// The root family's background-process list (ADR-0045 §3). It lives on the
// family root with `fork: "initial"`, so forks never carry a second copy and
// every read or write in the family can use the root id.
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import type { ProcessInfo } from "@pinomad/protocol/processes.ts";

export interface ProcessesDocValue extends JsonObject {
  processes: ProcessInfo[];
}

export const ProcessDoc = defineDoc<ProcessesDocValue>({
  kind: "pinomad.processes",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ processes: [] }),
  checkpointWhen: () => false,
});
