/**
 * How a provider sign-in on this page's server came back (ADR-0044 §5): the
 * server sends the browser to `/?oauth_error=<reason>`, `?oauth_pending=<id>`
 * or `?oauth_linked=<provider>`. Read once per page load and taken out of the
 * address at once, so a reload or a shared link doesn't replay it; App's own
 * replaceState calls keep `search`, so nothing else would drop them.
 */
export interface OAuthReturn {
  /** A refused or failed provider sign-in or link: the server's reason. */
  readonly error?: string;
  /** A sign-in that found no account yet: the id its page reads. */
  readonly pending?: string;
  /** A provider just linked to the signed-in account. */
  readonly linked?: string;
}

const PARAMS = ["oauth_error", "oauth_pending", "oauth_linked"] as const;
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** The return in `search`, keeping only well-formed values. */
export function parseOAuthReturn(search: string): OAuthReturn {
  const params = new URLSearchParams(search);
  const read = (name: (typeof PARAMS)[number]): string | undefined => {
    const value = params.get(name);
    return value !== null && TOKEN.test(value) ? value : undefined;
  };
  const error = read("oauth_error");
  const pending = read("oauth_pending");
  const linked = read("oauth_linked");
  return {
    ...(error === undefined ? {} : { error }),
    ...(pending === undefined ? {} : { pending }),
    ...(linked === undefined ? {} : { linked }),
  };
}

let taken: OAuthReturn | undefined;

/**
 * This page load's return, stripped from the address on the first call. Later
 * calls answer the same value until `clearOAuthReturn`.
 */
export function oauthReturn(): OAuthReturn {
  if (taken !== undefined) return taken;
  taken = typeof window === "undefined" ? {} : parseOAuthReturn(window.location.search);
  if (typeof window !== "undefined" && Object.keys(taken).length > 0) {
    const url = new URL(window.location.href);
    for (const name of PARAMS) url.searchParams.delete(name);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
  return taken;
}

/** Drops what was shown, so the next panel to mount doesn't say it again. */
export function clearOAuthReturn(part?: keyof OAuthReturn): void {
  const current = oauthReturn();
  if (part === undefined) taken = {};
  else {
    const { [part]: _shown, ...rest } = current;
    taken = rest;
  }
}

/** Tests: forget the cached value so the next call reads the address again. */
export function resetOAuthReturnForTests(): void {
  taken = undefined;
}
