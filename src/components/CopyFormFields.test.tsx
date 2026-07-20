import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyFormFields } from "@/components/CopyFormFields";

describe("CopyFormFields", () => {
  it("uses unprefixed ids by default, matching the single-instance-per-page callers", () => {
    const html = renderToStaticMarkup(<CopyFormFields />);
    expect(html).toContain('id="format"');
    expect(html).toContain('for="format"');
    expect(html).toContain('id="publisher"');
    expect(html).toContain('id="publishYear"');
    expect(html).toContain('id="specialNotes"');
  });

  it("prefixes every id/htmlFor pair when idPrefix is given, so two instances never collide", () => {
    const htmlA = renderToStaticMarkup(<CopyFormFields idPrefix="copy-a" />);
    const htmlB = renderToStaticMarkup(<CopyFormFields idPrefix="copy-b" />);

    for (const field of ["format", "publisher", "publishYear", "specialNotes"]) {
      expect(htmlA).toContain(`id="copy-a-${field}"`);
      expect(htmlA).toContain(`for="copy-a-${field}"`);
      expect(htmlB).toContain(`id="copy-b-${field}"`);
      // The two instances must not share a single id for the same field.
      expect(htmlA).not.toContain(`id="copy-b-${field}"`);
    }
  });
});
