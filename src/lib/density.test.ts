import { describe, it, expect, beforeEach, vi } from "vitest";

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  }),
}));

import { getDensity, densityCookieName } from "@/lib/density";

beforeEach(() => {
  cookieStore.clear();
});

describe("getDensity", () => {
  it("defaults to compact for the books view when no cookie is set", async () => {
    expect(await getDensity("books")).toBe("compact");
  });

  it("defaults to comfortable for the home view when no cookie is set", async () => {
    expect(await getDensity("home")).toBe("comfortable");
  });

  it("honors a stored cookie value over the default", async () => {
    cookieStore.set(densityCookieName("books"), "comfortable");
    expect(await getDensity("books")).toBe("comfortable");
  });

  it("falls back to the default for a garbage cookie value", async () => {
    cookieStore.set(densityCookieName("home"), "bogus");
    expect(await getDensity("home")).toBe("comfortable");
  });

  it("uses a distinct cookie name per view", () => {
    expect(densityCookieName("books")).not.toBe(densityCookieName("home"));
  });
});
