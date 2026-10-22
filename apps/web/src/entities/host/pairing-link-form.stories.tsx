import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PairingLinkForm } from "./pairing-link-form.tsx";

const meta = {
  title: "Entities/Host/PairingLinkForm",
  component: PairingLinkForm,
} satisfies Meta<typeof PairingLinkForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

// A valid link would set the hash and reload the page, so only rejected
// links are played.
export const NotAPairingLink: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "Pairing link" }), "https://example.com/docs");
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(await canvas.findByText("Not a pairing link")).toBeInTheDocument();
  },
};

export const TokenLink: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "Pairing link" }), "http://mbp:7777/#token=abc123");
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(await canvas.findByText(/Token links can't pair a device/)).toBeInTheDocument();
  },
};
