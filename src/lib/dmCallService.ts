import type { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.ts";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import DMCall, { IDMCall } from "../models/DMCall.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "../controllers/notificationController.ts";
import { emitConversationActivity } from "../controllers/dmController.ts";

/**
 * 1:1 DM voice/video calling — ring/accept/reject/cancel/end lifecycle.
 *
 * The actual WebRTC signaling (offer/answer/ICE) reuses the EXISTING
 * webrtc:offer/webrtc:answer/webrtc:ice-candidate relay handlers in
 * server.ts unchanged — those only check room membership, not what kind of
 * room it is. This module's job is entirely the call-specific part those
 * handlers don't do: who's allowed to call whom, ringing/timeout/busy
 * semantics, and putting exactly the two right sockets into a shared room
 * once (and only once) the callee accepts.
 *
 * Deliberately NOT reusing webrtc:join/leave or canJoinVoiceChannel from the
 * community voice-channel feature — those are permission-gated by SERVER
 * membership, which has no meaning for a DM. Keeping this fully separate
 * avoids adding channel/DM branching into code that took real effort to get
 * right for the community case.
 */

const CALL_RING_TIMEOUT_MS = 45_000;

// callId -> ring-timeout handle. In-memory, single-process — same tier as
// server.ts's own onlineUsers/joinedRooms/voiceConsent maps; a server
// restart mid-ring drops the timer along with every other live socket
// state, and the DMCall document is simply left in "ringing" (a rare,
// cosmetically-stale row, not a functional problem — nothing polls it).
const callTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearCallTimer(callId: string) {
  const timer = callTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    callTimers.delete(callId);
  }
}

/** Does `userId` have at least one connected socket right now? Every socket
 * joins a room named by its own userId on connect (see server.ts's
 * connection handler) — checking that room's size avoids needing access to
 * the separate in-memory onlineUsers presence map from this module. */
function hasConnectedSocket(io: Server, userId: string): boolean {
  return (io.sockets.adapter.rooms.get(userId)?.size ?? 0) > 0;
}

async function createCallLogMessage(
  io: Server,
  call: Pick<IDMCall, "conversationId" | "caller" | "callee" | "type">,
  outcome: "completed" | "missed" | "rejected" | "cancelled",
  durationSeconds?: number,
): Promise<void> {
  try {
    const label = call.type === "video" ? "Video call" : "Voice call";
    const content = outcome === "completed" ? label : `Missed ${label.toLowerCase()}`;

    const newMessage = await Message.create({
      content,
      sender: call.caller,
      conversationId: call.conversationId,
      callInfo: { type: call.type, outcome, durationSeconds, caller: call.caller },
    });

    await Conversation.findByIdAndUpdate(call.conversationId, {
      $push: { messages: newMessage._id },
    });

    const populatedMessage = await Message.findById(newMessage._id).populate({
      path: "sender",
      select: "name profilePic email about",
    });

    const conversationIdStr = call.conversationId.toString();
    io.to(conversationIdStr).emit("dm:new-message", populatedMessage);
    emitConversationActivity(io, [call.caller, call.callee], {
      conversationId: conversationIdStr,
      type: "new",
      senderId: call.caller.toString(),
      messageId: newMessage._id.toString(),
      lastMessage: populatedMessage,
    });
  } catch (err) {
    console.error("createCallLogMessage error:", err);
  }
}

async function notifyMissedCall(
  io: Server,
  callId: string,
  conversationId: string,
  callerId: string,
  calleeId: string,
  type: "voice" | "video",
): Promise<void> {
  try {
    const caller = await User.findById(callerId).select("name").lean();
    const callerName = caller?.name ?? "Someone";
    const notification = await createNotification({
      recipient: calleeId,
      sender: callerId,
      type: "missed_call",
      title: "Missed call",
      message: `Missed ${type} call from ${callerName}`,
      metadata: { conversationId, callId, callType: type },
    });
    sendNotificationViaSocket(io, calleeId, notification);
  } catch (err) {
    console.error("notifyMissedCall error:", err);
  }
}

export async function inviteCall(
  io: Server,
  socket: Socket,
  callerId: string,
  data: { conversationId?: string; calleeId?: string; type?: string },
): Promise<void> {
  const conversationId = data?.conversationId;
  const calleeId = data?.calleeId;
  const type = data?.type;

  if (
    !conversationId ||
    !calleeId ||
    (type !== "voice" && type !== "video") ||
    !mongoose.Types.ObjectId.isValid(conversationId) ||
    !mongoose.Types.ObjectId.isValid(calleeId) ||
    calleeId === callerId
  ) {
    socket.emit("call:error", { reason: "invalid_request" });
    return;
  }

  try {
    const conversation = await Conversation.findById(conversationId)
      .select("participants")
      .lean();
    const participantIds = (conversation?.participants || []).map((p: any) =>
      p.toString(),
    );
    if (
      !conversation ||
      !participantIds.includes(callerId) ||
      !participantIds.includes(calleeId)
    ) {
      socket.emit("call:error", { reason: "invalid_request" });
      return;
    }

    const [caller, callee] = await Promise.all([
      User.findById(callerId).select("name profilePic friends blockedUsers").lean(),
      User.findById(calleeId).select("blockedUsers").lean(),
    ]);
    if (!caller || !callee) {
      socket.emit("call:error", { reason: "invalid_request" });
      return;
    }
    const isFriend = (caller.friends || []).some(
      (f: any) => f.toString() === calleeId,
    );
    const isBlocked =
      (callee.blockedUsers || []).some((u: any) => u.toString() === callerId) ||
      (caller.blockedUsers || []).some((u: any) => u.toString() === calleeId);
    if (!isFriend || isBlocked) {
      socket.emit("call:error", { reason: "not_allowed" });
      return;
    }

    const busy = await DMCall.exists({
      status: { $in: ["ringing", "accepted"] },
      $or: [
        { caller: callerId },
        { callee: callerId },
        { caller: calleeId },
        { callee: calleeId },
      ],
    });
    if (busy) {
      socket.emit("call:error", { reason: "busy" });
      return;
    }

    const call = await DMCall.create({
      conversationId,
      caller: callerId,
      callee: calleeId,
      type,
      status: "ringing",
      callerSocketId: socket.id,
      startedAt: new Date(),
    });
    const callId = call._id.toString();

    if (!hasConnectedSocket(io, calleeId)) {
      await DMCall.updateOne({ _id: call._id }, { status: "missed", endedAt: new Date() });
      socket.emit("call:missed", { callId, reason: "offline" });
      await createCallLogMessage(io, call, "missed");
      await notifyMissedCall(io, callId, conversationId, callerId, calleeId, type);
      return;
    }

    io.to(calleeId).emit("call:incoming", {
      callId,
      conversationId,
      type,
      caller: { id: callerId, name: caller.name, profilePic: caller.profilePic },
    });
    socket.emit("call:ringing", { callId });

    const timer = setTimeout(() => {
      void (async () => {
        callTimers.delete(callId);
        const stillRinging = await DMCall.findOneAndUpdate(
          { _id: callId, status: "ringing" },
          { status: "missed", endedAt: new Date() },
          { new: true },
        );
        // Already accepted/rejected/cancelled by the time this fired.
        if (!stillRinging) return;
        io.to(callerId).emit("call:missed", { callId, reason: "no_answer" });
        io.to(calleeId).emit("call:timeout", { callId });
        await createCallLogMessage(io, stillRinging, "missed");
        await notifyMissedCall(io, callId, conversationId, callerId, calleeId, type);
      })().catch((err) => console.error("call ring-timeout error:", err));
    }, CALL_RING_TIMEOUT_MS);
    callTimers.set(callId, timer);
  } catch (err) {
    console.error("inviteCall error:", err);
    socket.emit("call:error", { reason: "server_error" });
  }
}

export async function acceptCall(
  io: Server,
  socket: Socket,
  userId: string,
  data: { callId?: string },
): Promise<void> {
  const callId = data?.callId;
  if (!callId || !mongoose.Types.ObjectId.isValid(callId)) return;

  try {
    const call = await DMCall.findOneAndUpdate(
      { _id: callId, callee: userId, status: "ringing" },
      { status: "accepted", connectedAt: new Date() },
      { new: true },
    );
    if (!call) {
      socket.emit("call:error", { reason: "not_found" });
      return;
    }
    clearCallTimer(callId);

    // Only the ONE socket that placed the call joins — not every tab/device
    // the caller has open (see DMCall.callerSocketId's own comment) — and
    // likewise only this specific callee socket, not all of the callee's.
    io.sockets.sockets.get(call.callerSocketId)?.join(callId);
    socket.join(callId);

    // Any OTHER tabs/devices the callee has open were also rung — tell them
    // this call was answered elsewhere so their incoming-call UI closes.
    io.to(call.callee.toString()).except(socket.id).emit("call:answered-elsewhere", { callId });

    io.to(callId).emit("call:accepted", { callId });
  } catch (err) {
    console.error("acceptCall error:", err);
  }
}

export async function rejectCall(
  io: Server,
  userId: string,
  data: { callId?: string },
): Promise<void> {
  const callId = data?.callId;
  if (!callId || !mongoose.Types.ObjectId.isValid(callId)) return;

  try {
    const call = await DMCall.findOneAndUpdate(
      { _id: callId, callee: userId, status: "ringing" },
      { status: "rejected", endedAt: new Date() },
      { new: true },
    );
    if (!call) return;
    clearCallTimer(callId);
    io.to(call.caller.toString()).emit("call:rejected", { callId });
    await createCallLogMessage(io, call, "rejected");
  } catch (err) {
    console.error("rejectCall error:", err);
  }
}

export async function cancelCall(
  io: Server,
  userId: string,
  data: { callId?: string },
): Promise<void> {
  const callId = data?.callId;
  if (!callId || !mongoose.Types.ObjectId.isValid(callId)) return;

  try {
    const call = await DMCall.findOneAndUpdate(
      { _id: callId, caller: userId, status: "ringing" },
      { status: "cancelled", endedAt: new Date() },
      { new: true },
    );
    if (!call) return;
    clearCallTimer(callId);
    io.to(call.callee.toString()).emit("call:cancelled", { callId });
    await createCallLogMessage(io, call, "cancelled");
  } catch (err) {
    console.error("cancelCall error:", err);
  }
}

export async function endCall(
  io: Server,
  userId: string,
  data: { callId?: string },
): Promise<void> {
  const callId = data?.callId;
  if (!callId || !mongoose.Types.ObjectId.isValid(callId)) return;

  try {
    const call = await DMCall.findOne({ _id: callId, status: "accepted" });
    if (!call) return;
    if (call.caller.toString() !== userId && call.callee.toString() !== userId) return;

    const endedAt = new Date();
    call.status = "ended";
    call.endedAt = endedAt;
    await call.save();

    io.to(callId).emit("call:ended", { callId });
    io.socketsLeave(callId);

    const durationSeconds = call.connectedAt
      ? Math.max(0, Math.round((endedAt.getTime() - call.connectedAt.getTime()) / 1000))
      : 0;
    await createCallLogMessage(io, call, "completed", durationSeconds);
  } catch (err) {
    console.error("endCall error:", err);
  }
}
