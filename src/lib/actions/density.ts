"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { densityCookieName, type Density, type DensityView } from "@/lib/density";

const VIEW_PATHS: Record<DensityView, string> = {
  books: "/books",
  home: "/",
};

export async function setDensity(view: DensityView, density: Density): Promise<void> {
  const store = await cookies();
  store.set(densityCookieName(view), density, {
    // A single-user personal app has no session boundary this should
    // expire at -- effectively "remember until they change it again".
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  revalidatePath(VIEW_PATHS[view]);
}
