import { Server } from "socket.io";

let ioInstance: Server | null = null;

export const setIoInstance = (io: Server) => {
  ioInstance = io;
};

export const getIoInstance = (): Server => {
  if (!ioInstance) {
    throw new Error("Socket.IO instance not initialized yet!");
  }
  return ioInstance;
};
