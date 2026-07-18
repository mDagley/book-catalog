import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveCoverUpdate } from "@/lib/copyCovers";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const originalFetch = global.fetch;
const savedPaths: string[] = [];

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
});

// 1x1 transparent PNG, same fixture coverStorage.test.ts uses.
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("resolveCoverUpdate", () => {
  it("returns the current cover path unchanged when nothing is selected", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "", selectedCoverSource: undefined },
      "existing-cover.png",
    );
    expect(result).toEqual({ coverImagePath: "existing-cover.png" });
  });

  it("returns null unchanged when nothing is selected and there was no existing cover", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "", selectedCoverSource: undefined },
      null,
    );
    expect(result).toEqual({ coverImagePath: null });
  });

  it("saves a new data URL cover when there was no existing cover", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: ONE_PX_PNG_DATA_URL, selectedCoverSource: "dataUrl" },
      null,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);
    expect(result.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
  });

  it("saves a new cover and deletes the old file when replacing an existing data URL cover", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);

    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: ONE_PX_PNG_DATA_URL, selectedCoverSource: "dataUrl" },
      oldPath,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);

    expect(result.coverImagePath).not.toBe(oldPath);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error for an invalid data URL without deleting the existing cover", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedPaths.push(oldPath);

    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "not-a-data-url", selectedCoverSource: "dataUrl" },
      oldPath,
    );

    expect(result).toEqual({ error: "Invalid cover image" });
    const stillThere = await readFile(path.join(uploadsDir, oldPath));
    expect(stillThere.length).toBeGreaterThan(0);
  });

  it("saves a new cover from a URL via saveCoverFromUrl", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from(ONE_PX_PNG_DATA_URL.split(",")[1], "base64"),
    } as unknown as Response);

    const result = await resolveCoverUpdate(
      {
        selectedCoverDataUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg",
        selectedCoverSource: "url",
      },
      null,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);
  });

  it("saves a new cover and deletes the old file when replacing an existing cover via URL", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from(ONE_PX_PNG_DATA_URL.split(",")[1], "base64"),
    } as unknown as Response);

    const result = await resolveCoverUpdate(
      {
        selectedCoverDataUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg",
        selectedCoverSource: "url",
      },
      oldPath,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);

    expect(result.coverImagePath).not.toBe(oldPath);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error when saveCoverFromUrl fails, without touching the existing cover", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedPaths.push(oldPath);
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    const result = await resolveCoverUpdate(
      {
        selectedCoverDataUrl: "https://covers.openlibrary.org/b/id/99999-M.jpg",
        selectedCoverSource: "url",
      },
      oldPath,
    );

    expect(result).toEqual({ error: "Failed to fetch cover image" });
    const stillThere = await readFile(path.join(uploadsDir, oldPath));
    expect(stillThere.length).toBeGreaterThan(0);
  });

  it("returns an error for an unrecognized cover source", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "something", selectedCoverSource: "bogus" },
      null,
    );
    expect(result).toEqual({ error: "Invalid cover selection" });
  });
});
