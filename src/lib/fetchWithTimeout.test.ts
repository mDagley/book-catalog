import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

// A fetch that never resolves on its own and only settles when its abort
// signal fires -- i.e. an upstream that has stopped answering.
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  });
}

describe("fetchWithTimeout", () => {
  it("gives up on an unresponsive server with a message naming the service", async () => {
    global.fetch = hangingFetch() as unknown as typeof fetch;
    await expect(fetchWithTimeout("https://abs.example/api/libraries", {}, 50, "Audiobookshelf")).rejects.toThrow(
      "Audiobookshelf didn't respond within 0s",
    );
  });

  it("passes headers through and returns the response when the server answers", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("ok"));
    global.fetch = mock;
    const response = await fetchWithTimeout("https://x.example", { headers: { A: "b" } }, 1000, "X");
    expect(await response.text()).toBe("ok");
    expect(mock.mock.calls[0][1].headers).toEqual({ A: "b" });
    expect(mock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("rethrows non-timeout errors unchanged", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchWithTimeout("https://x.example", {}, 1000, "X")).rejects.toThrow("fetch failed");
  });
});
