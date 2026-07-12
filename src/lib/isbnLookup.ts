export interface IsbnLookupResult {
  title: string | null;
  author: string | null;
  publisher: string | null;
  publishYear: number | null;
  coverUrl: string | null;
}

const EMPTY_RESULT: IsbnLookupResult = {
  title: null,
  author: null,
  publisher: null,
  publishYear: null,
  coverUrl: null,
};

export async function lookupIsbn(isbn: string): Promise<IsbnLookupResult> {
  try {
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(
      isbn,
    )}&format=json&jscmd=data`;
    const response = await fetch(url);
    if (!response.ok) {
      return EMPTY_RESULT;
    }

    const data = await response.json();
    const entry = data[`ISBN:${isbn}`];
    if (!entry) {
      return EMPTY_RESULT;
    }

    const yearMatch = /\d{4}/.exec(entry.publish_date ?? "");

    return {
      title: entry.title ?? null,
      author: entry.authors?.[0]?.name ?? null,
      publisher: entry.publishers?.[0]?.name ?? null,
      publishYear: yearMatch ? parseInt(yearMatch[0], 10) : null,
      coverUrl: entry.cover?.medium ?? entry.cover?.large ?? entry.cover?.small ?? null,
    };
  } catch {
    return EMPTY_RESULT;
  }
}
