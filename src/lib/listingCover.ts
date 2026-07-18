interface CoverSource {
  coverImagePath: string | null;
}

export interface CoverableBook {
  copies: CoverSource[];
  ebookCopies: CoverSource[];
  audiobookCopies: CoverSource[];
}

// Picks which cover represents a book row in a listing: physical copies
// first (in array order), then ebook copies, then audiobook copies -- the
// first non-null coverImagePath found wins. Applies regardless of any
// active ownership-type filter on the caller's side; this only answers
// "which cover identifies this book," not "which cover matches the
// currently filtered view."
export function resolveListingCover(book: CoverableBook): string | null {
  for (const list of [book.copies, book.ebookCopies, book.audiobookCopies]) {
    const found = list.find((c) => c.coverImagePath !== null);
    if (found) return found.coverImagePath;
  }
  return null;
}
