import { Hono } from "hono";
import { authMiddleware } from "../middleware/authMiddleware.ts";
import {
  followUser,
  unfollowUser,
  acceptFollowRequest,
  rejectFollowRequest,
  getPendingFollowRequests,
  getFollowers,
  getFollowing,
  getMutualFollowers,
  getFollowStatus,
  getSuggestedCreators,
  muteCreator,
  unmuteCreator,
  getMuteStatus,
} from "../controllers/followController.ts";

const followRoutes = new Hono();

followRoutes.use(authMiddleware);

followRoutes.get("/suggested", getSuggestedCreators);
followRoutes.get("/requests/pending", getPendingFollowRequests);
followRoutes.patch("/requests/:userId/accept", acceptFollowRequest);
followRoutes.patch("/requests/:userId/reject", rejectFollowRequest);
followRoutes.get("/:userId/followers", getFollowers);
followRoutes.get("/:userId/following", getFollowing);
followRoutes.get("/:userId/mutual", getMutualFollowers);
followRoutes.get("/:userId/status", getFollowStatus);
followRoutes.get("/:creatorId/mute", getMuteStatus);
followRoutes.post("/:creatorId/mute", muteCreator);
followRoutes.delete("/:creatorId/mute", unmuteCreator);
followRoutes.post("/:userId", followUser);
followRoutes.delete("/:userId", unfollowUser);

export default followRoutes;
