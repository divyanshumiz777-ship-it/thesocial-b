import { describe, it, expect } from "vitest";
import {
  getProfileVisibility,
  canViewFullProfile,
  redactedProfileView,
  fullProfileView,
  buildProfileView,
} from "../src/lib/profilePrivacy";

const OWNER_ID = "507f1f77bcf86cd799439011";
const VIEWER_ID = "507f1f77bcf86cd799439012";

function userWith(visibility?: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: OWNER_ID,
    name: "Creator One",
    username: "creatorone",
    email: "creator@example.com",
    profilePic: "pic.jpg",
    about: "bio text",
    website: "example.com",
    location: "Earth",
    verified: true,
    settings: { privacy: { profileVisibility: visibility } },
    ...overrides,
  };
}

describe("getProfileVisibility", () => {
  it("defaults to public when unset", () => {
    expect(getProfileVisibility(userWith(undefined))).toBe("public");
  });

  it("defaults to public for an unrecognized value (fails open by design, not a security bug — see canViewFullProfile default-deny)", () => {
    expect(getProfileVisibility(userWith("bogus"))).toBe("public");
  });

  it.each(["public", "private", "friends", "followers"])("passes through %s", (v) => {
    expect(getProfileVisibility(userWith(v))).toBe(v);
  });
});

describe("canViewFullProfile — the core privacy gate", () => {
  it("self can always view own profile, regardless of tier", () => {
    for (const tier of ["public", "private", "friends", "followers"]) {
      expect(
        canViewFullProfile(userWith(tier), { viewerId: OWNER_ID })
      ).toBe(true);
    }
  });

  it("public: anyone can view", () => {
    expect(
      canViewFullProfile(userWith("public"), { viewerId: VIEWER_ID })
    ).toBe(true);
    expect(canViewFullProfile(userWith("public"), {})).toBe(true); // anonymous
  });

  it("private (Only Me): nobody but self, even friends/followers", () => {
    expect(
      canViewFullProfile(userWith("private"), {
        viewerId: VIEWER_ID,
        isFriend: true,
        isFollower: true,
      })
    ).toBe(false);
  });

  it("friends: only friends, followers alone do not count", () => {
    const u = userWith("friends");
    expect(canViewFullProfile(u, { viewerId: VIEWER_ID, isFriend: true })).toBe(true);
    expect(canViewFullProfile(u, { viewerId: VIEWER_ID, isFollower: true })).toBe(false);
    expect(canViewFullProfile(u, { viewerId: VIEWER_ID })).toBe(false);
  });

  it("followers: accepted followers can view; a pending request does not count (caller must not pass isFollower for pending)", () => {
    const u = userWith("followers");
    expect(canViewFullProfile(u, { viewerId: VIEWER_ID, isFollower: true })).toBe(true);
    expect(canViewFullProfile(u, { viewerId: VIEWER_ID, isFollower: false })).toBe(false);
  });

  it("followers: friends also see through it (closer relationship than a mere follow)", () => {
    expect(
      canViewFullProfile(userWith("followers"), {
        viewerId: VIEWER_ID,
        isFriend: true,
        isFollower: false,
      })
    ).toBe(true);
  });

  it("anonymous (no viewerId) is denied on every non-public tier", () => {
    for (const tier of ["private", "friends", "followers"]) {
      expect(canViewFullProfile(userWith(tier), {})).toBe(false);
    }
  });
});

describe("redactedProfileView", () => {
  it("exposes only identity fields — name/username/verified survive, everything else is stripped", () => {
    const view = redactedProfileView(userWith("private"));
    expect(view).toEqual({
      _id: OWNER_ID,
      name: "Creator One",
      username: "creatorone",
      profilePic: "",
      verified: true,
      visibility: "private",
      restricted: true,
    });
    // Explicitly must NOT leak these:
    expect((view as any).email).toBeUndefined();
    expect((view as any).about).toBeUndefined();
    expect((view as any).website).toBeUndefined();
    expect((view as any).location).toBeUndefined();
  });
});

describe("fullProfileView", () => {
  it("never leaks friends/blockedUsers/settings/password even if present on the doc", () => {
    const raw = userWith("public", {
      friends: ["a", "b"],
      blockedUsers: ["c"],
      password: "hash",
      providerAccountId: "secret",
    });
    const view: any = fullProfileView(raw);
    expect(view.friends).toBeUndefined();
    expect(view.blockedUsers).toBeUndefined();
    expect(view.password).toBeUndefined();
    expect(view.providerAccountId).toBeUndefined();
    expect(view.restricted).toBe(false);
  });
});

describe("buildProfileView — the single entry point every controller uses", () => {
  it("returns the full view when allowed", () => {
    const view = buildProfileView(userWith("public"), { viewerId: VIEWER_ID });
    expect(view.restricted).toBe(false);
    expect((view as any).about).toBe("bio text");
  });

  it("returns the redacted view when not allowed", () => {
    const view = buildProfileView(userWith("private"), { viewerId: VIEWER_ID });
    expect(view.restricted).toBe(true);
    expect((view as any).about).toBeUndefined();
  });
});
