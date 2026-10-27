import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
import type { RtcSelectedPair } from "@pinomad/protocol/rtc.ts";
import { DEVBOX_HOST, fakeHosts, HOME_HOST, signedIn, withAccount, withHosts } from "../../test/story-fixtures.tsx";
import { HostsFallback, HostsMenu, HostsSection, type HostsRtc } from "./hosts.tsx";

// Picking or forgetting a host reloads the page, so these stories are for looking, not clicking.
const meta = {
  title: "Widgets/AppFrame/Hosts",
  component: HostsSection,
  args: { connection: "connected", connectedHostKey: HOME_HOST.hostKey },
} satisfies Meta<typeof HostsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

// The P2P panel is easier to read with a plain machine name in screenshots
// and story text; the shared HOME_HOST label is a sanitized placeholder.
const STUDIO_HOST = { ...HOME_HOST, name: "Studio" };
const studioHosts = () => fakeHosts([STUDIO_HOST], STUDIO_HOST.hostKey);

const diagnostics = (next: RtcDiagnostics): HostsRtc => ({
  rtcDiagnostics: () => next,
  setConnectionMode: () => {},
});

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

const openConnection = async (canvasElement: HTMLElement): Promise<void> => {
  const buttons = within(canvasElement).getAllByRole("button", { name: /^Connection to / });
  await userEvent.click(buttons[0]!);
};

export const Section: Story = { decorators: [withHosts()] };

export const SectionReconnecting: Story = { decorators: [withHosts()], args: { connection: "reconnecting" } };

/** A host paired before 5.12 announced no name, so it shows its address. */
export const SectionUnnamedHost: Story = {
  decorators: [withHosts(fakeHosts([HOME_HOST, { ...DEVBOX_HOST, name: undefined }]))],
};

export const SectionEmpty: Story = {
  decorators: [withHosts(fakeHosts([], null))],
  args: { connection: undefined, connectedHostKey: undefined },
};

/**
 * A live LAN route with both addresses revealed; the previous attempt's
 * failure stays visible even while the current link is active.
 */
export const SectionP2P: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({
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
  },
  play: async ({ canvasElement }) => {
    await openConnection(canvasElement);
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Show addresses" }));
  },
};

/** The host's candidate is a tailnet address, so the route reads Tailnet. */
export const SectionP2PTailnet: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({
      path: "p2p",
      phase: "active",
      cooldownRemainingMs: 0,
      selectedPair: TAILNET_PAIR,
    }),
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Neither end classifies, so the path stays a bare P2P. */
export const SectionP2PUnknownRoute: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({
      path: "p2p",
      phase: "active",
      cooldownRemainingMs: 0,
      selectedPair: UNKNOWN_PAIR,
    }),
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Cooling down still names the failed pair's route in its own row. */
export const SectionCoolingDown: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({
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
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionLastFailure: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({
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
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionRtcUnsupportedHost: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 22,
    rtcAvailable: true,
    remote: diagnostics({ path: "relay", phase: "idle", cooldownRemainingMs: 0 }),
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionRtcUnsupportedBrowser: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: false,
    remote: diagnostics({ path: "relay", phase: "idle", cooldownRemainingMs: 0 }),
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** Disconnected: the panel still changes the preference for the next connect. */
export const SectionDisconnected: Story = {
  decorators: [withHosts(fakeHosts([STUDIO_HOST], null))],
  args: { connection: undefined, connectedHostKey: undefined },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

/** The sidebar footer's hosts button, opened. */
export const Menu: Story = {
  decorators: [withHosts()],
  render: (args) => (
    <div className="flex justify-end pt-40">
      <HostsMenu {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Hosts" }));
  },
};

/** What the connection-failure screens show under their message. */
export const Fallback: Story = {
  decorators: [withHosts(), withAccount(signedIn())],
  render: () => <HostsFallback />,
};

/** Direct only with no reachable P2P path: the failure page plus the inline Hosts panel. */
export const DirectOnlyFailure: Story = {
  decorators: [withHosts(studioHosts()), withAccount(signedIn())],
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
      <HostsFallback />
    </div>
  ),
};
