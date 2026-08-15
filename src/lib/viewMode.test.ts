import { describe, it, expect, beforeEach, vi } from "vitest";

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  }),
}));

import { getViewMode, viewModeCookieName } from "@/lib/viewMode";

beforeEach(() => {
  cookieStore.clear();
});

describe("getViewMode", () => {
  it("defaults to grid for the books view when no cookie is set", async () => {
    expect(await getViewMode("books")).toBe("grid");
  });

  it("defaults to list for the home view when no cookie is set", async () => {
    expect(await getViewMode("home")).toBe("list");
  });

  it("honors a stored cookie value over the default", async () => {
    cookieStore.set(viewModeCookieName("books"), "list");
    expect(await getViewMode("books")).toBe("list");
  });

  it("falls back to the default for a garbage cookie value", async () => {
    cookieStore.set(viewModeCookieName("home"), "bogus");
    expect(await getViewMode("home")).toBe("list");
  });

  it("uses a distinct cookie name per view", () => {
    expect(viewModeCookieName("books")).not.toBe(viewModeCookieName("home"));
  });
});
