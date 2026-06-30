import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriend,
  getFriendsList,
  getOnlineFriends,
  getPendingRequests,
  getSentRequests,
  getUserProfile,
  searchUsers,
  getNicknames,
  setNickname,
  removeNickname,
} from "../controllers/friendController.ts";

const friendRoutes = new Hono();

friendRoutes.use(authMiddleware);

friendRoutes.post("/request", sendFriendRequest);
friendRoutes.get("/requests/pending", getPendingRequests);
friendRoutes.get("/requests/sent", getSentRequests);
friendRoutes.patch("/request/:requestId/accept", acceptFriendRequest);
friendRoutes.patch("/request/:requestId/reject", rejectFriendRequest);
friendRoutes.get("/", getFriendsList);
friendRoutes.get("/online", getOnlineFriends);
friendRoutes.get("/nicknames", getNicknames);
friendRoutes.put("/:friendId/nickname", setNickname);
friendRoutes.delete("/:friendId/nickname", removeNickname);
friendRoutes.delete("/:friendId", removeFriend);
friendRoutes.get("/user/:userId", getUserProfile);
friendRoutes.get("/search/users", searchUsers);

export default friendRoutes;
