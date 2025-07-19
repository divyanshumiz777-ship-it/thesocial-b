import dotenv from "dotenv";
import { serve } from "@hono/node-server";
import { Server } from "socket.io";
import { connectDB } from "./config/db.ts";
import app from "./app.ts";

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: envFile });

let ioInstance: Server;

async function startServer() {
  try {
    await connectDB();
    console.log("Database connected successfully!");

    const PORT = Number(process.env.PORT) || 8001;

    const httpServerInstance = await serve({
      fetch: app.fetch,
      port: PORT,
    });

    ioInstance = new Server(httpServerInstance, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
    });

    ioInstance.on("connection", (socket) => {
      console.log("Socket.IO: A user connected!");
      socket.on("message", (msg) => {
        console.log("Received message:", msg);
        ioInstance.emit("message", msg);
      });

      socket.on("disconnect", () => {
        console.log("Socket.IO: User disconnected!");
      });
    });

    console.log(`Hono/Socket.IO Server running on http://localhost:${PORT}`);
  } catch (error) {
    console.error("Failed to start application:", error);
    process.exit(1);
  }
}

startServer();

export const getIoInstance = () => {
  if (!ioInstance) {
    throw new Error("Socket.IO instance not initialized yet!");
  }
  return ioInstance;
};
