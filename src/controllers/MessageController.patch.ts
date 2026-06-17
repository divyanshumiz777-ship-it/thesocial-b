/**
 * messageController.toggleReaction — PATCHED
 *
 * The original used user._id which is undefined per authMiddleware.
 * This patch fixes the reaction logic to use user.id.
 *
 * Drop-in replacement for the toggleReaction export in messageController.ts.
 * All other exports (createMessage, getMessagesByChannelId, updateMessage,
 * deleteMessage, updateLastReadMessage, getLastReadMessage, searchMessages)
 * already use user.id correctly.
 */

import { Context } from "hono";
import mongoose from "mongoose";
import Message from "../models/Message.ts";
import { Server } from "socket.io";

export const toggleReaction = async (c: Context) => {
  const { messageId } = c.req.param();
  const { emoji, channelId } = await c.req.json();
  const user = c.get("user");
  const io: Server = c.get("io");

  if (!user) return c.json({ error: "Unauthorized" }, 401);

  if (
    !mongoose.Types.ObjectId.isValid(messageId) ||
    !mongoose.Types.ObjectId.isValid(channelId)
  )
    return c.json({ error: "Invalid ID format" }, 400);

  try {
    const message = await Message.findById(messageId);
    if (!message) return c.json({ error: "Message not found" }, 404);

    const userId = user.id; // FIXED: was user._id (undefined)
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const reactionIndex = message.reactions.findIndex((r) => r.emoji === emoji);
    const hasThisReaction =
      reactionIndex > -1 &&
      message.reactions[reactionIndex].users.some(
        (u) => u.toString() === userId
      );

    if (hasThisReaction) {
      const userIndex = message.reactions[reactionIndex].users.findIndex(
        (u) => u.toString() === userId
      );
      message.reactions[reactionIndex].users.splice(userIndex, 1);
      if (message.reactions[reactionIndex].users.length === 0) {
        message.reactions.splice(reactionIndex, 1);
      }
    } else {
      // Remove user from all other reactions (one reaction per user rule)
      for (const reaction of message.reactions) {
        const idx = reaction.users.findIndex((u) => u.toString() === userId);
        if (idx > -1) reaction.users.splice(idx, 1);
      }
      message.reactions = message.reactions.filter((r) => r.users.length > 0);

      const newIdx = message.reactions.findIndex((r) => r.emoji === emoji);
      if (newIdx > -1) {
        message.reactions[newIdx].users.push(userObjectId);
      } else {
        message.reactions.push({ emoji, users: [userObjectId] });
      }
    }

    await message.save();

    io.to(channelId).emit("reactionUpdated", {
      messageId: message._id,
      reactions: message.reactions,
    });

    return c.json(
      { message: "Reaction updated", reactions: message.reactions },
      200
    );
  } catch (error) {
    console.error("Error adding reaction:", error);
    return c.json({ error: "Failed to add reaction" }, 500);
  }
};