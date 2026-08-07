import type { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import Group from "../models/Group.ts";
import Message from "../models/Message.ts";
import User from "../models/User.ts";
import GroupCall, { IGroupCall } from "../models/GroupCall.ts";
import {
  createNotification,
  sendNotificationViaSocket,
} from "../controllers/notificationController.ts";

/**
 * Group DM voice/video calling. Unlike DMCall (a strict ring/accept/reject
 * state machine for exactly two people), a group call has no single callee
 * to accept or decline — starting one immediately puts the initiator in an
 * "active" call that anyone else in the group can join at any time, same
 * spirit as a community voice channel's "Join Channel", but discrete: it
 * rings everyone else in the group (socket + push) the moment it starts, and
 * posts a call-log message in the group's chat once the last participant
 * leaves. Not joining is an implicit decline — there's no formal reject.
 *
 * The actual WebRTC mesh reuses the EXISTING webrtc:offer/webrtc:answer/
 * webrtc:ice-candidate relay handlers in server.ts unchanged (they only
 * check room membership, not what kind of room it is), and the exact same
 * join-broadcast shape the community voice-channel webrtc:join handler uses
 * (`socket.join(roomId)` then `io.to(roomId).emit("webrtc:user-joined",
 * {userId})`) — that shape is already proven correct for N-way meshes (a
 * new joiner bootstraps its connections by RECEIVING offers the existing
 * members create in response to seeing this event, not the other way
 * around), so this deliberately mirrors it exactly rather than reinventing
 * join semantics.
 */

function notifyGroupMembers(io: Server, userIds: unknown[], event: string, payload: unknown): void {
  const seen = new Set<string>();
  for (const raw of userIds) {
    const id =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "toString" in raw
          ? String(raw)
          : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    io.to(id).emit(event, payload);
  }
}

async function createGroupCallLogMessage(
  io: Server,
  call: Pick<IGroupCall, "groupId" | "initiator" | "type">,
  outcome: "completed" | "missed",
  durationSeconds?: number,
): Promise<void> {
  try {
    const label = call.type === "video" ? "Video call" : "Voice call";
    const content = outcome === "completed" ? label : `Missed ${label.toLowerCase()}`;

    const newMessage = await Message.create({
      content,
      sender: call.initiator,
      groupId: call.groupId,
      callInfo: { type: call.type, outcome, durationSeconds, caller: call.initiator },
    });
    const populatedMessage = await Message.findById(newMessage._id).populate({
      path: "sender",
      select: "name profilePic email about",
    });

    io.to(call.groupId.toString()).emit("groupMessage", {
      groupId: call.groupId.toString(),
      message: populatedMessage,
    });
  } catch (err) {
    console.error("createGroupCallLogMessage error:", err);
  }
}

async function notifyIncomingGroupCall(
  io: Server,
  groupCallId: string,
  groupId: string,
  groupName: string,
  initiatorId: string,
  initiatorName: string,
  recipientId: string,
  type: "voice" | "video",
): Promise<void> {
  try {
    const notification = await createNotification({
      recipient: recipientId,
      sender: initiatorId,
      type: "incoming_group_call",
      title: `Incoming ${type} call`,
      message: `${initiatorName} started a ${type} call in "${groupName}"`,
      metadata: { groupId, groupCallId, callType: type },
    });
    sendNotificationViaSocket(io, recipientId, notification);
  } catch (err) {
    console.error("notifyIncomingGroupCall error:", err);
  }
}

// Returns the groupCallId the socket just joined (server.ts's caller uses
// this to track it in its own per-connection joinedRooms set, the same way
// it already does for webrtc:join — see this file's leaveGroupCallOnDisconnect
// for why that tracking matters), or null if the join/start failed.
export async function startOrJoinGroupCall(
  io: Server,
  socket: Socket,
  userId: string,
  data: { groupId?: string; type?: string },
): Promise<string | null> {
  const groupId = data?.groupId;
  const type = data?.type;

  if (
    !groupId ||
    (type !== "voice" && type !== "video") ||
    !mongoose.Types.ObjectId.isValid(groupId)
  ) {
    socket.emit("group-call:error", { reason: "invalid_request" });
    return null;
  }

  try {
    const group = await Group.findById(groupId).select("participants isDisabled name").lean();
    if (!group) {
      socket.emit("group-call:error", { reason: "invalid_request" });
      return null;
    }
    const participantIds = (group.participants || []).map((p: any) => p.toString());
    if (!participantIds.includes(userId)) {
      socket.emit("group-call:error", { reason: "not_allowed" });
      return null;
    }
    if (group.isDisabled) {
      socket.emit("group-call:error", { reason: "not_allowed" });
      return null;
    }

    const existing = await GroupCall.findOne({ groupId, status: "active" });

    if (existing) {
      const groupCallId = existing._id.toString();
      const alreadyIn = existing.joinedParticipants.some((p) => p.toString() === userId);
      if (!alreadyIn) {
        existing.joinedParticipants.push(new mongoose.Types.ObjectId(userId));
        await existing.save();
      }
      socket.join(groupCallId);
      // Mirrors the community voice-channel webrtc:join broadcast shape
      // exactly — see this file's header comment for why that shape (not a
      // "tell the new joiner about everyone" broadcast) is what makes an
      // N-way mesh actually converge.
      io.to(groupCallId).emit("webrtc:user-joined", { userId });
      socket.emit("group-call:joined", {
        groupCallId,
        groupId,
        type: existing.type,
        isNewCall: false,
        participantIds: existing.joinedParticipants.map((p) => p.toString()),
      });
      return groupCallId;
    }

    const call = await GroupCall.create({
      groupId,
      initiator: userId,
      type,
      status: "active",
      joinedParticipants: [userId],
      startedAt: new Date(),
    });
    const groupCallId = call._id.toString();
    socket.join(groupCallId);
    socket.emit("group-call:joined", {
      groupCallId,
      groupId,
      type,
      isNewCall: true,
      participantIds: [userId],
    });

    const initiator = await User.findById(userId).select("name profilePic").lean();
    const others = participantIds.filter((id) => id !== userId);
    notifyGroupMembers(io, others, "group-call:incoming", {
      groupCallId,
      groupId,
      groupName: group.name,
      type,
      initiator: { id: userId, name: initiator?.name, profilePic: initiator?.profilePic },
    });
    for (const otherId of others) {
      void notifyIncomingGroupCall(
        io,
        groupCallId,
        groupId,
        group.name,
        userId,
        initiator?.name || "Someone",
        otherId,
        type,
      );
    }
    return groupCallId;
  } catch (err) {
    console.error("startOrJoinGroupCall error:", err);
    socket.emit("group-call:error", { reason: "server_error" });
    return null;
  }
}

// Shared by the explicit "leave" socket handler and the disconnect-cleanup
// sweep in server.ts — both just need "this user is no longer in this call,
// end it if that was the last one," differing only in how they got the
// (groupCallId, userId) pair. Silently no-ops if groupCallId isn't a real,
// currently-active GroupCall — the same "no-op for anything that doesn't
// match" contract server.ts's endVoiceSessionIfEmpty already relies on for
// its own best-effort disconnect sweep.
async function removeParticipant(io: Server, groupCallId: string, userId: string): Promise<void> {
  if (!mongoose.Types.ObjectId.isValid(groupCallId)) return;
  try {
    const call = await GroupCall.findOneAndUpdate(
      { _id: groupCallId, status: "active" },
      { $pull: { joinedParticipants: userId } },
      { new: true },
    );
    if (!call) return;

    io.to(groupCallId).emit("webrtc:user-left", { userId });

    if (call.joinedParticipants.length === 0) {
      const endedAt = new Date();
      call.status = "ended";
      call.endedAt = endedAt;
      await call.save();
      io.socketsLeave(groupCallId);

      const durationSeconds = Math.max(
        0,
        Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000),
      );
      // "completed" regardless of duration — a lone initiator who leaves
      // immediately still gets a log entry rather than "missed" (nobody was
      // ever formally rung-and-declined the way a DM call can be; per-person
      // "you missed this" is already covered by the incoming push above).
      await createGroupCallLogMessage(io, call, "completed", durationSeconds);
      io.to(call.groupId.toString()).emit("group-call:ended", {
        groupCallId,
        groupId: call.groupId.toString(),
      });
    }
  } catch (err) {
    console.error("removeParticipant (group call) error:", err);
  }
}

export async function leaveGroupCall(
  io: Server,
  socket: Socket,
  userId: string,
  data: { groupCallId?: string },
): Promise<void> {
  const groupCallId = data?.groupCallId;
  if (!groupCallId) return;
  socket.leave(groupCallId);
  await removeParticipant(io, groupCallId, userId);
}

// Called from server.ts's disconnect handler for every room the socket was
// in — a no-op for any roomId that isn't a currently-active GroupCall's id
// (see removeParticipant's guard), exactly like endVoiceSessionIfEmpty's own
// contract for the equivalent voice-channel sweep.
export async function leaveGroupCallOnDisconnect(
  io: Server,
  userId: string,
  roomId: string,
): Promise<void> {
  await removeParticipant(io, roomId, userId);
}

export async function getActiveGroupCall(groupId: string): Promise<{
  groupCallId: string;
  type: "voice" | "video";
  participantIds: string[];
} | null> {
  if (!mongoose.Types.ObjectId.isValid(groupId)) return null;
  const call = await GroupCall.findOne({ groupId, status: "active" }).lean();
  if (!call) return null;
  return {
    groupCallId: call._id.toString(),
    type: call.type,
    participantIds: call.joinedParticipants.map((p) => p.toString()),
  };
}
