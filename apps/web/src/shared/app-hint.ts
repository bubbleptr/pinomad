import { OFFICIAL_SERVER_ORIGIN } from "./official-server.ts";

/**
 * The `pinomad_app` cookie (value `1`): the "this browser uses the web app"
 * marker that pinomad.si reads before it paints (#354). It lives on the apex
 * domain because the app runs on a subdomain, and it carries no credential: a
 * forged or stale one only sends a visitor to the app's own sign-in screen. A
 * self-hosted copy must never write into someone else's parent domain, so only
 * the official app host writes.
 */
export const APP_HINT_COOKIE_NAME = "pinomad_app";
/** Presence is the whole meaning; the site checks the name and value pair. */
const APP_HINT_COOKIE_VALUE = "1";
/** 30 days, refreshed each time the app opens. */
export const APP_HINT_MAX_AGE = 2_592_000;

const OFFICIAL_APP_HOST = new URL(OFFICIAL_SERVER_ORIGIN).hostname;

/**
 * The `pinomad_app=1` assignment for this page, or undefined where the page
 * must not write at all: 30 days while in use, `Max-Age=0` to clear.
 */
export function appHintCookie(hostname: string, inUse: boolean): string | undefined {
  if (hostname !== OFFICIAL_APP_HOST) return undefined;
  const maxAge = inUse ? APP_HINT_MAX_AGE : 0;
  return `${APP_HINT_COOKIE_NAME}=${APP_HINT_COOKIE_VALUE}; Domain=pinomad.si; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`;
}

/** Refresh or clear the marker for this browser; a no-op away from the official app host. */
export function syncAppHint(
  hostname: string,
  inUse: boolean,
  jar: Pick<Document, "cookie"> = document,
): void {
  const assignment = appHintCookie(hostname, inUse);
  if (assignment !== undefined) jar.cookie = assignment;
}
