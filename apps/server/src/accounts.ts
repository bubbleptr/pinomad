// Server accounts (ADR-0022 §2): the server persists users with their
// verified emails (ADR-0044), sessions, join tokens, host-link requests
// (#495), host bindings, the APNs tokens each account's devices registered
// (ADR-0036), mailed codes, account devices with the keys hosts admitted
// them under (ADR-0037), and sign-in providers with the flows, pending
// choices, one-time codes and re-auth grants around them (ADR-0044) in
// <dataDir>/server.sqlite, guarded by the same one-process-per-directory lock
// the host uses. Secrets never reach the DB in the clear — passwords are
// scrypt hashes; session and join tokens, host-link device and user codes,
// mailed codes, provider-flow states, pending ids, one-time codes and re-auth
// grants are SHA-256. Apple's refresh tokens are kept as they are: revoking
// one sends it.
//
// `node:sqlite` needs Node: the server runs on Node like the host, not Bun.

import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { ApnsEnvironment } from "@pinomad/protocol/relay.ts";
import { normalizeHostName } from "@pinomad/protocol/settings.ts";
import { isDataDirInUse, lockDataDir } from "./lock.ts";
import { type MailBody, type MailContent, renderMail } from "./mail-template.ts";
import type { OAuthProvider, ProviderIdentity } from "./oauth.ts";

const DB_FILE = "server.sqlite";
const SCHEMA_VERSION = 11;

// Sessions die 30 days after issue and are never renewed — a stolen token has a
// hard ceiling, and re-logging-in is the only way forward.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Join tokens are short-lived and single-use (ADR-0022 §3): a leaked one is
// only useful for minutes and only once.
const JOIN_TOKEN_TTL_MS = 10 * 60 * 1000;

// Host links (#495, RFC 8628): the short code a person types to let a host
// collect a join token. 8 letters from 20 consonants with no lookalikes —
// about 34.6 bits, guessable only under the lockout below — shown XXXX-XXXX,
// alive as long as a join token. The host polls no faster than the interval.
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const HOST_LINK_TTL_MS = JOIN_TOKEN_TTL_MS;
const HOST_LINK_INTERVAL_S = 5;
// RFC 8252 §8.13 / RFC 6749 §4.1.2: an authorization code lives minutes, not
// the request's ten; the host trades it the moment its listener receives it.
const HOST_LINK_CODE_TTL_MS = 2 * 60_000;
// RFC 8628 §3.5: a host told to slow down adds 5 s to its interval for good.
const SLOW_DOWN_STEP_S = 5;
// A poll sent on schedule can still arrive a little early when the previous
// one was held up on the way; only a gap shorter by more than this is too fast.
const POLL_SLACK_MS = 1000;
const HOST_OS_MAX_CODEPOINTS = 64;

/** The canonical form of a typed code, ignoring case, dashes and spaces; undefined when it can't be one. */
export function normalizeUserCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== USER_CODE_LENGTH) return undefined;
  for (const letter of code) if (!USER_CODE_ALPHABET.includes(letter)) return undefined;
  return code;
}

/** How a code is shown: XXXX-XXXX. */
export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

// Mailed codes (ADR-0044 §2): six digits, alive ten minutes, dead after five
// wrong guesses. Wrong guesses also count toward the login lockout.
const EMAIL_CODE_TTL_MS = 10 * 60_000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;

/** What a mailed code is for; a code only ever answers its own purpose. */
type EmailCodePurpose = "signup" | "reset" | "add_email" | "reauth";

// Provider sign-in (ADR-0044 §4, §5): a flow lives as long as a person might
// spend on the provider's pages, and so does the "no account yet" choice; a
// native client trades its one-time code at once.
const OAUTH_FLOW_TTL_MS = 10 * 60_000;
const OAUTH_PENDING_TTL_MS = 10 * 60_000;
const OAUTH_CODE_TTL_MS = 2 * 60_000;

// A re-auth grant (ADR-0044 §6) covers a few confirmations in a row.
const REAUTH_TTL_MS = 5 * 60_000;

/** How notices name a provider. */
const PROVIDER_NAMES: Record<OAuthProvider, string> = { google: "Google", github: "GitHub", apple: "Apple" };

// RFC 5321 caps a path at 256 octets, so an address at 254, and a local
// part at 64. Only a bare addr-spec with an unquoted dot-atom local part and
// a dotted hostname passes: header syntax like `a<victim@x>` or a display
// name would be one string here but another mailbox to the SMTP library,
// slipping past the per-email limit. Beyond that shape, the mailed code is
// what proves an address works.
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The one form of an email used for limits, storage and delivery alike:
 * trimmed and lowercased; undefined when it isn't a bare address.
 */
export function normalizeEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) && email.indexOf("@") <= MAX_LOCAL_PART_LENGTH
    ? email
    : undefined;
}

/**
 * How the server sends mail (ADR-0044 §2): SMTP in production (mail.ts),
 * a capturing fake in tests. Every mail has a text and an HTML part
 * (mail-template.ts).
 */
export interface Mailer {
  send(to: string, subject: string, body: MailBody): Promise<void>;
}

// Push registrations (ADR-0036 §2, §5): the app refreshes its token on every
// connect and foreground, so one untouched for 90 days belongs to a device
// that is gone; an account keeps its 32 most recently refreshed.
const PUSH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PUSH_TOKENS_PER_USER = 32;

// Same bounds the host applies to `setPushToken` (apps/host/src/push.ts):
// Apple does not fix the length, so hex up to 256 characters.
const APNS_TOKEN_PATTERN = /^(?:[0-9a-f]{2})+$/;
const APNS_TOKEN_MAX_CHARS = 256;

// Account devices (ADR-0037 §1): the client's own ID for itself is 128 random
// bits in base64url (22 characters); the bound leaves room for a longer one.
// Names are display labels, clipped like the host clips device names.
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const DEVICE_NAME_MAX_CODEPOINTS = 64;

// A host that admitted a device while its control connection was down sends
// the report after reconnecting (ADR-0037 §2): the offer's expiry plus this
// grace is how long the server still takes it, and how long an unreported
// vouching is kept.
const ADMISSION_REPORT_GRACE_MS = 24 * 60 * 60 * 1000;

// The expiry a host puts on an account offer is its own claim; the server
// keeps at most the host's offer lifetime (5 minutes) plus slack, so a host
// can't hold unreported vouchings, or their report window, open longer.
const MAX_OFFER_TTL_MS = 6 * 60 * 1000;

/** What a client says about itself at sign-in (ADR-0037 §1); `name` is already clipped. */
export interface DeviceClaim {
  readonly id: string;
  readonly name?: string;
}

/**
 * Validates the optional `device` of a login or sign-up body: undefined when
 * absent, "invalid" when malformed, else the claim with a trimmed, clipped
 * name (blank means unknown).
 */
export function parseDeviceClaim(raw: unknown): DeviceClaim | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "invalid";
  const { id, name } = raw as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id)) return "invalid";
  if (name !== undefined && typeof name !== "string") return "invalid";
  const clipped = [...(name ?? "").trim()].slice(0, DEVICE_NAME_MAX_CODEPOINTS).join("").trim();
  return clipped === "" ? { id } : { id, name: clipped };
}

/** The lowercase token when `raw` is a plausible APNs device token, else undefined. */
export function normalizeApnsToken(raw: string): string | undefined {
  const token = raw.toLowerCase();
  return token.length <= APNS_TOKEN_MAX_CHARS && APNS_TOKEN_PATTERN.test(token) ? token : undefined;
}

// scrypt parameters are embedded in the stored string, so they can be raised
// later without a flag day for existing hashes.
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;

// Shared with the login endpoint (api.ts): credentials outside these bounds
// are refused there, so creating one here would mint an account nobody can
// log into.
export const MIN_PASSWORD_CODEPOINTS = 12;
export const MAX_PASSWORD_CODEPOINTS = 1024;
export const MAX_USERNAME_CODEPOINTS = 254;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { readonly N: number; readonly r: number; readonly p: number },
) => Promise<Buffer>;

/** A valid-format hash whose verify always fails — unknown users still pay the scrypt cost. */
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${"A".repeat(22)}$${"A".repeat(43)}`;

export interface LoginLimits {
  /** scrypt computations at once; default 4. */
  readonly scryptConcurrency?: number;
  /** Pending scrypt work beyond the running set; default 64. Full → 429. */
  readonly scryptQueue?: number;
  /** Login attempts per source IP per window; default 30 per 5 min. */
  readonly ipMaxAttempts?: number;
  readonly ipWindowMs?: number;
  /** Failed logins (and wrong mailed codes) per account before lockout; default 5 per 15 min. */
  readonly userMaxFailures?: number;
  readonly userWindowMs?: number;
  /** Cap on both counter maps — a sprayed key space can't grow them without bound. */
  readonly counterMaxEntries?: number;
}

/** Abuse bounds for host links (#495); each has a default. */
export interface HostLinkLimits {
  /** Requests one source IP may start per window; default 10 per 10 min. */
  readonly startMaxPerIp?: number;
  readonly startWindowMs?: number;
  /** Unexpired requests at once, server-wide; default 1000. Full → 503. */
  readonly maxPending?: number;
  /** Wrong codes (lookup, confirm, deny) per account and per IP before lockout; default 10 and 30 per 15 min. */
  readonly userMaxFailures?: number;
  readonly ipMaxFailures?: number;
  readonly failureWindowMs?: number;
  /** Cap on each counter map. */
  readonly counterMaxEntries?: number;
}

/** Abuse bounds for mailing codes (ADR-0044 §2); each has a default. */
export interface CodeLimits {
  /** Codes one source IP may ask for per window; default 10 per hour. */
  readonly ipMax?: number;
  readonly ipWindowMs?: number;
  /** Codes one email may be sent per window; default 5 per hour. */
  readonly emailMax?: number;
  readonly emailWindowMs?: number;
  /** Codes the whole server sends per day; default 1000. */
  readonly dailyMax?: number;
  /** Cap on each counter map. */
  readonly counterMaxEntries?: number;
}

export interface AccountsOptions {
  readonly dataDir: string;
  /**
   * Bootstrap credentials (PINOMAD_SERVER_USER/PASSWORD); required only while
   * the users table is empty. A user with an `@` is an email, taken as
   * verified; anything else is a legacy username (ADR-0044 §8).
   */
  readonly bootstrapUser?: string;
  readonly bootstrapPassword?: string;
  readonly now?: () => number;
  readonly lockStaleMs?: number;
  readonly limits?: LoginLimits;
  readonly hostLinkLimits?: HostLinkLimits;
  /** Without one, email sign-up, password reset and adding an email are off (ADR-0044 §2). */
  readonly mailer?: Mailer;
  /** PINOMAD_SERVER_REGISTRATION; default "closed" (ADR-0044 §7). */
  readonly registration?: "open" | "closed";
  readonly codeLimits?: CodeLimits;
  readonly oauthLimits?: OAuthLimits;
}

/** Abuse bounds for starting provider sign-ins, which anyone may do; each has a default. */
export interface OAuthLimits {
  /** Flows one source IP may start per window; default 30 per 10 min. */
  readonly startMaxPerIp?: number;
  readonly startWindowMs?: number;
  /** Unexpired flows at once, server-wide; default 10000. Full → 503. */
  readonly maxPending?: number;
}

/**
 * The account as responses show it: `username` is the email, or the legacy
 * username of an account that has none yet (ADR-0044 §8).
 */
export interface AccountUser {
  /** Stable and opaque (#640): what clients file the account's pairings under. */
  readonly accountId: string;
  readonly username: string;
  readonly email?: string;
}

/** A session the account was just signed in with. */
export interface SignedIn {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: AccountUser;
}

export type LoginResult = ({ readonly status: "ok" } & SignedIn) | { readonly status: "invalid" } | { readonly status: "limited" };

/**
 * Asking for a mailed code. `sent` is all an anonymous caller learns, whether
 * or not a mail went out; `closed` means sign-up or mail is off. A signed-in
 * caller can also hear `wrong_password`, or `taken` when another account has
 * the email.
 */
export type SendCodeResult = "sent" | "limited" | "closed" | "taken" | "wrong_password" | "invalid_reauth";

/**
 * The second check before an action on the account (ADR-0044 §6): the
 * password, or a grant from POST /api/reauth, which only counts for the
 * session `token` it was issued to.
 */
export type Confirmation = { readonly password: string } | { readonly reauth: string; readonly token: string };

/** Why a confirmation failed: a wrong password, or a grant that is unknown, lapsed or another session's. */
export type ConfirmationFailure = "wrong_password" | "invalid_reauth";

/** An Apple refresh token to revoke, with the client_id it was issued to (ADR-0044 §9). */
export interface AppleGrant {
  readonly refreshToken: string;
  readonly clientId: string;
}

export type ChangePasswordResult =
  | { readonly status: "ok" }
  /** `unauthenticated`: the caller's session ended while the password was checked. */
  | { readonly status: "refused"; readonly reason: ConfirmationFailure | "weak_password" | "unauthenticated" }
  | { readonly status: "limited" };

export type DeleteAccountResult =
  /** The account's hosts, whose control connections lost their authorization, and Apple's grants to revoke. */
  | { readonly status: "ok"; readonly hostIds: readonly string[]; readonly appleGrants: readonly AppleGrant[] }
  /** `unauthenticated`: the caller's session ended while the password was checked. */
  | { readonly status: "refused"; readonly reason: ConfirmationFailure | "unauthenticated" }
  | { readonly status: "limited" };

/** Where a native client's browser goes back to, and how it proves it started the flow (ADR-0044 §5). */
export interface NativeRedirect {
  /** `pinomad://auth` or `http://127.0.0.1:<port>[/ or /callback]`. */
  readonly redirectUri: string;
  /** base64url(SHA-256(verifier)), RFC 7636 S256. */
  readonly codeChallenge: string;
  readonly state: string;
}

/**
 * A provider sign-in in flight, bound to the browser that started it by a
 * cookie whose hash is `bindingHash`. `native` runs in a browser the app
 * opened and ends in the app's PKCE exchange; `link` adds the identity to a
 * signed-in account.
 */
export interface OAuthFlow {
  readonly provider: OAuthProvider;
  readonly kind: "web" | "native" | "link";
  /** The server's own PKCE verifier and OIDC nonce toward the provider. */
  readonly verifier: string;
  readonly nonce: string;
  readonly bindingHash?: string;
  readonly native?: NativeRedirect;
  readonly linkUserId?: number;
  /** link: the SHA-256 of the session token that started it. */
  readonly linkSessionHash?: string;
}

/**
 * How a provider sign-in that found no account finishes once the person
 * chooses: in the browser that started it (`web`), by a code sent to a
 * native client's redirect (`native`), or in the answer to iOS's own call
 * (`direct`, native Sign in with Apple). Both browser kinds stay bound to
 * that browser's cookie: a pending id alone must never let someone else
 * finish the sign-in, or link the identity to their own account.
 */
export type PendingCompletion =
  | { readonly kind: "web"; readonly bindingHash: string }
  | { readonly kind: "native"; readonly bindingHash: string; readonly native: NativeRedirect }
  | { readonly kind: "direct" };

/** A provider sign-in that found no account (ADR-0044 §4, step 3). */
export interface PendingSignIn {
  readonly provider: OAuthProvider;
  readonly email?: string;
  readonly name?: string;
  readonly completion: PendingCompletion;
}

export type ResolveIdentityResult =
  | { readonly status: "user"; readonly userId: number }
  | { readonly status: "pending"; readonly id: string; readonly email?: string }
  | { readonly status: "refused"; readonly reason: "registration_closed" };

export type PendingResult =
  | { readonly status: "ok"; readonly userId: number; readonly completion: PendingCompletion }
  | {
      readonly status: "refused";
      readonly reason:
        | "not_found"
        | "registration_closed"
        | "no_verified_email"
        | "email_taken"
        | "identity_taken"
        | "password_required"
        | "weak_password";
    }
  | { readonly status: "limited" };

/** A sign-in method as account settings list it. */
export interface IdentityRow {
  readonly provider: OAuthProvider;
  readonly email?: string;
  readonly createdAt: number;
}

export type RemoveIdentityResult =
  | { readonly status: "ok"; readonly appleGrants: readonly AppleGrant[] }
  | { readonly status: "refused"; readonly reason: ConfirmationFailure | "not_found" | "last_method" }
  | { readonly status: "limited" };

export type ReauthResult =
  | { readonly status: "ok"; readonly reauth: string; readonly expiresAt: number }
  /** `unauthenticated`: the session ended while the password was checked. */
  | { readonly status: "refused"; readonly reason: "wrong_password" | "invalid_code" | "unauthenticated" }
  | { readonly status: "limited" };

export type RegisterResult =
  | ({ readonly status: "ok" } & SignedIn)
  | { readonly status: "refused"; readonly reason: "registration_closed" | "weak_password" | "invalid_code" }
  | { readonly status: "limited" };

export type ResetPasswordResult =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly reason: "email_unavailable" | "weak_password" | "invalid_code" }
  | { readonly status: "limited" };

export type SetEmailResult =
  | { readonly status: "ok"; readonly user: AccountUser }
  | { readonly status: "refused"; readonly reason: "email_unavailable" | ConfirmationFailure | "invalid_code" | "email_taken" }
  | { readonly status: "limited" };

export type StartHostLinkResult =
  | {
      readonly status: "ok";
      readonly mode: "code";
      /** The host's secret for polling; only its SHA-256 is stored. */
      readonly deviceCode: string;
      /** What the person types, as XXXX-XXXX. */
      readonly userCode: string;
      readonly expiresAt: number;
      /** Seconds between polls (RFC 8628). */
      readonly interval: number;
    }
  | {
      readonly status: "ok";
      readonly mode: "loopback";
      /** Names the request on the confirm page; only its SHA-256 is stored. */
      readonly requestId: string;
      readonly expiresAt: number;
    }
  | { readonly status: "limited" }
  | { readonly status: "busy" };

/** A host's poll in RFC 8628 terms: `pending` is authorization_pending, `expired` is expired_token. */
export type PollHostLinkResult =
  | { readonly status: "pending" }
  | { readonly status: "slow_down"; readonly interval: number }
  | { readonly status: "expired" }
  | { readonly status: "denied" }
  | { readonly status: "confirmed"; readonly token: string; readonly expiresAt: number };

/** A pending host link as the confirm page shows it. */
export interface HostLinkRequest {
  readonly hostId: string;
  readonly name: string;
  readonly os: string;
  readonly sourceIp: string;
  /** The host's IP isn't the confirmer's: the page warns that this may not be their machine. */
  readonly ipDiffers: boolean;
  readonly expiresAt: number;
}

/** What the browser types (#495), or the request id a loopback link put in its URL (#513). */
export type HostLinkRef = { readonly userCode: string } | { readonly requestId: string };

/** A host's loopback listener and its PKCE challenge (#513, RFC 8252). */
export interface HostLinkLoopback {
  readonly redirectUri: string;
  /** base64url(SHA-256(verifier)), RFC 7636 S256. */
  readonly codeChallenge: string;
  readonly state: string;
}

export type HostLinkCodeResult<T = Record<never, never>> =
  | ({ readonly status: "ok" } & T)
  | { readonly status: "not_found" }
  | { readonly status: "limited" };

export type JoinHostResult =
  | { readonly status: "joined"; readonly username: string }
  | { readonly status: "refused"; readonly reason: "invalid_token" | "expired_token" };

/** A bound host row as the API lists and looks it up. */
export interface HostRow {
  readonly hostId: string;
  readonly userId: number;
  readonly noisePublicKey: string;
  readonly name: string;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
  /**
   * Whether the host declared "device-reports" at its latest register
   * (ADR-0037 §5): without it, devices it admitted can only be revoked on
   * the host itself.
   */
  readonly deviceReports: boolean;
}

/**
 * One account device's standing on one host it joined through the account
 * (ADR-0037 §6): admitted, a revocation the host hasn't acknowledged yet,
 * or revoked.
 */
export type DeviceHostState = "registered" | "revoking" | "revoked";

/** An account device as GET /api/devices lists it, minus the caller-relative `current`. */
export interface AccountDeviceRow {
  readonly id: number;
  /** Absent when the client never said (older clients, sessions from before ADR-0037). */
  readonly name?: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly kickedAt?: number;
  readonly hosts: readonly { readonly hostId: string; readonly name: string; readonly state: DeviceHostState }[];
}

export type RemoveHostResult =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly reason: "not_found" | ConfirmationFailure }
  | { readonly status: "limited" };

export type KickDeviceResult =
  /** The hosts that now owe a revocation for this device. */
  | { readonly status: "ok"; readonly hostIds: readonly string[] }
  | { readonly status: "refused"; readonly reason: "not_found" | "current_device" | ConfirmationFailure }
  | { readonly status: "limited" };

/**
 * A host's report that an account offer admitted `publicKey` (ADR-0037 §2):
 * "revoke" when the device was kicked meanwhile and the host must revoke it
 * at once, "ignored" when the request isn't this host's or is long expired.
 */
export type AdmissionReportResult = "recorded" | "revoke" | "ignored";

export interface Accounts {
  /** Server database path — tests write join_tokens rows directly. */
  readonly dbPath: string;
  /** A mailer is configured: codes can be sent (ADR-0044 §2). */
  readonly emailEnabled: boolean;
  /** New accounts may be created (ADR-0044 §7); email sign-up also needs `emailEnabled`. */
  readonly registrationOpen: boolean;
  /**
   * Signs in by email (any case) or legacy username and ties the session to
   * an account device (ADR-0037 §1): the one `device` names, created or
   * refreshed and un-kicked, or without a claim a new unnamed one.
   */
  login(identifier: string, password: string, ip: string, device?: DeviceClaim): Promise<LoginResult>;
  /**
   * Mails a sign-up code (ADR-0044 §2), or, when the email already has an
   * account, a note saying so and no code. The caller can't tell which.
   */
  requestSignupCode(args: { readonly email: string; readonly ip: string }): SendCodeResult;
  /**
   * Spends a sign-up code to create an account with that verified email and
   * signs it in. Counts against the same per-address limit as login, and a
   * wrong code against the same lockout.
   */
  register(args: {
    readonly email: string;
    readonly code: string;
    readonly password: string;
    readonly ip: string;
    readonly device?: DeviceClaim;
  }): Promise<RegisterResult>;
  /** Mails a reset code when the email has an account; the caller can't tell whether it does. */
  requestPasswordReset(args: { readonly email: string; readonly ip: string }): SendCodeResult;
  /** Spends a reset code: the new password, and every session and credential of the account ends, as with `passwd`. */
  resetPasswordWithCode(args: {
    readonly email: string;
    readonly code: string;
    readonly password: string;
    readonly ip: string;
  }): Promise<ResetPasswordResult>;
  /**
   * Mails a code to an email the signed-in account wants as its own (ADR-0044
   * §8), after the confirmation — the password like a password change, or a
   * re-auth grant for an account without one — since the new address could
   * then reset the password: a stolen session alone can't take the account over.
   */
  requestEmailCode(args: { readonly userId: number; readonly email: string; readonly ip: string } & Confirmation): Promise<SendCodeResult>;
  /**
   * Spends that code after the confirmation again: the email becomes the
   * account's, verified, and an address it replaces is told. A wrong code or
   * password counts toward the account's lockout.
   */
  setEmail(args: { readonly userId: number; readonly email: string; readonly code: string } & Confirmation): Promise<SetEmailResult>;
  /**
   * Resolves a session token to its user and account device, or undefined
   * when unknown/expired. `deviceId` is absent only for sessions written
   * outside this module.
   */
  authenticate(
    token: string,
  ): { readonly userId: number; readonly user: AccountUser; readonly deviceId?: number } | undefined;
  /**
   * Ends this session. With `revoke` (#494) the session's account device
   * also leaves every host, as a kick would (ADR-0037 §3): no password,
   * since it only ever withdraws the caller's own device. Returns the hosts
   * that now owe a revocation.
   */
  logout(token: string, options?: { readonly revoke?: boolean }): string[];
  revokeAllSessions(userId: number): void;
  /**
   * Self-service password change (#450): checks the current password under
   * the same account lockout as login, then swaps the hash and signs out
   * every other session, so a leaked password leaves no live credential
   * behind except the caller's.
   */
  changePassword(
    args: {
      readonly userId: number;
      /** The caller's session token, which survives the change; a grant must be this session's. */
      readonly keepToken: string;
      readonly newPassword: string;
    } & ({ readonly currentPassword: string } | { readonly reauth: string }),
  ): Promise<ChangePasswordResult>;
  /**
   * Deletes the account after the confirmation (#451, ADR-0044 §6).
   * Sessions, join tokens, host bindings, push registrations, mailed codes
   * and sign-in identities go with it. Devices the hosts registered stay
   * registered: revoking them is the host's call (ADR-0022 §6).
   */
  deleteAccount(
    args: {
      readonly userId: number;
      /** The caller's session token, which must still be live when the write runs. */
      readonly keepToken: string;
    } & Confirmation,
  ): Promise<DeleteAccountResult>;
  /** Checks a confirmation for an action that changes nothing here yet, such as starting to link a provider. */
  confirm(userId: number, confirmation: Confirmation): Promise<"ok" | "limited" | ConfirmationFailure>;
  /** Mails a re-auth code to the account's own email (ADR-0044 §6); `no_email` for a legacy account without one. */
  requestReauthCode(args: { readonly userId: number; readonly ip: string }): SendCodeResult | "no_email";
  /**
   * Trades the password or a mailed re-auth code for a grant tied to the
   * session `token`, good for five minutes. Either one wrong counts toward
   * the login lockout.
   */
  grantReauth(args: { readonly userId: number; readonly token: string } & ({ readonly password: string } | { readonly code: string })): Promise<ReauthResult>;
  /**
   * Starts a provider sign-in (ADR-0044 §5): anyone may, so bounded per
   * source IP and server-wide. Returns the `state` the provider sends back,
   * with the server's PKCE verifier and nonce toward the provider.
   */
  startOAuthFlow(args: {
    readonly provider: OAuthProvider;
    readonly kind: OAuthFlow["kind"];
    readonly ip: string;
    readonly bindingHash?: string;
    readonly native?: NativeRedirect;
    readonly linkUserId?: number;
    /** link: the session starting it, which must outlive the provider's answer. */
    readonly linkSessionToken?: string;
  }): { readonly status: "ok"; readonly state: string; readonly verifier: string; readonly nonce: string } | { readonly status: "limited" } | { readonly status: "busy" };
  /**
   * Opens a native app's link flow in the browser it runs in (#631): the
   * flow was stored with the hash of a one-time `ticket` as its binding,
   * and the app's browser trades that ticket for a binding cookie of its
   * own. Both the state and the binding change here, so the start URL the
   * app was given works once. Undefined when no live link flow of
   * `provider` holds that ticket; counted per source IP with the starts.
   */
  startNativeLink(args: {
    readonly provider: OAuthProvider;
    readonly ticket: string;
    readonly bindingHash: string;
    readonly ip: string;
  }): { readonly status: "ok"; readonly state: string; readonly verifier: string; readonly nonce: string } | { readonly status: "limited" } | undefined;
  /** Spends the flow `state` names; undefined when unknown, expired or another provider's. */
  takeOAuthFlow(provider: OAuthProvider, state: string): OAuthFlow | undefined;
  /**
   * Finds the account a provider identity signs in to (ADR-0044 §4): the one
   * it is bound to; else the one whose verified email it verifies, binding
   * it there and mailing that account; else, while registration is open, a
   * pending record for the person to choose what to do with.
   */
  resolveIdentity(identity: ProviderIdentity, completion: PendingCompletion): ResolveIdentityResult;
  /**
   * Binds an identity to the account a link flow started from; a no-op when
   * it is already that account's. `session_ended` when the session that
   * started the flow is gone by now (signed out everywhere, password reset):
   * the owner's lockout must cover links already on their way.
   */
  linkIdentity(flow: { readonly linkUserId: number; readonly linkSessionHash: string }, identity: ProviderIdentity): "linked" | "identity_taken" | "session_ended";
  /** A live pending sign-in by its id. */
  pendingSignIn(id: string): PendingSignIn | undefined;
  /**
   * Spends a pending sign-in on a new account with its verified email and
   * the identity bound. The password is optional while the server can mail
   * re-auth codes; without a mailer it is required (`password_required`),
   * since it would be the account's only way to confirm anything later.
   */
  createFromPending(id: string, password?: string): Promise<PendingResult>;
  /** Spends a pending sign-in by binding its identity to the signed-in `userId`. */
  linkPending(id: string, userId: number): PendingResult;
  /** A session for an account a provider sign-in resolved to, tied to an account device as login does. */
  signIn(userId: number, device?: DeviceClaim): SignedIn | undefined;
  /** A one-time code for a native client's redirect, tied to its PKCE challenge; only its hash is stored. */
  issueOAuthCode(userId: number, codeChallenge: string): string;
  /** Trades that code with the verifier for a session; any attempt spends the code. */
  exchangeOAuthCode(code: string, codeVerifier: string, device?: DeviceClaim): SignedIn | undefined;
  /**
   * A native app's link from settings (#631), back from the provider: the
   * identity waits under a one-time code for the app that started it, which
   * alone holds the PKCE verifier. Binding in the browser instead would let
   * whoever opened someone else's start URL put their identity on that
   * account. `session_ended` when the starting session is already gone.
   */
  issueLinkCode(args: {
    readonly identity: ProviderIdentity;
    readonly linkUserId: number;
    readonly linkSessionHash: string;
    readonly codeChallenge: string;
  }): { readonly code: string } | "session_ended";
  /**
   * Binds the identity behind a link code, for the session that started the
   * link and with its verifier; `invalid_grant` for any other code, session
   * or verifier, which spends the code all the same.
   */
  completeLink(args: { readonly code: string; readonly codeVerifier: string; readonly token: string }): "linked" | "identity_taken" | "session_ended" | "invalid_grant";
  /** The account's sign-in methods, for settings. */
  listIdentities(userId: number): { readonly identities: readonly IdentityRow[]; readonly hasPassword: boolean };
  /** Unbinds every identity of `provider` after the confirmation; refuses when nothing else would sign the account in. */
  removeIdentity(args: { readonly userId: number; readonly provider: OAuthProvider } & Confirmation): Promise<RemoveIdentityResult>;
  /** True when hostId is bound to an account — the only way a host registers. */
  hasHost(hostId: string): boolean;
  /** Mints a single-use join token for a logged-in user; only its SHA-256 is stored. */
  createJoinToken(userId: number): { readonly token: string; readonly expiresAt: number };
  /**
   * A host asks to join without a token (#495): anonymous, so bounded per
   * source IP and server-wide. Its name, OS and IP are kept only until the
   * request is confirmed, denied or expires.
   */
  startHostLink(args: {
    readonly hostId: string;
    readonly name: string;
    readonly os: string;
    readonly ip: string;
    /** A loopback link (#513): no codes to poll or type, a redirect instead. */
    readonly loopback?: HostLinkLoopback;
  }): StartHostLinkResult;
  /**
   * The host's poll. A confirmed request mints its join token here, bound to
   * the request's hostId, so no plaintext token ever sits in the database; a
   * confirmed or denied request answers once and is gone.
   */
  pollHostLink(deviceCode: string): PollHostLinkResult;
  /**
   * The pending request behind a typed code or a request id. Wrong codes
   * count toward the lockout; a request id is unguessable, so a wrong one
   * doesn't.
   */
  lookupHostLink(args: { readonly userId: number; readonly ip: string } & HostLinkRef): HostLinkCodeResult<{ readonly request: HostLinkRequest }>;
  /**
   * Approves a pending request for `userId`'s account and forgets the host's
   * personal data. A loopback request answers with where to send the
   * browser: the host's listener, with a one-time code and its state.
   */
  confirmHostLink(args: { readonly userId: number; readonly ip: string } & HostLinkRef): HostLinkCodeResult<{ readonly redirect?: string }>;
  /** Refuses a pending request and forgets the host's personal data; a loopback one redirects with access_denied. */
  denyHostLink(args: { readonly userId: number; readonly ip: string } & HostLinkRef): HostLinkCodeResult<{ readonly redirect?: string }>;
  /**
   * Trades a loopback link's one-time code for a join token bound to its
   * host, when `codeVerifier` matches the challenge (#513, RFC 7636). Any
   * attempt spends the code, so a verifier can't be guessed at.
   */
  exchangeHostLinkCode(code: string, codeVerifier: string): { readonly status: "ok"; readonly token: string; readonly expiresAt: number } | { readonly status: "invalid" };
  /** Deletes expired join tokens and host-link requests; the server also runs it on a timer. */
  sweepExpired(): void;
  /**
   * Spends a join token and writes or rebinds the hosts row in one transaction —
   * the token must never be consumed without a binding landing beside it.
   */
  joinHost(args: {
    readonly token: string;
    readonly hostId: string;
    readonly noisePublicKey: string;
    readonly name?: string;
  }): JoinHostResult;
  /** The account a host is bound to, or undefined for an unbound hostId. */
  hostOwner(hostId: string): number | undefined;
  /**
   * Registers or refreshes a device's APNs token under `userId` (ADR-0036 §1-2).
   * A token belongs to one account at a time: registering it moves it here,
   * tied to `deviceId`, the account device of the session that registered it.
   */
  registerPushToken(userId: number, token: string, environment: ApnsEnvironment, deviceId?: number): void;
  /** Drops the registration only when `userId` owns it. */
  removePushToken(userId: number, token: string, environment: ApnsEnvironment): void;
  /** The account a live (refreshed within 90 days) registration belongs to. */
  pushTokenOwner(token: string, environment: ApnsEnvironment): number | undefined;
  /**
   * APNs reported the token invalid at `unregisteredAt`: drop the registration
   * only when it is older, so a late 410 never removes a fresh one (ADR-0025 §5).
   */
  forgetPushToken(token: string, environment: ApnsEnvironment, unregisteredAt: number): void;
  /** Drops a host's account binding; false when the hostId was never bound. */
  leaveHost(hostId: string): boolean;
  /**
   * The account removes one of its hosts after the confirmation (#512),
   * as for kicking a device: a stolen session must not be able to throw the
   * owner's machines out. The binding goes as with `leaveHost`, and the
   * hostId is remembered until it joins again, so `wasRemoved` can say so.
   */
  removeHost(args: { readonly userId: number; readonly hostId: string } & Confirmation): Promise<RemoveHostResult>;
  /** True when the account removed this hostId and it hasn't joined since. */
  wasRemoved(hostId: string): boolean;
  /** Every host bound to a user — GET /api/hosts. */
  listHosts(userId: number): HostRow[];
  /**
   * The host row scoped to its owner. Callers must never probe by hostId
   * alone: a host that belongs to someone else looks exactly like "not found".
   */
  hostFor(userId: number, hostId: string): HostRow | undefined;
  /**
   * Bumps last_seen_at on each successful register and records whether this
   * register declared "device-reports"; a no-op for unbound hostIds.
   */
  markHostSeen(hostId: string, deviceReports: boolean): void;
  /** The caller's account devices, most recently signed in first (ADR-0037 §6). */
  listDevices(userId: number): AccountDeviceRow[];
  /**
   * Remembers that the session behind `token` was handed an offer the host
   * minted for `requestId` (ADR-0037 §2), so the host's later report can be
   * tied to the session's device. False when the session is gone or the
   * host isn't the session's account's — the offer must not be handed out.
   */
  recordVouching(args: {
    readonly token: string;
    readonly hostId: string;
    readonly requestId: string;
    readonly expiresAt: number;
  }): boolean;
  /** A host's `device-admitted` (ADR-0037 §2). */
  recordAdmission(hostId: string, requestId: string, publicKey: string): AdmissionReportResult;
  /** Public keys `hostId` still owes a revocation for (ADR-0037 §3). */
  pendingRevocations(hostId: string): string[];
  /** A host's `device-revoked`: the pending revocation is done. */
  confirmRevocation(hostId: string, publicKey: string): void;
  /**
   * Kicks one of the caller's devices after the confirmation (ADR-0037
   * §3): its sessions and push registrations end, it is marked kicked, and
   * every host that reported admitting it owes a revocation. The caller's own
   * device is refused: that is `logout` with `revoke`.
   */
  kickDevice(
    args: { readonly userId: number; readonly deviceId: number; readonly currentDeviceId?: number } & Confirmation,
  ): Promise<KickDeviceResult>;
  /**
   * Writes the bound host's current display name, cleaned by the same
   * `normalizeHostName` the host applies (issue #212); a no-op for unbound
   * hostIds. Register reports it and the `name` frame keeps it current.
   */
  renameHost(hostId: string, name: string): void;
  close(): Promise<void>;
}

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

const DAY_MS = 24 * 60 * 60 * 1000;

/** A mailed code's stored hash, bound to its purpose and email so one never stands in for another. */
const codeHash = (purpose: EmailCodePurpose, email: string, code: string): string => sha256Hex(`${purpose}:${email}:${code}`);

/** A users row as sign-in and the session read it. */
interface UserRow {
  readonly id: number;
  readonly accountId: string;
  readonly username: string | null;
  readonly email: string | null;
  readonly passwordHash: string | null;
}

const USER_SELECT = "SELECT id, account_id AS accountId, username, email, password_hash AS passwordHash FROM users";

/** What responses show for an account (ADR-0044 §8). */
const accountUser = (row: {
  readonly accountId: string;
  readonly username: string | null;
  readonly email: string | null;
}): AccountUser =>
  row.email === null
    ? { accountId: row.accountId, username: row.username ?? "" }
    : { accountId: row.accountId, username: row.email, email: row.email };

/** The login lockout's key for an existing account. */
const accountLockKey = (userId: number): string => `user:${userId}`;

function requireEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (email === undefined) throw new Error(`not a valid email: ${raw}`);
  return email;
}

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(password, salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // "scrypt$N$r$p$salt$hash" — params come from the stored string so hash
  // strength can be raised for new passwords while old ones still verify.
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Params come out of the database, so bound them anyway: a corrupt row must
  // not be able to request a memory-bomb scrypt.
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0 || expected.length > 256) return false;
  const derived = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(derived, expected);
}

function assertPasswordPolicy(password: string): void {
  const length = [...password].length;
  if (length < MIN_PASSWORD_CODEPOINTS || length > MAX_PASSWORD_CODEPOINTS) {
    throw new Error(`password must be ${MIN_PASSWORD_CODEPOINTS}–${MAX_PASSWORD_CODEPOINTS} characters`);
  }
}

function assertUsernamePolicy(username: string): void {
  const length = [...username].length;
  if (length === 0 || length > MAX_USERNAME_CODEPOINTS) {
    throw new Error(`username must be 1–${MAX_USERNAME_CODEPOINTS} characters`);
  }
}

// `server passwd` writes beside a running server (#450): both connections
// wait out the other's write instead of failing with SQLITE_BUSY.
const BUSY_TIMEOUT_MS = 5000;

function openDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

const schemaVersion = (db: DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;

function migrate(db: DatabaseSync): void {
  const version = schemaVersion(db);
  if (version > SCHEMA_VERSION) {
    throw new Error(`server database schema ${version} is newer than this build (${SCHEMA_VERSION})`);
  }
  if (version === SCHEMA_VERSION) return;
  // Each step is one transaction so a crash can't leave a half-made schema.
  // Schema 1 defined join_tokens and hosts up front even though their writers
  // arrived in later steps (roadmap M3).
  if (version < 1) migrateTo1(db);
  if (version < 2) {
    db.exec(`
      BEGIN;
      CREATE TABLE push_tokens (
        token TEXT NOT NULL,
        environment TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (token, environment)
      );
      CREATE INDEX push_tokens_user ON push_tokens (user_id, updated_at);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (version < 3) {
    // The first account is the operator's (the bootstrap one); it alone
    // mints invites.
    db.exec(`
      BEGIN;
      ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET admin = 1 WHERE id = (SELECT MIN(id) FROM users);
      -- AUTOINCREMENT: minting sweeps expired invites, and a reused id would
      -- let a revoke from a stale list hit a code already sent to someone.
      CREATE TABLE invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
  if (version < 4) migrateTo4(db);
  if (version < 5) {
    // The account device whose session registered the token, so kicking it
    // drops the token too (ADR-0037 §3). Registrations from before this step
    // aren't tied to one. SET NULL: when a sign-in sweeps an unused unnamed
    // device, its registrations become untied instead of being dropped.
    db.exec(`
      BEGIN;
      ALTER TABLE push_tokens ADD COLUMN device_id INTEGER REFERENCES account_devices(id) ON DELETE SET NULL;
      CREATE INDEX push_tokens_device ON push_tokens (device_id);
      PRAGMA user_version = 5;
      COMMIT;
    `);
  }
  if (version < 6) {
    // Host links (#495). A request is pending until a signed-in user
    // confirms it (user_id set) or denies it; either clears the host's name,
    // OS and IP, and the row lives on only for the host's last poll. A join
    // token minted from one is bound to its host_id; tokens from "add a
    // host" stay bound to none.
    db.exec(`
      BEGIN;
      CREATE TABLE host_link_requests (
        device_code_hash TEXT PRIMARY KEY,
        user_code_hash TEXT NOT NULL UNIQUE,
        host_id TEXT NOT NULL,
        host_name TEXT,
        host_os TEXT,
        source_ip TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        interval_s INTEGER NOT NULL,
        last_poll_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX host_link_requests_expiry ON host_link_requests (expires_at);
      ALTER TABLE join_tokens ADD COLUMN host_id TEXT;
      PRAGMA user_version = 6;
      COMMIT;
    `);
  }
  if (version < 7) {
    // Hosts the account removed (#512), so one that was offline then learns
    // it on its next register instead of reading as never joined. Only the
    // hostId and when: no account, and a re-join deletes the row.
    db.exec(`
      BEGIN;
      CREATE TABLE removed_hosts (
        host_id TEXT PRIMARY KEY,
        removed_at INTEGER NOT NULL
      );
      PRAGMA user_version = 7;
      COMMIT;
    `);
  }
  if (version < 8) {
    // Loopback host links (#513, RFC 8252): the confirm page names the
    // request by a random id instead of a typed code, and the browser carries
    // a one-time code back to the host's loopback listener, which trades it
    // with its PKCE verifier. Such a request's device and user code hashes
    // are random values nobody holds.
    db.exec(`
      BEGIN;
      ALTER TABLE host_link_requests ADD COLUMN request_id_hash TEXT;
      ALTER TABLE host_link_requests ADD COLUMN redirect_uri TEXT;
      ALTER TABLE host_link_requests ADD COLUMN code_challenge TEXT;
      ALTER TABLE host_link_requests ADD COLUMN client_state TEXT;
      ALTER TABLE host_link_requests ADD COLUMN auth_code_hash TEXT;
      ALTER TABLE host_link_requests ADD COLUMN auth_code_expires_at INTEGER;
      CREATE UNIQUE INDEX host_link_requests_request_id ON host_link_requests (request_id_hash);
      CREATE UNIQUE INDEX host_link_requests_auth_code ON host_link_requests (auth_code_hash);
      PRAGMA user_version = 8;
      COMMIT;
    `);
  }
  if (version < 9) migrateTo9(db);
  if (version < 10) {
    // Provider sign-in (#620, ADR-0044 §3–§6, §9). Every secret a browser or
    // client carries (state, pending id, one-time code, re-auth grant) is
    // stored as its SHA-256; the server's own PKCE verifier and nonce toward
    // the provider are kept as they are, since the exchange sends them.
    db.exec(`
      BEGIN;
      -- Apple sends a name only the first time; its refresh token is revoked
      -- when the account goes or Apple is unlinked, with the client_id that
      -- received it (the web Services ID or the app's bundle id).
      ALTER TABLE user_identities ADD COLUMN name TEXT;
      ALTER TABLE user_identities ADD COLUMN refresh_token TEXT;
      ALTER TABLE user_identities ADD COLUMN refresh_client_id TEXT;
      CREATE TABLE oauth_flows (
        state_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('web', 'native', 'link')),
        verifier TEXT NOT NULL,
        nonce TEXT NOT NULL,
        -- web and link: the hash of the browser's binding cookie.
        binding_hash TEXT,
        -- native: where the code goes, its PKCE challenge and the client's state.
        redirect_uri TEXT,
        code_challenge TEXT,
        client_state TEXT,
        link_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        -- link: the session that started it, which must still be live when
        -- the identity is written.
        link_session_hash TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX oauth_flows_expiry ON oauth_flows (expires_at);
      -- A provider sign-in that found no account, waiting for the person to
      -- create one or link it to an account they sign in to.
      CREATE TABLE oauth_pending (
        id_hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        refresh_token TEXT,
        refresh_client_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('web', 'native', 'direct')),
        binding_hash TEXT,
        redirect_uri TEXT,
        code_challenge TEXT,
        client_state TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX oauth_pending_expiry ON oauth_pending (expires_at);
      CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      -- A grant dies with the session it was issued to.
      CREATE TABLE reauth_grants (
        grant_hash TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX reauth_grants_session ON reauth_grants (session_hash);
      PRAGMA user_version = 10;
      COMMIT;
    `);
  }
  if (version < 11) {
    // Clients key the pairings an account vouched for by this id (#640). Not
    // users.id: that one may be reused after a deletion (schema.test.ts), and
    // a random id says nothing about how many accounts there are. The trigger
    // fills it on every insert, so no insert site has to know about it.
    db.exec(`
      BEGIN;
      ALTER TABLE users ADD COLUMN account_id TEXT;
      UPDATE users SET account_id = lower(hex(randomblob(16)));
      CREATE UNIQUE INDEX users_account_id ON users (account_id);
      CREATE TRIGGER users_account_id_fill AFTER INSERT ON users WHEN NEW.account_id IS NULL
      BEGIN
        UPDATE users SET account_id = lower(hex(randomblob(16))) WHERE id = NEW.id;
      END;
      PRAGMA user_version = 11;
      COMMIT;
    `);
  }
}

/**
 * Email accounts (ADR-0044 §1, §7): users gain a verified email, keep a
 * username only as legacy accounts, and may have no password (sign-in by a
 * provider, #620); invites and the admin flag go. SQLite can't loosen NOT
 * NULL in place, so users is rebuilt, ids copied as they are. Foreign keys
 * must be off for that or dropping the old table would cascade into every
 * table that references it, and the pragma is a no-op inside a transaction.
 */
function migrateTo9(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      db.exec(`
        DROP TABLE invites;
        CREATE TABLE users_v9 (
          id INTEGER PRIMARY KEY,
          -- Legacy accounts only (ADR-0044 §8); NULL for email accounts.
          username TEXT UNIQUE,
          -- Lowercased; set only once verified, so email_verified_at goes with it.
          email TEXT UNIQUE,
          email_verified_at INTEGER,
          -- NULL for an account that only signs in through a provider (#620).
          password_hash TEXT,
          created_at INTEGER NOT NULL,
          CHECK (username IS NOT NULL OR email IS NOT NULL)
        );
        INSERT INTO users_v9 (id, username, password_hash, created_at) SELECT id, username, password_hash, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_v9 RENAME TO users;
        -- Sign-in providers bound to an account (#620): subject is the
        -- provider's stable id for the person, never an email.
        CREATE TABLE user_identities (
          provider TEXT NOT NULL,
          subject TEXT NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (provider, subject)
        );
        CREATE INDEX user_identities_user ON user_identities (user_id);
        -- Mailed codes: only the hash. A sign-up code has no account yet.
        -- AUTOINCREMENT, like every id here that could be reused.
        CREATE TABLE email_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'reset', 'add_email', 'reauth')),
          email TEXT NOT NULL,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          code_hash TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX email_codes_email ON email_codes (purpose, email);
        CREATE INDEX email_codes_user ON email_codes (user_id);
        CREATE INDEX email_codes_expiry ON email_codes (expires_at);
      `);
      const dangling = db.prepare("PRAGMA foreign_key_check").all();
      if (dangling.length > 0) throw new Error(`schema 9 migration left ${dangling.length} dangling references`);
      db.exec("PRAGMA user_version = 9; COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Account devices and remote revocation (ADR-0037). A device outlives its
 * sessions; a vouching ties one account offer (the server's requestId) to the
 * device it was handed to and, once the host reports it, the public key it
 * admitted. Sessions from before this schema each get an unnamed device.
 */
function migrateTo4(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      -- AUTOINCREMENT: ids appear in kick URLs, and a reused one would let a
      -- stale list kick a device that signed in later.
      CREATE TABLE account_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- The client's own ID; NULL for clients that send none, which never
        -- match each other (SQLite UNIQUE treats NULLs as distinct).
        client_id TEXT,
        name TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        kicked_at INTEGER,
        UNIQUE (user_id, client_id)
      );
      ALTER TABLE sessions ADD COLUMN device_id INTEGER REFERENCES account_devices(id) ON DELETE CASCADE;
      CREATE INDEX sessions_device ON sessions (device_id);
      ALTER TABLE hosts ADD COLUMN device_reports INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE vouchings (
        request_id TEXT PRIMARY KEY,
        device_id INTEGER NOT NULL REFERENCES account_devices(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        -- Filled by the host's device-admitted report.
        public_key TEXT,
        admitted_at INTEGER,
        -- Set when the account withdrew this vouching (a kick), reported
        -- yet or not: a report that arrives later is revoked at once.
        revoked_at INTEGER
      );
      CREATE INDEX vouchings_device ON vouchings (device_id);
      CREATE INDEX vouchings_host_key ON vouchings (host_id, public_key);
      CREATE TABLE pending_revocations (
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (host_id, public_key)
      );
    `);
    const sessions = db.prepare("SELECT token_hash AS tokenHash, user_id AS userId, created_at AS createdAt FROM sessions").all() as {
      tokenHash: string;
      userId: number;
      createdAt: number;
    }[];
    const insert = db.prepare("INSERT INTO account_devices (user_id, created_at, last_seen_at) VALUES (?, ?, ?)");
    const link = db.prepare("UPDATE sessions SET device_id = ? WHERE token_hash = ?");
    for (const session of sessions) {
      const deviceId = insert.run(session.userId, session.createdAt, session.createdAt).lastInsertRowid;
      link.run(deviceId, session.tokenHash);
    }
    db.exec("PRAGMA user_version = 4; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateTo1(db: DatabaseSync): void {
  db.exec(`
    BEGIN;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE join_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE hosts (
      host_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      noise_public_key TEXT NOT NULL,
      name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
    COMMIT;
  `);
}

/** A pending host link's columns as the user-code side reads them. */
interface PendingHostLink {
  readonly hostId: string;
  readonly name: string | null;
  readonly os: string | null;
  readonly sourceIp: string | null;
  readonly expiresAt: number;
  /** Set on loopback requests (#513). */
  readonly redirectUri: string | null;
  readonly clientState: string | null;
}

/** The host's listener with `params` added; the stored URI has no query of its own. */
const loopbackRedirect = (redirectUri: string, params: Record<string, string>): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

/** Fixed-window counters with a hard cap: full maps evict the oldest entries instead of growing. */
class WindowedCounter {
  private readonly map = new Map<string, { count: number; resetAt: number }>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(maxEntries: number, now: () => number) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  /** Counts one hit for `key`; returns true when the key is already at `max` inside its window. */
  hit(key: string, max: number, windowMs: number): boolean {
    if (this.isOver(key, max)) return true;
    this.bump(key, windowMs);
    return false;
  }

  isOver(key: string, max: number): boolean {
    const entry = this.map.get(key);
    return entry !== undefined && entry.resetAt > this.now() && entry.count >= max;
  }

  bump(key: string, windowMs: number): void {
    const now = this.now();
    let entry = this.map.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      // Re-set keeps insertion order fresh; on a full map the oldest entry loses its slot.
      this.map.delete(key);
      if (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next();
        if (!oldest.done) this.map.delete(oldest.value);
      }
      this.map.set(key, entry);
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.map.delete(key);
  }
}

/** Bounded concurrency for scrypt: CPU-heavy hashing can't be allowed to queue unboundedly. */
class ScryptGate {
  private running = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly maxQueue: number;
  constructor(concurrency: number, maxQueue: number) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
  }

  /** Runs `task` within the concurrency budget; undefined means the queue is full. */
  run<T>(task: () => Promise<T>): Promise<T> | undefined {
    if (this.running < this.concurrency) {
      this.running += 1;
      return this.finish(task());
    }
    if (this.waiters.length >= this.maxQueue) return undefined;
    return new Promise<T>((resolve, reject) => {
      this.waiters.push(() => {
        this.running += 1;
        void this.finish(task()).then(resolve, reject);
      });
    });
  }

  private async finish<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } finally {
      this.running -= 1;
      this.waiters.shift()?.();
    }
  }
}

export async function openAccounts(options: AccountsOptions): Promise<Accounts> {
  const now = options.now ?? Date.now;
  await mkdir(options.dataDir, { recursive: true });
  const release = await lockDataDir(options.dataDir, { staleMs: options.lockStaleMs });
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(options.dataDir);
    migrate(db);
    const userCount = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    if (userCount === 0) {
      if (options.bootstrapUser === undefined || options.bootstrapPassword === undefined) {
        throw new Error("PINOMAD_SERVER_USER and PINOMAD_SERVER_PASSWORD are required to create the first account");
      }
      // The operator typed it, so an email counts as verified (ADR-0044 §8).
      const email = options.bootstrapUser.includes("@") ? requireEmail(options.bootstrapUser) : undefined;
      if (email === undefined) assertUsernamePolicy(options.bootstrapUser);
      assertPasswordPolicy(options.bootstrapPassword);
      const hash = await hashPassword(options.bootstrapPassword);
      db.prepare("INSERT INTO users (username, email, email_verified_at, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
        email === undefined ? options.bootstrapUser : null,
        email ?? null,
        email === undefined ? null : now(),
        hash,
        now(),
      );
    }
  } catch (error) {
    db?.close();
    await release();
    throw error;
  }

  const limits = {
    scryptConcurrency: options.limits?.scryptConcurrency ?? 4,
    scryptQueue: options.limits?.scryptQueue ?? 64,
    ipMaxAttempts: options.limits?.ipMaxAttempts ?? 30,
    ipWindowMs: options.limits?.ipWindowMs ?? 5 * 60_000,
    userMaxFailures: options.limits?.userMaxFailures ?? 5,
    userWindowMs: options.limits?.userWindowMs ?? 15 * 60_000,
    counterMaxEntries: options.limits?.counterMaxEntries ?? 4096,
  };
  const gate = new ScryptGate(limits.scryptConcurrency, limits.scryptQueue);
  const ipAttempts = new WindowedCounter(limits.counterMaxEntries, now);
  const userFailures = new WindowedCounter(limits.counterMaxEntries, now);

  const linkLimits = {
    startMaxPerIp: options.hostLinkLimits?.startMaxPerIp ?? 10,
    startWindowMs: options.hostLinkLimits?.startWindowMs ?? 10 * 60_000,
    maxPending: options.hostLinkLimits?.maxPending ?? 1000,
    userMaxFailures: options.hostLinkLimits?.userMaxFailures ?? 10,
    ipMaxFailures: options.hostLinkLimits?.ipMaxFailures ?? 30,
    failureWindowMs: options.hostLinkLimits?.failureWindowMs ?? 15 * 60_000,
    counterMaxEntries: options.hostLinkLimits?.counterMaxEntries ?? 4096,
  };
  const linkStarts = new WindowedCounter(linkLimits.counterMaxEntries, now);
  const linkUserFailures = new WindowedCounter(linkLimits.counterMaxEntries, now);
  const linkIpFailures = new WindowedCounter(linkLimits.counterMaxEntries, now);

  const codeLimits = {
    ipMax: options.codeLimits?.ipMax ?? 10,
    ipWindowMs: options.codeLimits?.ipWindowMs ?? 60 * 60_000,
    emailMax: options.codeLimits?.emailMax ?? 5,
    emailWindowMs: options.codeLimits?.emailWindowMs ?? 60 * 60_000,
    dailyMax: options.codeLimits?.dailyMax ?? 1000,
    counterMaxEntries: options.codeLimits?.counterMaxEntries ?? 4096,
  };
  const codeIps = new WindowedCounter(codeLimits.counterMaxEntries, now);
  const codeEmails = new WindowedCounter(codeLimits.counterMaxEntries, now);
  const codesToday = new WindowedCounter(1, now);

  const oauthLimits = {
    startMaxPerIp: options.oauthLimits?.startMaxPerIp ?? 30,
    startWindowMs: options.oauthLimits?.startWindowMs ?? 10 * 60_000,
    maxPending: options.oauthLimits?.maxPending ?? 10_000,
  };
  const oauthStarts = new WindowedCounter(limits.counterMaxEntries, now);
  // Native link codes (#631) live only as long as this process: two minutes
  // at most, and a restart just asks for the link again.
  const linkCodes = new Map<
    string,
    { identity: ProviderIdentity; linkUserId: number; linkSessionHash: string; codeChallenge: string; expiresAt: number }
  >();

  const mailer = options.mailer;
  const registrationOpen = options.registration === "open";
  /** Email sign-up needs both: new accounts allowed, and a way to mail the code. */
  const emailSignup = registrationOpen && mailer !== undefined;

  /**
   * Whether one more code may go out: every ask counts against its address,
   * and one that passes against its email and the server's day. Asks for
   * every purpose share the bounds, whether or not a mail goes out, so the
   * limits say nothing about which emails have accounts.
   */
  const codeAllowed = (ip: string, email: string): boolean => {
    if (codeIps.hit(ip, codeLimits.ipMax, codeLimits.ipWindowMs)) return false;
    if (codeEmails.isOver(email, codeLimits.emailMax) || codesToday.isOver("all", codeLimits.dailyMax)) return false;
    codeEmails.bump(email, codeLimits.emailWindowMs);
    codesToday.bump("all", DAY_MS);
    return true;
  };

  /**
   * Hands a mail to the mailer without waiting: whether a mail went out, and
   * how long sending took, must not show in the answer (ADR-0044 §2).
   */
  const deliver = (purpose: string, to: string, subject: string, content: MailContent): void => {
    // The purpose only: subjects and bodies carry codes, and so may the
    // error, which some transports build from the message.
    mailer?.send(to, subject, renderMail(content)).catch(() => {
      console.error(JSON.stringify({ event: "mail_failed", purpose }));
    });
  };

  /** A fresh code for `purpose`, replacing any earlier one for the same email (or, adding an email, the same account). */
  const issueCode = (purpose: EmailCodePurpose, email: string, userId: number | null): string => {
    const at = now();
    db.prepare("DELETE FROM email_codes WHERE expires_at <= ?").run(at);
    if (purpose === "add_email") db.prepare("DELETE FROM email_codes WHERE purpose = ? AND user_id = ?").run(purpose, userId);
    else db.prepare("DELETE FROM email_codes WHERE purpose = ? AND email = ?").run(purpose, email);
    const code = String(randomInt(1_000_000)).padStart(6, "0");
    db.prepare(
      "INSERT INTO email_codes (purpose, email, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(purpose, email, userId, codeHash(purpose, email, code), at, at + EMAIL_CODE_TTL_MS);
    return code;
  };

  /**
   * Spends the live code for `purpose` and `email` (and `userId`, when the
   * code is tied to an account) inside the caller's transaction. A wrong
   * guess counts against the code, which dies at the fifth, and against
   * `lockKey`, the same lockout as login.
   */
  const spendCode = (
    purpose: EmailCodePurpose,
    email: string,
    code: string,
    lockKey: string,
    userId?: number,
  ): boolean => {
    // One live code per purpose and email (per account, adding an email):
    // issuing a code replaces the earlier one.
    const row = db
      .prepare(
        `SELECT id, code_hash AS codeHash, attempts FROM email_codes
         WHERE purpose = ? AND email = ? AND user_id IS ? AND expires_at > ?`,
      )
      .get(purpose, email, userId ?? null, now()) as { id: number; codeHash: string; attempts: number } | undefined;
    if (row !== undefined && safeEqual(codeHash(purpose, email, code.replace(/\s/g, "")), row.codeHash)) {
      db.prepare("DELETE FROM email_codes WHERE id = ?").run(row.id);
      return true;
    }
    userFailures.bump(lockKey, limits.userWindowMs);
    if (row !== undefined) {
      if (row.attempts + 1 >= EMAIL_CODE_MAX_ATTEMPTS) db.prepare("DELETE FROM email_codes WHERE id = ?").run(row.id);
      else db.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    }
    return false;
  };

  /** The account a sign-in names: an email in any case, else a legacy username as typed. */
  const findUser = (identifier: string): UserRow | undefined => {
    const email = normalizeEmail(identifier);
    return db
      .prepare(`${USER_SELECT} WHERE email = ? OR username = ? ORDER BY email IS ? DESC LIMIT 1`)
      .get(email ?? null, identifier, email ?? null) as UserRow | undefined;
  };

  const userById = (userId: number): UserRow | undefined => db.prepare(`${USER_SELECT} WHERE id = ?`).get(userId) as UserRow | undefined;

  /**
   * The login lockout's key: the account, however it was named, or for a
   * name no account has, the name itself, so both lock out alike.
   */
  const lockKeyFor = (identifier: string, user: UserRow | undefined): string =>
    user === undefined ? `name:${normalizeEmail(identifier) ?? identifier}` : accountLockKey(user.id);

  const PENDING_SELECT = `SELECT host_id AS hostId, host_name AS name, host_os AS os, source_ip AS sourceIp, expires_at AS expiresAt,
      redirect_uri AS redirectUri, client_state AS clientState FROM host_link_requests`;

  const linkIdentity = (
    { linkUserId: userId, linkSessionHash }: { readonly linkUserId: number; readonly linkSessionHash: string },
    identity: ProviderIdentity,
  ): "linked" | "identity_taken" | "session_ended" =>
    transaction(() => {
      const live = db
        .prepare("SELECT 1 AS x FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?")
        .get(linkSessionHash, userId, now());
      if (live === undefined) return "session_ended";
      const bound = identityOwner(identity.provider, identity.subject);
      if (bound !== undefined && bound !== userId) return "identity_taken";
      bindIdentity(userId, identity);
      return "linked";
    });

  /**
   * Expired one-use credentials: join tokens, mailed codes, host-link
   * requests with the host's personal data, and provider sign-in state with
   * the person's (flows, pending choices, one-time codes, re-auth grants).
   */
  const sweepExpired = (): void => {
    const at = now();
    for (const table of ["join_tokens", "host_link_requests", "email_codes", "oauth_flows", "oauth_pending", "oauth_codes", "reauth_grants"]) {
      db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(at);
    }
  };

  const mintJoinToken = (userId: number, hostId: string | null): { readonly token: string; readonly expiresAt: number } => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + JOIN_TOKEN_TTL_MS;
    db.prepare("INSERT INTO join_tokens (token_hash, user_id, created_at, expires_at, host_id) VALUES (?, ?, ?, ?, ?)").run(
      sha256Hex(token),
      userId,
      now(),
      expiresAt,
      hostId,
    );
    return { token, expiresAt };
  };

  /**
   * The user-code half of a host link: the lockout, then the pending request
   * the code names. A wrong or malformed code counts against both the account
   * and the IP; a right one clears neither, so settling a request of one's
   * own can't buy more guesses.
   */
  const pendingByRef = (
    userId: number,
    ref: HostLinkRef,
    ip: string,
  ): "limited" | "not_found" | { readonly column: "user_code_hash" | "request_id_hash"; readonly hash: string; readonly row: PendingHostLink } => {
    if ("requestId" in ref) {
      // 32 random bytes: nothing to guess, so nothing to count.
      const hash = sha256Hex(ref.requestId);
      const row = db
        .prepare(`${PENDING_SELECT} WHERE request_id_hash = ? AND state = 'pending' AND expires_at > ?`)
        .get(hash, now()) as PendingHostLink | undefined;
      return row === undefined ? "not_found" : { column: "request_id_hash", hash, row };
    }
    const { userCode } = ref;
    const userKey = String(userId);
    if (linkUserFailures.isOver(userKey, linkLimits.userMaxFailures) || linkIpFailures.isOver(ip, linkLimits.ipMaxFailures)) {
      return "limited";
    }
    const code = normalizeUserCode(userCode);
    const codeHash = code === undefined ? undefined : sha256Hex(code);
    const row =
      codeHash === undefined
        ? undefined
        : (db
            .prepare(`${PENDING_SELECT} WHERE user_code_hash = ? AND state = 'pending' AND expires_at > ?`)
            .get(codeHash, now()) as PendingHostLink | undefined);
    if (codeHash === undefined || row === undefined) {
      linkUserFailures.bump(userKey, linkLimits.failureWindowMs);
      linkIpFailures.bump(ip, linkLimits.failureWindowMs);
      return "not_found";
    }
    return { column: "user_code_hash", hash: codeHash, row };
  };

  /**
   * Settles a pending request, clearing the host's personal data in the same
   * write. A loopback request (#513) never polls: a confirm mints its
   * one-time code for the redirect, and a deny drops the row and redirects
   * with access_denied.
   */
  const settleHostLink = (
    args: { readonly userId: number; readonly ip: string } & HostLinkRef,
    state: "confirmed" | "denied",
  ): HostLinkCodeResult<{ readonly redirect?: string }> => {
    const found = pendingByRef(args.userId, args, args.ip);
    if (found === "limited" || found === "not_found") return { status: found };
    const { column, hash, row } = found;
    const at = now();
    const loopback = row.redirectUri === null ? undefined : { redirectUri: row.redirectUri, state: row.clientState ?? "" };
    if (loopback !== undefined && state === "denied") {
      const dropped = db
        .prepare(`DELETE FROM host_link_requests WHERE ${column} = ? AND state = 'pending' AND expires_at > ?`)
        .run(hash, at);
      if (Number(dropped.changes) !== 1) return { status: "not_found" };
      return { status: "ok", redirect: loopbackRedirect(loopback.redirectUri, { error: "access_denied", state: loopback.state }) };
    }
    const code = loopback === undefined ? undefined : randomBytes(32).toString("base64url");
    const settled = db
      .prepare(
        `UPDATE host_link_requests SET state = ?, user_id = ?, host_name = NULL, host_os = NULL, source_ip = NULL,
           auth_code_hash = ?, auth_code_expires_at = ?
         WHERE ${column} = ? AND state = 'pending' AND expires_at > ?`,
      )
      .run(
        state,
        state === "confirmed" ? args.userId : null,
        code === undefined ? null : sha256Hex(code),
        code === undefined ? null : at + HOST_LINK_CODE_TTL_MS,
        hash,
        at,
      );
    if (Number(settled.changes) !== 1) return { status: "not_found" };
    return loopback === undefined || code === undefined
      ? { status: "ok" }
      : { status: "ok", redirect: loopbackRedirect(loopback.redirectUri, { code, state: loopback.state }) };
  };

  /**
   * The account device a sign-in lands on (ADR-0037 §1), inside the caller's
   * transaction: the claimed one, refreshed and no longer kicked — a password
   * sign-in is the owner taking it back — or a new unnamed one. Unnamed
   * devices pile up one per sign-in of an older client, so the ones left with
   * no live session and nothing reported go first.
   */
  const deviceForSignIn = (userId: number, claim: DeviceClaim | undefined): number => {
    const at = now();
    if (claim === undefined) {
      db.prepare(
        `DELETE FROM account_devices WHERE user_id = ? AND client_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = account_devices.id AND s.expires_at > ?)
           AND NOT EXISTS (SELECT 1 FROM vouchings v WHERE v.device_id = account_devices.id)`,
      ).run(userId, at);
      return Number(
        db.prepare("INSERT INTO account_devices (user_id, created_at, last_seen_at) VALUES (?, ?, ?)").run(userId, at, at)
          .lastInsertRowid,
      );
    }
    const row = db
      .prepare(
        `INSERT INTO account_devices (user_id, client_id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, client_id) DO UPDATE SET
           name = COALESCE(excluded.name, name), last_seen_at = excluded.last_seen_at, kicked_at = NULL
         RETURNING id`,
      )
      .get(userId, claim.id, claim.name ?? null, at, at) as { id: number };
    return row.id;
  };

  const issueSession = (userId: number, device: DeviceClaim | undefined): { readonly token: string; readonly expiresAt: number } => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now());
    const deviceId = deviceForSignIn(userId, device);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + SESSION_TTL_MS;
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, device_id) VALUES (?, ?, ?, ?, ?)").run(
      sha256Hex(token),
      userId,
      now(),
      expiresAt,
      deviceId,
    );
    return { token, expiresAt };
  };

  /**
   * Offers the server forwarded that no host reported within their expiry
   * plus grace were never used, or were used on a host that will never say:
   * nothing to show or revoke (ADR-0037 §2).
   */
  const sweepVouchings = (): void => {
    db.prepare("DELETE FROM vouchings WHERE public_key IS NULL AND expires_at <= ?").run(now() - ADMISSION_REPORT_GRACE_MS);
  };

  /**
   * The account stops vouching for a device (ADR-0037 §3), inside the
   * caller's transaction: its sessions and push registrations end, it is
   * marked kicked, and every host that reported admitting it owes a
   * revocation. Returns those hosts.
   */
  const withdrawDevice = (deviceId: number): string[] => {
    const at = now();
    sweepVouchings();
    db.prepare("DELETE FROM sessions WHERE device_id = ?").run(deviceId);
    // A host without device-reports never revokes it, so its push
    // registrations must go too, or that host could still push to it.
    db.prepare("DELETE FROM push_tokens WHERE device_id = ?").run(deviceId);
    db.prepare("UPDATE account_devices SET kicked_at = ? WHERE id = ?").run(at, deviceId);
    // Every key a host reported that the account still vouched for is
    // asked back; already-withdrawn ones are left alone, so a host that
    // re-paired a device by QR after an earlier kick keeps it.
    const hostIds = (
      db
        .prepare("SELECT DISTINCT host_id AS hostId FROM vouchings WHERE device_id = ? AND public_key IS NOT NULL AND revoked_at IS NULL")
        .all(deviceId) as { hostId: string }[]
    ).map((row) => row.hostId);
    db.prepare(
      `INSERT OR IGNORE INTO pending_revocations (host_id, public_key, created_at)
       SELECT host_id, public_key, ? FROM vouchings
       WHERE device_id = ? AND public_key IS NOT NULL AND revoked_at IS NULL`,
    ).run(at, deviceId);
    // Then withdraw every offer it holds, reported or not: one a host
    // reports later is revoked on arrival, whatever the device does
    // meanwhile (ADR-0037 §2).
    db.prepare("UPDATE vouchings SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(at, deviceId);
    return hostIds;
  };

  const currentHash = (userId: number): string | null | undefined => userById(userId)?.passwordHash;

  /**
   * Re-authentication for account changes: the password must match under the
   * same account lockout as login, with the same in-task re-check and bump
   * so queued guesses see each other. Hands back the hash it verified, which
   * the caller's write must still find.
   */
  const checkPassword = async (
    userId: number,
    password: string,
  ): Promise<"limited" | "wrong_password" | { readonly verifiedHash: string }> => {
    const lockKey = accountLockKey(userId);
    if (userFailures.isOver(lockKey, limits.userMaxFailures)) return "limited";
    const stored = currentHash(userId) ?? undefined;
    const outcome = await gate.run(async (): Promise<"limited" | "wrong_password" | "ok"> => {
      if (userFailures.isOver(lockKey, limits.userMaxFailures)) return "limited";
      if (!(await verifyPassword(password, stored ?? DUMMY_HASH)) || stored === undefined) {
        userFailures.bump(lockKey, limits.userWindowMs);
        return "wrong_password";
      }
      return "ok";
    });
    if (outcome === undefined || outcome === "limited") return "limited";
    if (outcome === "wrong_password") return "wrong_password";
    userFailures.reset(lockKey);
    return { verifiedHash: stored! };
  };

  /** Whether `grant` is a live re-auth grant of the live session `token`, which is `userId`'s (ADR-0044 §6). */
  const reauthValid = (userId: number, token: string, grant: string): boolean => {
    const at = now();
    return (
      db
        .prepare(
          `SELECT 1 AS x FROM reauth_grants g JOIN sessions s ON s.token_hash = g.session_hash
           WHERE g.grant_hash = ? AND g.session_hash = ? AND g.expires_at > ? AND s.user_id = ? AND s.expires_at > ?`,
        )
        .get(sha256Hex(grant), sha256Hex(token), at, userId, at) !== undefined
    );
  };

  /** Whether `token` is still a live session of `userId`; a write may find it signed out elsewhere. */
  const sessionLive = (userId: number, token: string): boolean =>
    db
      .prepare("SELECT 1 AS x FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?")
      .get(sha256Hex(token), userId, now()) !== undefined;

  /** A confirmation that passed: by password, the hash it verified, which the write must still find; or the grant. */
  type Confirmed = { readonly verifiedHash: string } | { readonly reauth: string; readonly token: string };

  /** The password under the login lockout, or a grant; a grant is 32 random bytes, so a wrong one costs nothing. */
  const confirmAccount = async (userId: number, confirmation: Confirmation): Promise<"limited" | ConfirmationFailure | Confirmed> => {
    if ("reauth" in confirmation) {
      return reauthValid(userId, confirmation.token, confirmation.reauth) ? { reauth: confirmation.reauth, token: confirmation.token } : "invalid_reauth";
    }
    return checkPassword(userId, confirmation.password);
  };

  /**
   * Inside the write: the verified password is still the account's (a reset
   * that committed while scrypt ran voids it), or the grant is still live
   * (its session may have ended meanwhile).
   */
  const stillConfirmed = (userId: number, confirmed: Confirmed): ConfirmationFailure | undefined => {
    if ("verifiedHash" in confirmed) return currentHash(userId) === confirmed.verifiedHash ? undefined : "wrong_password";
    return reauthValid(userId, confirmed.token, confirmed.reauth) ? undefined : "invalid_reauth";
  };

  /** Apple's refresh tokens among the account's identities, optionally only one provider's. */
  const appleGrants = (userId: number): AppleGrant[] =>
    db
      .prepare(
        `SELECT refresh_token AS refreshToken, refresh_client_id AS clientId FROM user_identities
         WHERE user_id = ? AND provider = 'apple' AND refresh_token IS NOT NULL AND refresh_client_id IS NOT NULL`,
      )
      .all(userId) as unknown as AppleGrant[];

  /** A bound identity's account. */
  const identityOwner = (provider: OAuthProvider, subject: string): number | undefined =>
    (db.prepare("SELECT user_id AS userId FROM user_identities WHERE provider = ? AND subject = ?").get(provider, subject) as
      | { userId: number }
      | undefined)?.userId;

  /**
   * Binds an identity to an account, or refreshes what the provider said
   * about it when it is already bound there: a later Apple sign-in brings a
   * new refresh token, and only the first ever brings the name.
   */
  const bindIdentity = (userId: number, identity: ProviderIdentity): void => {
    db.prepare(
      `INSERT INTO user_identities (provider, subject, user_id, email, name, refresh_token, refresh_client_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, subject) DO UPDATE SET
         email = COALESCE(excluded.email, email), name = COALESCE(name, excluded.name),
         refresh_token = COALESCE(excluded.refresh_token, refresh_token),
         refresh_client_id = COALESCE(excluded.refresh_client_id, refresh_client_id)
       WHERE user_id = excluded.user_id`,
    ).run(
      identity.provider,
      identity.subject,
      userId,
      identity.email ?? null,
      identity.name ?? null,
      identity.refreshToken ?? null,
      identity.refreshClientId ?? null,
      now(),
    );
  };

  /** Tells an account a sign-in method was added without asking it (ADR-0044 §4, step 2). */
  const noticeNewMethod = (email: string, provider: OAuthProvider): void => {
    const name = PROVIDER_NAMES[provider];
    deliver(
      "new_sign_in_method",
      email,
      `A new sign-in method was added: ${name}`,
      {
        lead: `${name} can now sign in to your PiNomad account, because it confirmed this email address.`,
        note: `If this wasn't you, sign in, remove ${name} under Sign-in methods, and sign out everywhere.`,
      },
    );
  };

  interface PendingRow {
    readonly provider: OAuthProvider;
    readonly subject: string;
    readonly email: string | null;
    readonly emailVerified: number;
    readonly name: string | null;
    readonly refreshToken: string | null;
    readonly refreshClientId: string | null;
    readonly kind: PendingCompletion["kind"];
    readonly bindingHash: string | null;
    readonly redirectUri: string | null;
    readonly codeChallenge: string | null;
    readonly clientState: string | null;
  }

  const pendingRow = (id: string): PendingRow | undefined =>
    db
      .prepare(
        `SELECT provider, subject, email, email_verified AS emailVerified, name, refresh_token AS refreshToken,
                refresh_client_id AS refreshClientId, kind, binding_hash AS bindingHash, redirect_uri AS redirectUri,
                code_challenge AS codeChallenge, client_state AS clientState
         FROM oauth_pending WHERE id_hash = ? AND expires_at > ?`,
      )
      .get(sha256Hex(id), now()) as PendingRow | undefined;

  const completionOf = (row: PendingRow): PendingCompletion =>
    row.kind === "web"
      ? { kind: "web", bindingHash: row.bindingHash ?? "" }
      : row.kind === "native"
        ? {
            kind: "native",
            bindingHash: row.bindingHash ?? "",
            native: { redirectUri: row.redirectUri ?? "", codeChallenge: row.codeChallenge ?? "", state: row.clientState ?? "" },
          }
        : { kind: "direct" };

  const identityOf = (row: PendingRow): ProviderIdentity => ({
    provider: row.provider,
    subject: row.subject,
    ...(row.email === null ? {} : { email: row.email }),
    emailVerified: row.emailVerified === 1,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.refreshToken === null || row.refreshClientId === null ? {} : { refreshToken: row.refreshToken, refreshClientId: row.refreshClientId }),
  });

  /** Runs `write` in one immediate transaction. */
  const transaction = <T>(write: () => T): T => inTransaction(db, write);

  const emailOwner = (email: string): number | undefined =>
    (db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined)?.id;

  const weakPassword = (password: string): boolean => {
    const length = [...password].length;
    return length < MIN_PASSWORD_CODEPOINTS || length > MAX_PASSWORD_CODEPOINTS;
  };

  return {
    dbPath: join(options.dataDir, DB_FILE),

    emailEnabled: mailer !== undefined,
    registrationOpen,

    async login(identifier, password, ip, device) {
      if (ipAttempts.hit(ip, limits.ipMaxAttempts, limits.ipWindowMs)) return { status: "limited" };
      const user = findUser(identifier);
      // The lockout applies to existing and non-existing names alike —
      // answering differently would leak which ones are real.
      const lockKey = lockKeyFor(identifier, user);
      if (userFailures.isOver(lockKey, limits.userMaxFailures)) return { status: "limited" };
      // Re-check inside the task: a burst queues requests that all pass the
      // first check; once earlier failures lock the name, queued work must
      // refuse instead of still verifying (and possibly issuing a session).
      // The failure count is bumped in the task too, so the next queued task's
      // re-check sees it — recording after the await would lag one behind.
      const outcome = await gate.run(async (): Promise<"limited" | "invalid" | number> => {
        if (userFailures.isOver(lockKey, limits.userMaxFailures)) return "limited";
        const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
        if (!ok || user === undefined || user.passwordHash === null) {
          userFailures.bump(lockKey, limits.userWindowMs);
          return "invalid";
        }
        return user.id;
      });
      if (outcome === undefined || outcome === "limited") return { status: "limited" };
      if (outcome === "invalid") return { status: "invalid" };
      // The hash was read before scrypt yielded; a password change or reset
      // that committed meanwhile must not be crossed by a session minted from
      // the old password.
      db.exec("BEGIN IMMEDIATE");
      let session: { readonly token: string; readonly expiresAt: number } | undefined;
      let current: UserRow | undefined;
      try {
        current = userById(outcome);
        if (current !== undefined && current.passwordHash === user?.passwordHash) session = issueSession(outcome, device);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (session === undefined || current === undefined) return { status: "invalid" };
      userFailures.reset(lockKey);
      return { status: "ok", ...session, user: accountUser(current) };
    },

    requestSignupCode({ email, ip }) {
      if (!emailSignup) return "closed";
      if (!codeAllowed(ip, email)) return "limited";
      if (emailOwner(email) !== undefined) {
        deliver(
          "signup_existing",
          email,
          "Your PiNomad account",
          {
            lead: "Someone asked to create a PiNomad account with this email, but you already have an account.",
            note: "Sign in, or reset your password if you forgot it. If this wasn't you, ignore this email.",
          },
        );
        return "sent";
      }
      const code = issueCode("signup", email, null);
      deliver(
        "signup",
        email,
        `${code} is your PiNomad sign-up code`,
        { lead: "Your PiNomad sign-up code", code, note: "If you didn't ask for it, ignore this email." },
      );
      return "sent";
    },

    async register({ email, code, password, ip, device }) {
      if (!emailSignup) return { status: "refused", reason: "registration_closed" };
      // Before the code, so a typo in the password doesn't cost the code.
      if (weakPassword(password)) return { status: "refused", reason: "weak_password" };
      if (ipAttempts.hit(ip, limits.ipMaxAttempts, limits.ipWindowMs)) return { status: "limited" };
      const lockKey = lockKeyFor(email, findUser(email));
      if (userFailures.isOver(lockKey, limits.userMaxFailures)) return { status: "limited" };
      const hash = await gate.run(() => hashPassword(password));
      if (hash === undefined) return { status: "limited" };
      // Code and account land in one transaction: a code is spent only by the
      // sign-up that creates the account.
      db.exec("BEGIN IMMEDIATE");
      try {
        // Taken meanwhile (a CLI add): only the holder of the code sees it,
        // and the code is no good any more.
        if (!spendCode("signup", email, code, lockKey) || emailOwner(email) !== undefined) {
          db.exec("COMMIT");
          return { status: "refused", reason: "invalid_code" };
        }
        const at = now();
        const userId = Number(
          db
            .prepare("INSERT INTO users (email, email_verified_at, password_hash, created_at) VALUES (?, ?, ?, ?)")
            .run(email, at, hash, at).lastInsertRowid,
        );
        const session = issueSession(userId, device);
        const created = userById(userId)!;
        db.exec("COMMIT");
        userFailures.reset(lockKey);
        return { status: "ok", ...session, user: accountUser(created) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    requestPasswordReset({ email, ip }) {
      if (mailer === undefined) return "closed";
      if (!codeAllowed(ip, email)) return "limited";
      const userId = emailOwner(email);
      if (userId === undefined) return "sent";
      const code = issueCode("reset", email, userId);
      deliver(
        "reset",
        email,
        `${code} is your PiNomad password reset code`,
        {
          lead: "Your PiNomad password reset code",
          code,
          note: "If you didn't ask to reset your password, ignore this email; your password stays as it is.",
        },
      );
      return "sent";
    },

    async resetPasswordWithCode({ email, code, password, ip }) {
      if (mailer === undefined) return { status: "refused", reason: "email_unavailable" };
      if (weakPassword(password)) return { status: "refused", reason: "weak_password" };
      if (ipAttempts.hit(ip, limits.ipMaxAttempts, limits.ipWindowMs)) return { status: "limited" };
      const lockKey = lockKeyFor(email, findUser(email));
      if (userFailures.isOver(lockKey, limits.userMaxFailures)) return { status: "limited" };
      const hash = await gate.run(() => hashPassword(password));
      if (hash === undefined) return { status: "limited" };
      db.exec("BEGIN IMMEDIATE");
      try {
        // The account is read inside the write: the code is tied to it, so a
        // deleted account's code went with it.
        const userId = emailOwner(email);
        if (userId === undefined || !spendCode("reset", email, code, lockKey, userId)) {
          if (userId === undefined) userFailures.bump(lockKey, limits.userWindowMs);
          db.exec("COMMIT");
          return { status: "refused", reason: "invalid_code" };
        }
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
        // As with `passwd`: whoever knew the old password keeps nothing.
        dropCredentials(db, userId);
        db.exec("COMMIT");
        userFailures.reset(lockKey);
        return { status: "ok" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async requestEmailCode(args) {
      const { userId, email, ip } = args;
      if (mailer === undefined) return "closed";
      const checked = await confirmAccount(userId, args);
      if (typeof checked === "string") return checked;
      const owner = emailOwner(email);
      if (owner !== undefined && owner !== userId) return "taken";
      if (!codeAllowed(ip, email)) return "limited";
      const code = issueCode("add_email", email, userId);
      deliver(
        "add_email",
        email,
        `${code} is your PiNomad confirmation code`,
        { lead: "Your code to use this email for your PiNomad account", code, note: "If you didn't ask for it, ignore this email." },
      );
      return "sent";
    },

    async setEmail(args) {
      const { userId, email, code } = args;
      if (mailer === undefined) return { status: "refused", reason: "email_unavailable" };
      const checked = await confirmAccount(userId, args);
      if (checked === "limited") return { status: "limited" };
      if (typeof checked === "string") return { status: "refused", reason: checked };
      const lockKey = accountLockKey(userId);
      let previous: string | null | undefined;
      let accountId = "";
      db.exec("BEGIN IMMEDIATE");
      try {
        // As for a password change: a reset while scrypt ran voids the
        // password typed here, and a grant dies with its session.
        const user = userById(userId);
        const stale = user === undefined ? "wrong_password" : stillConfirmed(userId, checked);
        if (user === undefined || stale !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: stale ?? "wrong_password" };
        }
        const owner = emailOwner(email);
        if (owner !== undefined && owner !== userId) {
          db.exec("COMMIT");
          return { status: "refused", reason: "email_taken" };
        }
        if (!spendCode("add_email", email, code, lockKey, userId)) {
          db.exec("COMMIT");
          return { status: "refused", reason: "invalid_code" };
        }
        db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run(email, now(), userId);
        previous = user.email;
        accountId = user.accountId;
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // The address that could reset the password until now hears of it.
      if (previous !== null && previous !== undefined && previous !== email) {
        deliver(
          "email_changed",
          previous,
          "Your PiNomad email was changed",
          {
            lead: `The email of your PiNomad account was changed to ${email}.`,
            note:
              "If this wasn't you, someone else has your password and now controls the account's email. " +
              "Contact your server's operator.",
          },
        );
      }
      return { status: "ok", user: { accountId, username: email, email } };
    },

    authenticate(token) {
      const row = db
        .prepare(
          `SELECT s.user_id AS userId, u.account_id AS accountId, u.username AS username, u.email AS email, s.expires_at AS expiresAt, s.device_id AS deviceId
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        )
        .get(sha256Hex(token)) as
        | { userId: number; accountId: string; username: string | null; email: string | null; expiresAt: number; deviceId: number | null }
        | undefined;
      if (row === undefined || row.expiresAt <= now()) return undefined;
      return {
        userId: row.userId,
        user: accountUser(row),
        ...(row.deviceId === null ? {} : { deviceId: row.deviceId }),
      };
    },

    logout(token, options) {
      const tokenHash = sha256Hex(token);
      if (options?.revoke !== true) {
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
        return [];
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const session = db.prepare("SELECT device_id AS deviceId FROM sessions WHERE token_hash = ?").get(tokenHash) as
          | { deviceId: number | null }
          | undefined;
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
        // A session with no account device (written outside this module)
        // has nothing to withdraw: it just signs out.
        const hostIds = session?.deviceId == null ? [] : withdrawDevice(session.deviceId);
        db.exec("COMMIT");
        return hostIds;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async changePassword(args) {
      const { userId, keepToken, newPassword } = args;
      if (weakPassword(newPassword)) return { status: "refused", reason: "weak_password" };
      // A grant also sets a first password on an account that has none.
      const checked = await confirmAccount(
        userId,
        "reauth" in args ? { reauth: args.reauth, token: keepToken } : { password: args.currentPassword },
      );
      if (checked === "limited") return { status: "limited" };
      if (typeof checked === "string") return { status: "refused", reason: checked };
      const hash = await gate.run(() => hashPassword(newPassword));
      if (hash === undefined) return { status: "limited" };
      // Swap only the hash that was verified, and only while the caller's
      // session is still live: a reset or another change that committed while
      // scrypt ran wins, and a sign-out elsewhere voids the write.
      db.exec("BEGIN IMMEDIATE");
      try {
        const stale =
          "verifiedHash" in checked && !sessionLive(userId, keepToken)
            ? "unauthenticated"
            : stillConfirmed(userId, checked);
        if (stale !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: stale };
        }
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
        dropCredentials(db, userId, sha256Hex(keepToken));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { status: "ok" };
    },

    async deleteAccount(args) {
      const { userId, keepToken } = args;
      const checked = await confirmAccount(userId, args);
      if (checked === "limited") return { status: "limited" };
      if (typeof checked === "string") return { status: "refused", reason: checked };
      // Same compare-and-swap as a password change, and the session that
      // confirmed it must still be live: a reset or a sign-out elsewhere that
      // landed while scrypt ran wins over the delete.
      db.exec("BEGIN IMMEDIATE");
      try {
        const stale =
          "verifiedHash" in checked && !sessionLive(userId, keepToken)
            ? "unauthenticated"
            : stillConfirmed(userId, checked);
        if (stale !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: stale };
        }
        const hostIds = (db.prepare("SELECT host_id AS hostId FROM hosts WHERE user_id = ?").all(userId) as { hostId: string }[]).map(
          (row) => row.hostId,
        );
        // Read before the rows go: Apple is told after the delete (ADR-0044 §9).
        const grants = appleGrants(userId);
        // ON DELETE CASCADE takes sessions (and their re-auth grants), join
        // tokens, hosts, push registrations, account devices with their
        // vouchings, the hosts' pending revocations, mailed codes, provider
        // identities, and provider sign-ins in flight.
        db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        db.exec("COMMIT");
        return { status: "ok", hostIds, appleGrants: grants };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async confirm(userId, confirmation) {
      const checked = await confirmAccount(userId, confirmation);
      return typeof checked === "string" ? checked : "ok";
    },

    requestReauthCode({ userId, ip }) {
      if (mailer === undefined) return "closed";
      const email = userById(userId)?.email ?? null;
      if (email === null) return "no_email";
      if (!codeAllowed(ip, email)) return "limited";
      const code = issueCode("reauth", email, userId);
      deliver(
        "reauth",
        email,
        `${code} is your PiNomad confirmation code`,
        {
          lead: "Your code to confirm a change to your PiNomad account",
          code,
          note: "If you didn't ask for it, someone else may be signed in to your account: sign out everywhere.",
        },
      );
      return "sent";
    },

    async grantReauth(args) {
      const { userId, token } = args;
      const lockKey = accountLockKey(userId);
      if ("password" in args) {
        const checked = await checkPassword(userId, args.password);
        if (checked === "limited") return { status: "limited" };
        if (checked === "wrong_password") return { status: "refused", reason: "wrong_password" };
      } else {
        if (userFailures.isOver(lockKey, limits.userMaxFailures)) return { status: "limited" };
        const email = userById(userId)?.email ?? null;
        const spent = email !== null && transaction(() => spendCode("reauth", email, args.code, lockKey, userId));
        if (!spent) {
          if (email === null) userFailures.bump(lockKey, limits.userWindowMs);
          return { status: "refused", reason: "invalid_code" };
        }
      }
      const reauth = randomBytes(32).toString("base64url");
      const at = now();
      const expiresAt = at + REAUTH_TTL_MS;
      // Tied to the session as it stands now: one that ended while the
      // password was checked gets nothing.
      const granted = transaction(() => {
        db.prepare("DELETE FROM reauth_grants WHERE expires_at <= ?").run(at);
        return db
          .prepare(
            `INSERT INTO reauth_grants (grant_hash, session_hash, expires_at)
             SELECT ?, token_hash, ? FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?`,
          )
          .run(sha256Hex(reauth), expiresAt, sha256Hex(token), userId, at).changes;
      });
      return Number(granted) === 1 ? { status: "ok", reauth, expiresAt } : { status: "refused", reason: "unauthenticated" };
    },

    startOAuthFlow({ provider, kind, ip, bindingHash, native, linkUserId, linkSessionToken }) {
      if (oauthStarts.hit(ip, oauthLimits.startMaxPerIp, oauthLimits.startWindowMs)) return { status: "limited" };
      const at = now();
      db.prepare("DELETE FROM oauth_flows WHERE expires_at <= ?").run(at);
      const live = (db.prepare("SELECT COUNT(*) AS n FROM oauth_flows").get() as { n: number }).n;
      if (live >= oauthLimits.maxPending) return { status: "busy" };
      const state = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      db.prepare(
        `INSERT INTO oauth_flows (state_hash, provider, kind, verifier, nonce, binding_hash, redirect_uri, code_challenge, client_state,
                                  link_user_id, link_session_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sha256Hex(state),
        provider,
        kind,
        verifier,
        nonce,
        bindingHash ?? null,
        native?.redirectUri ?? null,
        native?.codeChallenge ?? null,
        native?.state ?? null,
        linkUserId ?? null,
        linkSessionToken === undefined ? null : sha256Hex(linkSessionToken),
        at,
        at + OAUTH_FLOW_TTL_MS,
      );
      return { status: "ok", state, verifier, nonce };
    },

    startNativeLink({ provider, ticket, bindingHash, ip }) {
      if (oauthStarts.hit(ip, oauthLimits.startMaxPerIp, oauthLimits.startWindowMs)) return { status: "limited" };
      const state = randomBytes(32).toString("base64url");
      const row = db
        .prepare(
          `UPDATE oauth_flows SET state_hash = ?, binding_hash = ?
           WHERE binding_hash = ? AND provider = ? AND kind = 'link' AND redirect_uri IS NOT NULL AND expires_at > ?
           RETURNING verifier, nonce`,
        )
        .get(sha256Hex(state), bindingHash, sha256Hex(ticket), provider, now()) as { verifier: string; nonce: string } | undefined;
      return row === undefined ? undefined : { status: "ok", state, verifier: row.verifier, nonce: row.nonce };
    },

    takeOAuthFlow(provider, state) {
      const hash = sha256Hex(state);
      const row = db
        .prepare(
          `SELECT provider, kind, verifier, nonce, binding_hash AS bindingHash, redirect_uri AS redirectUri, code_challenge AS codeChallenge,
                  client_state AS clientState, link_user_id AS linkUserId, link_session_hash AS linkSessionHash, expires_at AS expiresAt
           FROM oauth_flows WHERE state_hash = ?`,
        )
        .get(hash) as
        | {
            provider: OAuthProvider;
            kind: OAuthFlow["kind"];
            verifier: string;
            nonce: string;
            bindingHash: string | null;
            redirectUri: string | null;
            codeChallenge: string | null;
            clientState: string | null;
            linkUserId: number | null;
            linkSessionHash: string | null;
            expiresAt: number;
          }
        | undefined;
      // Spent by its first callback, whatever happens next.
      if (row !== undefined) db.prepare("DELETE FROM oauth_flows WHERE state_hash = ?").run(hash);
      if (row === undefined || row.expiresAt <= now() || row.provider !== provider) return undefined;
      return {
        provider: row.provider,
        kind: row.kind,
        verifier: row.verifier,
        nonce: row.nonce,
        ...(row.bindingHash === null ? {} : { bindingHash: row.bindingHash }),
        ...(row.redirectUri === null || row.codeChallenge === null
          ? {}
          : { native: { redirectUri: row.redirectUri, codeChallenge: row.codeChallenge, state: row.clientState ?? "" } }),
        ...(row.linkUserId === null ? {} : { linkUserId: row.linkUserId }),
        ...(row.linkSessionHash === null ? {} : { linkSessionHash: row.linkSessionHash }),
      };
    },

    resolveIdentity(identity, completion) {
      const result = transaction((): ResolveIdentityResult & { notify?: string } => {
        const bound = identityOwner(identity.provider, identity.subject);
        if (bound !== undefined) {
          bindIdentity(bound, identity);
          return { status: "user", userId: bound };
        }
        // Both sides verified, or no merge: an unverified email must never
        // reach someone else's account (ADR-0044 §4).
        if (identity.emailVerified && identity.email !== undefined) {
          const owner = db.prepare("SELECT id FROM users WHERE email = ? AND email_verified_at IS NOT NULL").get(identity.email) as
            | { id: number }
            | undefined;
          if (owner !== undefined) {
            bindIdentity(owner.id, identity);
            return { status: "user", userId: owner.id, notify: identity.email };
          }
        }
        if (!registrationOpen) return { status: "refused", reason: "registration_closed" };
        const id = randomBytes(32).toString("base64url");
        const at = now();
        db.prepare("DELETE FROM oauth_pending WHERE expires_at <= ?").run(at);
        db.prepare(
          `INSERT INTO oauth_pending (id_hash, provider, subject, email, email_verified, name, refresh_token, refresh_client_id,
                                      kind, binding_hash, redirect_uri, code_challenge, client_state, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sha256Hex(id),
          identity.provider,
          identity.subject,
          identity.email ?? null,
          identity.emailVerified ? 1 : 0,
          identity.name ?? null,
          identity.refreshToken ?? null,
          identity.refreshClientId ?? null,
          completion.kind,
          completion.kind === "direct" ? null : completion.bindingHash,
          completion.kind === "native" ? completion.native.redirectUri : null,
          completion.kind === "native" ? completion.native.codeChallenge : null,
          completion.kind === "native" ? completion.native.state : null,
          at,
          at + OAUTH_PENDING_TTL_MS,
        );
        return { status: "pending", id, ...(identity.email === undefined ? {} : { email: identity.email }) };
      });
      if (result.notify !== undefined) noticeNewMethod(result.notify, identity.provider);
      const { notify: _notify, ...answer } = result;
      return answer;
    },

    linkIdentity: (flow, identity) => linkIdentity(flow, identity),

    pendingSignIn(id) {
      const row = pendingRow(id);
      if (row === undefined) return undefined;
      return {
        provider: row.provider,
        ...(row.email === null ? {} : { email: row.email }),
        ...(row.name === null ? {} : { name: row.name }),
        completion: completionOf(row),
      };
    },

    async createFromPending(id, password) {
      if (password === undefined && mailer === undefined) return { status: "refused", reason: "password_required" };
      if (password !== undefined && weakPassword(password)) return { status: "refused", reason: "weak_password" };
      const hash = password === undefined ? null : await gate.run(() => hashPassword(password));
      if (hash === undefined) return { status: "limited" };
      return transaction((): PendingResult => {
        const row = pendingRow(id);
        if (row === undefined) return { status: "refused", reason: "not_found" };
        // A refusal leaves the record for the other choice, linking.
        if (!registrationOpen) return { status: "refused", reason: "registration_closed" };
        if (row.email === null || row.emailVerified !== 1) return { status: "refused", reason: "no_verified_email" };
        if (emailOwner(row.email) !== undefined) return { status: "refused", reason: "email_taken" };
        if (identityOwner(row.provider, row.subject) !== undefined) return { status: "refused", reason: "identity_taken" };
        const at = now();
        const userId = Number(
          db.prepare("INSERT INTO users (email, email_verified_at, password_hash, created_at) VALUES (?, ?, ?, ?)").run(row.email, at, hash, at)
            .lastInsertRowid,
        );
        bindIdentity(userId, identityOf(row));
        db.prepare("DELETE FROM oauth_pending WHERE id_hash = ?").run(sha256Hex(id));
        return { status: "ok", userId, completion: completionOf(row) };
      });
    },

    linkPending(id, userId) {
      return transaction((): PendingResult => {
        const row = pendingRow(id);
        if (row === undefined) return { status: "refused", reason: "not_found" };
        const bound = identityOwner(row.provider, row.subject);
        if (bound !== undefined && bound !== userId) return { status: "refused", reason: "identity_taken" };
        bindIdentity(userId, identityOf(row));
        db.prepare("DELETE FROM oauth_pending WHERE id_hash = ?").run(sha256Hex(id));
        return { status: "ok", userId, completion: completionOf(row) };
      });
    },

    signIn(userId, device) {
      return transaction(() => {
        const user = userById(userId);
        return user === undefined ? undefined : { ...issueSession(userId, device), user: accountUser(user) };
      });
    },

    issueLinkCode({ identity, linkUserId, linkSessionHash, codeChallenge }) {
      const at = now();
      const live = db.prepare("SELECT 1 AS x FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?").get(linkSessionHash, linkUserId, at);
      if (live === undefined) return "session_ended";
      for (const [hash, entry] of linkCodes) if (entry.expiresAt <= at) linkCodes.delete(hash);
      // Bounded like the flows that lead here; the oldest goes first.
      if (linkCodes.size >= oauthLimits.maxPending) linkCodes.delete(linkCodes.keys().next().value!);
      const code = randomBytes(32).toString("base64url");
      linkCodes.set(sha256Hex(code), { identity, linkUserId, linkSessionHash, codeChallenge, expiresAt: at + OAUTH_CODE_TTL_MS });
      return { code };
    },

    completeLink({ code, codeVerifier, token }) {
      const hash = sha256Hex(code);
      const entry = linkCodes.get(hash);
      // Spent by any attempt, right verifier or not.
      linkCodes.delete(hash);
      if (
        entry === undefined ||
        entry.expiresAt <= now() ||
        !safeEqual(sha256Hex(token), entry.linkSessionHash) ||
        !safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), entry.codeChallenge)
      ) {
        return "invalid_grant";
      }
      return linkIdentity({ linkUserId: entry.linkUserId, linkSessionHash: entry.linkSessionHash }, entry.identity);
    },

    issueOAuthCode(userId, codeChallenge) {
      const code = randomBytes(32).toString("base64url");
      const at = now();
      db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(at);
      db.prepare("INSERT INTO oauth_codes (code_hash, user_id, code_challenge, expires_at) VALUES (?, ?, ?, ?)").run(
        sha256Hex(code),
        userId,
        codeChallenge,
        at + OAUTH_CODE_TTL_MS,
      );
      return code;
    },

    exchangeOAuthCode(code, codeVerifier, device) {
      const hash = sha256Hex(code);
      return transaction(() => {
        const row = db.prepare("SELECT user_id AS userId, code_challenge AS challenge, expires_at AS expiresAt FROM oauth_codes WHERE code_hash = ?").get(hash) as
          | { userId: number; challenge: string; expiresAt: number }
          | undefined;
        if (row === undefined) return undefined;
        // Spent by any attempt, right verifier or not.
        db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(hash);
        if (row.expiresAt <= now() || !safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), row.challenge)) return undefined;
        const user = userById(row.userId);
        return user === undefined ? undefined : { ...issueSession(row.userId, device), user: accountUser(user) };
      });
    },

    listIdentities(userId) {
      const rows = db
        .prepare("SELECT provider, email, created_at AS createdAt FROM user_identities WHERE user_id = ? ORDER BY created_at, provider")
        .all(userId) as unknown as { provider: OAuthProvider; email: string | null; createdAt: number }[];
      return {
        identities: rows.map((row) => ({ provider: row.provider, ...(row.email === null ? {} : { email: row.email }), createdAt: row.createdAt })),
        hasPassword: (userById(userId)?.passwordHash ?? null) !== null,
      };
    },

    async removeIdentity(args) {
      const { userId, provider } = args;
      const checked = await confirmAccount(userId, args);
      if (checked === "limited") return { status: "limited" };
      if (typeof checked === "string") return { status: "refused", reason: checked };
      return transaction((): RemoveIdentityResult => {
        const stale = stillConfirmed(userId, checked);
        if (stale !== undefined) return { status: "refused", reason: stale };
        const counts = db
          .prepare("SELECT SUM(provider = ?) AS mine, SUM(provider <> ?) AS others FROM user_identities WHERE user_id = ?")
          .get(provider, provider, userId) as { mine: number | null; others: number | null };
        if ((counts.mine ?? 0) === 0) return { status: "refused", reason: "not_found" };
        // Never the last way in: with no password and no other provider, the
        // account could only be reached through a password reset by email.
        if ((counts.others ?? 0) === 0 && (userById(userId)?.passwordHash ?? null) === null) {
          return { status: "refused", reason: "last_method" };
        }
        const grants = provider === "apple" ? appleGrants(userId) : [];
        db.prepare("DELETE FROM user_identities WHERE user_id = ? AND provider = ?").run(userId, provider);
        return { status: "ok", appleGrants: grants };
      });
    },

    revokeAllSessions(userId) {
      // Signing out everywhere also stops every device of the account from
      // receiving pushes until it logs in and registers again (ADR-0036 §5).
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
        db.prepare("DELETE FROM push_tokens WHERE user_id = ?").run(userId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    hasHost(hostId) {
      return db.prepare("SELECT 1 AS x FROM hosts WHERE host_id = ?").get(hostId) !== undefined;
    },

    hostOwner(hostId) {
      const row = db.prepare("SELECT user_id AS userId FROM hosts WHERE host_id = ?").get(hostId) as
        | { userId: number }
        | undefined;
      return row?.userId;
    },

    registerPushToken(userId, token, environment, deviceId) {
      const at = now();
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM push_tokens WHERE updated_at < ?").run(at - PUSH_TOKEN_TTL_MS);
        db.prepare(
          `INSERT INTO push_tokens (token, environment, user_id, updated_at, device_id) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (token, environment) DO UPDATE SET
             user_id = excluded.user_id, updated_at = excluded.updated_at, device_id = excluded.device_id`,
        ).run(token.toLowerCase(), environment, userId, at, deviceId ?? null);
        db.prepare(
          `DELETE FROM push_tokens WHERE user_id = ? AND rowid NOT IN (
             SELECT rowid FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
           )`,
        ).run(userId, userId, MAX_PUSH_TOKENS_PER_USER);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    removePushToken(userId, token, environment) {
      db.prepare("DELETE FROM push_tokens WHERE token = ? AND environment = ? AND user_id = ?").run(
        token.toLowerCase(),
        environment,
        userId,
      );
    },

    pushTokenOwner(token, environment) {
      const row = db
        .prepare("SELECT user_id AS userId FROM push_tokens WHERE token = ? AND environment = ? AND updated_at >= ?")
        .get(token.toLowerCase(), environment, now() - PUSH_TOKEN_TTL_MS) as { userId: number } | undefined;
      return row?.userId;
    },

    forgetPushToken(token, environment, unregisteredAt) {
      db.prepare("DELETE FROM push_tokens WHERE token = ? AND environment = ? AND updated_at < ?").run(
        token.toLowerCase(),
        environment,
        unregisteredAt,
      );
    },

    createJoinToken(userId) {
      // Sweep dead rows opportunistically, the same convention as expired
      // sessions on login.
      sweepExpired();
      return mintJoinToken(userId, null);
    },

    startHostLink({ hostId, name, os, ip, loopback }) {
      if (linkStarts.hit(ip, linkLimits.startMaxPerIp, linkLimits.startWindowMs)) return { status: "limited" };
      sweepExpired();
      const live = (db.prepare("SELECT COUNT(*) AS n FROM host_link_requests").get() as { n: number }).n;
      if (live >= linkLimits.maxPending) return { status: "busy" };
      const deviceCode = randomBytes(32).toString("base64url");
      const at = now();
      const expiresAt = at + HOST_LINK_TTL_MS;
      const hostName = normalizeHostName(name);
      const hostOs = [...os.trim()].slice(0, HOST_OS_MAX_CODEPOINTS).join("");
      if (loopback !== undefined) {
        // Nobody holds a device code or user code for it: the redirect is the
        // only way out, so a poll can't bypass the loopback binding.
        const requestId = randomBytes(32).toString("base64url");
        db.prepare(
          `INSERT INTO host_link_requests
             (device_code_hash, user_code_hash, request_id_hash, redirect_uri, code_challenge, client_state,
              host_id, host_name, host_os, source_ip, interval_s, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sha256Hex(randomBytes(32).toString("base64url")),
          sha256Hex(randomBytes(32).toString("base64url")),
          sha256Hex(requestId),
          loopback.redirectUri,
          loopback.codeChallenge,
          loopback.state,
          hostId,
          hostName,
          hostOs,
          ip,
          HOST_LINK_INTERVAL_S,
          at,
          expiresAt,
        );
        return { status: "ok", mode: "loopback", requestId, expiresAt };
      }
      const insert = db.prepare(
        `INSERT INTO host_link_requests
           (device_code_hash, user_code_hash, host_id, host_name, host_os, source_ip, interval_s, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Live codes are unique; with at most maxPending of them among 20^8, a
      // collision is rare enough that a few redraws always settle it.
      for (let attempt = 0; ; attempt++) {
        const code = Array.from({ length: USER_CODE_LENGTH }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");
        try {
          insert.run(
            sha256Hex(deviceCode),
            sha256Hex(code),
            hostId,
            hostName,
            hostOs,
            ip,
            HOST_LINK_INTERVAL_S,
            at,
            expiresAt,
          );
          return { status: "ok", mode: "code", deviceCode, userCode: formatUserCode(code), expiresAt, interval: HOST_LINK_INTERVAL_S };
        } catch (error) {
          if (attempt >= 4 || !String(error).includes("UNIQUE")) throw error;
        }
      }
    },

    pollHostLink(deviceCode) {
      const deviceCodeHash = sha256Hex(deviceCode);
      const at = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT host_id AS hostId, state, user_id AS userId, interval_s AS intervalS, last_poll_at AS lastPollAt, expires_at AS expiresAt
             FROM host_link_requests WHERE device_code_hash = ?`,
          )
          .get(deviceCodeHash) as
          | { hostId: string; state: string; userId: number | null; intervalS: number; lastPollAt: number | null; expiresAt: number }
          | undefined;
        let result: PollHostLinkResult;
        if (row === undefined || row.expiresAt <= at) {
          db.prepare("DELETE FROM host_link_requests WHERE device_code_hash = ?").run(deviceCodeHash);
          result = { status: "expired" };
        } else if (row.lastPollAt !== null && at - row.lastPollAt < row.intervalS * 1000 - POLL_SLACK_MS) {
          const interval = row.intervalS + SLOW_DOWN_STEP_S;
          db.prepare("UPDATE host_link_requests SET interval_s = ?, last_poll_at = ? WHERE device_code_hash = ?").run(
            interval,
            at,
            deviceCodeHash,
          );
          result = { status: "slow_down", interval };
        } else if (row.state === "pending") {
          db.prepare("UPDATE host_link_requests SET last_poll_at = ? WHERE device_code_hash = ?").run(at, deviceCodeHash);
          result = { status: "pending" };
        } else {
          // Settled: this poll is the answer, and the request is spent.
          db.prepare("DELETE FROM host_link_requests WHERE device_code_hash = ?").run(deviceCodeHash);
          result =
            row.state === "confirmed" && row.userId !== null
              ? { status: "confirmed", ...mintJoinToken(row.userId, row.hostId) }
              : { status: "denied" };
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    lookupHostLink(args) {
      const { userId, ip } = args;
      const found = pendingByRef(userId, args, ip);
      if (found === "limited" || found === "not_found") return { status: found };
      const { row } = found;
      return {
        status: "ok",
        request: {
          hostId: row.hostId,
          name: row.name ?? "",
          os: row.os ?? "",
          sourceIp: row.sourceIp ?? "",
          ipDiffers: row.sourceIp !== ip,
          expiresAt: row.expiresAt,
        },
      };
    },

    confirmHostLink(args) {
      return settleHostLink(args, "confirmed");
    },

    denyHostLink(args) {
      return settleHostLink(args, "denied");
    },

    exchangeHostLinkCode(code, codeVerifier) {
      const codeHash = sha256Hex(code);
      const at = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT host_id AS hostId, user_id AS userId, code_challenge AS challenge, auth_code_expires_at AS codeExpiresAt
             FROM host_link_requests WHERE auth_code_hash = ? AND state = 'confirmed'`,
          )
          .get(codeHash) as { hostId: string; userId: number | null; challenge: string | null; codeExpiresAt: number | null } | undefined;
        // Spent by any attempt, right verifier or not.
        if (row !== undefined) db.prepare("DELETE FROM host_link_requests WHERE auth_code_hash = ?").run(codeHash);
        const valid =
          row !== undefined &&
          row.userId !== null &&
          row.challenge !== null &&
          row.codeExpiresAt !== null &&
          row.codeExpiresAt > at &&
          safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), row.challenge);
        const result = valid ? { status: "ok" as const, ...mintJoinToken(row.userId!, row.hostId) } : { status: "invalid" as const };
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    sweepExpired,

    joinHost({ token, hostId, noisePublicKey, name }) {
      const tokenHash = sha256Hex(token);
      const at = now();
      db.exec("BEGIN");
      try {
        const row = db
          .prepare(
            "SELECT user_id AS userId, expires_at AS expiresAt, used_at AS usedAt, host_id AS boundHostId FROM join_tokens WHERE token_hash = ?",
          )
          .get(tokenHash) as { userId: number; expiresAt: number; usedAt: number | null; boundHostId: string | null } | undefined;
        let failure: "invalid_token" | "expired_token" | undefined;
        // A token from a host link joins only the host the user confirmed (#495).
        if (row === undefined || row.usedAt !== null || (row.boundHostId !== null && row.boundHostId !== hostId)) {
          failure = "invalid_token";
        }
        else if (row.expiresAt <= at) failure = "expired_token";
        else {
          // The conditional UPDATE is what makes the token single-use: it
          // claims the row atomically, so a concurrent re-spend sees zero
          // changes and is refused instead of binding twice.
          const consumed = db
            .prepare("UPDATE join_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
            .run(at, tokenHash);
          if (Number(consumed.changes) !== 1) failure = "invalid_token";
        }
        if (failure !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: failure };
        }
        // A join that reports no name at all stays "Unknown host"; a
        // reported one goes through the shared cleaning like every write.
        const hostName = name === undefined ? "Unknown host" : normalizeHostName(name);
        // A host moving to another account takes nothing of the old one's
        // along: which of its devices came in through which account device,
        // and what it still owes, belonged to that account (ADR-0037).
        const previousOwner = (db.prepare("SELECT user_id AS userId FROM hosts WHERE host_id = ?").get(hostId) as { userId: number } | undefined)
          ?.userId;
        if (previousOwner !== undefined && previousOwner !== row!.userId) {
          db.prepare("DELETE FROM vouchings WHERE host_id = ?").run(hostId);
          db.prepare("DELETE FROM pending_revocations WHERE host_id = ?").run(hostId);
        }
        // Re-joining an already-bound hostId rebinds it (a new account gets it);
        // the upsert is what makes a lost join response safe to retry. A
        // repeat join to the same account keeps its join time, which clients
        // announce a host by (#531); a removal deletes the row, so a host back
        // after one gets a new time.
        db.prepare(
          `INSERT INTO hosts (host_id, user_id, noise_public_key, name, joined_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(host_id) DO UPDATE SET
             user_id = excluded.user_id,
             noise_public_key = excluded.noise_public_key,
             name = excluded.name,
             joined_at = CASE WHEN hosts.user_id = excluded.user_id THEN hosts.joined_at ELSE excluded.joined_at END,
             last_seen_at = excluded.last_seen_at`,
        ).run(hostId, row!.userId, noisePublicKey, hostName, at, at);
        db.prepare("DELETE FROM removed_hosts WHERE host_id = ?").run(hostId);
        const user = userById(row!.userId);
        db.exec("COMMIT");
        return { status: "joined", username: user === undefined ? "unknown" : accountUser(user).username };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    leaveHost(hostId) {
      // Vouchings and pending revocations go with the row (ON DELETE CASCADE).
      return Number(db.prepare("DELETE FROM hosts WHERE host_id = ?").run(hostId).changes) > 0;
    },

    async removeHost(args) {
      const { userId, hostId } = args;
      const owned = (): boolean =>
        db.prepare("SELECT 1 AS x FROM hosts WHERE host_id = ? AND user_id = ?").get(hostId, userId) !== undefined;
      if (!owned()) return { status: "refused", reason: "not_found" };
      const checked = await confirmAccount(userId, args);
      if (checked === "limited") return { status: "limited" };
      if (typeof checked === "string") return { status: "refused", reason: checked };
      db.exec("BEGIN IMMEDIATE");
      try {
        // As in kickDevice: a reset during scrypt voids the typed password,
        // and a re-join during it may have moved the host to another account.
        const stale = stillConfirmed(userId, checked);
        if (stale !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: stale };
        }
        if (!owned()) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: "not_found" };
        }
        db.prepare("DELETE FROM hosts WHERE host_id = ?").run(hostId);
        db.prepare("INSERT INTO removed_hosts (host_id, removed_at) VALUES (?, ?) ON CONFLICT(host_id) DO UPDATE SET removed_at = excluded.removed_at").run(
          hostId,
          now(),
        );
        db.exec("COMMIT");
        return { status: "ok" };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    wasRemoved(hostId) {
      return db.prepare("SELECT 1 AS x FROM removed_hosts WHERE host_id = ?").get(hostId) !== undefined;
    },

    listHosts(userId) {
      return (
        db
          .prepare(
            `SELECT host_id AS hostId, user_id AS userId, noise_public_key AS noisePublicKey,
                    name, joined_at AS joinedAt, last_seen_at AS lastSeenAt, device_reports AS deviceReports
             FROM hosts WHERE user_id = ? ORDER BY joined_at`,
          )
          .all(userId) as unknown as (Omit<HostRow, "deviceReports"> & { deviceReports: number })[]
      ).map((row) => ({ ...row, deviceReports: row.deviceReports === 1 }));
    },

    hostFor(userId, hostId) {
      const row = db
        .prepare(
          `SELECT host_id AS hostId, user_id AS userId, noise_public_key AS noisePublicKey,
                  name, joined_at AS joinedAt, last_seen_at AS lastSeenAt, device_reports AS deviceReports
           FROM hosts WHERE user_id = ? AND host_id = ?`,
        )
        .get(userId, hostId) as (Omit<HostRow, "deviceReports"> & { deviceReports: number }) | undefined;
      return row === undefined ? undefined : { ...row, deviceReports: row.deviceReports === 1 };
    },

    markHostSeen(hostId, deviceReports) {
      db.prepare("UPDATE hosts SET last_seen_at = ?, device_reports = ? WHERE host_id = ?").run(now(), deviceReports ? 1 : 0, hostId);
    },

    listDevices(userId) {
      const devices = db
        .prepare(
          `SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt, kicked_at AS kickedAt
           FROM account_devices WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC`,
        )
        .all(userId) as unknown as { id: number; name: string | null; createdAt: number; lastSeenAt: number; kickedAt: number | null }[];
      // One row per reported key; a device that re-joined a host under a new
      // key has several, and the host shows its best standing.
      const keys = db
        .prepare(
          `SELECT v.device_id AS deviceId, v.host_id AS hostId, h.name AS hostName,
                  v.revoked_at IS NOT NULL AS revoked,
                  EXISTS (SELECT 1 FROM pending_revocations p WHERE p.host_id = v.host_id AND p.public_key = v.public_key) AS pending
           FROM vouchings v JOIN hosts h ON h.host_id = v.host_id JOIN account_devices d ON d.id = v.device_id
           WHERE d.user_id = ? AND v.public_key IS NOT NULL
           ORDER BY h.joined_at, v.host_id`,
        )
        .all(userId) as unknown as { deviceId: number; hostId: string; hostName: string; revoked: number; pending: number }[];
      const rank: Record<DeviceHostState, number> = { registered: 2, revoking: 1, revoked: 0 };
      const hosts = new Map<number, Map<string, { hostId: string; name: string; state: DeviceHostState }>>();
      for (const key of keys) {
        const state: DeviceHostState = key.pending === 1 ? "revoking" : key.revoked === 1 ? "revoked" : "registered";
        const perDevice = hosts.get(key.deviceId) ?? new Map<string, { hostId: string; name: string; state: DeviceHostState }>();
        hosts.set(key.deviceId, perDevice);
        const seen = perDevice.get(key.hostId);
        if (seen === undefined || rank[state] > rank[seen.state]) perDevice.set(key.hostId, { hostId: key.hostId, name: key.hostName, state });
      }
      return devices.map((device) => ({
        id: device.id,
        ...(device.name === null ? {} : { name: device.name }),
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        ...(device.kickedAt === null ? {} : { kickedAt: device.kickedAt }),
        hosts: [...(hosts.get(device.id)?.values() ?? [])],
      }));
    },

    recordVouching({ token, hostId, requestId, expiresAt }) {
      sweepVouchings();
      const session = db
        .prepare(
          `SELECT s.device_id AS deviceId FROM sessions s JOIN hosts h ON h.user_id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ? AND h.host_id = ?`,
        )
        .get(sha256Hex(token), now(), hostId) as { deviceId: number | null } | undefined;
      if (session === undefined) return false;
      if (session.deviceId !== null) {
        db.prepare("INSERT OR IGNORE INTO vouchings (request_id, device_id, host_id, expires_at) VALUES (?, ?, ?, ?)").run(
          requestId,
          session.deviceId,
          hostId,
          Math.min(expiresAt, now() + MAX_OFFER_TTL_MS),
        );
      }
      return true;
    },

    recordAdmission(hostId, requestId, publicKey) {
      db.exec("BEGIN");
      try {
        const vouching = db
          .prepare(
            `SELECT expires_at AS expiresAt, public_key AS publicKey, revoked_at AS revokedAt
             FROM vouchings WHERE request_id = ? AND host_id = ?`,
          )
          .get(requestId, hostId) as { expiresAt: number; publicKey: string | null; revokedAt: number | null } | undefined;
        // A report names one offer, once: another host's requestId, a second
        // report for the same offer, or one long past its offer is not a fact
        // this server vouched for.
        if (vouching === undefined || vouching.publicKey !== null || vouching.expiresAt + ADMISSION_REPORT_GRACE_MS <= now()) {
          db.exec("ROLLBACK");
          return "ignored";
        }
        db.prepare("UPDATE vouchings SET public_key = ?, admitted_at = ? WHERE request_id = ?").run(publicKey, now(), requestId);
        // Kicked while it held the secret: the host admitted a device on an
        // offer the account withdrew, so the revocation follows at once. A
        // sign-in since then doesn't matter: it only vouches for offers
        // handed out after it.
        if (vouching.revokedAt !== null) {
          db.prepare("INSERT OR IGNORE INTO pending_revocations (host_id, public_key, created_at) VALUES (?, ?, ?)").run(
            hostId,
            publicKey,
            now(),
          );
        }
        db.exec("COMMIT");
        return vouching.revokedAt === null ? "recorded" : "revoke";
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    pendingRevocations(hostId) {
      return (
        db.prepare("SELECT public_key AS publicKey FROM pending_revocations WHERE host_id = ? ORDER BY created_at").all(hostId) as {
          publicKey: string;
        }[]
      ).map((row) => row.publicKey);
    },

    confirmRevocation(hostId, publicKey) {
      // The vouching was marked withdrawn when the revocation was asked for;
      // the ack only ends the asking. An ack for anything else changes nothing.
      db.prepare("DELETE FROM pending_revocations WHERE host_id = ? AND public_key = ?").run(hostId, publicKey);
    },

    async kickDevice(args) {
      const { userId, deviceId, currentDeviceId } = args;
      const owned = (): boolean =>
        db.prepare("SELECT 1 AS x FROM account_devices WHERE id = ? AND user_id = ?").get(deviceId, userId) !== undefined;
      // Cheap refusals first: neither costs a scrypt run or a lockout strike.
      if (!owned()) return { status: "refused", reason: "not_found" };
      if (deviceId === currentDeviceId) return { status: "refused", reason: "current_device" };
      const checked = await confirmAccount(userId, args);
      if (checked === "limited") return { status: "limited" };
      if (typeof checked === "string") return { status: "refused", reason: checked };
      db.exec("BEGIN IMMEDIATE");
      try {
        // Same compare-and-swap as a password change: a reset that committed
        // while scrypt ran means the password typed here no longer holds.
        const stale = stillConfirmed(userId, checked);
        if (stale !== undefined) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: stale };
        }
        if (!owned()) {
          db.exec("ROLLBACK");
          return { status: "refused", reason: "not_found" };
        }
        const hostIds = withdrawDevice(deviceId);
        db.exec("COMMIT");
        return { status: "ok", hostIds };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    renameHost(hostId, name) {
      db.prepare("UPDATE hosts SET name = ? WHERE host_id = ?").run(normalizeHostName(name), hostId);
    },

    async close() {
      db.close();
      await release();
    },
  };
}

/**
 * Everything a password change must not leave live (#450): sessions (all but
 * `keepTokenHash`), unused join tokens and the host links that would mint
 * one (#495), push registrations, which a signed-out device would otherwise
 * keep receiving (ADR-0036 §5), and unspent mailed codes (ADR-0044). Runs
 * inside the caller's transaction.
 */
function dropCredentials(db: DatabaseSync, userId: number, keepTokenHash?: string): void {
  if (keepTokenHash === undefined) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  else db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, keepTokenHash);
  db.prepare("DELETE FROM join_tokens WHERE user_id = ? AND used_at IS NULL").run(userId);
  // A confirmed host link is a join token the host hasn't collected yet.
  db.prepare("DELETE FROM host_link_requests WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM push_tokens WHERE user_id = ?").run(userId);
  // A reset code mailed before the change would undo it.
  db.prepare("DELETE FROM email_codes WHERE user_id = ?").run(userId);
}

/**
 * The operator's commands (`pinomad server passwd`, `user add`, `user
 * set-email`) work whether or not the server is running: a stopped server's
 * directory is locked and migrated as usual; beside a running one they write
 * through SQLite's own locking, and only when the database is on this
 * build's schema, so an upgraded package never migrates the tables under an
 * older running server. The running server reads accounts and sessions from
 * the database on every request, so a change takes effect at once.
 */
async function withOperatorDatabase<T>(dataDir: string, write: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
  await mkdir(dataDir, { recursive: true });
  // retries: 0 answers "is a server running" at once; the default stale value
  // must match what servers use or a live lock looks abandoned.
  const release = await lockDataDir(dataDir, { retries: 0 }).catch((error: unknown) => {
    if (isDataDirInUse(error)) return undefined;
    throw error;
  });
  const db = openDatabase(dataDir);
  try {
    if (release !== undefined) {
      migrate(db);
    } else if (schemaVersion(db) !== SCHEMA_VERSION) {
      throw new Error(
        `the running server's database schema (${schemaVersion(db)}) differs from this build's (${SCHEMA_VERSION}); restart the server on this version first`,
      );
    }
    return await write(db);
  } finally {
    db.close();
    await release?.();
  }
}

/** Runs `write` in one immediate transaction. */
function inTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The one account `user` names, by email in any case or legacy username; every account when absent, which must be one. */
function operatorTarget(db: DatabaseSync, user: string | undefined): number {
  const users = (
    user === undefined
      ? db.prepare("SELECT id FROM users").all()
      : db.prepare("SELECT id FROM users WHERE email = ? OR username = ?").all(normalizeEmail(user) ?? null, user)
  ) as { id: number }[];
  if (users.length === 0) throw new Error(user === undefined ? "no account exists yet" : `no such account: ${user}`);
  if (users.length > 1) throw new Error(user === undefined ? "more than one account exists — pass --user" : `${user} names more than one account`);
  return users[0]!.id;
}

/**
 * `pinomad server passwd`: the operator resets an account's password, the
 * way a user who forgot theirs gets back in (#450). One transaction swaps the
 * hash and drops the account's credentials, so it is signed out at once.
 */
export async function resetPassword(options: {
  readonly dataDir: string;
  /** An email or legacy username; may be left out while there is one account. */
  readonly user?: string;
  readonly password: string;
}): Promise<void> {
  assertPasswordPolicy(options.password);
  await withOperatorDatabase(options.dataDir, async (db) => {
    // Hash first, then find the account inside the write: a freed id goes
    // to the next sign-up, so an id read before scrypt yields could name
    // someone else by the time it's written.
    const hash = await hashPassword(options.password);
    inTransaction(db, () => {
      const userId = operatorTarget(db, options.user);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
      dropCredentials(db, userId);
    });
  });
}

/**
 * `pinomad server user add <email>`: the operator creates an account, the
 * way people join a server whose registration is closed (ADR-0044 §7). The
 * operator typed the email, so it counts as verified.
 */
export async function addUser(options: { readonly dataDir: string; readonly email: string; readonly password: string }): Promise<void> {
  const email = requireEmail(options.email);
  assertPasswordPolicy(options.password);
  await withOperatorDatabase(options.dataDir, async (db) => {
    const hash = await hashPassword(options.password);
    inTransaction(db, () => {
      if (db.prepare("SELECT 1 AS x FROM users WHERE email = ?").get(email) !== undefined) {
        throw new Error(`an account with ${email} already exists`);
      }
      const at = Date.now();
      db.prepare("INSERT INTO users (email, email_verified_at, password_hash, created_at) VALUES (?, ?, ?, ?)").run(email, at, hash, at);
    });
  });
}

/**
 * `pinomad server user set-email <user> <email>`: the operator gives an
 * account its email, verified, the way a legacy account on a server that
 * can't send mail gets one (ADR-0044 §8).
 */
export async function setUserEmail(options: { readonly dataDir: string; readonly user: string; readonly email: string }): Promise<void> {
  const email = requireEmail(options.email);
  await withOperatorDatabase(options.dataDir, (db) =>
    inTransaction(db, () => {
      const userId = operatorTarget(db, options.user);
      const owner = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
      if (owner !== undefined && owner.id !== userId) throw new Error(`another account already has ${email}`);
      db.prepare("UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?").run(email, Date.now(), userId);
    }),
  );
}
