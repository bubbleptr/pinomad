import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { RtcSelectedPair } from "@pinomad/protocol/rtc.ts";
import type { StoredHost } from "@pinomad/client/stored-host.ts";
import { DEVBOX_HOST, fakeHosts, fakeRemote, fakeView, HOME_HOST, signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { HostComposerStore } from "../../entities/composer/composer-store.ts";
import {
  createHostRuntimeRegistry,
  HostRuntimesContext,
  type HostRuntimeInfo,
} from "../../entities/host/host-runtimes.ts";
import { HostsFallback, HostsMenu, HostsSection } from "./hosts.tsx";

const STUDIO_HOST = { ...HOME_HOST, name: "Studio" };

/** A machine that joined the account and also listens on its tailnet and LAN. */
const ROUTED_HOST: StoredHost = {
  ...HOME_HOST,
  url: "wss://app.pinomad.si/relay/h",
  account: { serverOrigin: "https://app.pinomad.si", hostId: HOME_HOST.hostKey },
  endpointSet: {
    schemaVersion: 1,
    endpoints: [
      { transport: "webSocket", role: "relay", url: "wss://app.pinomad.si/relay/h" },
      { transport: "webSocket", role: "direct", url: "wss://kieran-mbp.tailf76614.ts.net:7422" },
      { transport: "webSocket", role: "direct", url: "wss://kieran-mbp.local:7422" },
    ],
  },
};
const studioHosts = () => fakeHosts([STUDIO_HOST], STUDIO_HOST.hostKey);

const view = (connection: "connected" | "reconnecting" = "connected", minor = 23) =>
  fakeView({
    connection,
    host: { version: "0.9.0", protocol: { major: 5, minor, patch: 0 } },
  } as never);

const ready = (next: RtcDiagnostics, connection: "connected" | "reconnecting" = "connected"): HostRuntimeInfo => {
  const current = view(connection);
  return {
    phase: "ready",
    remote: {
      ...fakeRemote(current),
      rtcDiagnostics: () => next,
      setConnectionMode: () => {},
    },
    view: current,
    retry: () => {},
    composer: new HostComposerStore(),
  };
};

const connecting: HostRuntimeInfo = {
  phase: "connecting",
  retry: () => {},
  composer: new HostComposerStore(),
};

const withRuntime = (info?: HostRuntimeInfo): Decorator => (Story) => {
  const registry = createHostRuntimeRegistry();
  if (info !== undefined) {
    for (const host of [HOME_HOST, DEVBOX_HOST, STUDIO_HOST, ROUTED_HOST]) registry.publish(host.hostKey, info);
  }
  return (
    <HostRuntimesContext.Provider value={registry}>
      <Story />
    </HostRuntimesContext.Provider>
  );
};

const relay = ready({ path: "relay", phase: "active", cooldownRemainingMs: 0 });

// Browsers replace this device's host candidate with an mDNS name, so only
// the host's end tells the real route.
const MDNS_LOCAL = { type: "host", address: "4f2a1c9d.local", scope: "unknown" } as const;
const LAN_PAIR: RtcSelectedPair = {
  local: MDNS_LOCAL,
  remote: { type: "host", address: "192.168.1.42:51234", scope: "lan" },
};
const TAILNET_PAIR: RtcSelectedPair = {
  local: MDNS_LOCAL,
  remote: { type: "srflx", address: "100.101.102.103:51234", scope: "tailnet" },
};
const UNKNOWN_PAIR: RtcSelectedPair = {
  local: MDNS_LOCAL,
  remote: { type: "srflx", address: "studio-a.local", scope: "unknown" },
};

/** Opens the first host's own page, where its connection lives. */
const openConnection = async (canvasElement: HTMLElement): Promise<void> => {
  const buttons = within(canvasElement).getAllByRole("button", { name: / details$/ });
  await userEvent.click(buttons[0]!);
};

const meta = {
  title: "Widgets/AppFrame/Hosts",
  component: HostsSection,
  decorators: [withHosts(), withRuntime(relay)],
  args: { rtcAvailable: true },
} satisfies Meta<typeof HostsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Section: Story = {};

/** Each machine lists the routes that reach it. */
export const SectionRoutes: Story = {
  decorators: [withHosts(fakeHosts([ROUTED_HOST, DEVBOX_HOST], ROUTED_HOST.hostKey)), withRuntime(relay)],
};

/** Direct only leaves the relay route out. */
export const SectionRoutesDirectOnly: Story = {
  decorators: [
    withHosts(fakeHosts([{ ...ROUTED_HOST, connectionMode: "directOnly" }], ROUTED_HOST.hostKey)),
    withRuntime(ready({ path: "direct", phase: "idle", cooldownRemainingMs: 0 })),
  ],
};

export const SectionReconnecting: Story = {
  decorators: [withHosts(), withRuntime(ready({ path: "relay", phase: "idle", cooldownRemainingMs: 0 }, "reconnecting"))],
};

/** A host paired before 5.12 announced no name, so it shows its address. */
export const SectionUnnamedHost: Story = {
  decorators: [withHosts(fakeHosts([HOME_HOST, { ...DEVBOX_HOST, name: undefined }])), withRuntime(relay)],
};

/** Signed in: the account's other hosts follow, offering Pair where the server can reach them. */
export const SectionWithAccount: Story = {
  decorators: [withHosts(fakeHosts([HOME_HOST])), withRuntime(relay), withAccount(signedIn())],
};

/** A paired host that refused this device: the row's one action is Pair again. */
export const SectionRefused: Story = {
  decorators: [
    withHosts(),
    withRuntime(relay),
    withAccount(signedIn({ rejectedHostKeys: [HOME_HOST.hostKey] })),
  ],
};

/** The host's own page: connection, routes, and the ways to let it go. */
export const SectionHostPage: Story = {
  decorators: [withHosts(fakeHosts([ROUTED_HOST, DEVBOX_HOST], ROUTED_HOST.hostKey)), withRuntime(relay), withAccount(signedIn())],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Unpair asks first, in a dialog. */
export const SectionUnpair: Story = {
  decorators: [withHosts(), withRuntime(relay)],
  play: async ({ canvasElement }) => {
    await openConnection(canvasElement);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Unpair…" }));
  },
};

/** Add a host, signed in: the join command first, a pairing link on request. */
export const SectionAddHost: Story = {
  decorators: [withHosts(), withRuntime(relay), withAccount(signedIn())],
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Add a host…" }));
  },
};

export const SectionEmpty: Story = {
  decorators: [withHosts(fakeHosts([], null)), withRuntime(undefined)],
};

/**
 * A live LAN route with both addresses revealed; the previous attempt's
 * failure stays visible even while the current link is active.
 */
export const SectionP2P: Story = {
  decorators: [
    withHosts(studioHosts()),
    withRuntime(
      ready({
        path: "p2p",
        phase: "active",
        cooldownRemainingMs: 0,
        selectedPair: LAN_PAIR,
        lastFailure: {
          stage: "ice",
          reason: "the ICE connection failed",
          agoMs: 12_000,
          pair: LAN_PAIR,
        },
      }),
    ),
  ],
  play: async ({ canvasElement }) => {
    await openConnection(canvasElement);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Show addresses" }));
    // Chromium treats userEvent's synthetic click as keyboard focus, so clear
    // it to leave the story in the resting state used for screenshots.
    (document.activeElement as HTMLElement | null)?.blur();
  },
};

/** The host's candidate is a tailnet address, so the route reads Tailnet. */
export const SectionP2PTailnet: Story = {
  decorators: [
    withHosts(studioHosts()),
    withRuntime(ready({ path: "p2p", phase: "active", cooldownRemainingMs: 0, selectedPair: TAILNET_PAIR })),
  ],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Neither end classifies, so the path stays a bare P2P. */
export const SectionP2PUnknownRoute: Story = {
  decorators: [
    withHosts(studioHosts()),
    withRuntime(ready({ path: "p2p", phase: "active", cooldownRemainingMs: 0, selectedPair: UNKNOWN_PAIR })),
  ],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Cooling down still names the failed pair's route in its own row. */
export const SectionCoolingDown: Story = {
  decorators: [
    withHosts(studioHosts()),
    withRuntime(
      ready({
        path: "relay",
        phase: "cooldown",
        cooldownRemainingMs: 120_000,
        lastFailure: {
          stage: "ice",
          reason: "the ICE connection failed",
          agoMs: 12_000,
          pair: LAN_PAIR,
        },
      }),
    ),
  ],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionLastFailure: Story = {
  decorators: [
    withHosts(studioHosts()),
    withRuntime(
      ready({
        path: "relay",
        phase: "idle",
        cooldownRemainingMs: 0,
        lastFailure: {
          stage: "ice",
          reason: "the ICE connection failed",
          agoMs: 45_000,
          pair: TAILNET_PAIR,
        },
      }),
    ),
  ],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionRtcUnsupportedHost: Story = {
  decorators: [
    withHosts(studioHosts()),
    withRuntime(ready({ path: "relay", phase: "idle", cooldownRemainingMs: 0 })),
  ],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionRtcUnsupportedBrowser: Story = {
  args: { rtcAvailable: false },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Disconnected: the panel still changes the preference for the next connect. */
export const SectionDisconnected: Story = {
  decorators: [withHosts(fakeHosts([STUDIO_HOST], null)), withRuntime(connecting)],
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** The sidebar footer's hosts button, opened. */
export const Menu: Story = {
  decorators: [withHosts(), withRuntime(relay)],
  render: () => (
    <div className="flex justify-end pt-40">
      <HostsMenu />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Hosts" }));
  },
};

/** What the connection-failure screens show under their message. */
export const Fallback: Story = {
  decorators: [withHosts(), withRuntime(relay), withAccount(signedIn())],
  render: () => <HostsFallback />,
};

/** Direct only with no reachable P2P path: the failure page plus the inline Hosts panel. */
export const DirectOnlyFailure: Story = {
  decorators: [withHosts(studioHosts()), withRuntime(relay), withAccount(signedIn())],
  parameters: { canvasWidth: "full" },
  render: () => (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-6">
      <VStack gap={4} hAlign="center" style={{ maxWidth: 420 }}>
        <Banner
          status="error"
          title="Direct connection unavailable"
          description="This host can't be reached without the relay, and the peer-to-peer link didn't connect."
        />
        <Text type="supporting" style={{ textAlign: "center" }}>
          Details: the ICE connection failed
        </Text>
        <Text type="supporting" style={{ textAlign: "center" }}>
          Change this host's connection mode under Hosts below, then retry.
        </Text>
        <HStack gap={2}>
          <Button label="Retry" variant="secondary" />
        </HStack>
      </VStack>
      <HostsFallback canSwitch />
    </div>
  ),
};
