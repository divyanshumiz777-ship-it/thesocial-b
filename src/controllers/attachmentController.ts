import { Context } from "hono";
import { Server } from "socket.io";
import Message from "../models/Message.ts";
import mongoose from "mongoose";
import { uploadOnCloudinary } from "../lib/cloudinary.ts";
import { Buffer } from "node:buffer";
import {
  validateFile,
  sanitizeFilename,
  getCloudinaryFolder,
  getCloudinaryResourceType,
  getFileSizeInMB,
  formatFileSize,
} from "../lib/fileUpload.ts";

interface AttachmentMetadata {
  width?: number;
  height?: number;
  duration?: number;
}

export const uploadAttachment = async (c: Context) => {
  try {
    const io: Server = c.get("io");
    if (!io) return c.json({ error: "Socket.IO instance not available" }, 500);

    const user = c.get("user");
    if (!user?.id) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    const conversationId = (formData.get("conversationId") as string) || null;
    const channelId = (formData.get("channelId") as string) || null;

    if (!file) {
      return c.json({ error: "No file provided" }, 400);
    }

    const validation = validateFile(file);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400);
    }

    const fileType = validation.type!;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const cloudinaryResponse = await uploadOnCloudinary(buffer, {
      folder: getCloudinaryFolder(fileType),
      resource_type: getCloudinaryResourceType(fileType),
    });

    if (!cloudinaryResponse) {
      return c.json({ error: "Upload to Cloudinary failed" }, 500);
    }

    const metadata: AttachmentMetadata = {};

    if (fileType === "image" && cloudinaryResponse.width) {
      metadata.width = cloudinaryResponse.width;
      metadata.height = cloudinaryResponse.height;
    }

    if (
      (fileType === "video" || fileType === "audio") &&
      cloudinaryResponse.duration
    ) {
      metadata.duration = cloudinaryResponse.duration;
    }

    const attachment = {
      _id: new mongoose.Types.ObjectId(),
      url: cloudinaryResponse.secure_url,
      type: fileType as "image" | "video" | "document" | "audio",
      fileName: sanitizeFilename(file.name),
      fileSize: file.size,
      mimeType: file.type,
      ...metadata,
    };

    if (conversationId) {
      io.to(conversationId).emit("attachment:uploaded", {
        attachment,
        userId: user.id,
      });
    }
    if (channelId) {
      io.to(channelId).emit("attachment:uploaded", {
        attachment,
        userId: user.id,
      });
    }

    return c.json(
      {
        success: true,
        attachment,
      },
      200
    );
  } catch (error) {
    console.error("Error uploading attachment:", error);
    return c.json({ error: "Failed to upload attachment" }, 500);
  }
};

export const deleteAttachment = async (c: Context) => {
  try {
    const io: Server = c.get("io");
    const user = c.get("user");
    const { messageId, attachmentId } = c.req.param();

    if (!user?.id) {
      return c.json({ error: "Authentication required" }, 401);
    }

    if (!messageId || !attachmentId) {
      return c.json({ error: "Message ID and Attachment ID required" }, 400);
    }

    if (
      !mongoose.Types.ObjectId.isValid(messageId) ||
      !mongoose.Types.ObjectId.isValid(attachmentId)
    ) {
      return c.json({ error: "Invalid ID format" }, 400);
    }

    const message = await Message.findOne({
      _id: messageId,
      sender: user.id,
    });

    if (!message) {
      return c.json(
        {
          error: "Message not found or you don't have permission to modify it",
        },
        403
      );
    }

    const attachmentIndex = message.attachmentsV2?.findIndex((a) =>
      a.url?.includes(attachmentId)
    );

    if (attachmentIndex === undefined || attachmentIndex < 0) {
      return c.json({ error: "Attachment not found in message" }, 404);
    }

    message.attachmentsV2?.splice(attachmentIndex, 1);
    await message.save();

    if (io) {
      const channelId = message.channel?.toString();
      const conversationId = message.conversationId?.toString();

      if (channelId) {
        io.to(channelId).emit("attachment:deleted", {
          messageId,
          attachmentId,
        });
      }
      if (conversationId) {
        io.to(conversationId).emit("attachment:deleted", {
          messageId,
          attachmentId,
        });
      }
    }

    return c.json(
      {
        success: true,
        message: "Attachment deleted successfully",
      },
      200
    );
  } catch (error) {
    console.error("Error deleting attachment:", error);
    return c.json({ error: "Failed to delete attachment" }, 500);
  }
};

export const getAttachmentStats = async (c: Context) => {
  try {
    const user = c.get("user");

    if (!user?.id) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const messages = await Message.find({
      sender: user.id,
      attachmentsV2: { $exists: true, $ne: [] },
    }).select("attachmentsV2");

    let totalSize = 0;
    let totalCount = 0;

    for (const message of messages) {
      for (const attachment of message.attachmentsV2 || []) {
        totalSize += attachment.fileSize || 0;
        totalCount++;
      }
    }

    return c.json(
      {
        totalSize,
        totalCount,
        formattedSize: formatFileSize(totalSize),
        quotaUsage: getFileSizeInMB(totalSize),
      },
      200
    );
  } catch (error) {
    console.error("Error getting attachment stats:", error);
    return c.json({ error: "Failed to get attachment stats" }, 500);
  }
};
