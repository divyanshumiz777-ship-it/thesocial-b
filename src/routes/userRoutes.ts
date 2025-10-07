import { Hono } from "hono";
import {
  getAllUsers,
  getUser,
  editUser,
  deleteUser,
  joinServer,
  leaveServer,
  userServers,
  getUserConversations,
} from "../controllers/userController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const userRouter = new Hono();

userRouter.get("/user-servers", authMiddleware, userServers);
userRouter.get("/conversations", authMiddleware, getUserConversations);
userRouter.get("/all-user-detail", getAllUsers);
userRouter.get("/user-detail/:id", getUser);
userRouter.put("/user-detail/:id", editUser);
userRouter.delete("/user-detail/:id", deleteUser);
userRouter.post("/join-server/:id", authMiddleware, joinServer);
userRouter.post("/leave-server/:id", authMiddleware, leaveServer);
