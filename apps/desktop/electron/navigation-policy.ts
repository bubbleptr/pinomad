/**
 * The window is a shell for the bundled UI, not a browser: pages it did not
 * build never load inside it. Only http(s) escapes — handed to the system
 * default browser — so chat markdown links open somewhere readable.
 */

/** window.open / target="_blank": http(s) → external browser, everything else dropped. */
export function windowOpenAction(url: string): "external" | "deny" {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? "external" : "deny";
  } catch {
    return "deny";
  }
}

/** In-window navigation: only staying on the app origin (e.g. hash hops) is allowed. */
export function navigateAwayAction(currentUrl: string, targetUrl: string): "allow" | "external" | "deny" {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    // Compare scheme+authority, not .origin: Node's URL gives non-special
    // schemes (app:, file:) the opaque origin "null", which would equate them.
    if (target.protocol === current.protocol && target.host === current.host) return "allow";
    return windowOpenAction(targetUrl) === "external" ? "external" : "deny";
  } catch {
    return "deny";
  }
}
