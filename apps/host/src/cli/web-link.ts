import { hostAddress } from "./host-address.ts";

/** The loopback browser link carrying the token; safe to print on operator demand. */
export function webLink(url: string, token: string): string {
  const web = new URL("http://127.0.0.1:5199/");
  web.hash = new URLSearchParams({ token, url }).toString();
  return web.href;
}

if (import.meta.main) {
  const { url, token } = await hostAddress(process.argv.slice(2));
  // Deliberately requested by the operator, never emitted by the host's routine logs.
  console.log(webLink(url, token));
}
