import { describe, it, expect, vi, afterEach } from "vitest";
import { sendPriceDropDigest } from "@/lib/emailDigest";
import type { PriceDrop } from "@/lib/priceTracking";

const originalFetch = global.fetch;
const originalKey = process.env.RESEND_API_KEY;
const originalTo = process.env.PRICE_ALERT_EMAIL;

afterEach(() => {
  global.fetch = originalFetch;
  // Assigning `undefined` back would set the string "undefined" (process.env
  // values are always strings), leaking a truthy value into later tests --
  // delete instead when it was never set.
  if (originalKey === undefined) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = originalKey;
  }
  if (originalTo === undefined) {
    delete process.env.PRICE_ALERT_EMAIL;
  } else {
    process.env.PRICE_ALERT_EMAIL = originalTo;
  }
  vi.restoreAllMocks();
});

const SAMPLE_DROPS: PriceDrop[] = [
  { tbrItemId: "1", tbrItemTitle: "The Way of Kings", retailer: "librofm", previousPrice: 52.49, newPrice: 39.99 },
];

describe("sendPriceDropDigest", () => {
  it("sends one email via the Resend API when there are drops", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "abc" }) } as Response);

    await sendPriceDropDigest(SAMPLE_DROPS);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init!.body as string);
    expect(body.to).toEqual(["me@example.com"]);
    expect(body.html).toContain("The Way of Kings");
    expect(body.html).toContain("52.49");
    expect(body.html).toContain("39.99");
  });

  it("HTML-escapes book titles and retailer names in the digest body", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "abc" }) } as Response);

    const maliciousDrops: PriceDrop[] = [
      {
        tbrItemId: "2",
        tbrItemTitle: `<script>alert("xss")</script>`,
        retailer: "Tom & Jerry's <Books>",
        previousPrice: 19.99,
        newPrice: 9.99,
      },
    ];

    await sendPriceDropDigest(maliciousDrops);

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.html).not.toContain("<script>alert(\"xss\")</script>");
    expect(body.html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(body.html).toContain("Tom &amp; Jerry's &lt;Books&gt;");
  });

  it("does nothing when there are no drops", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn();

    await sendPriceDropDigest([]);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("logs and does not throw when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendPriceDropDigest(SAMPLE_DROPS)).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("catches and logs a send failure instead of throwing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.PRICE_ALERT_EMAIL = "me@example.com";
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendPriceDropDigest(SAMPLE_DROPS)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
