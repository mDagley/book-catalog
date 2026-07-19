import PerspT from "perspective-transform";

export interface Point {
  x: number;
  y: number;
}

// A structural stand-in for the browser's ImageData -- deliberately not
// using the real ImageData type/constructor here so this module has zero
// DOM dependency and can be unit-tested directly in Vitest's Node
// environment (which has no ImageData global). Callers convert to/from a
// real ImageData at the DOM boundary (see QuadCropEditor.tsx).
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// Given the 4 corners of a traced quadrilateral, in order [topLeft,
// topRight, bottomRight, bottomLeft], computes the output rectangle's
// dimensions as the average of each pair of opposite edges -- avoids
// arbitrarily stretching/squashing the result to match just one edge (a
// quad photographed at a slight angle has, e.g., a shorter top edge than
// bottom; averaging keeps the output an unbiased size rather than picking
// one side arbitrarily).
export function computeOutputDimensions(
  corners: [Point, Point, Point, Point],
): { width: number; height: number } {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const topWidth = dist(topLeft, topRight);
  const bottomWidth = dist(bottomLeft, bottomRight);
  const leftHeight = dist(topLeft, bottomLeft);
  const rightHeight = dist(topRight, bottomRight);
  return {
    width: Math.max(1, Math.round((topWidth + bottomWidth) / 2)),
    height: Math.max(1, Math.round((leftHeight + rightHeight) / 2)),
  };
}

function cornersToFlatArray(corners: [Point, Point, Point, Point]): number[] {
  return corners.flatMap((p) => [p.x, p.y]);
}

// Bilinear-samples `source` at a (possibly fractional) coordinate.
// Coordinates outside the source bounds are CLAMPED to the nearest edge
// pixel rather than rejected -- this is standard edge-clamp sampling, and
// it also absorbs tiny floating-point overshoot from the homography's
// inverse mapping right at the image boundary (e.g. -1e-15 instead of an
// exact 0), which would otherwise be misread as genuinely out-of-bounds
// for a point that's mathematically ON the boundary.
function sampleBilinear(source: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const { width, height, data } = source;
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = clampedX - x0;
  const fy = clampedY - y0;

  const at = (px: number, py: number, channel: number) => data[(py * width + px) * 4 + channel];

  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    const top = at(x0, y0, channel) * (1 - fx) + at(x1, y0, channel) * fx;
    const bottom = at(x0, y1, channel) * (1 - fx) + at(x1, y1, channel) * fx;
    result[channel] = top * (1 - fy) + bottom * fy;
  }
  return result;
}

// Warps `source` so the quadrilateral traced by `corners` (in source pixel
// coordinates, order [topLeft, topRight, bottomRight, bottomLeft]) becomes
// a clean axis-aligned rectangle of the given output dimensions.
//
// Iterates OUTPUT pixels and inverse-maps each one back into source space
// (rather than iterating source pixels and forward-mapping them into the
// output) specifically to avoid holes: a forward mapping can leave some
// output pixels unwritten wherever the source-to-destination mapping is
// less than 1:1 dense. Inverse mapping guarantees every output pixel gets
// exactly one sampled value. Runs once per capture (not real-time), so an
// O(outputWidth * outputHeight) per-pixel loop in plain JS is fine.
export function warpQuadrilateral(
  source: PixelBuffer,
  corners: [Point, Point, Point, Point],
  outputWidth: number,
  outputHeight: number,
): PixelBuffer {
  const srcFlat = cornersToFlatArray(corners);
  const dstFlat = [0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight];
  const perspT = PerspT(srcFlat, dstFlat);

  const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y++) {
    for (let x = 0; x < outputWidth; x++) {
      const [srcX, srcY] = perspT.transformInverse(x, y);
      const [r, g, b, a] = sampleBilinear(source, srcX, srcY);
      const i = (y * outputWidth + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width: outputWidth, height: outputHeight, data };
}
