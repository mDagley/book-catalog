import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deleteCoverImage, saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const savedPaths: string[] = [];

afterEach(async () => {
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
});

describe("saveCoverImage", () => {
  it("saves a base64 PNG data URL to disk and returns its relative path", async () => {
    // 1x1 transparent PNG
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const relPath = await saveCoverImage(dataUrl);
    savedPaths.push(relPath);

    expect(relPath).toMatch(/^[a-f0-9-]+\.png$/);
    const written = await readFile(path.join(uploadsDir, relPath));
    expect(written.length).toBeGreaterThan(0);
  });

  it("rejects a data URL with an unsupported mime type", async () => {
    const dataUrl = "data:text/plain;base64,aGVsbG8=";
    await expect(saveCoverImage(dataUrl)).rejects.toThrow(/unsupported image type/i);
  });

  it("rejects a malformed data URL", async () => {
    await expect(saveCoverImage("not-a-data-url")).rejects.toThrow(/invalid data url/i);
  });

  it("rejects a payload larger than the max cover image size", async () => {
    // One byte over the 10MB limit, once base64-decoded.
    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const dataUrl = `data:image/png;base64,${oversizedBuffer.toString("base64")}`;

    await expect(saveCoverImage(dataUrl)).rejects.toThrow(/too large/i);
  });
});

describe("deleteCoverImage", () => {
  it("removes a file that exists", async () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const relPath = await saveCoverImage(dataUrl);

    await deleteCoverImage(relPath);

    await expect(readFile(path.join(uploadsDir, relPath))).rejects.toThrow();
  });

  it("does not throw when the file does not exist", async () => {
    await expect(deleteCoverImage("does-not-exist.png")).resolves.toBeUndefined();
  });

  it("does not delete a file outside the uploads directory given a path-traversal-shaped filename", async () => {
    const siblingDir = path.join(uploadsDir, "..", "cover-storage-test-sibling");
    const victimPath = path.join(siblingDir, "victim-file.png");
    await mkdir(siblingDir, { recursive: true });
    await writeFile(victimPath, "sensitive contents");

    try {
      await deleteCoverImage("../cover-storage-test-sibling/victim-file.png");

      const stillThere = await readFile(victimPath, "utf8");
      expect(stillThere).toBe("sensitive contents");
    } finally {
      await rm(siblingDir, { recursive: true, force: true });
    }
  });

  it("does not throw even when the underlying rm call fails", async () => {
    // A non-empty directory sitting at a name that matches SAFE_COVER_FILENAME.
    // fs.rm without { recursive: true } fails on this (EISDIR/ENOTEMPTY),
    // which is exactly the kind of non-ENOENT error { force: true } does NOT
    // suppress on its own.
    const dirName = "deadbeef-dead-beef-dead-beefdeadbeef.png";
    const dirPath = path.join(uploadsDir, dirName);
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, "nested-file"), "contents");

    try {
      await expect(deleteCoverImage(dirName)).resolves.toBeUndefined();
    } finally {
      await rm(dirPath, { recursive: true, force: true });
    }
  });
});
