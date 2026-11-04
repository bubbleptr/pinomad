// `bun run desktop` loads the renderer from the Vite dev server, so its
// requests carry the dev origin instead of app://pinomad. The account server
// recognizes the desktop app only by app://pinomad (token login and CORS), so
// it answers dev sign-ins with 403 origin_mismatch and no CORS grant. In dev
// only, main.ts runs these two rewrites on every request: the dev renderer's
// requests go out as app://pinomad, and a grant made to app://pinomad comes
// back addressed to the dev origin so Chromium accepts the response.

const findHeader = (headers: Record<string, unknown>, name: string): string | undefined =>
  Object.keys(headers).find((key) => key.toLowerCase() === name);

export function devRequestHeaders(
  headers: Record<string, string>,
  devOrigin: string,
  appOrigin: string,
): Record<string, string> | undefined {
  const key = findHeader(headers, "origin");
  if (key === undefined || headers[key] !== devOrigin) return undefined;
  return { ...headers, [key]: appOrigin };
}

export function devResponseHeaders(
  headers: Record<string, string[]>,
  devOrigin: string,
  appOrigin: string,
): Record<string, string[]> | undefined {
  const key = findHeader(headers, "access-control-allow-origin");
  if (key === undefined || headers[key]?.[0] !== appOrigin) return undefined;
  return { ...headers, [key]: [devOrigin] };
}
