import { describe, it, expect, vi, afterEach } from "vitest";
import { readSyncResponse, runSync, describeHttpFailure } from "@/lib/syncResponse";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function htmlResponse(status: number): Response {
  return new Response("<html><body>Gateway Timeout</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readSyncResponse", () => {
  it("reports success from the route's JSON", async () => {
    expect(await readSyncResponse(jsonResponse({ success: true, synced: 3 }))).toEqual({ kind: "ok" });
  });

  it("passes through the route's own error message", async () => {
    const outcome = await readSyncResponse(
      jsonResponse({ success: false, error: "Audiobookshelf didn't respond within 30s" }, 502),
    );
    expect(outcome).toEqual({ kind: "failed", message: "Audiobookshelf didn't respond within 30s" });
  });

  it("turns a proxy's HTML 504 page into a timeout message instead of throwing", async () => {
    const outcome = await readSyncResponse(htmlResponse(504));
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("took too long");
    expect(outcome.kind === "failed" && outcome.message).toContain("504");
  });

  it("turns an empty 500 into a server-error message", async () => {
    const outcome = await readSyncResponse(new Response("", { status: 500 }));
    expect(outcome).toEqual({ kind: "failed", message: "server error (HTTP 500)" });
  });

  it("detects an expired-session redirect before parsing the body", async () => {
    const response = htmlResponse(200);
    Object.defineProperty(response, "redirected", { value: true });
    expect(await readSyncResponse(response)).toEqual({ kind: "sessionExpired" });
  });
});

describe("runSync", () => {
  it("only blames the connection when fetch itself rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const outcome = await runSync("/api/sync/abs");
    expect(outcome.kind === "failed" && outcome.message).toContain("check your connection");
  });

  it("never throws on a non-JSON reply", async () => {
    global.fetch = vi.fn().mockResolvedValue(htmlResponse(502));
    await expect(runSync("/api/sync/abs")).resolves.toEqual({
      kind: "failed",
      message: describeHttpFailure(502),
    });
  });
});
