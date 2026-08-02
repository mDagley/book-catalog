// Strips diacritics before the A-Z test so bucketing agrees with a
// locale-aware, base-letter-insensitive sort (an author like "Émile Zola"
// sorts among the E's -- it should bucket under "E", not fall through to
// "#" just because its first character isn't plain ASCII). Shared by
// /tbr's jump-nav (tbrGap.ts) and /books' jump-to-letter and startsWith
// filter (search.ts), so both pages agree on what "browsing alphabetically"
// means for a given title/author.
export function letterBucket(key: string): string {
  const normalized = key
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase();
  const firstChar = normalized.charAt(0);
  return /[A-Z]/.test(firstChar) ? firstChar : "#";
}

// "#" (the catch-all for non-letter first characters) always sorts last,
// after every real letter -- matches the jump-nav order both /tbr and
// /books use (A...Z, #).
export function sortLetters(letters: string[]): string[] {
  return [...letters].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
}
