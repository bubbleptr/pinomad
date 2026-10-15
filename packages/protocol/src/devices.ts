// Paired device registry — the shape of the host's session-scoped DevicesDoc.
// Mutable arrays: Durable's JsonObject requires them.

/**
 * How a device registered (ADR-0022 §6): a one-time offer the user was shown
 * ("qr"), a loopback-only offer for same-machine clients ("local"), or one the
 * joined server vouched for ("account"). Absent on entries predating sources.
 */
export type DeviceSource = "qr" | "local" | "account";

/** A device that completed pairing; `publicKey` is its base64url X25519 public key. */
export type DeviceEntry = {
  publicKey: string;
  name: string;
  pairedAt: number;
  source?: DeviceSource;
};

export type HostDevices = {
  devices: DeviceEntry[];
};
