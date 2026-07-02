import Message from "../models/Message.ts";
import ConversationReadStatus from "../models/ConversationReadStatus.ts";

/**
 * Redacts a populated participant down to the fields safe to expose in a
 * conversation payload, hiding the profile picture for accounts set to
 * "private" visibility. Shared by getUserConversations (list) and
 * findOrRestoreDm (single) so the privacy rule can't drift between the two.
 */
export function redactParticipant(p: any) {
  const visibility = p?.settings?.privacy?.profileVisibility;
  return {
    _id: p._id,
    name: p.name,
    email: p.email,
    profilePic: visibility === "private" ? "" : (p.profilePic ?? ""),
    lastSeen: p.lastSeen,
  };
}

/**
 * Shapes a single populated Conversation doc into the same wire format
 * getUserConversations returns, from one user's viewpoint (per-user
 * deletedAt cutoff, unread count, last visible message). Only used for
 * single-conversation responses (e.g. find-or-restore) — the sidebar list
 * keeps its own batched queries to avoid N+1s across many conversations.
 */
export async function formatSingleConversationForUser(
  conv: any,
  userId: string
) {
  const convId = conv._id;
  const deletedAt = conv.deletedAt?.get(userId.toString());

  const lastMsgQuery: Record<string, unknown> = {
    conversationId: convId,
    deletedFor: { $ne: userId },
  };
  if (deletedAt) lastMsgQuery.createdAt = { $gt: deletedAt };

  const lastMsgDoc = await Message.findOne(lastMsgQuery)
    .sort({ createdAt: -1 })
    .select("content sender createdAt edited attachmentsV2")
    .populate({ path: "sender", select: "name" })
    .lean<{
      _id: unknown;
      content: string;
      sender: { _id: unknown; name: string } | unknown;
      createdAt: Date;
      edited?: boolean;
      attachmentsV2?: unknown[];
    }>();

  const lastMessage = lastMsgDoc
    ? {
        _id: lastMsgDoc._id,
        content: lastMsgDoc.content,
        sender: lastMsgDoc.sender,
        createdAt: lastMsgDoc.createdAt,
        edited: lastMsgDoc.edited || false,
        attachmentsV2: lastMsgDoc.attachmentsV2 || [],
      }
    : null;

  const readStatus = await ConversationReadStatus.findOne({
    user: userId,
    conversation: convId,
  }).select("lastReadAt");
  const lastReadAt = readStatus?.lastReadAt;

  const cutoffs = [lastReadAt, deletedAt].filter(Boolean) as Date[];
  const unreadCutoff = cutoffs.length
    ? new Date(Math.max(...cutoffs.map((d) => d.getTime())))
    : null;

  const unreadQuery: Record<string, unknown> = {
    conversationId: convId,
    sender: { $ne: userId },
    deletedForEveryone: { $ne: true },
    deletedFor: { $ne: userId },
  };
  if (unreadCutoff) unreadQuery.createdAt = { $gt: unreadCutoff };

  const unreadCount = await Message.countDocuments(unreadQuery);

  const redactedParticipants = (conv.participants as any[]).map(
    redactParticipant
  );

  return {
    _id: conv._id,
    participants: redactedParticipants,
    lastMessage,
    unreadCount,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastActivityAt: lastMessage?.createdAt ?? conv.updatedAt,
  };
}
