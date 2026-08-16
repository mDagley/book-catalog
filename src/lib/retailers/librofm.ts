import * as cheerio from "cheerio";
import type { RetailerAdapter, RetailerMatchResult } from "@/lib/retailers/types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// The daily cron job that calls these adapters runs with { noOverlap: true }
// -- a hung fetch with no timeout would block that job indefinitely and
// prevent every future run, not just fail this one item.
const FETCH_TIMEOUT_MS = 15_000;

async function search(title: string, author: string | null): Promise<RetailerMatchResult | null> {
  const query = author ? `${title} ${author}` : title;
  const url = `https://libro.fm/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`libro.fm search failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const first = $(".book-grid-item").first();
  const link = first.find("a.book").first();
  const href = link.attr("href");
  if (!href) return null;

  const matchedTitle = first.find(".book-info .title").first().text().trim();
  const matchedAuthorText = first.find(".book-info .author").first().text().trim();

  return {
    matchedTitle,
    matchedAuthor: matchedAuthorText || null,
    productUrl: new URL(href, "https://libro.fm").toString(),
  };
}

interface LibroFmJsonLd {
  offers?: { highPrice?: string };
}

async function fetchPrice(productUrl: string): Promise<number | null> {
  const response = await fetch(productUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`libro.fm product fetch failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const scriptText = $('script[type="application/ld+json"]').first().html();
  if (!scriptText) return null;

  let data: LibroFmJsonLd;
  try {
    data = JSON.parse(scriptText);
  } catch {
    return null;
  }

  const highPrice = data.offers?.highPrice;
  if (!highPrice) return null;
  const price = Number(highPrice);
  return Number.isFinite(price) ? price : null;
}

export const librofmAdapter: RetailerAdapter = {
  id: "librofm",
  search,
  fetchPrice,
};
