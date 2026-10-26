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
  /** Whether the joined server may vouch for new devices (ADR-0022 §6); PiNomad-only, defaults on. */
  readonly acceptAccountDevices: boolean;
  /**
   * STUN servers the host advertises in `hello.rtc` and uses when it answers
   * an offer (5.23, ADR-0033). Empty means ICE runs on host candidates only.
   * Absent on hosts before 5.23, like `hostName` before 5.12.
   */
  readonly rtcStun?: readonly string[];
  /** The machine's display name (5.12): the settings override, else the cleaned hostname. Absent on older hosts. */
  readonly hostName?: string;
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
  acceptAccountDevices: true,
  rtcStun: true,
  hostName: true,
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
  typeof value === "string" && Object.prototype.hasOwnProperty.call(THINKING_LEVEL_KEYS, value);

export const isQueueMode = (value: unknown): value is QueueMode => value === "all" || value === "one-at-a-time";

/** The fallback display name when a host name cleans to nothing. */
export const HOST_NAME_FALLBACK = "pinomad";
/** Host names are capped at this many UTF-16 units. */
export const HOST_NAME_MAX_UNITS = 64;

// C0/C1 controls and DEL: a display name carries no terminals, so cleaning
// drops every character that could move a cursor or paint nothing.
const isHostNameControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/**
 * The shared cleaning half of host naming (5.12): strips a trailing `.local`,
 * trims, drops control characters, caps the length — the same pipeline the
 * server applies (issue #212). One pass can leave another `.local` suffix or
 * new trailing space behind ("a.local.local", ".local "), so the pipeline runs
 * to a fixed point — a stored name is already canonical and a second clean is
 * a no-op. An empty result means the input carries nothing displayable:
 * `normalizeHostName` falls back there, callers validating user input treat it
 * as "no name at all".
 */
export function cleanHostName(name: string): string {
  let cleaned = name;
  for (;;) {
    const local = cleaned.endsWith(".local") ? cleaned.slice(0, -".local".length) : cleaned;
    const next = [...local.trim()].filter((c) => !isHostNameControl(c.codePointAt(0)!)).join("").slice(0, HOST_NAME_MAX_UNITS);
    if (next === cleaned) return next;
    cleaned = next;
  }
}

export function normalizeHostName(name: string): string {
  const cleaned = cleanHostName(name);
  return cleaned === "" ? HOST_NAME_FALLBACK : cleaned;
}
