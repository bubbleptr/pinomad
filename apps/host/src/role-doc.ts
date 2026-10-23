// The named agent a conversation currently runs as (ADR-0023, protocol 5.18):
// `name` is the role copied into `pi.agent`, `null` for no agent. The field is
// absent only on conversations created before this document existed; their
// summaries fall back to the top-level IndexEntry role. Rewindable + asOf so a
// fork copies the name at the fork entry, and the fork's init reads it once so
// the inherited copy materializes into a valued publication.
import { defineDoc } from "@earendil-works/pi-durable";

export const RoleDoc = defineDoc<{ name?: string | null }>({
  kind: "pinomad.role",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
});
