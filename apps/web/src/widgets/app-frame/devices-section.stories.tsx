import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { fakeRemote, fakeView, SELF } from "../../test/story-fixtures.tsx";
import { DevicesSection } from "./devices-section.tsx";

const view = fakeView();

const meta = {
  title: "Widgets/AppFrame/DevicesSection",
  component: DevicesSection,
  args: { view, remote: fakeRemote(view), self: SELF },
} satisfies Meta<typeof DevicesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PairingOffer: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Pair a device" }));
  },
};

export const PairingFails: Story = {
  args: {
    remote: fakeRemote(view, {
      createPairing: () => Promise.reject(new Error("Remote access is off. Run `pinomad remote enable` on the host.")),
    }),
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Pair a device" }));
  },
};

export const Empty: Story = { args: { view: fakeView({ devices: [] }) } };

export const Disconnected: Story = { args: { view: fakeView({ connection: "reconnecting" }) } };
