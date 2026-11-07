import type { AccountError } from "@pinomad/client/account.ts";

/** Server and model error codes in words. Unknown codes fall through to the raw code. */
export function accountErrorMessage(error: AccountError): string {
  switch (error.code) {
    case "invalid_credentials":
      return "Wrong email or password.";
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
    case "weak_password":
      return "Use a password of at least 12 characters.";
    case "wrong_password":
      return "The password is wrong.";
    case "invalid_code":
      return "That code is wrong or has expired. Check the latest email, or send a new code.";
    case "invalid_email":
      return "Enter a valid email address.";
    case "registration_closed":
      return "This server isn't taking new accounts.";
    case "email_unavailable":
      return "This server can't send email right now. Try again later.";
    case "email_taken":
      return "Another account already uses that email.";
    case "password_required":
      return "Choose a password for the account.";
    case "invalid_reauth":
      return "The confirmation expired. Confirm again.";
    case "last_method":
      return "This is the only way to sign in to your account. Add another before removing it.";
    case "identity_taken":
      return "That account is already linked to another PiNomad account.";
    case "session_ended":
      return "You were signed out before linking finished. Sign in and try again.";
    case "no_email":
      return "Your account has no email to send a code to.";
    case "no_verified_email":
      return "The provider didn't give a verified email. Sign in another way, or verify your email there first.";
    case "superseded":
      return "You signed in another way while this sign-in was waiting.";
    case "access_denied":
      return "Sign-in was cancelled.";
    case "invalid_state":
      return "This sign-in expired or was started in another browser. Start again.";
    case "exchange_failed":
    case "invalid_token":
      return "The provider's answer couldn't be checked. Try again.";
    case "not_found":
      return "This sign-in expired. Start again.";
    case "host_removed":
      return "The host was removed from the account.";
    case "remove_unsupported":
      return "This server can't remove hosts yet. Run pinomad leave on the host instead.";
    case "current_device":
      return "That's the device you're using. Sign out instead.";
    default:
      return `Something went wrong (${error.code}).`;
  }
}
