import { describe, it, expect } from "vitest";
import { isAdminEmail, ADMIN_EMAIL } from "../src/lib/admin.ts";

describe("isAdminEmail", () => {
  it("accepts the configured admin email (case-insensitive)", () => {
    expect(isAdminEmail(ADMIN_EMAIL)).toBe(true);
    expect(isAdminEmail(ADMIN_EMAIL.toUpperCase())).toBe(true);
  });

  it("rejects other emails", () => {
    expect(isAdminEmail("other@example.com")).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});
