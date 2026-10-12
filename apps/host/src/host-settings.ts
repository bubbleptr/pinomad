// PiNomad-owned host settings (ADR-0021 §1-3): <dataDir>/settings.json holds only
// the keys a device set; every other key falls back to pi's settings, then the
// built-ins. The effective value rides the `settings` stream and `updateSettings`
// writes through here — the host is the only writer (§4), so there is no watch.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
  HOST_SETTING_KEYS,
  isQueueMode,
  isThinkingLevel,
  type HostSettingKey,
  type HostSettings,
  type HostSettingsPatch,
  type QueueMode,
} from "@pinomad/protocol/settings.ts";
import type { ConversationDefaults, ModelSummary, ThinkingLevel } from "@pinomad/protocol/view.ts";
import { Published, sameList, type HostValue } from "./host-value.ts";

/** Where a setting goes when PiNomad's file does not set it; evaluated on each recompute. */
export interface SettingsFallback {
  defaultModel(): ModelRef | null;
  defaultThinkingLevel(): ThinkingLevel | null;
  steeringMode(): QueueMode;
  followUpMode(): QueueMode;
}

/** The `settings` stream's source: the effective value plus updates to the file. */
export interface HostSettingsStore extends HostValue<HostSettings> {
  update(patch: HostSettingsPatch): Promise<void>;
}

/** The `hello.defaults` / new-conversation defaults the effective settings imply. */
export function settingsDefaults(settings: HostSettings): ConversationDefaults {
  return {
    ...(settings.defaultModel === null ? {} : { model: settings.defaultModel }),
    ...(settings.defaultThinkingLevel === null ? {} : { thinkingLevel: settings.defaultThinkingLevel }),
  };
}

const isModelRef = (value: unknown): value is ModelRef =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && typeof (value as ModelRef).provider === "string"
  && (value as ModelRef).provider !== ""
  && typeof (value as ModelRef).modelId === "string"
  && (value as ModelRef).modelId !== "";

/** Why a file value cannot be honored: wrong shape, or a model the host cannot run right now. */
type Invalidity = "malformed" | "unavailable";

const fileValueError = (
  key: HostSettingKey,
  value: unknown,
  models: readonly ModelSummary[],
): Invalidity | undefined => {
  switch (key) {
    case "defaultModel":
      if (!isModelRef(value)) return "malformed";
      return models.some((each) => each.provider === value.provider && each.modelId === value.modelId)
        ? undefined
        : "unavailable";
    case "defaultThinkingLevel":
      return isThinkingLevel(value) ? undefined : "malformed";
    case "steeringMode":
    case "followUpMode":
      return isQueueMode(value) ? undefined : "malformed";
  }
};

const sameModel = (a: ModelRef | null, b: ModelRef | null): boolean =>
  a === b || (a !== null && b !== null && a.provider === b.provider && a.modelId === b.modelId);

const sameSettings = (a: HostSettings, b: HostSettings): boolean =>
  a.steeringMode === b.steeringMode
  && a.followUpMode === b.followUpMode
  && a.defaultThinkingLevel === b.defaultThinkingLevel
  && sameModel(a.defaultModel, b.defaultModel)
  && sameList(a.custom, b.custom, (x, y) => x === y);

const parse = (path: string, text: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid settings file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid settings file ${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

export async function openHostSettings(options: {
  readonly path: string;
  readonly fallback: SettingsFallback;
  readonly models: HostValue<readonly ModelSummary[]>;
}): Promise<HostSettingsStore> {
  // A missing file means nothing is customized; it is created on the first update.
  let file: Record<string, unknown> = await readFile(options.path, "utf8").then(
    (text) => parse(options.path, text),
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(`Cannot read settings file ${options.path}: ${error instanceof Error ? error.message : String(error)}`);
    },
  );

  // Malformed file values warn once each — stale hand edits are worth naming;
  // a model that is merely unavailable right now is runtime state, quietly
  // inherited until the provider logs back in.
  const warned = new Set<HostSettingKey>();

  /** The effective value: each set-and-valid file key overrides the fallback; the rest inherit. */
  const compute = (): HostSettings => {
    const fileValues: Partial<Record<HostSettingKey, unknown>> = {};
    const custom: HostSettingKey[] = [];
    for (const key of HOST_SETTING_KEYS) {
      if (!Object.hasOwn(file, key)) continue;
      const value = file[key];
      const invalid = fileValueError(key, value, options.models.value);
      if (invalid === "malformed" && !warned.has(key)) {
        warned.add(key);
        console.error(`${options.path}: ignoring invalid value for settings key "${key}": ${JSON.stringify(value)}`);
      }
      if (invalid !== undefined) continue;
      fileValues[key] = value;
      custom.push(key);
    }
    const { fallback } = options;
    return {
      defaultModel: (fileValues.defaultModel as ModelRef | undefined) ?? fallback.defaultModel(),
      defaultThinkingLevel:
        (fileValues.defaultThinkingLevel as ThinkingLevel | undefined) ?? fallback.defaultThinkingLevel(),
      steeringMode: (fileValues.steeringMode as QueueMode | undefined) ?? fallback.steeringMode(),
      followUpMode: (fileValues.followUpMode as QueueMode | undefined) ?? fallback.followUpMode(),
      custom,
    };
  };

  const published = new Published(compute(), sameSettings);
  // A login/logout changes what the host can run: the file's default model and
  // the pi fallback are both re-evaluated against the live list.
  options.models.subscribe(() => published.set(compute()));
  let tail = Promise.resolve();

  const write = async (patch: HostSettingsPatch): Promise<void> => {
    // A persisted default must be a model this host can actually run.
    const model = patch.defaultModel;
    if (
      model !== undefined
      && model !== null
      && !options.models.value.some((each) => each.provider === model.provider && each.modelId === model.modelId)
    ) {
      throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
    }
    // Mutate a copy: `file` only moves once the write is durably on disk, so a
    // failed write cannot make memory and disk diverge.
    const next = { ...file };
    for (const key of HOST_SETTING_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    // Unknown keys ride along untouched — a newer PiNomad may have written them.
    const tmp = `${options.path}.tmp`;
    await mkdir(dirname(options.path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, options.path);
    file = next;
    published.set(compute());
  };

  return {
    get value() {
      return published.value;
    },
    subscribe: (listener) => published.subscribe(listener),
    // Updates are serialized: each lands fully — file write then publish —
    // before the next starts.
    update: (patch) => (tail = tail.then(() => write(patch), () => write(patch))),
  };
}
