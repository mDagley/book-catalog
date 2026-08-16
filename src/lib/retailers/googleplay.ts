import type { RetailerAdapter, RetailerMatchResult } from "@/lib/retailers/types";

const API_BASE = "https://www.googleapis.com/books/v1/volumes";

interface GoogleBooksSaleInfo {
  saleability?: string;
  isEbook?: boolean;
  retailPrice?: { amount?: number };
  buyLink?: string;
}

interface GoogleBooksVolume {
  volumeInfo?: { title?: string; authors?: string[] };
  saleInfo?: GoogleBooksSaleInfo;
}

function apiKeyParam(): string {
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  return key ? `&key=${encodeURIComponent(key)}` : "";
}

async function search(title: string, author: string | null): Promise<RetailerMatchResult | null> {
  const q = author ? `intitle:${title} inauthor:${author}` : `intitle:${title}`;
  const url = `${API_BASE}?q=${encodeURIComponent(q)}&country=US${apiKeyParam()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Books search failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { items?: GoogleBooksVolume[] };
  const forSale = (data.items ?? []).find(
    (item) =>
      item.saleInfo?.saleability === "FOR_SALE" &&
      item.saleInfo?.isEbook === true &&
      item.saleInfo?.buyLink,
  );
  if (!forSale) return null;

  return {
    matchedTitle: forSale.volumeInfo?.title ?? title,
    matchedAuthor: forSale.volumeInfo?.authors?.join(", ") ?? null,
    productUrl: forSale.saleInfo!.buyLink!,
  };
}

async function fetchPrice(productUrl: string): Promise<number | null> {
  const id = new URL(productUrl).searchParams.get("id");
  if (!id) return null;

  const key = process.env.GOOGLE_BOOKS_API_KEY;
  const url = key
    ? `${API_BASE}/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`
    : `${API_BASE}/${encodeURIComponent(id)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Books volume fetch failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as GoogleBooksVolume;
  if (data.saleInfo?.saleability !== "FOR_SALE" || data.saleInfo?.isEbook !== true) return null;
  const amount = data.saleInfo?.retailPrice?.amount;
  return typeof amount === "number" ? amount : null;
}

export const googleplayAdapter: RetailerAdapter = {
  id: "googleplay",
  search,
  fetchPrice,
};
