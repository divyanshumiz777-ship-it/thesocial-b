import type { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import Conversation from "../models/Conversation.ts";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import DMCall, { IDMCall } from "../models/DMCall.ts";
import redis from "./redis.ts";
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

// callId -> set of userIds who've confirmed their OWN local media is ready,
// held in Redis (not a local Map) — the caller's and callee's sockets can
// land on DIFFERENT backend instances behind Railway's load balancer, and a
// plain in-process Map would only ever see whichever side happened to hit
// THIS process, leaving bothReady permanently false on every instance. This
// was a confirmed live bug: both sides emitted call:media-ready with a
// matching callId, but webrtc:user-joined never fired. Redis is already the
// shared cross-instance store this backend uses (see server.ts's Socket.IO
// redis-adapter wiring for the same class of problem on the emit side).
//
// webrtc:user-joined is only ever emitted once BOTH sides are in this set —
// each side's useWebRTC only registers its offer/answer/ICE listeners once
// ITS OWN getUserMedia() resolves (mirrors the community voice-channel gate:
// enabled = joined && !!localStream), so emitting the join signal any
// earlier — e.g. immediately at accept time — risks it arriving before one
// side is listening yet (getUserMedia can take anywhere from a few ms to
// several seconds on a first-ever permission prompt), and Socket.IO does not
// replay missed events. Waiting for both removes the race entirely instead
// of relying on emission-order luck.
const MEDIA_READY_TTL_SECONDS = 120;
function mediaReadyKey(callId: string) {
  return `dmcall:media-ready:${callId}`;
}
function mediaTriggeredKey(callId: string) {
  return `dmcall:media-triggered:${callId}`;
}

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

    // Mirrors createDm's own update exactly (dmController.ts) — sending a
    // message (a call-log entry is one) un-hides / un-deletes the
    // conversation for both participants and clears their per-user
    // deletedAt cutoff. Without this, a call placed on a conversation either
    // side had previously hidden/removed would create the log entry but
    // leave the conversation missing from that side's list — unlike what
    // happens for a normal text message.
    const callerIdStr = call.caller.toString();
    const calleeIdStr = call.callee.toString();
    await Conversation.findByIdAndUpdate(call.conversationId, {
      $push: { messages: newMessage._id },
      $pull: {
        hiddenFor: { $in: [callerIdStr, calleeIdStr] },
        deletedFor: { $in: [callerIdStr, calleeIdStr] },
      },
      $unset: {
        [`deletedAt.${callerIdStr}`]: "",
        [`deletedAt.${calleeIdStr}`]: "",
      },
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

// Push notifications previously only fired for a call the callee never
// answered (notifyMissedCall below) — a ringing call only ever reached a
// backgrounded/closed app via the plain "call:incoming" socket event, which
// does nothing once the tab isn't running JS. This fires immediately
// alongside call:incoming so a push reaches the OS notification tray the
// same moment the in-app ring starts, not just after it's already missed.
async function notifyIncomingCall(
  io: Server,
  callId: string,
  conversationId: string,
  callerId: string,
  calleeId: string,
  callerName: string,
  type: "voice" | "video",
): Promise<void> {
  try {
    const notification = await createNotification({
      recipient: calleeId,
      sender: callerId,
      type: "incoming_call",
      title: `Incoming ${type} call`,
      message: `${callerName} is calling you`,
      metadata: { conversationId, callId, callType: type },
    });
    sendNotificationViaSocket(io, calleeId, notification);
  } catch (err) {
    console.error("notifyIncomingCall error:", err);
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

    // Forced to the primary — the connection's default readPreference is
    // "primaryPreferred" (config/db.ts), which lets this land on a secondary
    // that hasn't yet replicated a just-written status: "ended" from the
    // other party's hangup moments earlier. That stale read was surfacing as
    // "you're on another call" immediately after a call had genuinely ended.
    const busy = await DMCall.exists({
      status: { $in: ["ringing", "accepted"] },
      $or: [
        { caller: callerId },
        { callee: callerId },
        { caller: calleeId },
        { callee: calleeId },
      ],
    }).read("primary");
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
    void notifyIncomingCall(io, callId, conversationId, callerId, calleeId, caller.name, type);

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
    const callerSocket = io.sockets.sockets.get(call.callerSocketId);
    callerSocket?.join(callId);
    socket.join(callId);
    console.log(
      `[dmCall] acceptCall callId=${callId} callerSocketId=${call.callerSocketId} callerSocketFound=${!!callerSocket} calleeSocketId=${socket.id}`,
    );

    // Any OTHER tabs/devices the callee has open were also rung — tell them
    // this call was answered elsewhere so their incoming-call UI closes.
    io.to(call.callee.toString()).except(socket.id).emit("call:answered-elsewhere", { callId });

    io.to(callId).emit("call:accepted", { callId });
  } catch (err) {
    console.error("acceptCall error:", err);
  }
}

export async function mediaReady(
  io: Server,
  userId: string,
  data: { callId?: string },
): Promise<void> {
  const callId = data?.callId;
  if (!callId || !mongoose.Types.ObjectId.isValid(callId)) return;
  console.log(`[dmCall] mediaReady called: callId=${callId} userId=${userId}`);

  try {
    // Guards against re-emitting webrtc:user-joined (and thus a second,
    // leaked RTCPeerConnection on the caller's side — handleUserJoined
    // doesn't close an existing one before creating a new one) if this is
    // ever called again after the pair is already complete (e.g. a
    // client-side reconnect re-running its ready effect).
    const alreadyTriggered = await redis.exists(mediaTriggeredKey(callId));
    if (alreadyTriggered) return;

    // Forced to the primary for the same reason as inviteCall's busy check
    // above: media-ready fires within ~1s of acceptCall's status write, well
    // within reach of replication lag to a secondary under the connection's
    // default "primaryPreferred" — a stale read here silently drops this
    // event (call is null, function just returns) instead of erroring, so
    // this was invisible without directly comparing client and server logs.
    const call = await DMCall.findOne({ _id: callId, status: "accepted" })
      .select("caller callee")
      .read("primary")
      .lean();
    if (!call) {
      console.log(`[dmCall] mediaReady: no accepted call found for callId=${callId}`);
      return;
    }
    if (call.caller.toString() !== userId && call.callee.toString() !== userId) return;

    const readyKey = mediaReadyKey(callId);
    await redis.sadd(readyKey, userId);
    await redis.expire(readyKey, MEDIA_READY_TTL_SECONDS);
    const readyMembers = await redis.smembers(readyKey);

    const bothReady =
      readyMembers.includes(call.caller.toString()) && readyMembers.includes(call.callee.toString());
    console.log(
      `[dmCall] mediaReady callId=${callId} userId=${userId} readySet=${readyMembers.join(",")} bothReady=${bothReady}`,
    );
    if (!bothReady) return;

    // Atomic cross-instance claim — if two instances both observe bothReady
    // in the same race window, only the one that wins this NX set actually
    // emits, so webrtc:user-joined still fires exactly once.
    const claimed = await redis.set(mediaTriggeredKey(callId), "1", "EX", MEDIA_READY_TTL_SECONDS, "NX");
    if (claimed !== "OK") return;

    // Naming the callee mirrors community voice channels' own semantics: the
    // OTHER party (caller) reacts to webrtc:user-joined by creating the
    // RTCPeerConnection and sending the offer; the callee's own client sees
    // remoteId === its own userId and no-ops (same self-check every other
    // webrtc:user-joined recipient already has).
    const roomSize = io.sockets.adapter.rooms.get(callId)?.size ?? 0;
    console.log(`[dmCall] emitting webrtc:user-joined for callId=${callId}, room size=${roomSize}`);
    io.to(callId).emit("webrtc:user-joined", { userId: call.callee.toString() });
  } catch (err) {
    console.error("mediaReady error:", err);
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
    await redis.del(mediaReadyKey(callId));
    await redis.del(mediaTriggeredKey(callId));

    const durationSeconds = call.connectedAt
      ? Math.max(0, Math.round((endedAt.getTime() - call.connectedAt.getTime()) / 1000))
      : 0;
    await createCallLogMessage(io, call, "completed", durationSeconds);
  } catch (err) {
    console.error("endCall error:", err);
  }
}

// Called from server.ts's disconnect handler. Without this, a call left
// "ringing" or "accepted" when a socket drops (app crash, force-quit,
// network loss — anything short of the normal reject/cancel/end socket
// events) stays stuck in that status forever, and inviteCall's busy check
// matches ANY in-progress call for either party, so every future call
// attempt between that pair permanently fails with "they're on another
// call" even once the other side is genuinely offline. This was a
// confirmed real gap: no disconnect cleanup existed for DM calls at all
// (unlike voice channels' endVoiceSessionIfEmpty and group calls'
// leaveGroupCallOnDisconnect, both already wired in server.ts).
//
// Only runs once this was the user's LAST connected socket — a call still
// active on another of their devices/tabs shouldn't be torn down just
// because one of them disconnected.
export async function endDMCallsOnDisconnect(io: Server, userId: string): Promise<void> {
  if (hasConnectedSocket(io, userId)) return;

  try {
    const calls = await DMCall.find({
      status: { $in: ["ringing", "accepted"] },
      $or: [{ caller: userId }, { callee: userId }],
    });

    for (const call of calls) {
      const callId = call._id.toString();
      const wasRinging = call.status === "ringing";
      const isCaller = call.caller.toString() === userId;
      const otherPartyId = (isCaller ? call.callee : call.caller).toString();

      clearCallTimer(callId);
      call.status = wasRinging ? "missed" : "ended";
      call.endedAt = new Date();
      await call.save();

      if (wasRinging) {
        // The disconnecting party was either the caller (still ringing —
        // the callee's incoming-call UI needs to close) or the callee
        // (the caller sees a missed call, same as any other unanswered
        // ring), so the event differs by role even though the outcome
        // (call-log "missed") is the same either way.
        io.to(otherPartyId).emit(isCaller ? "call:cancelled" : "call:missed", { callId, reason: "offline" });
        await createCallLogMessage(io, call, "missed");
      } else {
        io.to(callId).emit("call:ended", { callId });
        io.socketsLeave(callId);
        await redis.del(mediaReadyKey(callId));
        await redis.del(mediaTriggeredKey(callId));
        const durationSeconds = call.connectedAt
          ? Math.max(0, Math.round((call.endedAt.getTime() - call.connectedAt.getTime()) / 1000))
          : 0;
        await createCallLogMessage(io, call, "completed", durationSeconds);
      }
    }
  } catch (err) {
    console.error("endDMCallsOnDisconnect error:", err);
  }
}
