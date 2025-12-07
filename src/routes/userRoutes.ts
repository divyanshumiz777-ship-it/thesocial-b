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
  listFriends,
  addFriend,
  removeFriend,
  getUserSettings,
  updateUserSettings,
  updateLastSeen,
  updateProfile,
} from "../controllers/userController.ts";
import {
  updateCustomStatus,
  clearCustomStatus,
} from "../controllers/featureController.ts";
import { authMiddleware } from "../middleware/authMiddleware.ts";

export const userRouter = new Hono();

userRouter.get("/user-servers", authMiddleware, userServers);
userRouter.get("/conversations", authMiddleware, getUserConversations);
userRouter.get("/friends", authMiddleware, listFriends);
userRouter.post("/friends/add", authMiddleware, addFriend);
userRouter.post("/friends/remove", authMiddleware, removeFriend);
userRouter.post("/update-last-seen", authMiddleware, updateLastSeen);
userRouter.get("/all-user-detail", getAllUsers);
userRouter.get("/user-detail/:id", getUser);
userRouter.put("/user-detail/:id", editUser);
userRouter.put("/profile/:id", authMiddleware, updateProfile);
userRouter.delete("/user-detail/:id", deleteUser);
userRouter.post("/join-server/:id", authMiddleware, joinServer);
userRouter.post("/leave-server/:id", authMiddleware, leaveServer);
userRouter.get("/settings", authMiddleware, getUserSettings);
userRouter.put("/settings", authMiddleware, updateUserSettings);

userRouter.put("/custom-status", authMiddleware, updateCustomStatus);
userRouter.delete("/custom-status", authMiddleware, clearCustomStatus);
