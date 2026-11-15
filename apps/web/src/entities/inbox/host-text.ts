// Two Inbox facts the web reads out of the host's text, because the
// transcript derivation does not carry them yet. Temporary: once
// packages/client (and pinomad-core) expose them as structured data, these go
// and the components keep their props. The formats are the host's, in
// apps/host/src/inbox.ts (`inbox_submit`'s result and `eventBlocks`).

/** The task an `inbox_submit` call created or added to, from its result text. */
export function submittedTaskId(output: string | undefined): string | undefined {
  return output?.match(/^(?:Created task|Added to task) ([0-9a-f-]+)[:.]/)?.[1];
}

const unescape = (text: string): string =>
  text.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** The ids of the events a worker message delivered, in order; none in a message the user typed. */
export function deliveredEventIds(text: string): string[] {
  return [...text.matchAll(/<event source="[^"]*" id="([^"]*)"/g)].map((match) => unescape(match[1]!));
}
