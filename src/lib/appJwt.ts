import jwt from "jsonwebtoken";

// Historically, only the Next.js frontend minted this token (see
// frontend/lib/authOptions.ts's jwt callback: jwt.sign({id, email, role},
// JWT_SECRET, {expiresIn: "30d"})) — the backend only ever VERIFIED it via
// authMiddleware.ts. A standalone native client has no Next.js layer to do
// that minting for it, so the backend now issues the exact same token
// shape/secret/expiry itself. Both issuers producing an identical shape
// means authMiddleware doesn't care which one signed a given token.
// `role` is intentionally not part of this payload: the User model has no
// plain string role field (only `roles: ObjectId[]`, references into a
// separate per-server Role model) — frontend/lib/authOptions.ts's identical
// `token.role = user.role` has always silently evaluated to undefined for
// this same reason. Not fixing that pre-existing web-layer no-op here;
// admin/permission checks in this backend are done by email (see
// backend/src/lib/admin.ts's isAdminEmail) or by per-server Role documents,
// never by a JWT-embedded role string.
export interface AppJwtPayload {
  id: string;
  email: string;
}

export function signAppJwt(payload: AppJwtPayload): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}
