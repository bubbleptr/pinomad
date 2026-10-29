// The multi-host composition root: one RemoteDurable per stored host, one
// focused conversation, and a composer store that outlives focus changes.
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Layout";
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import { keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { candidatePlan } from "@pinomad/protocol/remote-candidates.ts";
import { useDurableView, useRemoteDurable } from "../../use-remote.ts";
import { Centered } from "../../shared/ui/centered.tsx";
import { HostsFallback } from "../../widgets/app-frame/hosts.tsx";
import { RepairViaAccount } from "../../widgets/account/repair-via-account.tsx";
import { VersionMismatch } from "../../widgets/app-frame/version-mismatch.tsx";
import { useRunNotifications } from "../conversation/use-run-notifications.ts";
import { HostComposerContext } from "../composer/composer-context.tsx";
import { HostComposerStore } from "../composer/composer-store.ts";
import { createBrowserRtcPlatform } from "./browser-rtc.ts";
import { useConversationFocus } from "./use-conversation-focus.ts";
import { useHostNameSync, useHosts } from "./host-store.ts";
import { HostRuntimesContext } from "./host-runtimes.ts";
import type { HostFocus } from "./focus.ts";
import { secureOptions } from "./secure-options.ts";

export type RemoteConnect = (options: RemoteDurableOptions) => Promise<RemoteDurable>;

export type HostWorkbenchRenderer = (input: {
  host: StoredHost;
  remote: RemoteDurable;
  device: KeyPair;
  rejected: ReactNode;
  retry: () => void;
}) => ReactNode;

/** Every paired host runs at once; only the focused one paints the workbench. */
export function HostRuntimes({
  hosts,
  focus,
  connect,
  renderWorkbench,
}: {
  hosts: readonly StoredHost[];
  focus: HostFocus | null;
  /** Test seam forwarded to every host's useRemoteDurable. */
  connect?: RemoteConnect;
  renderWorkbench: HostWorkbenchRenderer;
}) {
  return (
    <>
      {hosts.map((host) => (
        <HostRuntime
          key={host.hostKey}
          host={host}
          focused={focus?.hostKey === host.hostKey}
          focusTarget={focus?.hostKey === host.hostKey ? focus.conversationId : undefined}
          renderWorkbench={renderWorkbench}
          {...(connect === undefined ? {} : { connect })}
        />
      ))}
    </>
  );
}

/**
 * One paired host's connection. It stays mounted while another host is
 * focused; losing focus only releases its conversation subscriptions
 * (ADR-0035 §2), never the connection itself.
 */
function HostRuntime({
  host,
  focused,
  focusTarget,
  connect,
  renderWorkbench,
}: {
  host: StoredHost;
  focused: boolean;
  focusTarget: ConversationId | undefined;
  connect?: RemoteConnect;
  renderWorkbench: HostWorkbenchRenderer;
}) {
  const { endpoints, setConnection } = useHosts();
  const registry = useContext(HostRuntimesContext);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // One composer store per host runtime: drafts and uploads outlive a focused
  // workbench but never cross to another host.
  const composer = useMemo(() => new HostComposerStore(), []);
  const device = useMemo<KeyPair>(
    () => keyPairFromPrivate(fromBase64Url(host.privateKey)),
    [host.privateKey],
  );
  const target = useMemo(
    () => ({ url: host.url, endpointSet: host.endpointSet }),
    [host.url, host.endpointSet],
  );
  const candidates = useMemo(
    () => candidatePlan(target.url, target.endpointSet, { pageProtocol: window.location.protocol }),
    [target],
  );
  const rtcPlatform = useMemo(() => createBrowserRtcPlatform(), []);
  const options = useMemo<RemoteDurableOptions>(
    () =>
      secureOptions({
        hostKey: host.hostKey,
        device,
        target,
        candidates,
        stored: host,
        rtcPlatform,
        setConnection,
        // A validated hello set, including an explicit empty one, is an
        // address-only update keyed by hostKey; identity and account stay put.
        onEndpointSet: (endpointSet) => {
          void endpoints(host.hostKey, endpointSet).catch((error: unknown) =>
            console.error("Could not store the host's remote endpoints", error),
          );
        },
      }),
    [candidates, device, endpoints, host, rtcPlatform, setConnection, target],
  );
  const state = useRemoteDurable(
    options,
    // Re-pairing the same host after a revocation keeps hostKey but replaces
    // the device key; that is a new identity and needs a fresh connection.
    `${host.hostKey} ${host.privateKey} ${attempt}`,
    connect === undefined ? undefined : { connect },
  );

  useEffect(() => {
    if (registry === undefined || state.status === "ready") return;
    if (state.status === "connecting") {
      registry.publish(host.hostKey, { phase: "connecting", retry });
      return;
    }
    registry.publish(host.hostKey, {
      phase: "failed",
      error: state.error,
      unauthorized: state.unauthorized,
      ...(state.mismatch === undefined ? {} : { mismatch: state.mismatch }),
      retry,
    });
  }, [host.hostKey, registry, retry, state]);

  useEffect(
    () => () => {
      registry?.remove(host.hostKey);
    },
    [host.hostKey, registry],
  );
  useEffect(() => {
    composer.setRemote(state.status === "ready" ? state.remote : undefined);
  }, [composer, state]);

  if (state.status === "ready") {
    return (
      <HostComposerContext.Provider value={composer}>
        <ReadyHost
          host={host}
          remote={state.remote}
          device={device}
          focused={focused}
          focusTarget={focusTarget}
          retry={retry}
          renderWorkbench={renderWorkbench}
        />
      </HostComposerContext.Provider>
    );
  }
  if (!focused) return null;
  return (
    <HostComposerContext.Provider value={composer}>
      {state.status === "connecting" ? (
        <Centered>
          <EmptyState title="Connecting" description={host.url} />
        </Centered>
      ) : (
        <HostFailure host={host} state={state} retry={retry} />
      )}
    </HostComposerContext.Provider>
  );
}

/** The focused host failed before its first view; other hosts keep running. */
function HostFailure({
  host,
  state,
  retry,
}: {
  host: StoredHost;
  state: Extract<ReturnType<typeof useRemoteDurable>, { status: "failed" }>;
  retry: () => void;
}) {
  const { forget } = useHosts();
  if (state.mismatch !== undefined) {
    return (
      <Centered>
        <VersionMismatch wsUrl={host.url} mismatch={state.mismatch} hostKey={host.hostKey} />
        <HostsFallback />
      </Centered>
    );
  }
  if (state.unauthorized) {
    return (
      <Centered>
        <VStack gap={4} hAlign="center">
          <EmptyState title="This device isn't paired" description="It isn't paired with the host, or was revoked." />
          <RepairViaAccount hostKey={host.hostKey} />
          <Button
            label="Forget this host"
            variant="secondary"
            onClick={() => void forget(host.hostKey)}
          />
        </VStack>
        <HostsFallback />
      </Centered>
    );
  }
  return (
    <Centered>
      <VStack gap={4} hAlign="center">
        <BannerForFailure state={state} retry={retry} />
      </VStack>
      <HostsFallback />
    </Centered>
  );
}

function BannerForFailure({
  state,
  retry,
}: {
  state: Extract<ReturnType<typeof useRemoteDurable>, { status: "failed" }>;
  retry: () => void;
}) {
  return (
    <>
      <Banner
        status="error"
        title={state.direct === undefined ? "Could not connect to the host" : "Direct connection unavailable"}
        description={
          state.direct === undefined
            ? state.error
            : "This host can't be reached without the relay, and the peer-to-peer link didn't connect."
        }
      />
      {state.direct === undefined ? null : (
        <Text type="supporting" style={{ textAlign: "center" }}>
          {`Details: ${state.direct.reason}`}
        </Text>
      )}
      <Button label="Retry" variant="secondary" onClick={retry} />
    </>
  );
}

/**
 * A ready host keeps its notification baseline and view subscription even
 * while another host is on screen; only its workbench is unmounted.
 */
function ReadyHost({
  host,
  remote,
  device,
  focused,
  focusTarget,
  retry,
  renderWorkbench,
}: {
  host: StoredHost;
  remote: RemoteDurable;
  device: KeyPair;
  focused: boolean;
  focusTarget: ConversationId | undefined;
  retry: () => void;
  renderWorkbench: HostWorkbenchRenderer;
}) {
  const view = useDurableView(remote);
  const registry = useContext(HostRuntimesContext);
  const { focusConversation, forget } = useHosts();
  useEffect(() => {
    registry?.publish(host.hostKey, { phase: "ready", remote, view, retry });
  }, [host.hostKey, registry, remote, retry, view]);
  useEffect(
    () => () => {
      registry?.remove(host.hostKey);
    },
    [host.hostKey, registry],
  );
  useHostNameSync(host.hostKey, view.settings);
  useConversationFocus(remote, view, focusTarget);
  useRunNotifications(
    view,
    host.hostKey,
    // A focused draft shows no conversation even while the previous one is
    // still in the view for the moment its release takes.
    focused && focusTarget !== undefined ? view.conversation?.conversation.id : undefined,
    focusConversation,
  );
  if (!focused) return null;
  const rejected = (
    <VStack gap={4} hAlign="center">
      <EmptyState title="This device isn't paired" description="It isn't paired with the host, or was revoked." />
      <RepairViaAccount hostKey={host.hostKey} />
      <Button label="Forget this host" variant="secondary" onClick={() => void forget(host.hostKey)} />
    </VStack>
  );
  return renderWorkbench({ host, remote, device, rejected, retry });
}
