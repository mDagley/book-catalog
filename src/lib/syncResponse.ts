// Client-safe helpers for the "Refresh now" button (RefreshSyncButton).
//
// The sync routes always answer with JSON ({ success, error? }). If the
// response is anything else, something between the browser and the route
// broke -- typically the hosting reverse proxy timing the request out (an
// HTML 504 page) or the server crashing (an HTML/empty 500). Before this,
// the button called response.json() unconditionally, so every one of those
// cases surfaced as a SyntaxError and was misreported as "check your
// connection". These helpers turn each case into a specific message.

export type SyncOutcome =
  | { kind: "ok" }
  | { kind: "failed"; message: string }
  | { kind: "sessionExpired" };

export function describeHttpFailure(status: number): string {
  if (status === 504 || status === 524 || status === 408) {
    return `the server took too long to respond (HTTP ${status}) — the sync may still finish in the background`;
  }
  if (status === 502 || status === 503) {
    return `the server is unavailable or restarting (HTTP ${status})`;
  }
  if (status >= 500) return `server error (HTTP ${status})`;
  return `unexpected response (HTTP ${status})`;
}

export async function readSyncResponse(response: Response): Promise<SyncOutcome> {
  // An expired session makes middleware redirect to /login, whose HTML
  // comes back as a 200. fetch() follows the redirect transparently, but
  // response.redirected tells us it happened.
  if (response.redirected) return { kind: "sessionExpired" };

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { kind: "failed", message: describeHttpFailure(response.status) };
  }

  if (typeof data === "object" && data !== null && "success" in data) {
    const body = data as { success: unknown; error?: unknown };
    if (body.success === true) return { kind: "ok" };
    return {
      kind: "failed",
      message: typeof body.error === "string" && body.error ? body.error : describeHttpFailure(response.status),
    };
  }
  return { kind: "failed", message: describeHttpFailure(response.status) };
}

// Wraps the whole request so it never throws: a rejected fetch() (no
// response at all) is the only case that genuinely means the browser
// couldn't reach the server.
export async function runSync(url: string): Promise<SyncOutcome> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST" });
  } catch {
    return { kind: "failed", message: "couldn't reach the server — check your connection" };
  }
  return readSyncResponse(response);
}
