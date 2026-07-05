import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { verifyPassword } from "@/lib/auth";

describe("verifyPassword", () => {
  it("returns true when the password matches the hash", async () => {
    const hash = await bcrypt.hash("correct-horse-battery-staple", 10);
    const result = await verifyPassword("correct-horse-battery-staple", hash);
    expect(result).toBe(true);
  });

  it("returns false when the password does not match the hash", async () => {
    const hash = await bcrypt.hash("correct-horse-battery-staple", 10);
    const result = await verifyPassword("wrong-password", hash);
    expect(result).toBe(false);
  });
});
