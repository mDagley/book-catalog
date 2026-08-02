import { cookies } from "next/headers";

export type Density = "comfortable" | "compact";
export type DensityView = "books" | "home";

// Per the design spec: /books defaults to compact (browsing a large
// library), / defaults to comfortable (confirming a single edition, where
// the larger cover is doing real work).
const DEFAULTS: Record<DensityView, Density> = {
  books: "compact",
  home: "comfortable",
};

export function densityCookieName(view: DensityView): string {
  return `density-${view}`;
}

// Cookie rather than localStorage: this app is server-component-first, so
// reading the cookie during render means the correct density is in the
// FIRST HTML response -- no hydration flash, no client state library.
export async function getDensity(view: DensityView): Promise<Density> {
  const store = await cookies();
  const value = store.get(densityCookieName(view))?.value;
  return value === "comfortable" || value === "compact" ? value : DEFAULTS[view];
}
