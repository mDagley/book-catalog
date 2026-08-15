"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { viewModeCookieName, type ViewMode, type ViewModeView } from "@/lib/viewMode";

const VIEW_PATHS: Record<ViewModeView, string> = {
  books: "/books",
  home: "/",
};

export async function setViewMode(view: ViewModeView, mode: ViewMode): Promise<void> {
  const store = await cookies();
  store.set(viewModeCookieName(view), mode, {
    // A single-user personal app has no session boundary this should
    // expire at -- effectively "remember until they change it again".
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  revalidatePath(VIEW_PATHS[view]);
}
