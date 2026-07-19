import { describe, it, expect } from "vitest";
import { computeOutputDimensions, warpQuadrilateral, type Point, type PixelBuffer } from "./perspectiveCrop";

describe("computeOutputDimensions", () => {
  it("matches a perfect axis-aligned rectangle's width/height exactly", () => {
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(computeOutputDimensions(corners)).toEqual({ width: 100, height: 50 });
  });

  it("averages opposite edge lengths for a non-rectangular quadrilateral", () => {
    // Top edge 80 wide (horizontal), bottom edge 100 wide (horizontal) --
    // width should average to 90. Left edge is vertical (length exactly
    // 50); right edge is slanted (hypot(20, 50)) -- expected height below
    // is the average of those two, computed with the same Math.hypot the
    // implementation uses, then rounded, so this test doesn't depend on
    // hand-computing an irrational square root.
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    const expectedHeight = Math.round((50 + Math.hypot(20, 50)) / 2);
    expect(computeOutputDimensions(corners)).toEqual({ width: 90, height: expectedHeight });
  });
});

describe("warpQuadrilateral", () => {
  function makePixelBuffer(
    width: number,
    height: number,
    colorAt: (x: number, y: number) => [number, number, number, number],
  ): PixelBuffer {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b, a] = colorAt(x, y);
        const i = (y * width + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
    }
    return { width, height, data };
  }

  function readPixel(buffer: PixelBuffer, x: number, y: number): [number, number, number, number] {
    const i = (y * buffer.width + x) * 4;
    return [buffer.data[i], buffer.data[i + 1], buffer.data[i + 2], buffer.data[i + 3]];
  }

  it("reproduces the source image when the traced quadrilateral is the whole image (identity transform)", () => {
    const width = 8;
    const height = 8;
    const source = makePixelBuffer(width, height, (x, y) => {
      const isRight = x >= width / 2;
      const isBottom = y >= height / 2;
      if (!isRight && !isBottom) return [255, 0, 0, 255];
      if (isRight && !isBottom) return [0, 255, 0, 255];
      if (!isRight && isBottom) return [0, 0, 255, 255];
      return [255, 255, 0, 255];
    });
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];

    const result = warpQuadrilateral(source, corners, width, height);

    // Sample well inside each quadrant (2+ pixels from any edge or the
    // quadrant boundary) so floating-point rounding in the homography's
    // inverse mapping can't blend across a color boundary, and use loose
    // thresholds rather than exact equality for the same reason.
    const [r1, g1, b1] = readPixel(result, 1, 1);
    expect(r1).toBeGreaterThan(200);
    expect(g1).toBeLessThan(30);
    expect(b1).toBeLessThan(30);

    const [r2, g2, b2] = readPixel(result, 6, 1);
    expect(g2).toBeGreaterThan(200);
    expect(r2).toBeLessThan(30);
    expect(b2).toBeLessThan(30);

    const [r3, g3, b3] = readPixel(result, 1, 6);
    expect(b3).toBeGreaterThan(200);
    expect(r3).toBeLessThan(30);
    expect(g3).toBeLessThan(30);

    const [r4, g4, b4] = readPixel(result, 6, 6);
    expect(r4).toBeGreaterThan(200);
    expect(g4).toBeGreaterThan(200);
    expect(b4).toBeLessThan(30);
  });

  it("crops a sub-rectangle of the source without distortion when the traced corners are axis-aligned", () => {
    // 4x4 source: left half red, right half green. Tracing just the
    // left-half sub-rectangle (columns 0-1) at 1:1 output size should
    // reproduce exactly that region, cropping out the green half entirely.
    const width = 4;
    const height = 4;
    const source = makePixelBuffer(width, height, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const corners: [Point, Point, Point, Point] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];

    const result = warpQuadrilateral(source, corners, 2, 4);

    expect(result.width).toBe(2);
    expect(result.height).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) {
        const [r, g] = readPixel(result, x, y);
        expect(r).toBeGreaterThan(200);
        expect(g).toBeLessThan(30);
      }
    }
  });
});
