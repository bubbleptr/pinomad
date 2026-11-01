import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { HOST_LINK_REQUEST, signedIn, withAccount } from "../../test/story-fixtures.tsx";
import { HostLinkCodeForm, HostLinkConfirm, HostLinkEntry, HostLinkOutcome } from "./host-link-entry.tsx";

// Confirming a host that ran `pinomad join <origin>` without a token (#496),
// one story per step. The container starts on the entry; the later steps are
// its view components with the props the container passes.

const meta = {
  title: "Widgets/Account/HostLink",
  component: HostLinkEntry,
  decorators: [withAccount(signedIn())],
} satisfies Meta<typeof HostLinkEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The code field, as Add a host and the first-host home show it. */
export const Entry: Story = {};

/** Opened at /host-link: Cancel closes the dialog. */
export const EntryWithCancel: Story = { args: { onClose: fn() } };

/** A wrong, spent or expired code. */
export const LookupNotFound: Story = {
  render: () => (
    <HostLinkCodeForm code="KXHNBWCV" error={{ code: "not_found", status: 404 }} onChange={fn()} onSubmit={fn()} />
  ),
};

/** Locked out after too many wrong codes. */
export const LookupRateLimited: Story = {
  render: () => (
    <HostLinkCodeForm code="KXHNBWCV" error={{ code: "rate_limited", status: 429 }} onChange={fn()} onSubmit={fn()} />
  ),
};

/** Which machine is asking, before anything is sent. */
export const Confirm: Story = {
  render: () => (
    <HostLinkConfirm
      request={{ ...HOST_LINK_REQUEST, expiresAt: Date.now() + 9 * 60_000 }}
      onConfirm={fn()}
      onDeny={fn()}
      onBack={fn()}
    />
  ),
};

/** The host asked from another address than this device: maybe not the user's machine. */
export const ConfirmDifferentNetwork: Story = {
  render: () => (
    <HostLinkConfirm
      request={{ ...HOST_LINK_REQUEST, ipDiffers: true, expiresAt: Date.now() + 9 * 60_000 }}
      onConfirm={fn()}
      onDeny={fn()}
      onBack={fn()}
    />
  ),
};

/** The ten minutes ran out on the confirm page: Confirm is off. */
export const Expired: Story = {
  render: () => (
    <HostLinkConfirm request={{ ...HOST_LINK_REQUEST, expiresAt: Date.now() - 1 }} onConfirm={fn()} onDeny={fn()} onBack={fn()} />
  ),
};

/** Confirm found the request gone: answered elsewhere, or expired in between. */
export const AnswerFailed: Story = {
  render: () => (
    <HostLinkConfirm
      request={{ ...HOST_LINK_REQUEST, expiresAt: Date.now() + 4 * 60_000 }}
      error={{ code: "not_found", status: 404 }}
      onConfirm={fn()}
      onDeny={fn()}
      onBack={fn()}
    />
  ),
};

export const Confirmed: Story = {
  render: () => <HostLinkOutcome outcome="confirmed" name={HOST_LINK_REQUEST.name} onDone={fn()} />,
};

export const Denied: Story = {
  render: () => <HostLinkOutcome outcome="denied" name={HOST_LINK_REQUEST.name} onDone={fn()} />,
};
