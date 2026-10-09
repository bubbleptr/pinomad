import { hostAddress } from "./host-address.ts";

/** The vite dev server's fixed port. */
export const DEV_WEB = "http://127.0.0.1:5199/";

/**
 * The loopback browser link carrying the token; safe to print on operator
 * demand. `base` is the page to load — the vite dev server by default, or the
 * host's own HTTP port when it serves the built client (service mode).
 */
export function webLink(url: string, token: string, base = DEV_WEB): string {
  const web = new URL(base);
  web.hash = new URLSearchParams({ token, url }).toString();
  return web.href;
}

/** The page a link should point at: live vite dev server first (HMR), then a host-served bundle, else vite's URL. */
export async function linkBase(url: string, answers200: (base: string) => Promise<boolean>): Promise<string> {
  const hostHttp = url.replace(/^ws/, "http");
  if (await answers200(DEV_WEB)) return DEV_WEB;
  if (await answers200(hostHttp)) return hostHttp;
  return DEV_WEB;
}

export async function main(argv: readonly string[]): Promise<void> {
  const { url, token } = await hostAddress(argv);
  const base = await linkBase(url, (probe) =>
    fetch(probe, { signal: AbortSignal.timeout(1000) }).then(
      (response) => response.status === 200,
      () => false,
    ),
  );
  // Deliberately requested by the operator, never emitted by the host's routine logs.
  console.log(webLink(url, token, base));
}

if (import.meta.main) await main(process.argv.slice(2));
