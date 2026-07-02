import { describe, it, expect, vi, beforeEach } from "vitest";

// Mutable holder so each test can swap what getIoInstance returns/throws.
let ioBehavior: () => any;

vi.mock("../src/config/socket.ts", () => ({
  getIoInstance: () => ioBehavior(),
}));

import { broadcastProfileChange } from "../src/lib/profileBroadcast.ts";

function makeIo() {
  const emitted: { room: string | null; event: string; payload: any }[] = [];
  const io: any = {
    emit: (event: string, payload: any) =>
      emitted.push({ room: null, event, payload }),
    to: (room: string) => ({
      emit: (event: string, payload: any) =>
        emitted.push({ room, event, payload }),
    }),
  };
  return { io, emitted };
}

const USER = {
  _id: "507f1f77bcf86cd799439001",
  name: "Ada",
  profilePic: "https://cdn/pic-v2.jpg",
  about: "hi",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("broadcastProfileChange", () => {
  it("does a GLOBAL io.emit of user:profile-changed with the resolved fields", () => {
    const { io, emitted } = makeIo();
    ioBehavior = () => io;

    broadcastProfileChange(USER);

    const global = emitted.find(
      (e) => e.room === null && e.event === "user:profile-changed"
    );
    expect(global).toBeTruthy();
    expect(global!.payload).toMatchObject({
      userId: USER._id,
      name: "Ada",
      profilePic: "https://cdn/pic-v2.jpg",
      about: "hi",
    });
    expect(typeof global!.payload.timestamp).toBe("number");
  });

  it("also emits creator:profileUpdated to the creator room WITH the real URL (not a boolean)", () => {
    const { io, emitted } = makeIo();
    ioBehavior = () => io;

    broadcastProfileChange(USER);

    const creator = emitted.find(
      (e) => e.room === `creator:${USER._id}` && e.event === "creator:profileUpdated"
    );
    expect(creator).toBeTruthy();
    expect(creator!.payload.creatorId).toBe(USER._id);
    expect(creator!.payload.changedFields.profilePic).toBe(
      "https://cdn/pic-v2.jpg"
    );
    // Guards against the old bug where this carried `!!profilePic`.
    expect(typeof creator!.payload.changedFields.profilePic).not.toBe("boolean");
  });

  it("normalises a missing profilePic to an empty string (avatar removal)", () => {
    const { io, emitted } = makeIo();
    ioBehavior = () => io;

    broadcastProfileChange({ _id: USER._id, name: "Ada" });

    const global = emitted.find((e) => e.event === "user:profile-changed");
    expect(global!.payload.profilePic).toBe("");
  });

  it("is a no-op (no throw) when the socket server isn't initialised", () => {
    ioBehavior = () => {
      throw new Error("Socket.IO instance not initialized yet!");
    };
    expect(() => broadcastProfileChange(USER)).not.toThrow();
  });
});
