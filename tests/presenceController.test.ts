import { describe, it, expect, vi, beforeEach } from "vitest";

const disconnectSockets = vi.fn();
const fetchSockets = vi.fn();
const inRoom = vi.fn(() => ({ disconnectSockets, fetchSockets }));
vi.mock("../src/config/socket.ts", () => ({
  getIoInstance: vi.fn(() => ({ in: inRoom })),
}));

import { getIoInstance } from "../src/config/socket.ts";
import { markSelfOffline } from "../src/controllers/presenceController.ts";

const USER_ID = "507f1f77bcf86cd799439001";
const SOCKET_ID = "sock_abc123";

function mockContext(body?: unknown) {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: () => ({ id: USER_ID }),
    req: {
      json: async () => {
        if (body === undefined) throw new Error("no body");
        return body;
      },
    },
    json: (payload: any, status = 200) => {
      calls.push({ body: payload, status });
      return { body: payload, status };
    },
  };
  return { c, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("markSelfOffline", () => {
  it("disconnects ONLY the socket named in the request, not every socket the user has", async () => {
    // A socket is always in a room named after its own id; `rooms` containing
    // the user id is what proves it belongs to this caller.
    fetchSockets.mockResolvedValueOnce([{ rooms: new Set([SOCKET_ID, USER_ID]) }]);

    const { c, calls } = mockContext({ socketId: SOCKET_ID });
    await markSelfOffline(c);

    // Scoped to the socket id — NOT `in(USER_ID)`, which would kill every
    // session this user has and tear down a call running in another tab.
    expect(inRoom).toHaveBeenCalledWith(SOCKET_ID);
    expect(inRoom).not.toHaveBeenCalledWith(USER_ID);
    // `true` (close the underlying connection) so the ping-timeout fallback
    // doesn't linger with the transport still open.
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toEqual({ success: true });
  });

  it("refuses to disconnect a socket that isn't the caller's own", async () => {
    // Someone else's socket: present, but not in this user's room. Without the
    // ownership check any authenticated user could drop any other user's
    // socket just by guessing its id.
    fetchSockets.mockResolvedValueOnce([{ rooms: new Set(["someone-elses-socket"]) }]);

    const { c, calls } = mockContext({ socketId: "someone-elses-socket" });
    await markSelfOffline(c);

    expect(disconnectSockets).not.toHaveBeenCalled();
    expect(calls[0].status).toBe(200);
  });

  it("disconnects nothing when no socketId is supplied (older client)", async () => {
    const { c, calls } = mockContext();
    await markSelfOffline(c);

    // Deliberately a no-op rather than the old disconnect-everything: the
    // presence grace period and ping timeout still mark them offline shortly
    // after, which is a far better failure mode than dropping live calls.
    expect(disconnectSockets).not.toHaveBeenCalled();
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toEqual({ success: true });
  });

  it("still responds success if Socket.IO isn't up yet (best-effort, not fatal)", async () => {
    (getIoInstance as any).mockImplementationOnce(() => {
      throw new Error("Socket.IO instance not initialized yet!");
    });

    const { c, calls } = mockContext({ socketId: SOCKET_ID });
    await expect(markSelfOffline(c)).resolves.toBeDefined();
    expect(calls[0].status).toBe(200);
  });
});
