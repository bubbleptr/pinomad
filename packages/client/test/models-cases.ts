// Shared inputs for the model derivations: the vitest suite and
// packages/client/test/rust-vectors.ts both consume these tables.
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ConversationDefaults, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import type { ModelPick } from "../src/model.ts";

const model = (over: Partial<ModelSummary> = {}): ModelSummary => ({
  provider: "anthropic",
  modelId: "claude-x",
  name: "Claude X",
  contextWindow: 200_000,
  thinkingLevels: ["off"],
  ...over,
});

export const MODELS = {
  a: model({ provider: "anthropic", modelId: "claude-a", name: "Claude A", thinkingLevels: ["off", "medium", "high"] }),
  b: model({ provider: "openai", modelId: "gpt-b", name: "GPT B", thinkingLevels: ["off", "low", "medium"] }),
  c: model({ provider: "local", modelId: "llama-c", name: "Llama C" }),
};

export const MODEL_LIST = [MODELS.a, MODELS.b, MODELS.c];

export const CLAMP_CASES: { name: string; levels: ThinkingLevel[]; want: ThinkingLevel }[] = [
  { name: "supported", levels: ["off", "low", "high"], want: "high" },
  { name: "exact-off", levels: ["off"], want: "off" },
  { name: "clamps-down", levels: ["off", "low", "medium"], want: "xhigh" },
  { name: "skips-unsupported-middle", levels: ["off", "medium"], want: "high" },
  { name: "nothing-below", levels: ["high", "max"], want: "off" },
  { name: "empty-levels", levels: [], want: "medium" },
  { name: "unknown-want", levels: ["off", "low"], want: "turbo" as ThinkingLevel },
];

export const MODEL_LABEL_CASES: { name: string; models: ModelSummary[]; selected: ModelPick }[] = [
  { name: "reasoning", models: MODEL_LIST, selected: { model: { provider: "openai", modelId: "gpt-b" }, level: "low" } },
  { name: "non-reasoning", models: MODEL_LIST, selected: { model: { provider: "local", modelId: "llama-c" }, level: "off" } },
  { name: "unlisted-model", models: MODEL_LIST, selected: { model: { provider: "gone", modelId: "claude-z" }, level: "high" } },
  { name: "no-model", models: MODEL_LIST, selected: { level: "off" } },
  {
    name: "name-null",
    models: [model({ name: null as unknown as string })],
    selected: { model: { provider: "anthropic", modelId: "claude-x" }, level: "off" },
  },
];

export const FILTER_CASES: { name: string; models: ModelSummary[]; query: string }[] = [
  { name: "blank-query", models: MODEL_LIST, query: "  " },
  { name: "name-substring", models: MODEL_LIST, query: "claude" },
  { name: "case-insensitive", models: MODEL_LIST, query: "CLAUDE" },
  { name: "provider-modelid", models: MODEL_LIST, query: "openai/gpt-b" },
  { name: "no-match", models: MODEL_LIST, query: "zzz" },
  { name: "trims", models: MODEL_LIST, query: "  gpt " },
  {
    name: "non-bmp",
    models: [model({ name: "Claude \u{1F680} Rocket", modelId: "claude-rocket" })],
    query: "rocket",
  },
  {
    // The query trims on UTF-16 units: a query that ends mid-surrogate-pair
    // cannot match a name holding the whole emoji.
    name: "surrogate-mismatch",
    models: [model({ name: "phone \uD83D\uDE0E", modelId: "m1" })],
    query: "\uD83D\uDFFF",
  },
  {
    name: "lone-surrogate-query",
    models: [model({ name: "phone \uD83D", modelId: "m1" })],
    query: "\uD83D",
  },
];

const ref = (m: ModelSummary): ModelRef => ({ provider: m.provider, modelId: m.modelId });

export const RECONCILE_CASES: {
  name: string;
  models: ModelSummary[];
  defaults: ConversationDefaults;
  remembered: ModelPick;
}[] = [
  {
    name: "remembered-listed",
    models: [MODELS.a, MODELS.b],
    defaults: { model: ref(MODELS.b) },
    remembered: { model: ref(MODELS.a), level: "high" },
  },
  {
    name: "default-fallback",
    models: [MODELS.a, MODELS.b],
    defaults: { model: ref(MODELS.b) },
    remembered: { model: { provider: "gone", modelId: "claude-z" }, level: "low" },
  },
  {
    name: "first-fallback",
    models: [MODELS.a, MODELS.b],
    defaults: { model: { provider: "gone", modelId: "claude-z" } },
    remembered: { model: { provider: "gone", modelId: "also-gone" }, level: "off" },
  },
  {
    name: "empty-list",
    models: [],
    defaults: {},
    remembered: { model: ref(MODELS.a), level: "high" },
  },
  {
    name: "clamps-remembered",
    models: [MODELS.a, MODELS.b],
    defaults: {},
    remembered: { model: ref(MODELS.b), level: "high" },
  },
  {
    name: "clamps-after-fallback",
    models: [MODELS.a, MODELS.b],
    defaults: { model: ref(MODELS.b) },
    remembered: { model: { provider: "gone", modelId: "claude-z" }, level: "high" },
  },
  {
    name: "no-remembered-model",
    models: [MODELS.a, MODELS.b],
    defaults: { model: ref(MODELS.a) },
    remembered: { level: "medium" },
  },
];

export const SAME_MODEL_CASES: { name: string; a?: ModelRef; b?: ModelRef }[] = [
  { name: "same", a: { provider: "openai", modelId: "gpt-b" }, b: { provider: "openai", modelId: "gpt-b" } },
  { name: "different-provider", a: { provider: "openai", modelId: "gpt-b" }, b: { provider: "local", modelId: "gpt-b" } },
  { name: "different-id", a: { provider: "openai", modelId: "gpt-b" }, b: { provider: "openai", modelId: "gpt-c" } },
  { name: "a-absent", b: { provider: "openai", modelId: "gpt-b" } },
  { name: "b-absent", a: { provider: "openai", modelId: "gpt-b" } },
  { name: "both-absent" },
];
