import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import type { DeviceEntry } from "@pinomad/protocol/devices.ts";
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";

export function DevicesDialog({
  view,
  remote,
  self,
  onClose,
}: {
  view: DurableView;
  remote: RemoteDurable;
  self?: KeyPair;
  onClose: () => void;
}) {
  const connected = view.connection === "connected";
  const selfKey = self === undefined ? undefined : toBase64Url(self.publicKey);
  const [offer, setOffer] = useState<{ url: string; expiresAt: number }>();
  const [pairError, setPairError] = useState<string>();
  const pair = (): void => {
    setPairError(undefined);
    void remote.controller.createPairing().then(setOffer, (error: unknown) => {
      setPairError(error instanceof Error ? error.message : String(error));
    });
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} width={440}>
      <Layout
        header={
          <DialogHeader
            title="Devices"
            subtitle="Paired devices can reach this host over the secure channel."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4} padding={2}>
              {view.devices.length === 0 ? (
                <Text type="supporting">No paired devices.</Text>
              ) : (
                <List density="compact">
                  {view.devices.map((device) => (
                    <DeviceRow
                      key={device.publicKey}
                      device={device}
                      isSelf={device.publicKey === selfKey}
                      connected={connected}
                      remote={remote}
                    />
                  ))}
                </List>
              )}
              {pairError === undefined ? null : <Banner status="error" title="Could not create a pairing offer" description={pairError} />}
              {offer === undefined ? (
                <Button label="Pair a device" variant="secondary" isDisabled={!connected} onClick={pair} />
              ) : (
                <PairingOffer url={offer.url} expiresAt={offer.expiresAt} onRenew={pair} />
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function DeviceRow({
  device,
  isSelf,
  connected,
  remote,
}: {
  device: DeviceEntry;
  isSelf: boolean;
  connected: boolean;
  remote: RemoteDurable;
}) {
  return (
    <ListItem
      label={device.name}
      description={`Paired ${new Date(device.pairedAt).toLocaleDateString()}`}
      endContent={
        <HStack gap={2} vAlign="center">
          {isSelf ? <Token label="This device" size="sm" /> : null}
          <Button
            label="Revoke"
            variant="ghost"
            size="sm"
            isDisabled={!connected}
            onClick={() => void remote.controller.revokeDevice(device.publicKey)}
          />
        </HStack>
      }
    />
  );
}

function PairingOffer({ url, expiresAt, onRenew }: { url: string; expiresAt: number; onRenew: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (seconds === 0) {
    return (
      <HStack gap={2} vAlign="center">
        <Text type="supporting">Expired</Text>
        <Button label="New code" variant="secondary" size="sm" onClick={onRenew} />
      </HStack>
    );
  }
  // A loopback link only reaches clients on this machine: the QR would send a
  // phone to an address it cannot open (ADR-0020 §4), so show the hint instead.
  const loopback = new URL(url).hostname === "127.0.0.1";
  return (
    <VStack gap={3} hAlign="center">
      {loopback ? null : <QrImage text={url} />}
      <Text type="supporting" style={{ wordBreak: "break-all", userSelect: "all" }}>
        {url}
      </Text>
      {loopback ? (
        <Text type="supporting">
          This link only works on this machine — paste it into the desktop app. To pair a phone, start the host with
          --remote-port or --relay.
        </Text>
      ) : null}
      <Text type="supporting">
        Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </Text>
    </VStack>
  );
}

const QR_QUIET = 2;

function QrImage({ text }: { text: string }) {
  const qr = useMemo(() => encode(text, { border: 0 }), [text]);
  const size = qr.size + QR_QUIET * 2;
  return (
    <svg
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${size} ${size}`}
      width={200}
      height={200}
      style={{ display: "block" }}
    >
      {/* Fixed black-on-white: scanners need the contrast regardless of theme. */}
      <rect width={size} height={size} fill="#ffffff" />
      {/* One path, not per-module rects — rect seams anti-alias into a ragged grid that hurts scanning. */}
      <path
        shapeRendering="crispEdges"
        fill="#000000"
        d={qr.data
          .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + QR_QUIET} ${y + QR_QUIET}h1v1h-1z` : "")))
          .filter((segment) => segment !== "")
          .join("")}
      />
    </svg>
  );
}
