import { cookies } from "next/headers";

export type ViewMode = "grid" | "list";
export type ViewModeView = "books" | "home";

// /books defaults to grid (browsing a large library benefits from covers,
// matching the reference site's default); / defaults to list (a "do I
// already own this?" lookup is usually 1-3 results, and the existing
// comfortable list card already shows a large cover per result).
const DEFAULTS: Record<ViewModeView, ViewMode> = {
  books: "grid",
  home: "list",
};

export function viewModeCookieName(view: ViewModeView): string {
  return `view-${view}`;
}

// Cookie rather than localStorage, exactly like density.ts: this app is
// server-component-first, so reading the cookie during render means the
// correct view is in the FIRST HTML response -- no hydration flash.
export async function getViewMode(view: ViewModeView): Promise<ViewMode> {
  const store = await cookies();
  const value = store.get(viewModeCookieName(view))?.value;
  return value === "grid" || value === "list" ? value : DEFAULTS[view];
}
