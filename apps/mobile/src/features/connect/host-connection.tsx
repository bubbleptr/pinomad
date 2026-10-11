import * as Device from "expo-device";
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Card, Spinner } from "heroui-native";
import { generateKeyPair, keyPairFromPrivate, type KeyPair } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, secureWebSocketTransport, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { RemoteDurable, RemoteDurableOptions } from "@pinomad/protocol/remote-durable.ts";
import type { ProtocolMismatch } from "@pinomad/protocol/view.ts";
import type { ConversationNode } from "@pinomad/protocol/organization.ts";
import { hostStore } from "../../entities/host/secure-host-store.ts";
import type { StoredHost } from "../../entities/host/host-store.ts";
import { useDurableView, useRemoteDurable } from "../../shared/lib/use-remote.ts";

/** What to connect with: a confirmed pairing offer, or a stored device key. */
export type ConnectSpec =
  | { readonly kind: "pair"; readonly url: string; readonly hostKey: string; readonly secret: string }
  | { readonly kind: "device"; readonly url: string; readonly hostKey: string; readonly privateKey: string };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={{ flex: 1 }} className="bg-background">
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}>{children}</View>
    </SafeAreaView>
  );
}

function MismatchMessage({ mismatch }: { mismatch: ProtocolMismatch }) {
  return (
    <View style={{ gap: 8, alignItems: "center" }}>
      <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600" }}>
        {mismatch.direction === "client-older" ? "Update this app" : "Upgrade the host"}
      </Text>
      <Text className="text-muted" style={{ textAlign: "center" }}>
        {mismatch.direction === "client-older"
          ? `The host speaks protocol major ${mismatch.hostMajor}; this app speaks ${mismatch.clientMajor}.`
          : `This app speaks protocol major ${mismatch.clientMajor}; the host speaks ${mismatch.hostMajor}. Run \`pinomad upgrade\`.`}
      </Text>
    </View>
  );
}

/** A secure-channel client: a confirmed pairing offer on first sight, the stored key after. */
export function HostConnection({
  spec,
  stored,
  onForget,
  onUseSaved,
  onPaired,
}: {
  spec: ConnectSpec;
  /** The stored host matching spec.hostKey, for key reuse on re-pairing. */
  stored: StoredHost | undefined;
  onForget(hostKey: string): void;
  /** Pairing offer failed while other hosts are stored: go back to them. */
  onUseSaved(): void;
  onPaired(host: StoredHost): void;
}) {
  const [attempt, setAttempt] = useState(0);
  // A pairing whose save failed: the device key would die with the process and
  // the spent invite can't pair again — surface it, never lose it silently.
  const [unsaved, setUnsaved] = useState<StoredHost>();

  const device = useMemo<KeyPair>(() => {
    if (spec.kind === "pair" && stored !== undefined) return keyPairFromPrivate(fromBase64Url(stored.privateKey));
    if (spec.kind === "device") return keyPairFromPrivate(fromBase64Url(spec.privateKey));
    return generateKeyPair();
  }, [spec, stored]);

  const saveHost = useCallback(
    async (host: StoredHost): Promise<void> => {
      try {
        await hostStore.save(host);
        setUnsaved(undefined);
        onPaired(host);
      } catch (error) {
        console.error("Could not save the paired host", error);
        setUnsaved(host);
      }
    },
    [onPaired],
  );

  const options = useMemo<RemoteDurableOptions>(
    () => ({
      transport: secureWebSocketTransport({
        url: spec.url,
        hostKey: fromBase64Url(spec.hostKey),
        device,
        ...(spec.kind === "pair"
          ? {
              pairing: { secret: spec.secret, name: Device.modelName ?? "iPhone" },
              onPaired: () => void saveHost({ url: spec.url, hostKey: spec.hostKey, privateKey: toBase64Url(device.privateKey) }),
            }
          : {}),
      }),
    }),
    [spec, device, saveHost],
  );

  const state = useRemoteDurable(options, `${spec.kind} ${spec.url} ${spec.hostKey} ${attempt}`);

  if (state.status === "connecting") {
    return (
      <Centered>
        <Spinner />
        <Text className="text-muted">Connecting to {hostOf(spec.url)}…</Text>
      </Centered>
    );
  }

  if (state.status === "failed") {
    if (state.unauthorized) {
      // A rejected pairing offer is the offer's problem; a rejected device key
      // means the device was revoked — only the device flow may forget a host.
      return spec.kind === "pair" ? (
        <Centered>
          <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600" }}>
            This pairing code was used or has expired
          </Text>
          <Text className="text-muted" style={{ textAlign: "center" }}>
            Generate a new link on the host: run `pinomad pair`, or open Devices → Pair a device.
          </Text>
          {stored === undefined ? null : (
            <Button variant="secondary" onPress={onUseSaved}>
              Use saved pairing
            </Button>
          )}
        </Centered>
      ) : (
        <Centered>
          <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600" }}>
            This device was rejected or revoked
          </Text>
          <Text className="text-muted" style={{ textAlign: "center" }}>
            It isn't paired with the host, or was revoked on it.
          </Text>
          <Button variant="danger-soft" onPress={() => onForget(spec.hostKey)}>
            Forget this host
          </Button>
        </Centered>
      );
    }
    if (state.mismatch !== undefined) {
      return (
        <Centered>
          <MismatchMessage mismatch={state.mismatch} />
        </Centered>
      );
    }
    return (
      <Centered>
        <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600" }}>
          Couldn't reach the host
        </Text>
        <Text className="text-muted" style={{ textAlign: "center" }}>
          {state.error}
        </Text>
        <Button variant="secondary" onPress={() => setAttempt((n) => n + 1)}>
          Retry
        </Button>
      </Centered>
    );
  }

  return (
    <ConnectedView
      remote={state.remote}
      spec={spec}
      unsaved={unsaved}
      onRetrySave={(host) => void saveHost(host)}
      onForget={onForget}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

function ConnectedView({
  remote,
  spec,
  unsaved,
  onRetrySave,
  onForget,
  onRetry,
}: {
  remote: RemoteDurable;
  spec: ConnectSpec;
  unsaved: StoredHost | undefined;
  onRetrySave(host: StoredHost): void;
  onForget(hostKey: string): void;
  onRetry(): void;
}) {
  const view = useDurableView(remote);

  if (view.unauthorized === true) {
    return (
      <Centered>
        <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600" }}>
          This device was rejected or revoked
        </Text>
        <Button variant="danger-soft" onPress={() => onForget(spec.hostKey)}>
          Forget this host
        </Button>
      </Centered>
    );
  }
  if (view.protocolMismatch !== undefined) {
    return (
      <Centered>
        <MismatchMessage mismatch={view.protocolMismatch} />
      </Centered>
    );
  }

  // The sidebar's list: top-level conversations — chats, then per project.
  const topLevel: readonly ConversationNode[] = [
    ...view.organized.chats,
    ...view.organized.projects.flatMap(({ conversations }) => conversations),
  ];

  return (
    <SafeAreaView style={{ flex: 1 }} className="bg-background" edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <View style={{ gap: 4 }}>
          <Text className="text-foreground" style={{ fontSize: 22, fontWeight: "700" }}>
            PiNomad
          </Text>
          <Text className="text-muted">{spec.url}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {view.connection === "reconnecting" ? <Spinner size="sm" /> : null}
            <Text className="text-muted">
              {view.connection === "connected" ? "Connected" : view.connection === "reconnecting" ? "Reconnecting…" : "Disconnected"}
            </Text>
          </View>
          {view.connection === "closed" ? (
            <Button variant="secondary" onPress={onRetry}>
              Reconnect
            </Button>
          ) : null}
        </View>
        {unsaved === undefined ? null : (
          <Card>
            <Card.Header>
              <Card.Title>This pairing wasn't saved</Card.Title>
              <Card.Description>It will be lost when the app restarts.</Card.Description>
            </Card.Header>
            <Card.Footer>
              <Button variant="secondary" onPress={() => onRetrySave(unsaved)}>
                Retry
              </Button>
            </Card.Footer>
          </Card>
        )}
        <Card>
          <Card.Header>
            <Card.Title>Conversations</Card.Title>
            <Card.Description>
              {topLevel.length === 0 ? "No conversations on this host yet" : `${topLevel.length} on this host`}
            </Card.Description>
          </Card.Header>
          <Card.Body style={{ gap: 8 }}>
            {topLevel.map((node) => (
              <Text key={node.summary.id} className="text-foreground" numberOfLines={1}>
                {node.summary.title ?? "Untitled conversation"}
              </Text>
            ))}
          </Card.Body>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
