import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPriceTrackingButton } from "@/components/RunPriceTrackingButton";

// RunPriceTrackingButton is a client component that calls useRouter() for
// router.refresh() after a successful run -- renderToStaticMarkup has no
// App Router context to provide it, so useRouter throws unless mocked, the
// same reason RecomputeOwnershipButton (the sibling this was copied from)
// has no render test of its own.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("RunPriceTrackingButton", () => {
  it("renders a button labeled to run the price check", () => {
    const html = renderToStaticMarkup(<RunPriceTrackingButton />);
    expect(html).toContain("Run price check");
  });
});
