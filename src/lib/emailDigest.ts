import type { PriceDrop } from "@/lib/priceTracking";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(drops: PriceDrop[]): string {
  const rows = drops
    .map(
      (d) =>
        `<li><strong>${escapeHtml(d.tbrItemTitle)}</strong> (${escapeHtml(d.retailer)}): $${d.previousPrice.toFixed(2)} → $${d.newPrice.toFixed(2)}</li>`,
    )
    .join("");
  return `<p>${drops.length} TBR book${drops.length === 1 ? "" : "s"} dropped in price:</p><ul>${rows}</ul>`;
}

export async function sendPriceDropDigest(drops: PriceDrop[]): Promise<void> {
  if (drops.length === 0) return;

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.PRICE_ALERT_EMAIL;
  if (!apiKey || !to) {
    console.error("Skipping price-drop digest email: RESEND_API_KEY/PRICE_ALERT_EMAIL not set");
    return;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "TBR Price Tracker <onboarding@resend.dev>",
        to: [to],
        subject: `${drops.length} TBR price drop${drops.length === 1 ? "" : "s"}`,
        html: renderHtml(drops),
      }),
    });
    if (!response.ok) {
      console.error(`Resend send failed: HTTP ${response.status}`);
    }
  } catch (err) {
    console.error("Resend send failed:", err);
  }
}
