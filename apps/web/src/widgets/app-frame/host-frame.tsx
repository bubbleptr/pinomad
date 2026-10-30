// The stored-host composition root's frame: it reads every host's runtime from
// the registry, so the sidebar lists all machines through every connection
// phase and focus change, while the main column stays inside HostRuntimes.
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { useMemo, type ReactNode } from "react";
import type { Home } from "@pinomad/protocol/organization.ts";
import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { useOptionalComposerSlotState } from "../../entities/composer/composer-context.tsx";
import { newDraftKey } from "../../entities/composer/composer-store.ts";
import { connectionStatus, useHostRuntimeInfos } from "../../entities/host/host-runtimes.ts";
import { readLastNewHost, selectNewChatHost } from "../../entities/host/last-new-host.ts";
import { useHosts } from "../../entities/host/host-store.ts";
import { hostLabels } from "@pinomad/client/stored-host.ts";
import { AppFrame, type FrameMachine } from "./app-frame.tsx";

/**
 * The frame for stored pairings: one sidebar group per paired machine, each
 * fed by its own runtime, so every machine stays browsable while any one of
 * them is connecting, failed, or out of focus (ADR-0035 §1).
 */
export function HostFrame({ children }: { children: ReactNode }) {
  const { hosts, focus, focusConversation, focusDraft, focusHost } = useHosts();
  const infos = useHostRuntimeInfos();
  const narrow = useMediaQuery("(max-width: 1023px)");
  const focusedInfo = focus === null ? undefined : infos.get(focus.hostKey);
  const home = useOptionalComposerSlotState(focusedInfo?.composer.slot(newDraftKey))?.home;
  // Each pairing's device key marks "This device" in that host's Devices list.
  const devices = useMemo(
    () => new Map(hosts.map((host) => [host.hostKey, keyPairFromPrivate(fromBase64Url(host.privateKey))])),
    [hosts],
  );
  const labels = hostLabels(hosts);
  const machines: FrameMachine[] = hosts.map((host) => {
    const info = infos.get(host.hostKey);
    const ready = info?.phase === "ready" ? info : undefined;
    const device = devices.get(host.hostKey);
    return {
      key: host.hostKey,
      hostKey: host.hostKey,
      label: labels.get(host.hostKey) ?? host.url,
      ...(ready === undefined ? {} : { view: ready.view, remote: ready.remote }),
      ...(device === undefined ? {} : { device }),
      ...(info === undefined ? {} : { retry: info.retry }),
    };
  });

  const startDraft = (hostKey: string, next: Home): void => {
    // Put the home on that host's own new-draft slot first: focusing the
    // draft must not race the workbench that will read it.
    infos.get(hostKey)?.composer.slot(newDraftKey).setHome(next);
    focusDraft(hostKey);
  };
  const newChat = (): void => {
    const target = selectNewChatHost({
      hosts,
      lastNewHost: readLastNewHost(window.localStorage),
      connected: (hostKey) => connectionStatus(infos.get(hostKey)) === "connected",
    });
    if (target === undefined) return;
    startDraft(target, { kind: "chat" });
  };

  return (
    <AppFrame
      machines={machines}
      focusKey={focus?.hostKey}
      draftingChat={(focus === null || focus.conversationId === undefined) && home?.kind === "chat"}
      shownId={focus?.conversationId}
      onDraft={startDraft}
      onOpen={(hostKey, conversationId) => focusConversation({ hostKey, conversationId })}
      onNewChat={newChat}
      onShowMachine={focusHost}
      narrow={narrow}
    >
      {children}
    </AppFrame>
  );
}
