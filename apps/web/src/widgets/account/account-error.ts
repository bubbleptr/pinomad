import type { AccountError } from "@pinomad/client/account.ts";

/** Server and model error codes in words. Unknown codes fall through to the raw code. */
export function accountErrorMessage(error: AccountError): string {
  switch (error.code) {
    case "invalid_credentials":
      return "Wrong username or password.";
    case "rate_limited":
      return "Too many attempts. Wait a few minutes and try again.";
    case "network":
      return "Can't reach the server. Check the address and your connection.";
    case "origin_required":
      return "Enter the server address.";
    case "insecure_origin":
      return "The server address must start with https://.";
    case "unauthenticated":
      return "You were signed out. Sign in again.";
    case "accounts_disabled":
      return "This server doesn't have accounts turned on.";
    case "host_offline":
      return "The host is offline.";
    case "host_too_old":
      return "The host needs an update (run pinomad upgrade on it).";
    case "key_mismatch":
      return "The host's key doesn't match its account record. Run pinomad join on it again.";
    case "disabled":
      return "The host doesn't accept account devices. Turn it on in Devices, or pair with a QR code.";
    case "not_joined":
    case "rebinding":
      return "The host is moving between servers. Try again after it restarts.";
    case "host_timeout":
      return "The host didn't answer in time. Try again.";
    case "pair_rejected":
      return "The host refused this device. If you revoked it before, pair it with a QR code instead.";
    case "pair_unreachable":
      return "Couldn't reach the host on any offered path. Check your network connection or Tailscale and try again.";
    case "pair_timeout":
      return "The host didn't answer on any offered path in time. Try again.";
    case "pair_unsupported":
      return "This app can't connect to any address the host offered. The page may block an insecure ws:// path; try the desktop app or a secure address.";
    case "pairing_not_saved":
      return "Paired, but this device couldn't save the pairing.";
    case "invalid_invite":
      return "This invite code isn't valid. It may have been used or revoked.";
    case "invite_expired":
      return "This invite code has expired. Ask for a new one.";
    case "invalid_username":
      return "Use 2–32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.";
    case "weak_password":
      return "Use a password of at least 12 characters.";
    case "wrong_password":
      return "The current password is wrong.";
    case "current_device":
      return "That's the device you're using. Sign out instead.";
    case "admin_account":
      return "The server's admin account can't be deleted.";
    case "username_taken":
      return "That username is taken.";
    case "forbidden":
      return "Only the server's admin can do this.";
    default:
      return `Something went wrong (${error.code}).`;
  }
}
