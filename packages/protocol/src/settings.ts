import type { ModelRef } from "@earendil-works/pi-durable";
import type { ThinkingLevel } from "./view.ts";

/** Queue mode of pi's submissions inbox (`steering` / `followUp`). */
export type QueueMode = "all" | "one-at-a-time";

/** Effective host settings (ADR-0021 §2): PiNomad's settings.json, else pi's settings, else built-in. */
export interface HostSettings {
  readonly defaultModel: ModelRef | null;
  readonly defaultThinkingLevel: ThinkingLevel | null;
  readonly steeringMode: QueueMode;
  readonly followUpMode: QueueMode;
  /** Keys PiNomad's settings.json sets; the rest are inherited. Lets a client offer "reset". */
  readonly custom: readonly HostSettingKey[];
}

export type HostSettingKey = Exclude<keyof HostSettings, "custom">;

/** The writable settings keys (the object literal + satisfies keeps it exactly in sync with HostSettingKey). */
const HOST_SETTING_KEY_SET = {
  defaultModel: true,
  defaultThinkingLevel: true,
  steeringMode: true,
  followUpMode: true,
} satisfies Record<HostSettingKey, true>;
export const HOST_SETTING_KEYS = Object.keys(HOST_SETTING_KEY_SET) as readonly HostSettingKey[];

/** A partial update; `null` clears PiNomad's value so the key falls back to pi / built-in again. */
export type HostSettingsPatch = { readonly [K in HostSettingKey]?: Exclude<HostSettings[K], null> | null };

/** Every `ThinkingLevel`, for validating wire and file values; the satisfies keeps it exhaustive like HOST_STREAMS. */
const THINKING_LEVEL_KEYS = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true } satisfies Record<
  ThinkingLevel,
  true
>;

/** The levels in pi-ai's order; error messages and pickers list them. */
export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_KEYS) as readonly ThinkingLevel[];

// `in` would admit prototype keys like "constructor" and "__proto__".
export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && Object.hasOwn(THINKING_LEVEL_KEYS, value);

export const isQueueMode = (value: unknown): value is QueueMode => value === "all" || value === "one-at-a-time";
