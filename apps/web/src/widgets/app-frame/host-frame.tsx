// The stored-host composition root's frame: it reads the focused host's
// runtime from the registry, so the sidebar survives every connection phase and
// focus change, while the main column stays inside HostRuntimes.
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
import { AppFrame } from "./app-frame.tsx";

/**
 * The frame for stored pairings. The focused host supplies its view and remote
 * only once ready; the sidebar still paints during connecting and failure.
 */
export function HostFrame({ children }: { children: ReactNode }) {
  const { hosts, focus, focusConversation, focusDraft } = useHosts();
  const infos = useHostRuntimeInfos();
  const narrow = useMediaQuery("(max-width: 1023px)");
  const host = focus === null ? undefined : hosts.find((entry) => entry.hostKey === focus.hostKey);
  const info = focus === null ? undefined : infos.get(focus.hostKey);
  const ready = info?.phase === "ready" ? info : undefined;
  const slot = info?.composer.slot(newDraftKey);
  const home = useOptionalComposerSlotState(slot)?.home;
  // The focused host's device key marks "This device" in Settings → Devices;
  // it belongs to the client, so the frame derives it once per stored entry.
  const device = useMemo(
    () => (host === undefined ? undefined : keyPairFromPrivate(fromBase64Url(host.privateKey))),
    [host],
  );

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
      {...(focus === null ? {} : { hostKey: focus.hostKey })}
      {...(ready === undefined ? {} : { view: ready.view, remote: ready.remote })}
      {...(device === undefined ? {} : { device })}
      {...(info === undefined ? {} : { onReconnect: info.retry })}
      draftingChat={(focus === null || focus.conversationId === undefined) && home?.kind === "chat"}
      shownId={focus?.conversationId}
      onDraft={(next) => {
        if (focus !== null) startDraft(focus.hostKey, next);
      }}
      onOpen={(id) => {
        if (focus !== null) focusConversation({ hostKey: focus.hostKey, conversationId: id });
      }}
      onNewChat={newChat}
      narrow={narrow}
    >
      {children}
    </AppFrame>
  );
}
