import { Context } from "hono";
import type { Server } from "socket.io";
import mongoose from "mongoose";
import Message from "../models/Message.ts";
import Conversation from "../models/Conversation.ts";
import Group from "../models/Group.ts";
import DiscordServer from "../models/DiscordServer.ts";
import ServerMember from "../models/ServerMember.ts";
import { invalidateAfterMessage, invalidateAfterDM } from "../lib/cacheInvalidation.ts";
import CacheInvalidator from "../lib/cacheInvalidation.ts";
import { fireWebhooksForEvent } from "../lib/webhookEvents.ts";
import { emitConversationActivity } from "./dmController.ts";

// Everything the forward-destination picker needs in one round trip: DMs,
// group DMs, and servers with their (text-only — you can't forward a
// message into a voice/video channel) channels. Assembled server-side
// rather than composed from three separately-shaped existing hooks, so the
// picker gets one complete, consistently-shaped response instead of
// stitching together partial data (e.g. DiscordServer.channels is normally
// just an array of ids, not populated with names, everywhere else it's used).
export const getForwardTargets = async (c: Context) => {
  try {
    const requester = c.get("user");
    const userId = requester.id;

    const [conversations, groups, servers] = await Promise.all([
      Conversation.find({
        participants: userId,
        hiddenFor: { $ne: userId },
        deletedFor: { $ne: userId },
      })
        .select("participants")
        .populate("participants", "name profilePic")
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean(),
      Group.find({ participants: userId, isGroupDM: true })
        .select("name icon")
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean(),
      DiscordServer.find({ $or: [{ owner: userId }, { "members.user": userId }] })
        .select("name imageUrl channels")
        .populate({ path: "channels", select: "name type", match: { type: "Text" } })
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean(),
    ]);

    return c.json({
      conversations: conversations.map((conv: any) => {
        const other = conv.participants.find((p: any) => p._id.toString() !== userId);
        return {
          _id: conv._id,
          otherUserId: other?._id?.toString() ?? "",
          name: other?.name ?? "Unknown",
          profilePic: other?.profilePic ?? "",
        };
      }),
      groups: groups.map((g: any) => ({ _id: g._id, name: g.name, icon: g.icon ?? "" })),
      servers: servers.map((s: any) => ({
        _id: s._id,
        name: s.name,
        imageUrl: s.imageUrl ?? "",
        channels: (s.channels || [])
          .filter(Boolean)
          .map((ch: any) => ({ _id: ch._id, name: ch.name })),
      })),
    });
  } catch (error) {
    console.error("Error fetching forward targets:", error);
    return c.json({ error: "Failed to fetch forward targets" }, 500);
  }
};

// A forward fans out to several destinations at once (mirrors WhatsApp/
// Telegram's multi-select forward) — capped well above any real use to keep
// this from being a spam vector.
const MAX_TARGETS = 20;

type ForwardTarget =
  | { type: "channel"; channelId: string; serverId: string }
  | { type: "conversation"; conversationId: string }
  | { type: "group"; groupId: string };

function isValidTarget(t: any): t is ForwardTarget {
  if (!t || typeof t !== "object") return false;
  if (t.type === "channel") return mongoose.Types.ObjectId.isValid(t.channelId) && mongoose.Types.ObjectId.isValid(t.serverId);
  if (t.type === "conversation") return mongoose.Types.ObjectId.isValid(t.conversationId);
  if (t.type === "group") return mongoose.Types.ObjectId.isValid(t.groupId);
  return false;
}

// Loads the source message ONLY if the requester actually had access to it —
// a member of its server (channel messages), a participant in its
// conversation (1:1 DM), or a participant/owner of its group (group DM).
// Never trusts a bare messageId alone; forwarding must not become a way to
// read content the requester was never part of.
async function loadForwardableSource(messageId: string, requesterId: string) {
  const source = await Message.findById(messageId).populate("sender", "name");
  if (!source || !source.sender) return null;
  if (source.deletedForEveryone) return null;
  if (source.deletedFor?.some((id) => id.toString() === requesterId)) return null;

  if (source.channel && source.server) {
    const isMember = await ServerMember.exists({ server: source.server, user: requesterId });
    if (!isMember) return null;
  } else if (source.conversationId) {
    const conv = await Conversation.findById(source.conversationId).select("participants");
    if (!conv || !conv.participants.some((p: any) => p.toString() === requesterId)) return null;
  } else if (source.groupId) {
    const group = await Group.findById(source.groupId).select("participants owner");
    const inGroup =
      !!group &&
      (group.participants.some((p: any) => p.toString() === requesterId) ||
        group.owner?.toString() === requesterId);
    if (!inGroup) return null;
  } else {
    // A call-log entry or some other shape with no known destination — never
    // forwardable.
    return null;
  }

  return source;
}

export const forwardMessage = async (c: Context) => {
  try {
    const requester = c.get("user");
    const io: Server | undefined = c.get("io");
    const { messageId } = c.req.param();
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return c.json({ error: "Invalid message ID" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const targets = Array.isArray(body?.targets) ? body.targets : [];
    if (targets.length === 0) {
      return c.json({ error: "At least one forward target is required" }, 400);
    }
    if (targets.length > MAX_TARGETS) {
      return c.json({ error: `Cannot forward to more than ${MAX_TARGETS} destinations at once` }, 400);
    }
    if (!targets.every(isValidTarget)) {
      return c.json({ error: "One or more targets are invalid" }, 400);
    }

    const source = await loadForwardableSource(messageId, requester.id);
    if (!source) {
      return c.json({ error: "Message not found or not accessible" }, 404);
    }

    const forwardedFrom = {
      messageId: source._id,
      senderId: (source.sender as any)._id,
      senderName: (source.sender as any).name || "Unknown",
    };

    const results = await Promise.all(
      (targets as ForwardTarget[]).map(async (target) => {
        try {
          if (target.type === "channel") {
            const isMember = await ServerMember.exists({ server: target.serverId, user: requester.id });
            if (!isMember) return { target, ok: false, error: "Not a member of that server" };

            const newMessage = await Message.create({
              channel: target.channelId,
              server: target.serverId,
              sender: requester.id,
              content: source.content,
              formattedContent: source.formattedContent,
              plainText: source.plainText,
              attachments: source.attachments,
              attachmentsV2: source.attachmentsV2,
              forwardedFrom,
            });
            const populated = await Message.findById(newMessage._id).populate("sender", "name profilePic email");

            if (io) {
              io.to(target.channelId).emit("messageCreated", populated);
              io.to(target.serverId).emit("server:new-message", {
                serverId: target.serverId,
                channelId: target.channelId,
                message: populated,
              });
            }
            void fireWebhooksForEvent(target.serverId, "message_created", {
              channelId: target.channelId,
              sender: { id: requester.id, name: requester.email },
              content: source.content,
              messageId: newMessage._id.toString(),
            }, io);
            await invalidateAfterMessage(target.channelId, target.serverId);

            return { target, ok: true, message: populated };
          }

          if (target.type === "conversation") {
            const conv = await Conversation.findById(target.conversationId);
            if (!conv || !conv.participants.some((p: any) => p.toString() === requester.id)) {
              return { target, ok: false, error: "Not a participant of that conversation" };
            }

            const newMessage = await Message.create({
              content: source.content,
              sender: requester.id,
              conversationId: conv._id,
              attachments: source.attachments,
              attachmentsV2: source.attachmentsV2,
              forwardedFrom,
            });
            await Conversation.findByIdAndUpdate(conv._id, { $push: { messages: newMessage._id } });
            const populated = await Message.findById(newMessage._id).populate("sender", "name profilePic email about");

            if (io) {
              io.to(conv._id.toString()).emit("dm:new-message", populated);
              emitConversationActivity(io, conv.participants, {
                conversationId: conv._id.toString(),
                type: "new",
                senderId: requester.id,
                messageId: newMessage._id.toString(),
                lastMessage: populated,
              });
            }
            await invalidateAfterDM(conv._id.toString(), requester.id);

            return { target, ok: true, message: populated };
          }

          // target.type === "group"
          const group = await Group.findById(target.groupId);
          const inGroup =
            !!group &&
            (group.participants.some((p: any) => p.toString() === requester.id) ||
              group.owner?.toString() === requester.id);
          if (!inGroup) return { target, ok: false, error: "Not a member of that group" };
          if (group.isDisabled) return { target, ok: false, error: "This group is disabled" };

          const newMessage = new Message({
            sender: requester.id,
            content: source.content,
            attachmentsV2: source.attachmentsV2,
            groupId: group._id,
            forwardedFrom,
            createdAt: new Date(),
          });
          await newMessage.save();
          await newMessage.populate("sender", "name email profilePic");

          if (io) {
            io.to(group._id.toString()).emit("groupMessage", {
              groupId: group._id.toString(),
              message: newMessage.toObject(),
            });
          }
          await CacheInvalidator.invalidateGroup(group._id.toString());

          return { target, ok: true, message: newMessage.toObject() };
        } catch (err) {
          console.error("Error forwarding message to target:", target, err);
          return { target, ok: false, error: "Failed to forward to this destination" };
        }
      }),
    );

    const successCount = results.filter((r) => r.ok).length;
    return c.json({ results, successCount, totalCount: results.length }, 200);
  } catch (error) {
    console.error("Error forwarding message:", error);
    return c.json({ error: "Failed to forward message" }, 500);
  }
};
