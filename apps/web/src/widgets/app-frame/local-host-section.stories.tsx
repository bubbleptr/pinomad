import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { signedIn, withAccount, withDesktopLocalHost } from "../../test/story-fixtures.tsx";
import { LocalHostSection } from "./local-host-section.tsx";

const meta = {
  title: "Widgets/AppFrame/LocalHostSection",
  component: LocalHostSection,
  decorators: [withAccount(signedIn())],
} satisfies Meta<typeof LocalHostSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const running = { kind: "installed", running: true, stopped: false, stopping: false, detail: "running (pid 4242)" } as const;
const off = { kind: "installed", running: false, stopped: true, stopping: false, detail: "stopped" } as const;

const clickSwitch = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("switch"));
};

/** The installed host's service is up. */
export const Running: Story = { decorators: [withDesktopLocalHost({ state: running })] };

/** Turned off here or with `pinomad service stop`; it stays off across logins. */
export const Off: Story = { decorators: [withDesktopLocalHost({ state: off })] };

/** Turning off asks first: other devices lose this Mac, and running tasks finish first. */
export const ConfirmOff: Story = {
  decorators: [withDesktopLocalHost({ state: running })],
  play: clickSwitch,
};

/** `service stop` waits for running tasks; Cancel interrupts it and the host stays on. */
export const Stopping: Story = {
  decorators: [
    withDesktopLocalHost({
      state: running,
      stopLines: [
        "waiting for running tasks to finish",
        "  refactor-auth (pinomad): running for 4m",
        "  release-notes (website): running for 1m",
      ],
      stopWaits: true,
    }),
  ],
  play: async (context) => {
    await clickSwitch(context);
    // The dialog portals out of the canvas.
    await userEvent.click(await within(document.body).findByRole("button", { name: "Turn off" }));
  },
};

/** Back in This Mac while a stop still waits: the lines so far and Cancel, without turning it off again. */
export const StopStillRunning: Story = {
  decorators: [
    withDesktopLocalHost({
      state: running,
      stopLines: ["waiting for running tasks to finish", "  refactor-auth (pinomad): running for 4m"],
      stopWaits: true,
      stopInFlight: true,
    }),
  ],
};

/** Starting failed; the CLI's message goes in the banner. */
export const StartFailed: Story = {
  decorators: [
    withDesktopLocalHost({ state: off, startResult: { ok: false, message: "launchctl bootstrap failed: 5: Input/output error" } }),
  ],
  play: clickSwitch,
};

/** No host on this Mac: Set up this Mac installs one in the background and joins it to this account. */
export const NotInstalled: Story = { decorators: [withDesktopLocalHost({ state: { kind: "not-installed" } })] };

const setUp = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name: "Set up this Mac" }));
};

/** The installer running: its last lines and Cancel. */
export const Installing: Story = {
  decorators: [
    withDesktopLocalHost({
      state: { kind: "not-installed" },
      installLines: ["Downloading Node 26.12.1 (darwin-arm64)", "Installing pinomad@latest"],
      installWaits: true,
    }),
  ],
  play: setUp,
};

/** The installer failed: its message, Try again, and the command to run by hand. */
export const InstallFailed: Story = {
  decorators: [
    withDesktopLocalHost({
      state: { kind: "not-installed" },
      installLines: ["Downloading Node 26.12.1 (darwin-arm64)"],
      installResult: {
        outcome: "failed",
        message: "install.sh: could not download https://nodejs.org/dist/v26.12.1/node-v26.12.1-darwin-arm64.tar.gz",
      },
    }),
  ],
  play: setUp,
};

/** Installed, but joining the account failed: Try again mints a fresh token without installing again. */
export const JoinFailed: Story = {
  decorators: [
    withDesktopLocalHost({
      state: { kind: "not-installed" },
      joinResult: { ok: false, message: "the join token expired — generate a fresh one" },
    }),
  ],
  play: setUp,
};

/** Signed out there is no account for the new host to join. */
export const NotInstalledSignedOut: Story = {
  decorators: [withDesktopLocalHost({ state: { kind: "not-installed" } }), withAccount({ status: "signed-out", mode: "bearer" })],
};

/** A pinomad from before `service status --json`: no switch, just the upgrade. */
export const TooOld: Story = { decorators: [withDesktopLocalHost({ state: { kind: "too-old" } })] };

/** The installed pinomad couldn't run at all. */
export const CheckFailed: Story = {
  decorators: [
    withDesktopLocalHost({
      state: {
        kind: "error",
        message: "Couldn't run the installed pinomad: spawn /Users/me/.nvm/versions/node/v25.1.0/bin/node ENOENT",
      },
    }),
  ],
};
