import { Hono } from "hono";
import { getPublicReelPreview, getReelCaptionsVtt } from "../controllers/reelController.ts";

// Deliberately separate from reelRouter (which has a blanket
// `.use(authMiddleware)`) — this is the one reel endpoint that must work
// for a logged-out visitor or link-preview crawler, mounted at its own
// path so it can never accidentally inherit that auth requirement.
export const publicReelRouter = new Hono();

publicReelRouter.get("/:reelId", getPublicReelPreview);
// A <video><track src> request never carries an Authorization header, so
// this needs to live here too, not on the authed reelRouter.
publicReelRouter.get("/:reelId/captions.vtt", getReelCaptionsVtt);
