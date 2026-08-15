import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhysicalBookIcon, EbookIcon, AudiobookIcon } from "@/components/FormatBadgeIcons";

describe("FormatBadgeIcons", () => {
  it("renders each icon as a presentational svg with no title by default", () => {
    for (const Icon of [PhysicalBookIcon, EbookIcon, AudiobookIcon]) {
      const html = renderToStaticMarkup(<Icon />);
      expect(html).toContain("<svg");
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("<title>");
    }
  });

  it("renders an accessible title and role=img when title is given", () => {
    const html = renderToStaticMarkup(<PhysicalBookIcon title="Physical copy" />);
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Physical copy</title>");
    expect(html).not.toContain('aria-hidden');
  });
});
