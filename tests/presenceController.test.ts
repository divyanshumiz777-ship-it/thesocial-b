import { describe, it, expect, vi, beforeEach } from "vitest";

const disconnectSockets = vi.fn();
const inRoom = vi.fn(() => ({ disconnectSockets }));
vi.mock("../src/config/socket.ts", () => ({
  getIoInstance: vi.fn(() => ({ in: inRoom })),
}));

import { getIoInstance } from "../src/config/socket.ts";
import { markSelfOffline } from "../src/controllers/presenceController.ts";

const USER_ID = "507f1f77bcf86cd799439001";

function mockContext() {
  const calls: { body: any; status: number }[] = [];
  const c: any = {
    get: () => ({ id: USER_ID }),
    json: (body: any, status = 200) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("markSelfOffline", () => {
  it("forcibly disconnects the caller's own socket(s), not anyone else's", async () => {
    const { c, calls } = mockContext();
    await markSelfOffline(c);

    expect(inRoom).toHaveBeenCalledWith(USER_ID);
    // `true` (close the underlying connection) — a caller relying on this to
    // actually stop the ping-timeout fallback path from lingering, not just
    // drop the Socket.IO session while the transport stays open.
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect(calls[0].status).toBe(200);
    expect(calls[0].body).toEqual({ success: true });
  });

  it("still responds success if Socket.IO isn't up yet (best-effort, not fatal)", async () => {
    (getIoInstance as any).mockImplementationOnce(() => {
      throw new Error("Socket.IO instance not initialized yet!");
    });

    const { c, calls } = mockContext();
    await expect(markSelfOffline(c)).resolves.toBeDefined();
    expect(calls[0].status).toBe(200);
  });
});
