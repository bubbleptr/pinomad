// The conversation's name when one was set: `source` is "auto" for the title
// generated after the first successful run, "manual" for a rename. Either way
// it is final — once present the host never regenerates and the summary serves
// it over the first-message fallback. `fork: "initial"` so a fork names itself,
// never inheriting its parent's.
import { defineDoc } from "@earendil-works/pi-durable";

export const TitleDoc = defineDoc<{ title?: string; source?: "auto" | "manual" }>({
  kind: "pinomad.title",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});
