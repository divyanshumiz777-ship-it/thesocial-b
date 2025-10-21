import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  uploadAttachment,
  deleteAttachment,
  getAttachmentStats,
} from "../controllers/attachmentController.ts";

const attachmentRoutes = new Hono();

attachmentRoutes.use("*", authMiddleware);
attachmentRoutes.post("/upload", uploadAttachment);
attachmentRoutes.delete("/:messageId/:attachmentId", deleteAttachment);
attachmentRoutes.get("/stats", getAttachmentStats);

export default attachmentRoutes;
