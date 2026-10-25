import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
import { DevicesSection } from "./devices-section.tsx";

const offer = (url: string) => ({ url, expiresAt: Date.now() + 60_000 });

/** Open Devices → Pair a device with the offer the host would have returned. */
async function openOffer(url: string): Promise<void> {
  const view = fakeView({ devices: [] });
  const remote = fakeRemote(view, { createPairing: async () => offer(url) });
  const user = userEvent.setup();
  render(<DevicesSection view={view} remote={remote} />);
  await user.click(screen.getByRole("button", { name: "Pair a device" }));
}

describe("DevicesSection pairing QR", () => {
  it.each([
    ["localhost", "http://localhost:7422/#pair=AAAA.secret"],
    ["another 127.x", "http://127.0.0.2:7422/#pair=AAAA.secret"],
    ["IPv6 loopback", "http://[::1]:7422/#pair=AAAA.secret"],
  ])("shows a link-only hint for %s", async (_label, url) => {
    await openOffer(url);
    expect(await screen.findByText("This link only works on this machine", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  });

  it("shows a QR for a non-loopback offer", async () => {
    await openOffer("https://192.168.1.20:7422/#pair=AAAA.secret");
    expect(await screen.findByRole("img", { name: "Pairing QR code" })).toBeInTheDocument();
  });
});
