import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import type { RtcDiagnostics } from "@pinomad/protocol/remote-durable.ts";
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

/** The live path after the relay-to-P2P handoff. */
export const SectionP2P: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({ path: "p2p", phase: "active", selectedCandidateType: "host", cooldownRemainingMs: 0 }),
  },
  play: ({ canvasElement }) => openConnection(canvasElement),
};

export const SectionCoolingDown: Story = {
  decorators: [withHosts(studioHosts())],
  args: {
    connectedHostKey: STUDIO_HOST.hostKey,
    hostMinor: 23,
    rtcAvailable: true,
    remote: diagnostics({
      path: "relay",
      phase: "cooldown",
      selectedCandidateType: "srflx",
      cooldownRemainingMs: 120_000,
      lastFailure: { stage: "ice", reason: "the ICE connection failed" },
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
      selectedCandidateType: "host",
      cooldownRemainingMs: 0,
      lastFailure: { stage: "ice", reason: "the ICE connection failed" },
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
