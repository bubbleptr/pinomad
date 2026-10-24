// After createHarnessSettings / configureHarnessHttp / findInitialAgentModel in pi's
// packages/coding-agent/src/experimental/durable/harness-setup.ts (MIT, Earendil Works).
// See docs/licenses/pi.md for the upstream notice.
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef, HarnessSettings } from "@earendil-works/pi-durable";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelSummary } from "@pinomad/protocol/view.ts";
import type { HostSettingsStore } from "./host-settings.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./http-dispatcher.ts";

export function configureHarnessHttp(settingsManager: SettingsManager): void {
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
}

/** Harness settings read at every use from the "pi" block loaded at startup (ADR-0031); queue modes come from the settings store (live). */
export function createHarnessSettings(
  settingsManager: SettingsManager,
  modes: Pick<HostSettingsStore, "value">,
): HarnessSettings {
  return {
    get stream() {
      const provider = settingsManager.getProviderRetrySettings();
      const idle = settingsManager.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() {
      return settingsManager.getCompactionSettings();
    },
    get retry() {
      return settingsManager.getRetrySettings();
    },
    get steeringMode() {
      return modes.value.steeringMode;
    },
    get followUpMode() {
      return modes.value.followUpMode;
    },
  };
}

/**
 * pi's default model from settings.json when it is available. Simpler than pi's
 * findInitialModel, which is not exported: no scoped models, no provider fallback.
 */
export function defaultModel(
  settingsManager: SettingsManager,
  modelRuntime: ModelRuntime,
): (ModelRef & { readonly thinkingLevel?: ModelThinkingLevel }) | undefined {
  const provider = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  if (provider === undefined || modelId === undefined) return undefined;
  if (modelRuntime.getModel(provider, modelId) === undefined) return undefined;
  const thinkingLevel = settingsManager.getDefaultThinkingLevel();
  return { provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
}

export function modelSummaries(modelRuntime: ModelRuntime): ModelSummary[] {
  return modelRuntime.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    // getSupportedThinkingLevels already returns ["off"] for non-reasoning
    // models and always leads with "off", matching the wire invariant.
    thinkingLevels: getSupportedThinkingLevels(model),
    images: model.input.includes("image"),
  }));
}
