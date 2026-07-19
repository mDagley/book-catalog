declare module "perspective-transform" {
  interface PerspectiveTransform {
    transform(x: number, y: number): [number, number];
    transformInverse(x: number, y: number): [number, number];
    srcPts: number[];
    dstPts: number[];
    coeffs: number[];
    coeffsInv: number[];
  }

  function PerspT(srcCorners: number[], dstCorners: number[]): PerspectiveTransform;

  export = PerspT;
}
