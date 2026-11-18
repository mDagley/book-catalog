// A fetch() that gives up after `timeoutMs` instead of waiting forever.
//
// Used by the ABS and Goodreads syncs. Without a timeout, a slow or
// unresponsive upstream makes the sync hang until the hosting reverse proxy
// gives up and returns its own HTML error page -- which the "Refresh now"
// button can only report as a generic failure. With one, the sync fails
// fast with a message that names the service that didn't answer.
//
// The signal also covers reading the body (response.json()/text()), so a
// response that stalls mid-download is caught too.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  serviceName: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`${serviceName} didn't respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
