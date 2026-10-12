// The `models` and `auth` host streams plus the `logout` call, backed by pi's
// credential file (ADR-0021 §5-6): a login or logout in the Pi CLI rewrites
// `auth.json`, which is noticed here and pushed to every subscribed device.
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HostAuth, StoredLogin } from "@pinomad/protocol/auth.ts";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { HostValue } from "./host-value.ts";
import { modelSummaries } from "./pi-setup.ts";

/** Live sources behind the `models`/`auth` streams and the `logout` call. */
export interface ModelAuth {
  readonly models: HostValue<readonly ModelSummary[]>;
  readonly auth: HostValue<HostAuth>;
  logout(providerId: string): Promise<void>;
  close(): void;
}

/** A `HostValue` that republishes only when `equal` reports a real change. */
class Published<T> implements HostValue<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly #equal: (a: T, b: T) => boolean;
  #value: T;

  constructor(value: T, equal: (a: T, b: T) => boolean) {
    this.#value = value;
    this.#equal = equal;
  }

  get value(): T {
    return this.#value;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(next: T): void {
    if (this.#equal(this.#value, next)) return;
    this.#value = next;
    for (const listener of this.#listeners) listener(next);
  }
}

const sameList = <T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((entry, index) => same(entry, b[index]!));

const sameModel = (a: ModelSummary, b: ModelSummary): boolean =>
  a.provider === b.provider
  && a.modelId === b.modelId
  && a.name === b.name
  && a.contextWindow === b.contextWindow
  && sameList(a.thinkingLevels, b.thinkingLevels, (x, y) => x === y);

const sameLogin = (a: StoredLogin, b: StoredLogin): boolean =>
  a.providerId === b.providerId && a.name === b.name && a.kind === b.kind && a.subscription === b.subscription;

/** Stored credentials as the `auth` stream value; `list()` re-reads auth.json when its revision changed. */
async function storedLogins(modelRuntime: ModelRuntime): Promise<HostAuth> {
  const credentials = await modelRuntime.listCredentials();
  const logins: StoredLogin[] = credentials.map((credential) => ({
    providerId: credential.providerId,
    name: modelRuntime.getProvider(credential.providerId)?.name ?? credential.providerId,
    kind: credential.type,
    subscription: modelRuntime.isUsingSubscription(credential.providerId),
  }));
  logins.sort((a, b) => a.providerId.localeCompare(b.providerId));
  return { logins };
}

/**
 * Track pi's `auth.json`: publishes the available-model list and the stored
 * logins, republished when the file changes or `logout` removes a credential.
 * The watch is on the file's directory — it survives however the file is
 * rewritten, including an atomic rename that would orphan a file-level watch.
 */
export async function watchModelAuth(
  modelRuntime: ModelRuntime,
  options: { authPath: string; debounceMs?: number },
): Promise<ModelAuth> {
  const debounceMs = options.debounceMs ?? 150;
  const models = new Published(modelSummaries(modelRuntime), (a, b) => sameList(a, b, sameModel));
  const auth = new Published(await storedLogins(modelRuntime), (a, b) => sameList(a.logins, b.logins, sameLogin));

  const fileName = basename(options.authPath);
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let reported = false;
  let closed = false;

  const refresh = async (): Promise<void> => {
    try {
      // The only call that re-runs availability for externally stored
      // credentials; reads see them earlier, snapshots do not.
      await modelRuntime.getAvailable();
      models.set(modelSummaries(modelRuntime));
      auth.set(await storedLogins(modelRuntime));
      reported = false;
    } catch (error) {
      // Keep the last values; a bad or half-written file must not kill the watcher.
      if (!reported) console.error(`model-auth refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      reported = true;
    }
  };

  const directory = dirname(options.authPath);
  if (existsSync(directory)) {
    watcher = watch(directory, (_event, changed) => {
      if (closed || (changed !== null && changed !== fileName)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), debounceMs);
    });
    watcher.on("error", (error) => {
      if (!reported) console.error(`model-auth watch failed: ${error.message}`);
      reported = true;
    });
  }

  return {
    models,
    auth,
    async logout(providerId) {
      if (!auth.value.logins.some((login) => login.providerId === providerId)) {
        throw new Error(`No stored credential for provider "${providerId}"`);
      }
      await modelRuntime.logout(providerId);
      // logout() already synchronized the runtime snapshot; republish now
      // rather than wait for the debounced watch event.
      models.set(modelSummaries(modelRuntime));
      auth.set(await storedLogins(modelRuntime));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
