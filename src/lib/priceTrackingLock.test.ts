import { describe, it, expect, afterEach } from "vitest";
import { tryAcquirePriceTrackingLock, releasePriceTrackingLock } from "@/lib/priceTrackingLock";

afterEach(() => {
  releasePriceTrackingLock();
});

describe("priceTrackingLock", () => {
  it("acquires the lock when free", () => {
    expect(tryAcquirePriceTrackingLock()).toBe(true);
  });

  it("refuses a second acquire while already held", () => {
    expect(tryAcquirePriceTrackingLock()).toBe(true);
    expect(tryAcquirePriceTrackingLock()).toBe(false);
  });

  it("allows acquiring again after release", () => {
    expect(tryAcquirePriceTrackingLock()).toBe(true);
    releasePriceTrackingLock();
    expect(tryAcquirePriceTrackingLock()).toBe(true);
  });

  it("release is a no-op when the lock isn't held", () => {
    expect(() => releasePriceTrackingLock()).not.toThrow();
    expect(tryAcquirePriceTrackingLock()).toBe(true);
  });
});
