// Paired device registry — the shape of the host's session-scoped DevicesDoc.
// Mutable arrays: Durable's JsonObject requires them.

/** A device that completed pairing; `publicKey` is its base64url X25519 public key. */
export type DeviceEntry = {
  publicKey: string;
  name: string;
  pairedAt: number;
};

export type HostDevices = {
  devices: DeviceEntry[];
};
