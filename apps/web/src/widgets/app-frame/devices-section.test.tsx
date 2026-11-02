import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { keyPairFromPrivate } from "@pinomad/protocol/noise.ts";
import { fromBase64Url, toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import { HostsContext } from "../../entities/host/host-store.ts";
import { DEVBOX_HOST, fakeHosts, fakeRemote, fakeView } from "../../test/story-fixtures.tsx";
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

describe("DevicesSection unpairing", () => {
  const self = keyPairFromPrivate(fromBase64Url(DEVBOX_HOST.privateKey));
  const selfKey = toBase64Url(self.publicKey);
  const otherKey = "B".repeat(43);

  function renderDevices() {
    const view = fakeView({
      devices: [
        { publicKey: selfKey, name: "Mac Desktop", pairedAt: 0, source: "local" },
        { publicKey: otherKey, name: "iPhone", pairedAt: 0, source: "qr" },
      ],
    });
    const remote = fakeRemote(view);
    const hosts = fakeHosts([DEVBOX_HOST], DEVBOX_HOST.hostKey);
    render(
      <HostsContext.Provider value={hosts}>
        <DevicesSection view={view} remote={remote} self={self} hostKey={DEVBOX_HOST.hostKey} />
      </HostsContext.Provider>,
    );
    return { remote, hosts };
  }

  it("forgets the host here too when this device unpairs itself", async () => {
    const { remote, hosts } = renderDevices();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Unpair Mac Desktop…" }));
    await user.click(within(screen.getByRole("group", { name: "Unpair this device?" })).getByRole("button", { name: "Unpair" }));

    await waitFor(() => expect(hosts.forget).toHaveBeenCalledWith(DEVBOX_HOST.hostKey));
    expect(remote.controller.revokeDevice).toHaveBeenCalledWith(selfKey);
  });

  it("unpairs another device on the host only", async () => {
    const { remote, hosts } = renderDevices();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Unpair iPhone…" }));
    await user.click(within(screen.getByRole("group", { name: "Unpair iPhone?" })).getByRole("button", { name: "Unpair" }));

    await waitFor(() => expect(remote.controller.revokeDevice).toHaveBeenCalledWith(otherKey));
    expect(hosts.forget).not.toHaveBeenCalled();
  });
});
