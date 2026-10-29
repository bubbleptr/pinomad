import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationId, ConversationView, JsonObject, TaskGraph } from "@earendil-works/pi-durable";
import { MAX_ATTACHMENTS_PER_MESSAGE, type UserAttachment } from "./attachments.ts";
import type { ImageVariant, OutgoingImage, ViewImage } from "./images.ts";
import { checkoutOf, homeOf, organize } from "./organization.ts";
import type { KeyPair } from "./noise.ts";
import type { PresentationType } from "./presentation.ts";
import {
  type CallMethod,
  type CallMethods,
  type ClientFrame,
  conversationStream,
  docStream,
  HOST_STREAM_NAMES,
  type HostStreamName,
  type HostStreamValues,
  hostStreams,
  hostSupportsCall,
  hostSupportsFeature,
  PROTOCOL,
  type ServerFrame,
  type StreamName,
  UNAUTHORIZED_CLOSE_CODE,
} from "./frames.ts";
import type { ConnectionMode } from "./connection-mode.ts";
import { parseEndpointSet, type EndpointSet } from "./endpoints.ts";
import {
  candidatePlan,
  DIRECT_UNAVAILABLE,
  filterCandidatesForMode,
  type RemoteCandidate,
  signalCandidates,
} from "./remote-candidates.ts";
import {
  rtcTransport,
  type RtcClock,
  type RtcPlatform,
  SYSTEM_RTC_CLOCK,
} from "./rtc-carrier.ts";
import {
  isRtcHello,
  rtcSelectedPair,
  type RtcCandidatePair,
  type RtcHello,
  type RtcSelectedPair,
} from "./rtc.ts";
import { type FrameConnection, type FrameHandlers, type FrameTransport, webSocketTransport } from "./transport.ts";
import { isBusy } from "./transcript.ts";
import type {
  ConversationDefaults,
  DurableController,
  DurableView,
  DurableViewSource,
  ExtensionDocView,
  LogicalSubmission,
  ModelSummary,
  Notice,
  SubmissionDraft,
  SubmissionPlacement,
} from "./view.ts";

/** The one-time offer a pairing candidate carries until message 2 verifies. */
export interface PairingContext {
  readonly secret: string;
  readonly name: string;
}

/** Per-candidate deadlines. Every stage is bounded, and a retired candidate cancels its timer. */
export interface CandidateTimeouts {
  readonly socketOpenMs: number;
  readonly noiseMs: number;
  readonly helloMs: number;
  readonly syncMs: number;
}

export const DEFAULT_CANDIDATE_TIMEOUTS: CandidateTimeouts = {
  socketOpenMs: 5_000,
  noiseMs: 5_000,
  helloMs: 5_000,
  syncMs: 10_000,
};

/**
 * The round budget defaults to every candidate's four stage deadlines plus a
 * small margin, so a cap never starves a later candidate of its turn. An
 * explicit `roundTimeoutMs` may be tighter for tests or operations.
 */

/** Which phase a candidate failed in, for the per-path diagnostics a round aggregates. */
export type CandidateFailureStage = "unsupported" | "open" | "noise" | "hello" | "sync" | "round" | "closed";

export interface CandidateFailure {
  readonly candidate: RemoteCandidate;
  readonly stage: CandidateFailureStage;
  readonly unauthorized: boolean;
  readonly code?: number;
  readonly reason?: string;
}

/** The carrier actually carrying business frames right now. */
export type ConnectionPath = "loopback" | "relay" | "direct" | "p2p";

/** Where a P2P preparation attempt stopped; diagnostics only, never a 4401. */
export type P2PFailureStage = "signal" | "ice" | "noise" | "warm" | "commit" | "liveness";

export interface P2PFailure {
  readonly stage: P2PFailureStage;
  readonly reason?: string;
  /** Milliseconds since the failure, on the same monotonic clock as the cooldown. */
  readonly agoMs: number;
  /** The selected pair at the moment of failure; absent before ICE picked one. */
  readonly pair?: RtcSelectedPair;
}

/** Live diagnostics for the connection-mode UI (ADR-0033 §5). */
export interface RtcDiagnostics {
  readonly path: ConnectionPath;
  readonly phase: "idle" | "scheduled" | "signal" | "ice" | "noise" | "warm" | "active" | "cooldown";
  readonly lastFailure?: P2PFailure;
  readonly selectedPair?: RtcSelectedPair;
  /** Milliseconds until the next preparation attempt is allowed; 0 when ready. */
  readonly cooldownRemainingMs: number;
}

/**
 * The platform half of the RTC carrier (ADR-0033 §2). Supplying it is the
 * capability declaration: a coordinator without `rtc` never creates a Peer,
 * never sends `rtcOffer`, and never opens a signal-only connection.
 */
export interface RtcCoordinatorOptions {
  readonly platform: RtcPlatform;
  readonly hostKey: Uint8Array;
  readonly device: KeyPair;
  /** The stored `hello.rtc.signalOnly` hint; Direct only tries signaling only when true. */
  readonly signalOnlyHint?: boolean;
  /** Builds a signal-only WebSocket transport (SIGNAL_PROLOGUE) for Direct only. */
  readonly openSignalTransport?: (candidate: RemoteCandidate) => FrameTransport;
  /** The host announced, or a failed signal handshake disproved, `signalOnly`; PR3/PR4 persist it. */
  readonly onSignalOnly?: (signalOnly: boolean) => void | Promise<void>;
  readonly onSignalOnlyError?: (error: Error) => void;
}

/** Every applicable candidate failed; `failures` carries one entry per path. */
export class ConnectionFailedError extends Error {
  readonly failures: readonly CandidateFailure[];
  constructor(failures: readonly CandidateFailure[]) {
    super(`Could not connect to the host: ${failures.map(describeFailure).join("; ")}`);
    this.name = "ConnectionFailedError";
    this.failures = failures;
  }
}

/**
 * Direct only could not reach the host: no direct business candidate worked
 * and the relay-backed P2P link failed too. `reason` is the last preparation
 * failure; the message stays the text the coordinator already reports.
 */
export class DirectUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`${DIRECT_UNAVAILABLE} (${reason})`);
    this.name = "DirectUnavailableError";
    this.reason = reason;
  }
}

const REMOTE_ACCESS_UNAVAILABLE =
  "Remote access is unavailable: the host published no remote path and this device has no local entry.";

/** P2P liveness: a pong every 5s, dead after 15s of absolute silence. */
const LIVENESS_INTERVAL_MS = 5_000;
const LIVENESS_BUDGET_MS = 15_000;
/** A foreground/network-change verification ping must answer inside 3s. */
const LIVENESS_VERIFY_MS = 3_000;
const UPGRADE_DELAY_MS = 1_000;
const UPGRADE_IDLE_MS = 300;
const UPGRADE_IDLE_LIMIT_MS = 30_000;
const UPGRADE_DEADLINE_MS = 25_000;
const PREPARE_RETRY_MS = 1_000;
const COOLDOWN_START_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60_000;
const P2P_STABLE_MS = 10 * 60_000;
const FALLBACK_QUIET_MS = 60_000;
const COOLDOWN_CLEAR_INTERVAL_MS = 60_000;
/** A submit with no result for this long is unknown, never failed (ADR-0034 §7). */
const SUBMISSION_TIMEOUT_MS = 30_000;

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** Lowercase hex from fresh random bytes. */
const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

const describeFailure = (failure: CandidateFailure): string => {
  const role = failure.candidate.role === "loopback" ? "local" : failure.candidate.role;
  const where = `${role} ${failure.candidate.url}`;
  if (failure.stage === "unsupported") return `${where} skipped (${failure.reason ?? "unsupported"})`;
  const code = failure.code === undefined ? "" : ` (close ${failure.code})`;
  return `${where} failed at ${failure.stage}${code}${failure.reason === undefined ? "" : `: ${failure.reason}`}`;
};

/** A source of network-change events; web and desktop wrap their platform's. */
export interface NetworkChanges {
  subscribe(listener: () => void): () => void;
}

/** Foreground/background transitions; PR3/PR4 wire the platform's source. */
export interface AppLifecycle {
  subscribe(listener: (state: "foreground" | "background") => void): () => void;
}

export type RemoteDurableOptions = (
  | {
      /** `ws://127.0.0.1:<port>` of a host's gateway. */
      readonly url: string;
      readonly token: string;
    }
  | { readonly transport: FrameTransport }
  | {
      /** Already ordered by `candidatePlan`; unsupported entries are reported, not dialed. */
      readonly candidates: readonly RemoteCandidate[];
      /**
       * Builds the carrier for one candidate. `pairing` is present until
       * message 2 verifies, so every retry before that shares the identity and
       * secret; afterwards this client passes undefined.
       */
      readonly openTransport: (candidate: RemoteCandidate, pairing: PairingContext | undefined) => FrameTransport;
      /** The invite's one-time offer for this round; cleared exactly once on message 2. */
      readonly pairing?: PairingContext;
      /**
       * The record's legacy url, used only to rebuild the plan from a hello's
       * endpoint set (a loopback entry stays local). Defaults to the first candidate.
       */
      readonly legacyUrl?: string;
      /** The page's protocol, so a hello update can mark mixed-content paths unsupported. */
      readonly pageProtocol?: string;
    }
) & {
  readonly reconnectDelayMs?: { readonly min: number; readonly max: number };
  readonly candidateTimeouts?: Partial<CandidateTimeouts>;
  /** Cap a whole round; defaults to the sum of every candidate's stage budgets. */
  readonly roundTimeoutMs?: number;
  /** Abort a connection attempt before ready; after ready, close the durable instead. */
  readonly signal?: AbortSignal;
  readonly network?: NetworkChanges;
  readonly lifecycle?: AppLifecycle;
  /** Message 2 verified: persist the device identity now, independently of ready. */
  readonly onPaired?: () => void | Promise<void>;
  /** Persisting after paired failed; the pairing itself stays valid and ready continues. */
  readonly onPairedError?: (error: Error) => void;
  /** A validated hello endpoint set (including an explicit empty one). */
  readonly onEndpointSet?: (endpointSet: EndpointSet) => void | Promise<void>;
  readonly onEndpointSetError?: (error: Error) => void;
  readonly onCandidateFailure?: (failure: CandidateFailure) => void;
  /** Defaults to `auto`; switching it through `setConnectionMode` reconnects the whole client. */
  readonly connectionMode?: ConnectionMode;
  /** Absent means this platform cannot do RTC; the coordinator then behaves exactly as before. */
  readonly rtc?: RtcCoordinatorOptions;
  /** Injectable monotonic clock for P2P timers; defaults to platform timers. */
  readonly clock?: RtcClock;
};

export interface RemoteDurable {
  readonly view: DurableViewSource;
  readonly controller: DurableController;
  /** Switching mode reconnects the whole client (ADR-0033 §3). */
  setConnectionMode(mode: ConnectionMode): void;
  /** Current path, P2P phase, last failure, selected ICE type, cooldown. */
  rtcDiagnostics(): RtcDiagnostics;
  close(): void;
}

/**
 * A DurableViewSource and DurableController over a host's gateway. Holds no
 * Harness: each subscribed stream is a snapshot plus chord ops, and a lost
 * host is reconnected to and resubscribed from fresh snapshots, never replayed.
 */
export function connectRemoteDurable(options: RemoteDurableOptions): Promise<RemoteDurable> {
  return new RemoteClient(options).ready;
}

/**
 * The host closed with 4401: this client is not allowed (wrong token, or the
 * device is not paired or was revoked). Typed so a client UI can tell "rejected"
 * apart from "host unreachable" — conflating them would offer to wipe a good key.
 */
export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized: this client is not allowed (wrong token, or the device is not paired or was revoked)");
    this.name = "UnauthorizedError";
  }
}

/**
 * A call that was still waiting for its result when the connection dropped.
 * The host may have acted on it anyway — unlike a call the host refused —
 * so a client can look for its effect in the streams after reconnecting.
 */
export class DisconnectedError extends Error {
  constructor() {
    super("Disconnected from host");
    this.name = "DisconnectedError";
  }
}

/**
 * The host's hello announced a major this client does not speak (ADR-0018).
 * Before the first view the ready promise rejects with it; after, the view's
 * connection goes "outdated" and no calls are sent — a host-served page
 * reloads instead.
 */
export class ProtocolMismatchError extends Error {
  readonly hostMajor: number;
  readonly clientMajor: number;
  /** Packaged release version the host announced; absent for a source checkout. */
  readonly hostVersion?: string;
  /** Which side is behind: `client-older` → update the app; `host-older` → upgrade the host. */
  readonly direction: "client-older" | "host-older";
  constructor(hostMajor: number, clientMajor: number, hostVersion?: string) {
    const direction = hostMajor > clientMajor ? ("client-older" as const) : ("host-older" as const);
    super(
      direction === "client-older"
        ? `Client out of date: the host speaks protocol major ${hostMajor}, this client speaks ${clientMajor}`
        : `Host out of date: this client speaks protocol major ${clientMajor}, the host speaks ${hostMajor}`,
    );
    this.name = "ProtocolMismatchError";
    this.hostMajor = hostMajor;
    this.clientMajor = clientMajor;
    if (hostVersion !== undefined) this.hostVersion = hostVersion;
    this.direction = direction;
  }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/**
 * One client-side send from enqueue to the host's own fact (ADR-0034 §5).
 * `fixed` marks a resolved conversation target: retries read this, never
 * "whatever is shown now".
 */
type SubmissionFact = NonNullable<CallMethods["submission"]["result"]>;

interface SubmissionRecord {
  readonly requestId: string;
  readonly text: string;
  readonly whenBusy: "steer" | "followUp";
  readonly placement: SubmissionPlacement;
  readonly images: readonly OutgoingImage[];
  readonly imageViews?: readonly ViewImage[];
  /** Undefined omits the field; an empty array tells a 5.16 host not to scan. */
  readonly skills?: readonly string[];
  readonly attachments: readonly string[];
  readonly attachmentDetails?: readonly UserAttachment[];
  phase: "queued" | "inFlight" | "unknown" | "failed" | "settled";
  conversationId?: ConversationId;
  fixed: boolean;
  submissionId?: number;
  entry?: number;
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Releases the command chain when the 30s timeout wins. */
  timeoutResolve?: () => void;
  /** Admission is confirmed; no timeout applies while waiting for its entry. */
  admitted: boolean;
  confirming: boolean;
  /** Snapshot version last checked for a missing entry. */
  checkedVersion?: number;
}

/**
 * Whether a batch needs the host's 5.15 image-ref support: a ref with no
 * inline bytes. Bytes win when both are present, so a block carrying data is
 * a bytes form an older host understands — same rule as the Rust client.
 */
function needsImageRefs(images: readonly OutgoingImage[]): boolean {
  return images.some((image) => {
    const data = "data" in image ? image.data : "";
    const ref = "ref" in image ? image.ref : "";
    return data === "" && ref !== "";
  });
}

/** One candidate's live connection; retired attempts are ignored by generation. */
interface DialAttempt {
  readonly candidate: RemoteCandidate;
  readonly generation: number;
  connection?: FrameConnection;
  phase: "open" | "noise" | "hello" | "sync" | "ready";
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
  /** This dial runs over the RTC DataChannel; its path is P2P, not a socket role. */
  p2p?: boolean;
}

type HelloFrame = Extract<ServerFrame, { type: "hello" }>;

/**
 * At most one background RTC carrier. It is not a `#dial`: it never
 * subscribes or sends business calls, and its hello is cached until the
 * commit hands the connection over.
 */
interface Standby {
  readonly generation: number;
  phase: "signal" | "ice" | "noise" | "warm";
  connection?: FrameConnection;
  /** The connection carrying `rtcOffer` (the active dial or a signal-only socket). */
  signal?: FrameConnection;
  readonly signalOnly: boolean;
  timer?: ReturnType<typeof setTimeout>;
  hello?: HelloFrame;
  pingId?: number;
  pingTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleSince?: number;
  warmAt?: number;
  selectedPair?: RtcSelectedPair;
  /** Pre-commit 3s ping on the RTC carrier before the barrier commits. */
  verify?: {
    readonly id: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  installed: boolean;
}

/** A failure plus the monotonic instant it happened; agoMs is computed on read. */
interface RecordedP2PFailure {
  readonly stage: P2PFailureStage;
  readonly reason?: string;
  readonly atMs: number;
  readonly pair?: RtcSelectedPair;
}

interface DeferredCall {
  readonly id: number;
  readonly frame: ClientFrame;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface SyncGate {
  readonly entries: DeferredCall[];
}

interface Handoff {
  readonly standby: Standby;
  readonly old: DialAttempt | undefined;
  readonly entries: DeferredCall[];
  timer?: ReturnType<typeof setTimeout>;
  idleSince?: number;
  warmAt: number;
  prepared: boolean;
  released: boolean;
}

interface SignalAttempt {
  readonly generation: number;
  index: number;
  connection?: FrameConnection;
  timer?: ReturnType<typeof setTimeout>;
  /** Bumped per candidate so a late close from the previous socket is inert. */
  token: number;
  done: boolean;
}

class RemoteClient {
  readonly ready: Promise<RemoteDurable>;
  readonly #options: RemoteDurableOptions;
  readonly #listeners = new Set<() => void>();
  readonly #values = new Map<StreamName, unknown>();
  // Filled at each hello from the announced minor — a 5.0 host never sees a
  // `models`/`auth` subscribe (ADR-0018 §1).
  readonly #wanted = new Set<StreamName>();
  // Streams whose CURRENT subscription delivered a snapshot. A wanted-but-not-
  // fresh stream (after reconnect, before the host answers) has a stale value —
  // #acquire must wait for it, never serve the old one.
  readonly #fresh = new Set<StreamName>();
  #docs: readonly { readonly kind: string; readonly presentation?: PresentationType }[] = [];
  #toolPresentations: Record<string, PresentationType> = {};
  readonly #snapshotWaiters = new Map<
    StreamName,
    { resolve(): void; reject(error: Error): void; endSatisfies: boolean }[]
  >();
  readonly #pending = new Map<number, Pending>();
  /** Every role, including relays that Direct only keeps only for signaling. */
  #fullCandidates: RemoteCandidate[];
  #candidates: RemoteCandidate[];
  #mode: ConnectionMode;
  readonly #rtc: RtcCoordinatorOptions | undefined;
  readonly #clock: RtcClock;
  #hostRtc: RtcHello | undefined;
  #signalOnlyHint: boolean;
  #standby: Standby | undefined;
  #signalAttempt: SignalAttempt | undefined;
  #handoff: Handoff | undefined;
  /** Calls that arrived after a reconnect's shell was visible but before its conversation/docs synced. */
  #syncGate: SyncGate | undefined;
  #upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  #upgradeSeq = 0;
  #upgradeFailures = 0;
  #cooldownUntil = 0;
  #noUpgradeUntil = 0;
  #lastCooldownClear = Number.NEGATIVE_INFINITY;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;
  #activePath: ConnectionPath = "loopback";
  #p2pFailure: RecordedP2PFailure | undefined;
  #selectedPair: RtcSelectedPair | undefined;
  #livenessTimer: ReturnType<typeof setTimeout> | undefined;
  #livenessDeadline = 0;
  #livenessNext = 0;
  #background = false;
  readonly #probes = new Map<number, { generation: number; timer?: ReturnType<typeof setTimeout> }>();
  /** The list this round walks; a hello's newer set applies from the next round. */
  #roundCandidates: RemoteCandidate[] = [];
  readonly #openTransport: (candidate: RemoteCandidate, pairing: PairingContext | undefined) => FrameTransport;
  readonly #baseUrl: string;
  readonly #pageProtocol: string | undefined;
  readonly #timeouts: CandidateTimeouts;
  readonly #roundTimeoutMs: number | undefined;
  readonly #followsHostEndpoints: boolean;
  #pairing: PairingContext | undefined;
  #dial: DialAttempt | undefined;
  #generation = 0;
  #round = 0;
  #candidateIndex = 0;
  #failures: CandidateFailure[] = [];
  #roundTimer: ReturnType<typeof setTimeout> | undefined;
  #backoffTimer: ReturnType<typeof setTimeout> | undefined;
  #backoffGeneration = 0;
  #networkUnsubscribe: (() => void) | undefined;
  #lifecycleUnsubscribe: (() => void) | undefined;
  #signalCleanup: (() => void) | undefined;
  #roundExpired = false;
  #roundActive = false;
  #everReady = false;
  #outageNoticed = false;
  #state: DurableView | undefined;
  #current: ConversationId | undefined;
  #side: ConversationId | undefined;
  #nextCall = 1;
  #nextNotice = 1;
  /** Every send this session, settled ones kept as idempotency guards. */
  readonly #submissions = new Map<string, SubmissionRecord>();
  /** Written objects from enqueue order; the view publishes the active ones. */
  readonly #submissionOrder: SubmissionRecord[] = [];
  readonly #submissionLocks = new Set<string>();
  /** One counter per stream snapshot, so a reset-trimmed entry is rechecked. */
  readonly #streamVersions = new Map<StreamName, number>();
  /** The connected host's minor version; gates minor-gated streams and calls. */
  #hostMinor = 0;
  /**
   * Whether this connection's hello has arrived. A subscribe must wait for it:
   * the previous connection's minor says nothing about this host, and only the
   * hello decides whether conversation streams may ask for refs.
   */
  #helloReceived = false;
  /** The last hello's model list — `view.models` until the `models` stream's snapshot arrives. */
  #helloModels: readonly ModelSummary[] = [];
  /** The last hello's defaults — `view.defaults` until the `settings` stream's snapshot arrives. */
  #helloDefaults: ConversationDefaults = {};
  /** The last hello's packaged version, absent on source checkouts — `view.host.version`. */
  #hostVersion: string | undefined;
  #attempt = 0;
  /**
   * One random suffix per coordinator instance. The host caches answered
   * peers by device + attempt, so a reloaded page must not ask with the
   * same id and receive the previous offer's SDP answer.
   */
  #rtcAttemptNonce = randomHex(8);
  #closed = false;
  #notifying = false;
  #commands = Promise.resolve();
  #resolveReady!: (value: RemoteDurable) => void;
  #rejectReady!: (error: Error) => void;

  constructor(options: RemoteDurableOptions) {
    this.#options = options;
    this.#mode = options.connectionMode ?? "auto";
    this.#rtc = options.rtc;
    this.#clock = options.clock ?? SYSTEM_RTC_CLOCK;
    this.#signalOnlyHint = options.rtc?.signalOnlyHint === true;
    this.#followsHostEndpoints = "candidates" in options;
    if ("candidates" in options) {
      this.#fullCandidates = [...options.candidates];
      this.#openTransport = options.openTransport;
      this.#pairing = options.pairing;
      this.#baseUrl = options.legacyUrl ?? options.candidates[0]?.url ?? "";
      this.#pageProtocol = options.pageProtocol;
    } else if ("transport" in options) {
      this.#fullCandidates = [{ url: options.transport.label, role: "legacy" }];
      this.#openTransport = () => options.transport;
      this.#baseUrl = options.transport.label;
      this.#pageProtocol = undefined;
    } else {
      this.#fullCandidates = candidatePlan(options.url, undefined);
      this.#openTransport = () => webSocketTransport(options.url, options.token);
      this.#baseUrl = options.url;
      this.#pageProtocol = undefined;
    }
    this.#candidates = filterCandidatesForMode(this.#fullCandidates, this.#mode);
    this.#timeouts = { ...DEFAULT_CANDIDATE_TIMEOUTS, ...options.candidateTimeouts };
    this.#roundTimeoutMs = options.roundTimeoutMs;
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    const signal = options.signal;
    const initiallyAborted = signal?.aborted === true;
    if (signal !== undefined) {
      const abort = (): void => this.#abort();
      if (initiallyAborted) queueMicrotask(abort);
      else {
        signal.addEventListener("abort", abort, { once: true });
        this.#signalCleanup = () => signal.removeEventListener("abort", abort);
      }
    }
    this.#networkUnsubscribe = options.network?.subscribe(() => this.#networkChanged());
    this.#lifecycleUnsubscribe = options.lifecycle?.subscribe((state) => {
      if (state === "background") this.#enterBackground();
      else this.#enterForeground();
    });
    if (!initiallyAborted) this.#beginRound();
  }

  #isActive(dial: DialAttempt): boolean {
    return !this.#closed && this.#dial === dial && !dial.done && dial.generation === this.#generation;
  }

  #clearTimer(dial: DialAttempt): void {
    if (dial.timer === undefined) return;
    clearTimeout(dial.timer);
    dial.timer = undefined;
  }

  #arm(dial: DialAttempt, phase: "open" | "noise" | "hello" | "sync", ms: number): void {
    this.#clearTimer(dial);
    dial.timer = setTimeout(() => {
      dial.timer = undefined;
      if (!this.#isActive(dial)) return;
      this.#failDial(dial, phase, undefined, `no progress within ${ms}ms`);
    }, Math.max(0, ms));
  }

  #beginRound(): void {
    if (this.#closed || this.#dial !== undefined) return;
    this.#clearRoundTimers();
    this.#clearBackoff();
    this.#round += 1;
    const round = this.#round;
    this.#roundCandidates = [...this.#candidates];
    this.#candidateIndex = 0;
    this.#failures = [];
    this.#roundExpired = false;
    this.#roundActive = true;
    const perCandidate =
      this.#timeouts.socketOpenMs + this.#timeouts.noiseMs + this.#timeouts.helloMs + this.#timeouts.syncMs;
    const budget = this.#roundTimeoutMs ?? this.#roundCandidates.length * perCandidate + 1_000;
    this.#roundTimer = setTimeout(() => {
      this.#roundTimer = undefined;
      if (this.#closed || !this.#roundActive || this.#round !== round) return;
      const dial = this.#dial;
      this.#roundExpired = true;
      if (dial !== undefined) {
        this.#recordFailure(dial.candidate, "round", false, undefined, `the connection round exceeded ${budget}ms`);
        this.#abandonDial(dial);
      }
      this.#roundFailed();
    }, budget);
    this.#openCandidate();
  }

  #openCandidate(): void {
    if (this.#closed || !this.#roundActive || this.#dial !== undefined) return;
    if (this.#roundExpired) {
      this.#roundFailed();
      return;
    }
    const candidate = this.#roundCandidates[this.#candidateIndex++];
    if (candidate === undefined) {
      this.#roundFailed();
      return;
    }
    if (candidate.unsupported !== undefined) {
      this.#recordFailure(candidate, "unsupported", false, undefined, candidate.unsupported);
      queueMicrotask(() => this.#openCandidate());
      return;
    }
    const dial: DialAttempt = {
      candidate,
      generation: ++this.#generation,
      phase: "open",
      done: false,
    };
    this.#dial = dial;
    this.#helloReceived = false;
    this.#arm(dial, "open", this.#timeouts.socketOpenMs);
    const handlers: FrameHandlers = {
      opened: () => {
        if (this.#isActive(dial)) this.#phase(dial, "noise", this.#timeouts.noiseMs);
      },
      authenticated: () => {
        if (!this.#isActive(dial)) return;
        this.#phase(dial, "hello", this.#timeouts.helloMs);
        this.#paired();
      },
      message: (data) => {
        if (this.#isActive(dial)) this.#message(dial, data);
      },
      closed: (code, reason) => {
        if (this.#isActive(dial)) this.#failDial(dial, dial.phase === "ready" ? "closed" : dial.phase, code, reason);
      },
    };
    let transport: FrameTransport;
    try {
      transport = this.#openTransport(candidate, this.#pairing);
    } catch (error) {
      this.#failDial(dial, "open", undefined, asError(error).message);
      return;
    }
    let connection: FrameConnection;
    try {
      connection = transport.open(handlers);
    } catch (error) {
      this.#failDial(dial, "open", undefined, asError(error).message);
      return;
    }
    if (!this.#isActive(dial)) {
      connection.close();
      return;
    }
    dial.connection = connection;
  }

  #phase(dial: DialAttempt, phase: "noise" | "hello", ms: number): void {
    if (!this.#isActive(dial)) return;
    dial.phase = phase;
    this.#arm(dial, phase, ms);
  }

  /** Message 2 verified: the invite is spent and later candidates use the device identity alone. */
  #paired(): void {
    if (this.#pairing === undefined) return;
    this.#pairing = undefined;
    if (this.#options.onPaired === undefined) return;
    const report = (error: unknown): void => {
      try {
        this.#options.onPairedError?.(asError(error));
      } catch {
        // A diagnostic callback must not break the connection.
      }
    };
    try {
      void Promise.resolve(this.#options.onPaired()).catch(report);
    } catch (error) {
      report(error);
    }
  }

  #message(dial: DialAttempt, data: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      this.#failDial(dial, dial.phase === "ready" ? "closed" : dial.phase, undefined, "the host sent a frame that is not JSON");
      return;
    }
    if (frame === null || typeof frame !== "object") return;
    if (frame.type === "hello") {
      this.#onHello(dial, frame);
      return;
    }
    this.#receive(frame);
  }

  #onHello(dial: DialAttempt, frame: Extract<ServerFrame, { type: "hello" }>): void {
    // Hosts up to v4 announced a bare integer; the frame type says
    // ProtocolVersion, so read it defensively rather than widen the type.
    const announced: unknown = frame.protocol;
    const hostMajor =
      typeof announced === "number"
        ? announced
        : announced !== null && typeof announced === "object"
          ? (announced as { major?: unknown }).major
          : undefined;
    if (hostMajor !== PROTOCOL.major) {
      // A hello this side authenticated is a host-wide verdict: no other path
      // would speak a different major, so the round stops here (ADR-0032 §6).
      const mismatch = new ProtocolMismatchError(
        typeof hostMajor === "number" ? hostMajor : Number.NaN,
        PROTOCOL.major,
        frame.hostVersion,
      );
      this.#closed = true;
      this.#clearTimers();
      this.#stopCoordination();
      this.#stopListeners();
      this.#abandonDial();
      if (this.#state === undefined) {
        this.#rejectReady(mismatch);
      } else {
        this.#update({
          connection: "outdated",
          protocolMismatch: {
            hostMajor: mismatch.hostMajor,
            clientMajor: mismatch.clientMajor,
            ...(mismatch.hostVersion === undefined ? {} : { hostVersion: mismatch.hostVersion }),
            direction: mismatch.direction,
          },
        });
        this.#notice("error", mismatch.message);
      }
      return;
    }
    this.#clearTimer(dial);
    dial.phase = "sync";
    this.#arm(dial, "sync", this.#timeouts.syncMs);
    // The minor decides which streams and calls this host knows (ADR-0018
    // §1-2); hosts before the version object announced none.
    const hostMinor =
      announced !== null && typeof announced === "object" && typeof (announced as { minor?: unknown }).minor === "number"
        ? (announced as { minor: number }).minor
        : 0;
    this.#hostMinor = hostMinor;
    this.#helloReceived = true;
    this.#hostRtc = frame.rtc !== undefined && isRtcHello(frame.rtc) ? frame.rtc : undefined;
    if (this.#hostRtc?.signalOnly === true && !this.#signalOnlyHint) {
      this.#signalOnlyHint = true;
      this.#reportSignalOnly();
    }
    this.#docs = frame.docs;
    this.#toolPresentations = frame.toolPresentations;
    this.#helloModels = frame.models;
    this.#helloDefaults = frame.defaults ?? {};
    this.#hostVersion = frame.hostVersion;
    this.#fresh.clear();
    // A host that got older between reconnects no longer covers every host
    // stream; drop the ones it predates together with their values.
    const covered = new Set<StreamName>(hostStreams(hostMinor));
    for (const name of HOST_STREAM_NAMES) {
      if (covered.has(name)) {
        this.#wanted.add(name);
      } else {
        this.#wanted.delete(name);
        this.#values.delete(name);
        this.#fresh.delete(name);
      }
    }
    if (this.#current !== undefined) for (const stream of this.#conversationStreams(this.#current)) this.#wanted.add(stream);
    if (this.#side !== undefined) for (const stream of this.#conversationStreams(this.#side)) this.#wanted.add(stream);
    for (const stream of this.#wanted) this.#subscribe(stream);
    if (frame.endpointSet !== undefined) {
      const parsed = parseEndpointSet(frame.endpointSet);
      // Malformed or unsupported sets keep the previous candidates and never
      // interrupt the live connection; a valid set (empty included) owns the
      // next round's remote list.
      if (parsed.kind === "valid") {
        if (this.#followsHostEndpoints) {
          this.#fullCandidates = candidatePlan(this.#baseUrl, parsed.endpointSet, { pageProtocol: this.#pageProtocol });
          this.#candidates = filterCandidatesForMode(this.#fullCandidates, this.#mode);
        }
        if (this.#options.onEndpointSet !== undefined) {
          const report = (error: unknown): void => {
            try {
              this.#options.onEndpointSetError?.(asError(error));
            } catch {
              // A diagnostic callback must not break the live connection.
            }
          };
          try {
            void Promise.resolve(this.#options.onEndpointSet(parsed.endpointSet)).catch(report);
          } catch (error) {
            report(error);
          }
        }
      }
    }
    if (this.#state !== undefined) {
      this.#update({
        session: frame.session,
        toolPresentations: frame.toolPresentations,
        connection: "reconnecting",
        host: this.#hostInfo(),
      });
      this.#refresh();
    }
    void this.#afterHello(dial, frame, hostMinor);
  }

  async #afterHello(
    dial: DialAttempt,
    hello: Extract<ServerFrame, { type: "hello" }>,
    hostMinor: number,
  ): Promise<void> {
    try {
      // A snapshot may already have landed between the hello and this call;
      // only the streams still missing one need a waiter. `ended` satisfies
      // the barrier and clears the affected slot.
      const all = this.#syncStreams(hostMinor);
      const hostOnly = new Set<StreamName>(hostStreams(hostMinor));
      const missingHost = all.filter((stream) => hostOnly.has(stream) && !this.#fresh.has(stream));
      await Promise.all(missingHost.map((stream) => this.#snapshot(stream, true)));
      // A reconnect keeps its historical "connected" moment — the host's own
      // streams are enough to show the shell — but calls queue behind a sync
      // gate until the shown conversations and docs caught up. `connected`
      // must not mean "calls reject": the composer retries on that signal.
      if (this.#state !== undefined && dial.p2p !== true) {
        this.#update({ connection: "connected" });
        this.#refresh();
        // The shell is visible; the per-dial sync deadline still bounds the
        // conversation/doc barrier, so the whole-round budget must not fire
        // first.
        this.#clearRoundTimer();
        this.#roundActive = false;
        dial.phase = "ready";
      }
      const missing = all.filter((stream) => !this.#fresh.has(stream));
      if (this.#state !== undefined && dial.p2p !== true && missing.length > 0) {
        this.#syncGate = { entries: [] };
      }
      await Promise.all(missing.map((stream) => this.#snapshot(stream, true)));
    } catch {
      // The candidate was retired or the host ended a stream; its sync timer
      // decides whether another candidate gets a turn.
      return;
    }
    if (!this.#isActive(dial)) return;
    this.#clearTimer(dial);
    this.#clearRoundTimer();
    dial.phase = "ready";
    this.#roundActive = false;
    this.#attempt = 0;
    this.#everReady = true;
    this.#outageNoticed = false;
    this.#activePath = this.#pathOf(dial.candidate, dial.p2p === true);
    if (this.#state === undefined) {
      this.#state = {
        session: hello.session,
        organized: { chats: [], projects: [], archived: [] },
        models: this.#host("models") ?? hello.models,
        defaults: this.#effectiveDefaults(hello.defaults ?? {}),
        notices: [],
        connection: "connected",
        docs: [],
        submissions: [],
        toolPresentations: hello.toolPresentations,
        devices: [],
        mcp: null,
        auth: null,
        providers: null,
        settings: null,
        agents: null,
        host: this.#hostInfo(),
      };
      this.#refresh();
      this.#resolveReady({
        view: this.#viewSource(),
        controller: this.#controller(),
        setConnectionMode: (mode) => this.setConnectionMode(mode),
        rtcDiagnostics: () => this.rtcDiagnostics(),
        close: () => this.#close(),
      });
      this.#finishSyncGate();
      this.#afterCarrierReady(dial);
      return;
    }
    this.#update({ session: hello.session, connection: "connected" });
    this.#refresh();
    // The reconciliation queries and resends must finish before the gate
    // releases commands queued during the outage (ADR-0034 §6).
    await this.#recoverSubmissions();
    if (!this.#isActive(dial)) return;
    this.#finishSyncGate();
    this.#afterCarrierReady(dial);
  }

  /** Start liveness on P2P, or schedule the next upgrade on a WebSocket path. */
  #afterCarrierReady(dial: DialAttempt): void {
    if (dial.p2p === true) {
      this.#finishHandoff();
      this.#startLiveness();
      this.#startStableTimer();
      return;
    }
    this.#stopLiveness();
    this.#scheduleUpgrade(this.#upgradeDelayMs());
  }

  #recordFailure(
    candidate: RemoteCandidate,
    stage: CandidateFailureStage,
    unauthorized: boolean,
    code?: number,
    reason?: string,
  ): void {
    const failure: CandidateFailure = {
      candidate,
      stage,
      unauthorized,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.#failures.push(failure);
    try {
      this.#options.onCandidateFailure?.(failure);
    } catch {
      // A diagnostic callback must not break the round.
    }
  }

  #failDial(dial: DialAttempt, stage: CandidateFailureStage, code?: number, reason?: string): void {
    if (!this.#isActive(dial)) return;
    const wasReady = dial.phase === "ready";
    if (dial.p2p === true) {
      // A lost DataChannel is a candidate-level failure: never a 4401. A
      // failure before ready is the commit/sync half of the same switch.
      this.#recordP2PFailure(wasReady ? "liveness" : "commit", reason, this.#selectedPair);
      if (wasReady) {
        this.#noUpgradeUntil = this.#now() + FALLBACK_QUIET_MS;
        this.#stopLiveness();
        this.#clearStableTimer();
      }
    }
    this.#recordFailure(dial.candidate, stage, code === UNAUTHORIZED_CLOSE_CODE, code, reason);
    this.#abandonDial(dial);
    this.#loseSubmissions();
    this.#rejectPending();
    // A handoff that lost either side must fail what it queued and never
    // carry those calls into the next reconnect round (ADR-0033 §3 step 9).
    if (
      this.#handoff !== undefined
      && (this.#handoff.old === dial || (this.#handoff.standby.installed && this.#handoff.standby === this.#standby))
    ) {
      this.#abortHandoff(new DisconnectedError());
    }
    if (this.#closed) return;
    if (dial.p2p === true && !wasReady) {
      // A handoff/first P2P sync failure goes through the ordinary reconnect
      // round; it never walks the WebSocket candidate that was retired.
      this.#update({ connection: "reconnecting" });
      this.#beginRound();
      return;
    }
    // A live connection was lost: the next round starts from the first path.
    // During a reconnect round, keep walking the remaining candidates.
    if (wasReady) {
      this.#update({ connection: "reconnecting" });
      this.#beginRound();
      return;
    }
    if (this.#roundExpired) {
      this.#roundFailed();
      return;
    }
    queueMicrotask(() => this.#openCandidate());
  }

  /** Stop the current dial without recording a failure or starting the next one. */
  #abandonDial(expected?: DialAttempt): void {
    const dial = this.#dial;
    if (dial === undefined || (expected !== undefined && dial !== expected)) return;
    if (dial.p2p === true) this.#selectedPair = undefined;
    this.#dial = undefined;
    dial.done = true;
    this.#clearTimer(dial);
    if (this.#syncGate !== undefined) {
      for (const entry of this.#syncGate.entries.splice(0)) entry.reject(new DisconnectedError());
      this.#syncGate = undefined;
    }
    this.#rejectSnapshotWaiters(new DisconnectedError());
    dial.connection?.close();
  }

  #rejectPending(): void {
    for (const pending of this.#pending.values()) pending.reject(new DisconnectedError());
    this.#pending.clear();
  }

  #rejectSnapshotWaiters(error: Error): void {
    for (const waiters of this.#snapshotWaiters.values()) {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  }

  #dialedFailures(failures: readonly CandidateFailure[]): CandidateFailure[] {
    return failures.filter((failure) => failure.stage !== "unsupported");
  }

  /**
   * Only paths this client actually dialed can make the round unauthorized.
   * An unsupported candidate (mixed content, say) is evidence about this
   * platform, not about whether the host accepts the device.
   */
  #unauthorizedRound(failures: readonly CandidateFailure[]): boolean {
    const dialed = this.#dialedFailures(failures);
    return dialed.length > 0 && dialed.every((failure) => failure.unauthorized);
  }

  #roundFailed(): void {
    if (!this.#roundActive) return;
    this.#roundActive = false;
    this.#clearRoundTimers();
    this.#clearBackoff();
    if (this.#syncGate !== undefined) {
      for (const entry of this.#syncGate.entries.splice(0)) entry.reject(new DisconnectedError());
      this.#syncGate = undefined;
    }
    this.#dial = undefined;
    if (this.#closed) return;
    const failures = [...this.#failures];
    const dialed = this.#dialedFailures(failures);
    const unauthorized = this.#unauthorizedRound(failures);
    const emptyPlan = this.#roundCandidates.length === 0;
    // Direct only has no business relay fallback: a failed direct round opens
    // a signal-only relay connection and tries P2P instead of surfacing the
    // relay as a business path.
    if (
      !unauthorized
      && this.#mode === "directOnly"
      && this.#rtc !== undefined
      && (this.#signalOnlyHint || this.#hostRtc !== undefined)
      && this.#signalAttempt === undefined
      && this.#standby === undefined
      && this.#dial === undefined
    ) {
      this.#openSignalAttempt();
      return;
    }
    if (!this.#everReady) {
      this.#closed = true;
      this.#clearTimers();
      this.#stopListeners();
      this.#rejectReady(
        unauthorized
          ? new UnauthorizedError()
          : emptyPlan
            ? new Error(REMOTE_ACCESS_UNAVAILABLE)
            : this.#aggregateError(failures),
      );
      return;
    }
    if (unauthorized) {
      this.#closed = true;
      this.#clearTimers();
      this.#stopListeners();
      this.#update({ connection: "closed", unauthorized: true });
      this.#notice("error", new UnauthorizedError().message);
      return;
    }
    if (dialed.length === 0) {
      // No path was dialed. A genuinely empty plan has no remote entry at
      // all; an unsupported-only plan keeps its skipped-path reasons instead
      // of claiming the host published nothing.
      this.#closed = true;
      this.#clearTimers();
      this.#stopListeners();
      this.#update({ connection: "closed" });
      this.#notice("error", emptyPlan ? REMOTE_ACCESS_UNAVAILABLE : this.#aggregateError(failures).message);
      return;
    }
    this.#update({ connection: "reconnecting" });
    if (!this.#outageNoticed) {
      this.#outageNoticed = true;
      this.#notice("error", this.#aggregateError(failures).message);
    }
    this.#scheduleBackoff();
  }

  #aggregateError(failures: readonly CandidateFailure[]): Error {
    if (this.#unauthorizedRound(failures)) return new UnauthorizedError();
    if (failures.length === 0) return new Error(REMOTE_ACCESS_UNAVAILABLE);
    return new ConnectionFailedError(failures);
  }

  #scheduleBackoff(): void {
    this.#clearBackoff();
    const { min, max } = this.#options.reconnectDelayMs ?? { min: 200, max: 2000 };
    const delay = Math.min(max, min * 2 ** this.#attempt++);
    const generation = this.#backoffGeneration;
    this.#backoffTimer = setTimeout(() => {
      if (this.#backoffGeneration !== generation) return;
      this.#backoffTimer = undefined;
      if (!this.#closed) this.#beginRound();
    }, delay);
  }

  #networkChanged(): void {
    if (this.#closed) return;
    // Cooldown clearing is rate-limited; liveness is not.
    this.#clearCooldownRateLimited();
    if (this.#dial?.p2p === true && this.#dial.phase === "ready") {
      // A P2P path may have changed interfaces under a still-"satisfied"
      // network; probe it at once instead of waiting for the next tick.
      this.#verifyLiveness();
      return;
    }
    // A live WebSocket is not re-dialed on an interface change; only a
    // pending round or backoff restarts immediately.
    if (this.#dial?.phase === "ready") return;
    this.#clearBackoff();
    this.#clearRoundTimers();
    this.#abandonDial();
    this.#attempt = 0;
    this.#beginRound();
  }


  // ─── P2P standby, handoff, liveness and modes ─────────────────────────

  #now(): number {
    return this.#clock.now();
  }

  #upgradeDelayMs(): number {
    return UPGRADE_DELAY_MS;
  }

  #pathOf(candidate: RemoteCandidate, p2p = false): ConnectionPath {
    if (p2p) return "p2p";
    return candidate.role === "legacy" ? "relay" : candidate.role;
  }

  #reportSignalOnly(signalOnly = true): void {
    const report = (error: unknown): void => {
      try {
        this.#rtc?.onSignalOnlyError?.(asError(error));
      } catch {
        // A diagnostic callback must not break the connection.
      }
    };
    try {
      void Promise.resolve(this.#rtc?.onSignalOnly?.(signalOnly)).catch(report);
    } catch (error) {
      report(error);
    }
  }

  #hasSnapshotWaiters(): boolean {
    for (const waiters of this.#snapshotWaiters.values()) if (waiters.length > 0) return true;
    return false;
  }

  #scheduleUpgrade(delayMs: number): void {
    if (this.#closed || this.#rtc === undefined || this.#mode === "relayOnly") return;
    this.#clearUpgradeTimer();
    const seq = ++this.#upgradeSeq;
    this.#upgradeTimer = this.#clock.setTimeout(() => {
      this.#upgradeTimer = undefined;
      if (seq !== this.#upgradeSeq) return;
      this.#maybeStartUpgrade();
    }, Math.max(0, delayMs));
  }

  #clearUpgradeTimer(): void {
    if (this.#upgradeTimer === undefined) return;
    this.#clock.clearTimeout(this.#upgradeTimer);
    this.#upgradeTimer = undefined;
  }

  #maybeStartUpgrade(): void {
    if (this.#closed || this.#rtc === undefined || this.#mode === "relayOnly") return;
    if (this.#standby !== undefined || this.#handoff !== undefined || this.#signalAttempt !== undefined) return;
    const now = this.#now();
    const blockedUntil = Math.max(this.#cooldownUntil, this.#noUpgradeUntil);
    if (now < blockedUntil) {
      this.#scheduleUpgrade(blockedUntil - now);
      return;
    }
    const active = this.#dial;
    if (active?.phase === "ready" && active.connection !== undefined && this.#state?.connection === "connected") {
      if (this.#hostRtc === undefined) return;
      this.#beginRtcStandby(active.connection, false);
      return;
    }
    if (this.#mode !== "directOnly") return;
    if (this.#hostRtc === undefined && !this.#signalOnlyHint) return;
    this.#openSignalAttempt();
  }

  #beginRtcStandby(signal: FrameConnection, signalOnly: boolean): void {
    const rtc = this.#rtc;
    if (rtc === undefined || this.#standby !== undefined || this.#closed) return;
    const generation = ++this.#upgradeSeq;
    const standby: Standby = {
      generation,
      phase: "signal",
      signal,
      signalOnly,
      installed: false,
    };
    this.#standby = standby;
    this.#p2pFailure = undefined;
    standby.timer = this.#clock.setTimeout(() => {
      if (this.#standby !== standby || this.#handoff !== undefined) return;
      this.#failStandby(standby, "warm", `WebRTC preparation exceeded ${UPGRADE_DEADLINE_MS}ms`);
    }, UPGRADE_DEADLINE_MS);
    const attempt = `rtc-${this.#rtcAttemptNonce}-${generation}`;
    const transport = rtcTransport({
      platform: rtc.platform,
      stun: this.#hostRtc?.stun ?? [],
      hostKey: rtc.hostKey,
      device: rtc.device,
      clock: this.#clock,
      offer: (sdp) => this.#rtcOfferOn(signal, attempt, sdp),
      onSelectedPair: (pair: RtcCandidatePair | undefined) => {
        if (pair !== undefined) standby.selectedPair = rtcSelectedPair(pair.local, pair.remote);
      },
    });
    const handlers: FrameHandlers = {
      signaled: () => {
        if (this.#standby === standby) standby.phase = "ice";
      },
      opened: () => {
        if (this.#standby === standby) standby.phase = "noise";
      },
      authenticated: () => {
        if (this.#standby !== standby) return;
        standby.phase = "noise";
        // After Noise the host's Peer belongs to the DataChannel; the
        // signal-only socket may close without killing the candidate.
        if (standby.signalOnly) {
          try {
            standby.signal?.close();
          } catch {
            // Already gone.
          }
          standby.signal = undefined;
        }
      },
      message: (data) => {
        if (standby.installed) {
          const dial = standby.installed && this.#dial?.connection === standby.connection ? this.#dial : undefined;
          if (dial !== undefined && this.#isActive(dial)) this.#message(dial, data);
          return;
        }
        this.#standbyMessage(standby, data);
      },
      closed: (code, reason) => {
        if (standby.installed) {
          const dial = this.#dial?.connection === standby.connection ? this.#dial : undefined;
          if (dial !== undefined && this.#isActive(dial)) {
            this.#failDial(dial, dial.phase === "ready" ? "closed" : dial.phase, code, reason);
          }
          return;
        }
        if (this.#standby === standby) this.#failStandby(standby, standby.phase, reason ?? `DataChannel closed (${code})`);
      },
    };
    try {
      standby.connection = transport.open(handlers);
    } catch (error) {
      this.#failStandby(standby, "signal", asError(error).message);
    }
  }

  #rtcOfferOn(connection: FrameConnection, attempt: string, sdp: string): Promise<string> {
    const id = this.#nextCall++;
    return new Promise<string>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        connection.send(JSON.stringify({ type: "call", id, method: "rtcOffer", args: { attempt, sdp } }));
      } catch (error) {
        this.#pending.delete(id);
        reject(asError(error));
      }
    }).then((value) => {
      const answer = value as { sdp?: unknown } | null;
      if (answer === null || typeof answer !== "object" || typeof answer.sdp !== "string") {
        throw new Error("the host returned a malformed rtcOffer answer");
      }
      return answer.sdp;
    });
  }

  #standbyMessage(standby: Standby, data: string): void {
    if (this.#standby !== standby) return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      this.#failStandby(standby, "noise", "the DataChannel sent a frame that is not JSON");
      return;
    }
    if (frame === null || typeof frame !== "object") return;
    if (frame.type === "hello") {
      standby.hello = frame;
      if (standby.pingId === undefined) this.#warmStandby(standby);
      return;
    }
    if (frame.type === "result" && standby.verify?.id === frame.id) {
      const verify = standby.verify;
      standby.verify = undefined;
      if (verify.timer !== undefined) this.#clock.clearTimeout(verify.timer);
      if (frame.ok) verify.resolve();
      else verify.reject(new Error(frame.error));
      return;
    }
  }

  #warmStandby(standby: Standby): void {
    if (this.#standby !== standby || standby.hello === undefined) return;
    const id = this.#nextCall++;
    standby.pingId = id;
    this.#probeStandby(standby, id, 5_000).then(
      () => {
        if (this.#standby !== standby || standby.installed) return;
        standby.phase = "warm";
        standby.warmAt = this.#now();
        if (standby.timer !== undefined) this.#clock.clearTimeout(standby.timer);
        // Warm means "ready to commit"; waiting for an idle window is
        // bounded separately and never counts as a preparation failure.
        standby.timer = this.#clock.setTimeout(() => {
          if (this.#standby === standby && this.#handoff === undefined) {
            this.#deferStandby(standby, `no idle window within ${UPGRADE_IDLE_LIMIT_MS}ms`);
          }
        }, UPGRADE_IDLE_LIMIT_MS);
        this.#pollStandby(standby);
      },
      (error: unknown) => {
        if (this.#standby === standby) this.#failStandby(standby, "warm", asError(error).message);
      },
    );
  }

  #probeStandby(standby: Standby, id: number, timeoutMs: number): Promise<void> {
    if (this.#standby !== standby || standby.connection === undefined) {
      return Promise.reject(new Error("the RTC carrier is gone"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = this.#clock.setTimeout(() => {
        if (standby.verify?.id !== id) return;
        standby.verify = undefined;
        reject(new Error(`the RTC carrier did not answer a ping within ${timeoutMs}ms`));
      }, timeoutMs);
      standby.verify = { id, resolve, reject, timer };
      try {
        standby.connection!.send(
          JSON.stringify({ type: "call", id, method: "ping", args: { id: `rtc-${id}` } } satisfies ClientFrame),
        );
      } catch (error) {
        this.#clock.clearTimeout(timer);
        standby.verify = undefined;
        reject(asError(error));
      }
    });
  }

  #pollStandby(standby: Standby): void {
    if (this.#standby !== standby || standby.phase !== "warm" || standby.installed) return;
    if (this.#handoff !== undefined) return;
    // With no active business carrier there is no in-flight work to drain;
    // switch as soon as the RTC carrier is warm.
    if (this.#dial?.phase !== "ready") {
      this.#beginHandoff(standby);
      return;
    }
    const busy = this.#pending.size > 0 || this.#hasSnapshotWaiters();
    if (busy) {
      standby.idleSince = undefined;
    } else {
      const now = this.#now();
      standby.idleSince ??= now;
      if (now - standby.idleSince >= UPGRADE_IDLE_MS) {
        this.#beginHandoff(standby);
        return;
      }
    }
    if (standby.idleTimer !== undefined) this.#clock.clearTimeout(standby.idleTimer);
    standby.idleTimer = this.#clock.setTimeout(() => this.#pollStandby(standby), 100);
  }

  #beginHandoff(standby: Standby): void {
    if (this.#standby !== standby || this.#handoff !== undefined || standby.hello === undefined) return;
    if (standby.idleTimer !== undefined) this.#clock.clearTimeout(standby.idleTimer);
    standby.idleTimer = undefined;
    const handoff: Handoff = {
      standby,
      old: this.#dial,
      entries: [],
      warmAt: standby.warmAt ?? this.#now(),
      prepared: false,
      released: false,
    };
    this.#handoff = handoff;
    if (handoff.old?.phase === "ready" && handoff.old.connection !== undefined) {
      const id = this.#nextCall++;
      standby.verify = undefined;
      this.#probeStandby(standby, id, 3_000).then(
        () => {
          if (this.#handoff !== handoff || handoff.released) return;
          handoff.prepared = true;
          this.#installStandby(handoff);
        },
        (error: unknown) => {
          if (this.#handoff !== handoff || handoff.released) return;
          this.#releaseToOld(handoff, asError(error).message);
        },
      );
    } else {
      handoff.prepared = true;
      this.#installStandby(handoff);
    }
  }

  #installStandby(handoff: Handoff): void {
    if (this.#handoff !== handoff || handoff.released) return;
    const standby = handoff.standby;
    const hello = standby.hello;
    if (hello === undefined || standby.connection === undefined) {
      this.#abortHandoff(new Error("the RTC carrier lost its hello before handoff"));
      return;
    }
    const old = handoff.old;
    if (old !== undefined) {
      old.done = true;
      try {
        old.connection?.close();
      } catch {
        // Retiring the old carrier is not a reconnect trigger.
      }
    }
    const dial: DialAttempt = {
      candidate: { url: "webrtc", role: "direct" },
      generation: ++this.#generation,
      phase: "sync",
      connection: standby.connection,
      done: false,
      p2p: true,
    };
    this.#dial = dial;
    standby.installed = true;
    this.#activePath = "p2p";
    this.#selectedPair = standby.selectedPair;
    if (standby.signalOnly) standby.signal = undefined;
    // The cached hello now runs the ordinary hello → sync path. Until its
    // barrier releases, #call keeps queueing into the handoff.
    this.#onHello(dial, hello);
  }

  #releaseToOld(handoff: Handoff, reason: string): void {
    this.#handoff = undefined;
    this.#standby = undefined;
    this.#clearStandbyTimers(handoff.standby);
    try {
      handoff.standby.connection?.close();
    } catch {
      // Already gone.
    }
    if (handoff.standby.signalOnly && handoff.standby.signal !== undefined) {
      try {
        handoff.standby.signal.close();
      } catch {
        // Already gone.
      }
    }
    this.#recordP2PFailure("commit", reason, handoff.standby.selectedPair);
    this.#preparationFailed();
    const old = handoff.old;
    for (const entry of handoff.entries.splice(0)) {
      if (old === undefined) entry.reject(new Error("Not connected to the host"));
      else this.#deliverDeferred(old, entry);
    }
    this.#scheduleUpgrade(this.#cooldownRemainingMs());
  }

  #abortHandoff(error: Error): void {
    const handoff = this.#handoff;
    if (handoff === undefined) return;
    this.#handoff = undefined;
    this.#standby = undefined;
    this.#clearStandbyTimers(handoff.standby);
    try {
      handoff.standby.connection?.close();
    } catch {
      // Already gone.
    }
    if (handoff.standby.signalOnly && handoff.standby.signal !== undefined) {
      try {
        handoff.standby.signal.close();
      } catch {
        // Already gone.
      }
    }
    for (const entry of handoff.entries.splice(0)) entry.reject(error);
  }

  #finishSyncGate(): void {
    const gate = this.#syncGate;
    if (gate === undefined) return;
    this.#syncGate = undefined;
    const dial = this.#dial;
    for (const entry of gate.entries.splice(0)) {
      if (dial === undefined) entry.reject(new DisconnectedError());
      else this.#deliverDeferred(dial, entry);
    }
  }

  #finishHandoff(): void {
    const handoff = this.#handoff;
    if (handoff === undefined || !handoff.standby.installed) return;
    this.#handoff = undefined;
    this.#standby = undefined;
    const dial = this.#dial;
    for (const entry of handoff.entries.splice(0)) {
      if (dial === undefined) entry.reject(new Error("Not connected to the host"));
      else this.#deliverDeferred(dial, entry);
    }
    this.#startStableTimer();
  }

  #deliverDeferred(dial: DialAttempt, entry: DeferredCall): void {
    if (!this.#isActive(dial) || dial.phase !== "ready" || dial.connection === undefined) {
      entry.reject(new Error("Not connected to the host"));
      return;
    }
    this.#pending.set(entry.id, { resolve: entry.resolve, reject: entry.reject });
    try {
      dial.connection.send(JSON.stringify(entry.frame));
    } catch (error) {
      this.#pending.delete(entry.id);
      entry.reject(asError(error));
    }
  }

  #clearStandbyTimers(standby: Standby): void {
    for (const timer of [standby.timer, standby.pingTimer, standby.idleTimer, standby.verify?.timer]) {
      if (timer !== undefined) this.#clock.clearTimeout(timer);
    }
    standby.timer = undefined;
    standby.pingTimer = undefined;
    standby.idleTimer = undefined;
    standby.verify = undefined;
  }

  #failStandby(standby: Standby, stage: P2PFailureStage, reason: string): void {
    if (this.#standby !== standby) return;
    const handoff = this.#handoff;
    if (handoff !== undefined && handoff.standby === standby) {
      // A pre-commit failure must release the barrier and hand the queued
      // calls back to the still-usable old carrier.
      this.#releaseToOld(handoff, reason);
      return;
    }
    this.#standby = undefined;
    this.#clearStandbyTimers(standby);
    try {
      standby.connection?.close();
    } catch {
      // Already gone.
    }
    if (standby.signalOnly && standby.signal !== undefined) {
      try {
        standby.signal.close();
      } catch {
        // Already gone.
      }
    }
    this.#recordP2PFailure(stage, reason, standby.selectedPair);
    if (standby.signalOnly && stage === "signal") {
      this.#signalOnlyHint = false;
      this.#reportSignalOnly(false);
    }
    this.#preparationFailed();
    if (this.#state === undefined && this.#mode === "directOnly" && this.#dial === undefined) {
      this.#directUnavailable(reason);
      return;
    }
    this.#scheduleUpgrade(this.#cooldownRemainingMs());
  }

  #deferStandby(standby: Standby, reason: string): void {
    if (this.#standby !== standby) return;
    this.#standby = undefined;
    this.#clearStandbyTimers(standby);
    try {
      standby.connection?.close();
    } catch {
      // Already gone.
    }
    if (standby.signalOnly && standby.signal !== undefined) {
      try {
        standby.signal.close();
      } catch {
        // Already gone.
      }
    }
    this.#recordP2PFailure("commit", reason, standby.selectedPair);
    this.#scheduleUpgrade(PREPARE_RETRY_MS);
  }

  #recordP2PFailure(stage: P2PFailureStage, reason?: string, pair?: RtcSelectedPair): void {
    this.#p2pFailure = {
      stage,
      ...(reason === undefined ? {} : { reason }),
      atMs: this.#now(),
      ...(pair === undefined ? {} : { pair }),
    };
  }

  #preparationFailed(): void {
    this.#upgradeFailures += 1;
    const delay = Math.min(COOLDOWN_MAX_MS, COOLDOWN_START_MS * 2 ** (this.#upgradeFailures - 1));
    this.#cooldownUntil = this.#now() + delay;
  }

  #cooldownRemainingMs(): number {
    return Math.max(0, Math.max(this.#cooldownUntil, this.#noUpgradeUntil) - this.#now());
  }

  #startStableTimer(): void {
    if (this.#stableTimer !== undefined) this.#clock.clearTimeout(this.#stableTimer);
    this.#stableTimer = this.#clock.setTimeout(() => {
      this.#stableTimer = undefined;
      if (this.#activePath === "p2p" && this.#dial?.phase === "ready") {
        this.#upgradeFailures = 0;
        this.#cooldownUntil = 0;
        this.#noUpgradeUntil = 0;
      }
    }, P2P_STABLE_MS);
  }

  #clearCooldown(): void {
    this.#upgradeFailures = 0;
    this.#cooldownUntil = 0;
    this.#noUpgradeUntil = 0;
  }

  #openSignalAttempt(): void {
    const rtc = this.#rtc;
    if (rtc === undefined || this.#signalAttempt !== undefined || this.#closed) return;
    if (rtc.openSignalTransport === undefined) {
      this.#directUnavailable("the platform has no signal-only transport");
      return;
    }
    const candidates = signalCandidates(this.#fullCandidates);
    if (candidates.length === 0) {
      this.#directUnavailable("no relay candidate is available for signaling");
      return;
    }
    const attempt: SignalAttempt = { generation: ++this.#upgradeSeq, index: 0, token: 0, done: false };
    this.#signalAttempt = attempt;
    this.#openSignalCandidate(attempt, candidates);
  }

  #openSignalCandidate(attempt: SignalAttempt, candidates: readonly RemoteCandidate[]): void {
    if (this.#signalAttempt !== attempt || attempt.done || this.#closed) return;
    if (attempt.timer !== undefined) {
      this.#clock.clearTimeout(attempt.timer);
      attempt.timer = undefined;
    }
    while (attempt.index < candidates.length) {
      const candidate = candidates[attempt.index++]!;
      if (candidate.unsupported !== undefined) continue;
      const openSignal = this.#rtc?.openSignalTransport;
      if (openSignal === undefined) {
        this.#failSignalAttempt(attempt, "the platform has no signal-only transport");
        return;
      }
      let transport: FrameTransport;
      try {
        transport = openSignal(candidate);
      } catch (error) {
        this.#failSignalAttempt(attempt, asError(error).message);
        return;
      }
      const token = ++attempt.token;
      const timeoutMs = this.#timeouts.socketOpenMs + this.#timeouts.noiseMs + this.#timeouts.helloMs;
      attempt.timer = this.#clock.setTimeout(() => {
        if (this.#signalAttempt !== attempt || attempt.done || attempt.token !== token) return;
        attempt.done = true;
        attempt.token += 1;
        try {
          attempt.connection?.close();
        } catch {
          // Already gone.
        }
        attempt.connection = undefined;
        attempt.done = false;
        this.#openSignalCandidate(attempt, candidates);
      }, timeoutMs);
      const handlers: FrameHandlers = {
        message: (data) => this.#receiveSignalFrame(attempt, data),
        closed: (_code, _reason) => {
          if (attempt.token !== token) return;
          if (this.#signalAttempt !== attempt || attempt.done) {
            const standby = this.#standby;
            if (standby?.signalOnly === true && standby.signal === attempt.connection && !standby.installed
              && standby.phase !== "noise" && standby.phase !== "warm") {
              this.#failStandby(standby, standby.phase, "the signal-only connection closed");
            }
            return;
          }
          attempt.done = true;
          attempt.connection = undefined;
          attempt.done = false;
          this.#openSignalCandidate(attempt, candidates);
        },
      };
      try {
        attempt.connection = transport.open(handlers);
      } catch {
        continue;
      }
      return;
    }
    this.#failSignalAttempt(attempt, "every relay signal path failed");
  }

  #receiveSignalFrame(attempt: SignalAttempt, data: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    if (frame === null || typeof frame !== "object") return;
    if (frame.type === "result") {
      const pending = this.#pending.get(frame.id);
      this.#pending.delete(frame.id);
      if (frame.ok) pending?.resolve(frame.value);
      else pending?.reject(new Error(frame.error));
      return;
    }
    if (frame.type !== "signalHello") return;
    if (this.#signalAttempt !== attempt || attempt.done) return;
    attempt.done = true;
    this.#signalAttempt = undefined;
    if (attempt.timer !== undefined) this.#clock.clearTimeout(attempt.timer);
    attempt.timer = undefined;
    if (frame.rtc === undefined) {
      this.#directUnavailable("the host did not advertise WebRTC on its signal connection");
      return;
    }
    this.#hostRtc = frame.rtc;
    if (frame.rtc.signalOnly) this.#reportSignalOnly();
    const connection = attempt.connection;
    if (connection === undefined) {
      this.#directUnavailable("the signal-only connection vanished before its offer");
      return;
    }
    this.#beginRtcStandby(connection, true);
  }

  #failSignalAttempt(attempt: SignalAttempt, reason: string): void {
    if (this.#signalAttempt !== attempt) return;
    this.#signalAttempt = undefined;
    if (attempt.timer !== undefined) this.#clock.clearTimeout(attempt.timer);
    attempt.timer = undefined;
    this.#recordP2PFailure("signal", reason);
    this.#signalOnlyHint = false;
    this.#directUnavailable(reason);
  }

  #directUnavailable(reason: string): void {
    if (this.#closed) return;
    if (this.#state === undefined) {
      this.#closed = true;
      this.#clearTimers();
      this.#stopListeners();
      this.#rejectPending();
      this.#rejectSnapshotWaiters(new DisconnectedError());
      this.#rejectReady(new DirectUnavailableError(reason));
      return;
    }
    this.#notice("error", `${DIRECT_UNAVAILABLE} (${reason})`);
    this.#update({ connection: "reconnecting" });
    this.#scheduleBackoff();
  }

  #enterBackground(): void {
    if (this.#closed) return;
    this.#background = true;
    this.#stopLiveness();
  }

  #enterForeground(): void {
    if (this.#closed) return;
    this.#background = false;
    if (this.#dial?.p2p === true && this.#dial.phase === "ready") {
      this.#verifyLiveness();
      return;
    }
    if (this.#dial?.phase === "ready") return;
    this.#networkChanged();
  }

  #startLiveness(): void {
    this.#stopLiveness();
    if (this.#closed || this.#background || this.#dial?.p2p !== true || this.#dial.phase !== "ready") return;
    const now = this.#now();
    this.#livenessDeadline = now + LIVENESS_BUDGET_MS;
    this.#livenessNext = now + LIVENESS_INTERVAL_MS;
    this.#scheduleLiveness();
  }

  #scheduleLiveness(): void {
    if (this.#closed || this.#background || this.#dial?.p2p !== true || this.#dial.phase !== "ready") return;
    const delay = Math.max(0, this.#livenessNext - this.#now());
    this.#livenessTimer = this.#clock.setTimeout(() => {
      this.#livenessTimer = undefined;
      this.#livenessTick();
    }, delay);
  }

  #stopLiveness(): void {
    if (this.#livenessTimer !== undefined) this.#clock.clearTimeout(this.#livenessTimer);
    this.#livenessTimer = undefined;
    for (const probe of this.#probes.values()) {
      if (probe.timer !== undefined) this.#clock.clearTimeout(probe.timer);
    }
    this.#probes.clear();
  }

  #livenessTick(): void {
    const dial = this.#dial;
    if (this.#closed || this.#background || dial?.p2p !== true || dial.phase !== "ready") return;
    const now = this.#now();
    if (now >= this.#livenessDeadline) {
      this.#fallbackFromP2P("no pong within 15000ms");
      return;
    }
    this.#sendProbe(false);
    // Fixed 5s rhythm: late callbacks do not shift later probes.
    this.#livenessNext += LIVENESS_INTERVAL_MS;
    if (this.#livenessNext <= now) this.#livenessNext = now + LIVENESS_INTERVAL_MS;
    this.#scheduleLiveness();
  }

  #verifyLiveness(): void {
    this.#stopLiveness();
    if (this.#dial?.p2p !== true || this.#dial.phase !== "ready") return;
    const probe = this.#sendProbe(true);
    if (probe === undefined) return;
    this.#livenessNext = this.#now() + LIVENESS_INTERVAL_MS;
    this.#scheduleLiveness();
  }

  #sendProbe(verify: boolean): number | undefined {
    const dial = this.#dial;
    if (dial?.connection === undefined || dial.p2p !== true) return undefined;
    const id = this.#nextCall++;
    const entry: { generation: number; timer?: ReturnType<typeof setTimeout> } = { generation: dial.generation };
    this.#probes.set(id, entry);
    if (verify) {
      entry.timer = this.#clock.setTimeout(() => {
        if (!this.#probes.has(id)) return;
        this.#probes.delete(id);
        this.#fallbackFromP2P("the foreground verification ping did not answer within 3000ms");
      }, LIVENESS_VERIFY_MS);
    }
    try {
      dial.connection.send(JSON.stringify({ type: "call", id, method: "ping", args: { id: `probe-${id}` } } satisfies ClientFrame));
    } catch (error) {
      this.#probes.delete(id);
      if (entry.timer !== undefined) this.#clock.clearTimeout(entry.timer);
      this.#fallbackFromP2P(asError(error).message);
      return undefined;
    }
    return id;
  }

  #fallbackFromP2P(reason: string): void {
    const dial = this.#dial;
    if (dial?.p2p !== true) return;
    this.#recordP2PFailure("liveness", reason, this.#selectedPair);
    this.#selectedPair = undefined;
    this.#noUpgradeUntil = this.#now() + FALLBACK_QUIET_MS;
    this.#stopLiveness();
    this.#clearStableTimer();
    dial.done = true;
    try {
      dial.connection?.close();
    } catch {
      // Already gone.
    }
    if (this.#dial === dial) this.#dial = undefined;
    this.#rejectPending();
    this.#rejectSnapshotWaiters(new DisconnectedError());
    this.#clearRoundTimers();
    this.#update({ connection: "reconnecting" });
    this.#beginRound();
  }

  #clearStableTimer(): void {
    if (this.#stableTimer === undefined) return;
    this.#clock.clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
  }

  #livenessBudgetMs(): number {
    return LIVENESS_BUDGET_MS;
  }

  #clearCooldownRateLimited(): void {
    const now = this.#now();
    if (now - this.#lastCooldownClear < COOLDOWN_CLEAR_INTERVAL_MS) return;
    this.#lastCooldownClear = now;
    this.#clearCooldown();
  }

  setConnectionMode(mode: ConnectionMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#candidates = filterCandidatesForMode(this.#fullCandidates, mode);
    this.#clearUpgradeTimer();
    this.#stopLiveness();
    this.#clearStableTimer();
    if (this.#handoff !== undefined) this.#abortHandoff(new DisconnectedError());
    if (this.#standby !== undefined) {
      const standby = this.#standby;
      this.#standby = undefined;
      this.#clearStandbyTimers(standby);
      try {
        standby.connection?.close();
      } catch {
        // Already gone.
      }
    }
    if (this.#signalAttempt !== undefined) {
      const attempt = this.#signalAttempt;
      this.#signalAttempt = undefined;
      if (attempt.timer !== undefined) this.#clock.clearTimeout(attempt.timer);
      try {
        attempt.connection?.close();
      } catch {
        // Already gone.
      }
    }
    if (this.#closed) return;
    this.#clearRoundTimers();
    this.#clearBackoff();
    this.#abandonDial();
    this.#rejectPending();
    this.#rejectSnapshotWaiters(new DisconnectedError());
    if (this.#state !== undefined) this.#update({ connection: "reconnecting" });
    this.#beginRound();
  }

  rtcDiagnostics(): RtcDiagnostics {
    const standby = this.#standby;
    const cooldownRemainingMs = this.#cooldownRemainingMs();
    let phase: RtcDiagnostics["phase"];
    if (standby !== undefined) phase = standby.phase;
    else if (this.#dial?.p2p === true && this.#dial.phase === "ready") phase = "active";
    else if (this.#handoff !== undefined) phase = "warm";
    else if (cooldownRemainingMs > 0) phase = "cooldown";
    else if (this.#upgradeTimer !== undefined) phase = "scheduled";
    else phase = "idle";
    const failure = this.#p2pFailure;
    return {
      path: this.#activePath,
      phase,
      ...(failure === undefined
        ? {}
        : {
            lastFailure: {
              stage: failure.stage,
              ...(failure.reason === undefined ? {} : { reason: failure.reason }),
              agoMs: Math.max(0, this.#now() - failure.atMs),
              ...(failure.pair === undefined ? {} : { pair: failure.pair }),
            },
          }),
      ...(this.#selectedPair === undefined ? {} : { selectedPair: this.#selectedPair }),
      cooldownRemainingMs,
    };
  }

  #clearTimerDial(): void {
    if (this.#dial !== undefined) this.#clearTimer(this.#dial);
  }

  #clearRoundTimer(): void {
    if (this.#roundTimer === undefined) return;
    clearTimeout(this.#roundTimer);
    this.#roundTimer = undefined;
  }

  #clearRoundTimers(): void {
    this.#clearRoundTimer();
    this.#clearTimerDial();
  }

  #clearBackoff(): void {
    this.#backoffGeneration += 1;
    if (this.#backoffTimer === undefined) return;
    clearTimeout(this.#backoffTimer);
    this.#backoffTimer = undefined;
  }

  #clearTimers(): void {
    for (const record of this.#submissionOrder) this.#clearSubmissionTimer(record);
    this.#clearRoundTimer();
    this.#clearBackoff();
    this.#clearUpgradeTimer();
    this.#stopLiveness();
    this.#clearStableTimer();
    if (this.#dial !== undefined) this.#clearTimer(this.#dial);
  }

  /** Tear down every background P2P object without touching business state. */
  #stopCoordination(): void {
    this.#clearUpgradeTimer();
    this.#stopLiveness();
    this.#clearStableTimer();
    if (this.#handoff !== undefined) this.#abortHandoff(new DisconnectedError());
    if (this.#standby !== undefined) {
      const standby = this.#standby;
      this.#standby = undefined;
      this.#clearStandbyTimers(standby);
      try {
        standby.connection?.close();
      } catch {
        // Already gone.
      }
      if (standby.signalOnly && standby.signal !== undefined) {
        try {
          standby.signal.close();
        } catch {
          // Already gone.
        }
      }
    }
    if (this.#signalAttempt !== undefined) {
      const attempt = this.#signalAttempt;
      this.#signalAttempt = undefined;
      if (attempt.timer !== undefined) this.#clock.clearTimeout(attempt.timer);
      try {
        attempt.connection?.close();
      } catch {
        // Already gone.
      }
    }
  }

  #stopListeners(): void {
    this.#networkUnsubscribe?.();
    this.#networkUnsubscribe = undefined;
    this.#lifecycleUnsubscribe?.();
    this.#lifecycleUnsubscribe = undefined;
    this.#signalCleanup?.();
    this.#signalCleanup = undefined;
  }

  #abort(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    this.#stopCoordination();
    this.#stopListeners();
    this.#abandonDial();
    this.#rejectPending();
    this.#rejectSnapshotWaiters(new DisconnectedError());
    // A post-ready abort still has a public view: close it without touching
    // the paired / persisted state.
    this.#update({ connection: "closed" });
    this.#rejectReady(new Error("Connection attempt aborted"));
  }

  #send(frame: ClientFrame): void {
    this.#dial?.connection?.send(JSON.stringify(frame));
  }

  #receive(frame: ServerFrame): void {
    // ADR-0018 §4: a newer host's frames — including types and shapes this
    // build does not know — are ignored, never fatal.
    if (frame === null || typeof frame !== "object") return;
    switch (frame.type) {
      case "snapshot":
        if (!this.#wanted.has(frame.stream)) return;
        this.#values.set(frame.stream, frame.value);
        this.#fresh.add(frame.stream);
        this.#streamVersions.set(frame.stream, (this.#streamVersions.get(frame.stream) ?? 0) + 1);
        this.#refresh();
        for (const waiter of this.#snapshotWaiters.get(frame.stream)?.splice(0) ?? []) waiter.resolve();
        return;
      case "ops":
        if (!this.#wanted.has(frame.stream) || !this.#values.has(frame.stream)) return;
        this.#values.set(frame.stream, applyImmutable(this.#values.get(frame.stream), frame.ops));
        this.#refresh();
        return;
      case "ended": {
        this.#wanted.delete(frame.stream);
        this.#values.delete(frame.stream);
        this.#fresh.delete(frame.stream);
        const ended = new Error(`Stream ${frame.stream} ended: ${frame.reason}`);
        for (const waiter of this.#snapshotWaiters.get(frame.stream)?.splice(0) ?? []) {
          if (waiter.endSatisfies) waiter.resolve();
          else waiter.reject(ended);
        }
        // A sync barrier treats an ended selection as settled — never wait
        // forever — and drops the slot whose data can no longer be shown.
        if (this.#current !== undefined && this.#conversationStreams(this.#current).includes(frame.stream)) {
          this.#unshow();
        } else if (this.#side !== undefined && this.#conversationStreams(this.#side).includes(frame.stream)) {
          this.#side = undefined;
        }
        this.#refresh();
        return;
      }
      case "result": {
        const probe = this.#probes.get(frame.id);
        if (probe !== undefined) {
          this.#probes.delete(frame.id);
          if (probe.timer !== undefined) this.#clock.clearTimeout(probe.timer);
          // A late or wrong-generation pong carries no evidence about the
          // current carrier and is dropped (ADR-0033 §3).
          if (frame.ok && this.#dial?.generation === probe.generation) {
            this.#livenessDeadline = Math.max(this.#livenessDeadline, this.#clock.now() + this.#livenessBudgetMs());
          }
          if (this.#standby?.phase === "warm") this.#pollStandby(this.#standby);
          return;
        }
        const pending = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        if (frame.ok) pending?.resolve(frame.value);
        else pending?.reject(new Error(frame.error));
        if (this.#standby?.phase === "warm") this.#pollStandby(this.#standby);
        return;
      }
      case "notice":
        this.#notice(frame.level, frame.message);
        return;
    }
  }

  /** Resolve at the stream's next snapshot; reject if the host ends it instead. */
  #snapshot(stream: StreamName, endSatisfies = false): Promise<void> {
    // A stream released between the sync barrier's list and this call needs
    // no snapshot; waiting would hang the barrier (clear during a reconnect).
    if (!this.#wanted.has(stream)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.#snapshotWaiters.get(stream) ?? [];
      waiters.push({ resolve, reject, endSatisfies });
      this.#snapshotWaiters.set(stream, waiters);
    });
  }

  /**
   * The sync barrier's streams: every host stream plus the shown and side
   * conversations with their docs (ADR-0033 §3 step 8). This applies to an
   * ordinary reconnect too, not just the P2P handoff.
   */
  #syncStreams(hostMinor: number): StreamName[] {
    const streams = new Set<StreamName>(hostStreams(hostMinor));
    for (const id of [this.#current, this.#side]) {
      if (id === undefined) continue;
      for (const stream of this.#conversationStreams(id)) streams.add(stream);
    }
    return [...streams];
  }

  /** The streams that show one conversation: its view and its documents. */
  #conversationStreams(id: ConversationId): StreamName[] {
    return [conversationStream(id), ...this.#docs.map((doc) => docStream(doc.kind, id))];
  }

  /**
   * Subscribe to the streams a conversation slot needs. Streams another slot
   * already wants stay put — subscribing again would be a no-op on the host,
   * and their live values carry over (no snapshot wait).
   */
  async #acquire(id: ConversationId): Promise<void> {
    const missing = this.#conversationStreams(id).filter((stream) => !this.#wanted.has(stream));
    // Wanted but not fresh: already subscribed (the side may share it) yet the
    // host has not answered this connection — waiting hands us its new value,
    // never the stale one left over from before the reconnect.
    const stale = this.#conversationStreams(id).filter((stream) => this.#wanted.has(stream) && !this.#fresh.has(stream));
    // Mark the missing streams wanted before taking their snapshot waiters:
    // #snapshot refuses to wait for a stream nobody wants, so a clear that
    // released it can never hang this acquire.
    for (const stream of missing) this.#wanted.add(stream);
    const shown = Promise.all([...missing, ...stale].map((stream) => this.#snapshot(stream)));
    for (const stream of missing) {
      // Before the hello the minor is not known yet; the hello's #wanted loop
      // sends this stream with the right form once it has read the version.
      if (this.#helloReceived) this.#subscribe(stream);
    }
    await shown;
  }

  /** Release the streams of one slot's conversation the other slot does not still need. */
  #release(id: ConversationId, other: ConversationId | undefined): void {
    const keep = new Set<StreamName>(other === undefined ? [] : this.#conversationStreams(other));
    for (const stream of this.#conversationStreams(id)) {
      if (keep.has(stream)) continue;
      this.#wanted.delete(stream);
      this.#values.delete(stream);
      this.#fresh.delete(stream);
      // No snapshot will ever be accepted for this stream again, so a sync
      // barrier waiting on it must settle now. Otherwise a clear during a
      // reconnect would hold every later call until the sync timer kills a
      // healthy connection.
      for (const waiter of this.#snapshotWaiters.get(stream)?.splice(0) ?? []) waiter.resolve();
      this.#send({ type: "unsubscribe", stream });
    }
  }

  /**
   * Subscribe with the wire form this host's minor supports: conversation
   * streams ask for refs on 5.15+, docs and older hosts stay inline.
   */
  #subscribe(stream: StreamName): void {
    const refs = stream.startsWith("conversation:") && hostSupportsFeature(this.#hostMinor, "imageRefs");
    this.#send({ type: "subscribe", stream, ...(refs ? { images: "ref" as const } : {}) });
  }

  /** A host-level stream's latest value, or undefined until its first snapshot lands. */
  #host<K extends HostStreamName>(name: K): HostStreamValues[K] | undefined {
    return this.#values.get(name) as HostStreamValues[K] | undefined;
  }

  /** `view.host`: the announced protocol and the packaged version, when there is one. */
  #hostInfo(): NonNullable<DurableView["host"]> {
    return {
      protocol: { major: PROTOCOL.major, minor: this.#hostMinor },
      ...(this.#hostVersion === undefined ? {} : { version: this.#hostVersion }),
    };
  }

  /** `view.defaults`: derived from the `settings` stream once it arrived, never back to the hello's after. */
  #effectiveDefaults(fallback: ConversationDefaults): ConversationDefaults {
    const settings = this.#host("settings");
    if (settings === undefined) return fallback;
    return {
      ...(settings.defaultModel === null ? {} : { model: settings.defaultModel }),
      ...(settings.defaultThinkingLevel === null ? {} : { thinkingLevel: settings.defaultThinkingLevel }),
    };
  }

  /** `id` is `ancestor` or sits under it via `parent` links in the summaries. */
  #descendsFrom(id: ConversationId, ancestor: ConversationId): boolean {
    const summaries = this.#host("conversations") ?? [];
    const parentOf = new Map(summaries.map((summary) => [summary.id, summary.parent]));
    let cursor: ConversationId | undefined = id;
    for (let depth = 0; cursor !== undefined && depth < 8; depth++) {
      if (cursor === ancestor) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  }


  /** A lost carrier turns every unconfirmed in-flight send unknown at once. */
  #loseSubmissions(): void {
    for (const record of this.#submissionOrder) {
      if (record.phase !== "inFlight" || record.admitted) continue;
      record.phase = "unknown";
      this.#clearSubmissionTimer(record);
    }
  }
  /** The sends whose host fact has not replaced them yet, in enqueue order. */
  #activeSubmissions(): LogicalSubmission[] {
    return this.#submissionOrder
      .filter((record) => record.phase !== "settled")
      .map((record) => ({
        requestId: record.requestId,
        ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
        text: record.text,
        whenBusy: record.whenBusy,
        placement: record.placement,
        phase: record.phase,
        images: record.images,
        ...(record.imageViews === undefined ? {} : { imageViews: record.imageViews }),
        skills: record.skills ?? [],
        attachments: record.attachments,
        ...(record.attachmentDetails === undefined ? {} : { attachmentDetails: record.attachmentDetails }),
        ...(record.submissionId === undefined ? {} : { submissionId: record.submissionId }),
        ...(record.entry === undefined ? {} : { entry: record.entry }),
        ...(record.error === undefined ? {} : { error: record.error }),
      }));
  }

  #touchSubmissions(): void {
    this.#refresh();
  }

  #startSubmissionTimer(record: SubmissionRecord): void {
    this.#clearSubmissionTimer(record);
    record.timer = setTimeout(() => {
      record.timer = undefined;
      if (this.#closed || record.phase === "settled" || record.admitted) return;
      // The deadline covers both retry phases: a query that never answered
      // also leaves the row unknown, rather than holding the invoke forever.
      if (record.phase === "inFlight") record.phase = "unknown";
      const resolve = record.timeoutResolve;
      record.timeoutResolve = undefined;
      this.#touchSubmissions();
      // Let the serialized queue continue so Retry is reachable.
      resolve?.();
    }, SUBMISSION_TIMEOUT_MS);
  }

  /**
   * Arm one 30s deadline for a retry or recovery item and return the promise
   * that resolves when it fires (or when another fact clears it). The query
   * and the resend share this deadline, so crossing from one to the other
   * must not restart it.
   */
  #armSubmissionDeadline(record: SubmissionRecord): Promise<void> {
    this.#startSubmissionTimer(record);
    let resolve!: () => void;
    const deadline = new Promise<void>((done) => {
      resolve = done;
    });
    record.timeoutResolve = resolve;
    return deadline;
  }

  #clearSubmissionTimer(record: SubmissionRecord): void {
    const resolve = record.timeoutResolve;
    record.timeoutResolve = undefined;
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    resolve?.();
  }

  #submissionSettled(record: SubmissionRecord): boolean {
    return record.phase === "settled";
  }

  #settleSubmission(record: SubmissionRecord): void {
    if (this.#submissionSettled(record)) return;
    record.phase = "settled";
    record.error = undefined;
    this.#clearSubmissionTimer(record);
  }

  #entriesOf(id: ConversationId | undefined): readonly { readonly id?: unknown }[] {
    if (id === undefined) return [];
    const view = this.#values.get(conversationStream(id)) as ConversationView | undefined;
    return view?.entries ?? [];
  }

  #entryPresent(record: SubmissionRecord): boolean {
    if (record.entry === undefined) return false;
    return this.#entriesOf(record.conversationId).some((entry) => String(entry.id) === String(record.entry));
  }

  /** Whether the host's inbox currently shows the row this submission became. */
  #inboxHas(record: SubmissionRecord): boolean {
    if (record.conversationId === undefined || record.submissionId === undefined) return false;
    const inbox = this.#values.get(docStream("pi.inbox", record.conversationId)) as
      | { readonly items?: readonly { readonly id?: unknown }[] }
      | undefined;
    return (inbox?.items ?? []).some((item) => String(item.id) === String(record.submissionId));
  }

  /**
   * Take the host's record as the truth for a logical submission. A record
   * with an entry waits for that entry; one without waits for its inbox row
   * only while it is still queued. Placed/done/unanswered are already past
   * the client's view, so the local row goes away (ADR-0034 §7).
   */
  #applySubmissionRecord(record: SubmissionRecord, found: SubmissionFact): void {
    record.admitted = true;
    record.submissionId = found.submissionId;
    record.error = undefined;
    this.#clearSubmissionTimer(record);
    if (found.entry !== undefined) record.entry = found.entry;
    if (record.entry !== undefined) {
      if (this.#entryPresent(record) || found.status === "done") this.#settleSubmission(record);
      else record.phase = "inFlight";
    } else if (this.#inboxHas(record)) {
      this.#settleSubmission(record);
    } else if (found.status === "placed" || found.status === "done" || found.status === "unanswered") {
      this.#settleSubmission(record);
    } else {
      record.phase = "inFlight";
    }
    this.#touchSubmissions();
  }

  /** Settle records whose entry or inbox row has now arrived in a stream. */
  #reconcileSubmissions(): void {
    for (const record of this.#submissionOrder) {
      if (record.phase === "settled" || record.submissionId === undefined) continue;
      if (this.#entryPresent(record) || this.#inboxHas(record)) {
        this.#settleSubmission(record);
        continue;
      }
      // An admitted record with an entry the fresh snapshot lacks may have
      // been trimmed by a reset after it committed; a queued record with no
      // inbox row may have been consumed or withdrawn before we saw it. Ask
      // once per fresh snapshot in both cases.
      if (
        record.conversationId !== undefined
        && record.submissionId !== undefined
        && record.admitted
        && (record.entry !== undefined || !this.#inboxHas(record))
      ) {
        const stream = conversationStream(record.conversationId);
        // Either the transcript or the inbox moving can turn an admitted row
        // into a stale one, so check once per version of both.
        const version =
          (this.#streamVersions.get(stream) ?? 0)
          + (this.#streamVersions.get(docStream("pi.inbox", record.conversationId)) ?? 0);
        if (this.#fresh.has(stream) && record.checkedVersion !== version) {
          record.checkedVersion = version;
          void this.#confirmSubmission(record);
        }
      }
    }
  }

  /** One submission read; direct bypasses the sync gate during recovery. */
  #querySubmission(record: SubmissionRecord, direct = false): Promise<SubmissionFact | null> {
    if (!hostSupportsCall(this.#hostMinor, "submission")) {
      return Promise.reject(new Error("The host is too old for submission receipts (needs protocol 5.25); run `pinomad upgrade` on the host"));
    }
    if (record.conversationId === undefined) {
      return Promise.reject(new Error("No conversation selected"));
    }
    const args = { conversationId: record.conversationId, requestId: record.requestId };
    const call = direct ? this.#callNow("submission", args) : this.#call("submission", args);
    return call as Promise<SubmissionFact | null>;
  }

  /**
   * After an admission result without an entry (a queued input) ask once
   * whether the host already has a fact the snapshots missed.
   */
  async #confirmSubmission(record: SubmissionRecord): Promise<void> {
    if (record.confirming || record.phase === "settled" || !hostSupportsCall(this.#hostMinor, "submission")) return;
    record.confirming = true;
    try {
      const found = await this.#querySubmission(record);
      if (this.#closed || this.#submissionSettled(record)) return;
      if (found !== null) {
        this.#applySubmissionRecord(record, found);
      } else if (record.admitted && record.entry === undefined) {
        // A queued admit has no entry, and no record now: it was withdrawn or
        // consumed beyond the visible queue, so the local row is over. A known
        // entry still waits for its snapshot (a reset may have trimmed it).
        this.#settleSubmission(record);
        this.#touchSubmissions();
      }
    } catch {
      // The result already admitted it; snapshots remain the other source of truth.
    } finally {
      record.confirming = false;
    }
  }

  #submissionArgs(record: SubmissionRecord): CallMethods["submit"]["args"] {
    const conversationId = record.conversationId;
    if (conversationId === undefined) throw new Error("No conversation selected");
    return {
      conversationId,
      text: record.text,
      whenBusy: record.whenBusy,
      requestId: record.requestId,
      ...(record.images.length === 0 ? {} : { images: record.images }),
      ...this.#boundSkills(record.skills),
      ...(record.attachments.length === 0 ? {} : { attachments: record.attachments }),
    };
  }

  #validateSubmission(record: SubmissionRecord): void {
    if (record.images.length > 0 && !hostSupportsFeature(this.#hostMinor, "images")) {
      throw new Error("The host is too old for images (needs protocol 5.5); run `pinomad upgrade` on the host");
    }
    if (needsImageRefs(record.images) && !hostSupportsFeature(this.#hostMinor, "imageRefs")) {
      throw new Error("The host is too old for image refs (needs protocol 5.15); run `pinomad upgrade` on the host");
    }
    if (record.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error("At most " + MAX_ATTACHMENTS_PER_MESSAGE + " attachments per message");
    }
    if (record.attachments.length > 0 && !hostSupportsFeature(this.#hostMinor, "attachments")) {
      throw new Error("The host is too old for attachments (needs protocol 5.19); run `pinomad upgrade` on the host");
    }
  }

  #applySubmitResult(record: SubmissionRecord, result: { submissionId: number; entry?: number }): void {
    if (this.#closed) return;
    this.#clearSubmissionTimer(record);
    record.admitted = true;
    record.submissionId = result.submissionId;
    if (result.entry !== undefined) record.entry = result.entry;
    if (!hostSupportsFeature(this.#hostMinor, "submitEntry")) {
      // A pre-5.25 host has no entry to wait for; its result is the fact.
      this.#settleSubmission(record);
    } else if (record.entry !== undefined) {
      record.phase = "inFlight";
      if (this.#entryPresent(record)) this.#settleSubmission(record);
    } else {
      record.phase = "inFlight";
      if (record.conversationId !== undefined) {
        // This query answers the current snapshot; the next one may re-ask.
        record.checkedVersion =
          (this.#streamVersions.get(conversationStream(record.conversationId)) ?? 0)
          + (this.#streamVersions.get(docStream("pi.inbox", record.conversationId)) ?? 0);
      }
      void this.#confirmSubmission(record);
    }
    this.#touchSubmissions();
  }

  #applySubmitError(record: SubmissionRecord, error: unknown): void {
    if (this.#closed) return;
    this.#clearSubmissionTimer(record);
    if (
      error instanceof DisconnectedError
      || (error instanceof Error && error.message === "Not connected to the host")
    ) {
      record.phase = "unknown";
    } else {
      record.phase = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
    this.#touchSubmissions();
  }

  /**
   * Put one submit frame out and fold its result (or loss) into the record.
   * A caller that already armed the deadline passes it in, so a retry's
   * query and resend share one window.
   */
  async #sendSubmission(record: SubmissionRecord, direct: boolean, deadline?: Promise<void>): Promise<void> {
    if (record.phase === "settled" || this.#closed) return;
    if (deadline !== undefined && record.timer === undefined) {
      // The shared deadline already fired; never send on a spent window.
      if (record.phase !== "failed") {
        record.phase = "unknown";
        this.#touchSubmissions();
      }
      return;
    }
    record.phase = "inFlight";
    record.error = undefined;
    const call = direct
      ? this.#callNow("submit", this.#submissionArgs(record))
      : this.#call("submit", this.#submissionArgs(record));
    const timedOut = deadline ?? this.#armSubmissionDeadline(record);
    this.#touchSubmissions();
    // The result handler stays attached after a timeout: the host may still
    // admit the original request, and that late fact must win.
    const handled = (async () => {
      try {
        const result = (await call) as { submissionId: number; entry?: number };
        this.#applySubmitResult(record, result);
      } catch (error) {
        this.#applySubmitError(record, error);
      }
    })();
    await Promise.race([handled, timedOut]);
  }

  async #runSubmission(record: SubmissionRecord): Promise<void> {
    if (record.phase === "settled" || this.#closed) return;
    try {
      this.#validateSubmission(record);
    } catch (error) {
      if (this.#closed) return;
      record.phase = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      this.#touchSubmissions();
      return;
    }
    if (!record.fixed) {
      // Resolve once, in command order, then retries read this instead of the slot.
      const target = this.#current;
      if (target === undefined) {
        record.phase = "failed";
        record.error = "No conversation selected";
        this.#touchSubmissions();
        return;
      }
      record.conversationId = target;
      record.fixed = true;
    }
    await this.#sendSubmission(record, false);
  }

  /**
   * Before a reconnect's sync gate releases queued calls, resolve every
   * unknown send in enqueue order. A host record wins; a null record is the
   * only reason to resend the same requestId into the same conversation.
   */
  async #recoverSubmissions(): Promise<void> {
    const unknown = this.#submissionOrder.filter((record) => record.phase === "unknown");
    // Even when every stream arrived before this turn, the queries must
    // finish before calls queued during the outage may run (ADR-0034 §6).
    if (
      this.#syncGate === undefined
      && unknown.some((record) => record.fixed)
      && hostSupportsCall(this.#hostMinor, "submission")
    ) {
      this.#syncGate = { entries: [] };
    }
    for (const record of unknown) {
      if (this.#closed || record.phase !== "unknown" || !record.fixed) continue;
      try {
        if (!hostSupportsCall(this.#hostMinor, "submission")) {
          // A pre-5.25 host cannot answer "did you get it?"; leave the row for
          // the user's Retry, exactly like today's missing receipt.
          continue;
        }
        const deadline = this.#armSubmissionDeadline(record);
        const found = await this.#querySubmissionWithinDeadline(record, true, deadline);
        if (found === "deadline") continue;
        if (found !== null) {
          this.#applySubmissionRecord(record, found);
          continue;
        }
        // A fact may have settled the row while the query was in flight; a
        // spent deadline must never turn a null into a resend.
        if (record.phase !== "unknown" || record.timer === undefined) continue;
        await this.#sendSubmission(record, true, deadline);
      } catch (error) {
        if (this.#closed) return;
        this.#clearSubmissionTimer(record);
        record.phase = "unknown";
        this.#touchSubmissions();
        if (
          error instanceof DisconnectedError
          || (error instanceof Error && error.message === "Not connected to the host")
        ) {
          return;
        }
      }
    }
  }

  #submissionDraft(record: SubmissionRecord, images: readonly OutgoingImage[] = record.images): SubmissionDraft {
    return {
      text: record.text,
      whenBusy: record.whenBusy,
      images,
      skills: record.skills ?? [],
      attachments: record.attachments,
      ...(record.attachmentDetails === undefined ? {} : { attachmentDetails: record.attachmentDetails }),
    };
  }

  /**
   * Resolve every image to bytes before an edit removes the local submission.
   * A ref the host no longer serves must leave the row and composer untouched.
   */
  async #resolveSubmissionImages(record: SubmissionRecord): Promise<readonly OutgoingImage[]> {
    const views: readonly (ViewImage | OutgoingImage)[] = record.imageViews ?? record.images;
    const resolved: OutgoingImage[] = [];
    for (const image of views) {
      if ("data" in image) {
        resolved.push(image);
      } else {
        const bytes = await this.#call("image", { ref: image.ref });
        resolved.push({ data: bytes.data, mimeType: bytes.mimeType });
      }
    }
    return resolved;
  }

  /**
   * One submission read under an already armed deadline. If the deadline
   * wins, a late record may still reconcile the row, but it must not send.
   */
  async #querySubmissionWithinDeadline(
    record: SubmissionRecord,
    direct: boolean,
    deadline: Promise<void>,
  ): Promise<SubmissionFact | null | "deadline"> {
    const query = this.#querySubmission(record, direct);
    const outcome = await Promise.race([
      query.then(
        (found) => ({ kind: "found" as const, found }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      deadline.then(() => ({ kind: "deadline" as const })),
    ]);
    if (outcome.kind === "deadline") {
      void query.then(
        (found) => {
          if (this.#closed || found === null || record.phase === "settled") return;
          this.#applySubmissionRecord(record, found);
        },
        () => {},
      );
      return "deadline";
    }
    if (outcome.kind === "error") throw outcome.error;
    return outcome.found;
  }

  async #retrySubmission(record: SubmissionRecord): Promise<void> {
    if (record.phase !== "unknown" && record.phase !== "failed") return;
    const deadline = this.#armSubmissionDeadline(record);
    try {
      if (record.phase === "unknown" && hostSupportsCall(this.#hostMinor, "submission")) {
        const found = await this.#querySubmissionWithinDeadline(record, false, deadline);
        if (found === "deadline") return;
        if (found !== null) {
          this.#applySubmissionRecord(record, found);
          return;
        }
        // A fact may have settled the row while the query was in flight; a
        // spent deadline must never turn a null into a resend.
        if (record.phase !== "unknown" || record.timer === undefined) return;
      }
      await this.#sendSubmission(record, false, deadline);
    } catch (error) {
      if (this.#closed) return;
      this.#clearSubmissionTimer(record);
      if (
        error instanceof DisconnectedError
        || (error instanceof Error && error.message === "Not connected to the host")
      ) {
        record.phase = "unknown";
        record.error = undefined;
        this.#touchSubmissions();
        return;
      }
      record.phase = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      this.#touchSubmissions();
      throw error;
    }
  }

  async #takeBackSubmission(record: SubmissionRecord): Promise<SubmissionDraft | undefined> {
    let resolved: readonly OutgoingImage[] | undefined;
    const images = async (): Promise<readonly OutgoingImage[]> => {
      if (resolved !== undefined) return resolved;
      try {
        resolved = await this.#resolveSubmissionImages(record);
        return resolved;
      } catch {
        throw new Error("Couldn't load the original images — try again");
      }
    };
    if (record.phase === "queued" || record.phase === "failed") {
      const draft = await images();
      this.#settleSubmission(record);
      this.#touchSubmissions();
      return this.#submissionDraft(record, draft);
    }
    if (record.phase !== "unknown" && !(record.phase === "inFlight" && record.submissionId !== undefined)) {
      return undefined;
    }
    if (!hostSupportsCall(this.#hostMinor, "submission")) return undefined;
    const found = await this.#querySubmission(record);
    if (found === null) {
      const draft = await images();
      this.#settleSubmission(record);
      this.#touchSubmissions();
      return this.#submissionDraft(record, draft);
    }
    this.#applySubmissionRecord(record, found);
    if (this.#submissionSettled(record)) return undefined;
    if (found.status === "placed" || found.status === "done" || found.entry !== undefined) return undefined;
    if (found.status === "unanswered") {
      const draft = await images();
      this.#settleSubmission(record);
      this.#touchSubmissions();
      return this.#submissionDraft(record, draft);
    }
    if (record.conversationId === undefined) return undefined;
    const draft = await images();
    const { outcome } = await this.#call("withdrawQueued", {
      conversationId: record.conversationId,
      submissionId: found.submissionId,
    });
    if (outcome === "sent") {
      this.#settleSubmission(record);
      this.#touchSubmissions();
      return undefined;
    }
    this.#settleSubmission(record);
    this.#touchSubmissions();
    return this.#submissionDraft(record, draft);
  }
  /** One shown conversation's extension docs, in the host's order. */
  #docsOf(id: ConversationId): ExtensionDocView[] {
    return this.#docs.flatMap((doc) => {
      const stream = docStream(doc.kind, id);
      return this.#values.has(stream)
        ? [{ kind: doc.kind, presentation: doc.presentation, value: this.#values.get(stream) as JsonObject | null }]
        : [];
    });
  }

  #refresh(): void {
    if (this.#state === undefined) return;
    this.#reconcileSubmissions();
    const current = this.#current;
    const side = this.#side;
    const conversation =
      current === undefined ? undefined : (this.#values.get(conversationStream(current)) as ConversationView | undefined);
    const summaries = this.#host("conversations") ?? [];
    const index = this.#host("index") ?? { projects: [], conversations: [] };
    const devices = this.#host("devices")?.devices ?? [];
    const tasks = this.#wanted.has("tasks") ? (this.#values.get("tasks") as TaskGraph | undefined) : undefined;
    this.#update({
      conversation,
      // The stream value wins once it arrived; it must not fall back to a
      // reconnect hello's list, which the host may not have refreshed yet.
      models: this.#host("models") ?? this.#helloModels,
      organized: organize(index, summaries),
      home: current === undefined ? undefined : homeOf(index, summaries, current),
      checkout: current === undefined ? undefined : checkoutOf(index, summaries, current),
      tasks,
      docs: current === undefined ? [] : this.#docsOf(current),
      submissions: this.#activeSubmissions(),
      side:
        side === undefined
          ? undefined
          : {
              id: side,
              conversation: this.#values.get(conversationStream(side)) as ConversationView | undefined,
              docs: this.#docsOf(side),
            },
      devices,
      mcp: this.#host("mcp") ?? null,
      auth: this.#host("auth") ?? null,
      providers: this.#host("providers") ?? null,
      settings: this.#host("settings") ?? null,
      agents: this.#host("agents") ?? null,
      defaults: this.#effectiveDefaults(this.#helloDefaults),
    });
  }

  #update(patch: Partial<DurableView>): void {
    if (this.#state === undefined) return;
    this.#state = { ...this.#state, ...patch };
    if (this.#notifying) return;
    this.#notifying = true;
    // One render per burst of frames, as the in-process view source does.
    queueMicrotask(() => {
      this.#notifying = false;
      for (const listener of this.#listeners) listener();
    });
  }

  /**
   * The `skills` arg for a host that takes it (5.16, ADR-0028). An older host
   * never gets the list: the `$name` text still goes out, and the host
   * matches it (or not) the way it always did — nothing to refuse.
   */
  #boundSkills(skills: readonly string[] | undefined): { skills?: readonly string[] } {
    return skills === undefined || !hostSupportsFeature(this.#hostMinor, "boundSkills") ? {} : { skills };
  }

  #notice(level: Notice["level"], message: string): void {
    if (this.#state === undefined) return;
    this.#update({ notices: [...this.#state.notices, { id: this.#nextNotice++, level, message }].slice(-20) });
  }

  /** The provider calls all arrived together in 5.21 (ADR-0031). */
  #requireProviders(): void {
    if (!hostSupportsCall(this.#hostMinor, "beginLogin")) {
      throw new Error("The host is too old for this (needs protocol 5.21); run `pinomad upgrade` on the host");
    }
  }

  #call<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
    const handoff = this.#handoff;
    if (handoff !== undefined || this.#syncGate !== undefined) {
      // The atomic barrier (handoff) or an ordinary reconnect's sync gate
      // closed the new-call entrance. Calls wait here and can still be
      // cancelled without ever entering a ciphertext FIFO.
      const id = this.#nextCall++;
      const frame = { type: "call", id, method, args } as ClientFrame;
      const entries = handoff?.entries ?? this.#syncGate!.entries;
      return new Promise((resolve, reject) => {
        entries.push({ id, frame, resolve: resolve as (value: unknown) => void, reject });
      });
    }
    if (this.#dial?.phase !== "ready" || this.#state?.connection !== "connected") {
      return Promise.reject(new Error("Not connected to the host"));
    }
    return this.#deliverCall(this.#dial, this.#nextCall++, method, args);
  }

  /**
   * A call that bypasses the sync gate, for the reconciliation queries and
   * resends that must finish before the gate releases later commands.
   */
  #callNow<M extends CallMethod>(method: M, args: CallMethods[M]["args"]): Promise<CallMethods[M]["result"]> {
    if (this.#dial?.phase !== "ready" || this.#state?.connection !== "connected") {
      return Promise.reject(new Error("Not connected to the host"));
    }
    return this.#deliverCall(this.#dial, this.#nextCall++, method, args);
  }

  /** Put a call on one ready dial; used by the normal path and the handoff queue. */
  #deliverCall<M extends CallMethod>(
    dial: DialAttempt,
    id: number,
    method: M,
    args: CallMethods[M]["args"],
  ): Promise<CallMethods[M]["result"]> {
    if (!this.#isActive(dial) || dial.phase !== "ready" || dial.connection === undefined) {
      return Promise.reject(new Error("Not connected to the host"));
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        dial.connection!.send(JSON.stringify({ type: "call", id, method, args } as ClientFrame));
      } catch (error) {
        this.#pending.delete(id);
        reject(asError(error));
      }
    });
  }

  /** Serialized like the in-process controller, so toggles and switches apply in order; failures become notices. */
  #command(operation: () => Promise<unknown>): Promise<void> {
    this.#commands = this.#commands
      .then(operation)
      .then(
        () => {},
        (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
      );
    return this.#commands;
  }

  /**
   * Queued behind #commands like #command, but the caller owns the result and
   * the error — the promise is handed back and no notice is produced.
   */
  #request<T>(operation: () => Promise<T>): Promise<T> {
    const request = this.#commands.then(operation);
    this.#commands = request.then(
      () => {},
      () => {},
    );
    return request;
  }

  #viewSource(): DurableViewSource {
    return {
      current: () => this.#state!,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  #controller(): DurableController {
    // crypto.randomUUID exists only in secure contexts; a phone on http://<lan-ip> has none.
    const newRequestId = (): string =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const conversationId = (): ConversationId => {
      if (this.#current === undefined) throw new Error("No conversation selected");
      return this.#current;
    };
    return {
      addProject: (path) => this.#request(() => this.#call("addProject", { path })),
      listFolders: (path) =>
        this.#request(() => {
          if (!hostSupportsCall(this.#hostMinor, "listFolders")) {
            throw new Error("The host is too old for this (needs protocol 5.3); run `pinomad upgrade` on the host");
          }
          return this.#call("listFolders", path === undefined ? {} : { path });
        }),
      removeProject: (path) => this.#command(() => this.#call("removeProject", { path })),
      renameConversation: (id, title) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "renameConversation")) {
            throw new Error("The host is too old for this (needs protocol 5.4); run `pinomad upgrade` on the host");
          }
          await this.#call("renameConversation", { conversationId: id, title });
        }),
      createConversation: (home, text, options) =>
        this.#command(async () => {
          const images = options?.images ?? [];
          if (images.length > 0 && !hostSupportsFeature(this.#hostMinor, "images")) {
            throw new Error("The host is too old for images (needs protocol 5.5); run `pinomad upgrade` on the host");
          }
          // A pre-5.15 host calls `{ ref }` malformed and closes with 4400, so
          // refuse it here — bytes still go to a 5.5 host (ADR-0018 §2).
          if (needsImageRefs(images) && !hostSupportsFeature(this.#hostMinor, "imageRefs")) {
            throw new Error("The host is too old for image refs (needs protocol 5.15); run `pinomad upgrade` on the host");
          }
          const attachments = options?.attachments ?? [];
          if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
            throw new Error(`At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
          }
          if (attachments.length > 0 && !hostSupportsFeature(this.#hostMinor, "attachments")) {
            throw new Error("The host is too old for attachments (needs protocol 5.19); run `pinomad upgrade` on the host");
          }
          // A pre-5.10 host would silently ignore `agent` and create an
          // unassigned conversation — fail instead (ADR-0023 §8).
          if (options?.agent !== undefined && !hostSupportsFeature(this.#hostMinor, "agentConversations")) {
            throw new Error("The host is too old for named agents (needs protocol 5.10); run `pinomad upgrade` on the host");
          }
          const { conversationId } = await this.#call("createConversation", {
            home,
            text,
            requestId: newRequestId(),
            ...(options?.checkout === undefined ? {} : { checkout: options.checkout }),
            ...(options?.model === undefined ? {} : { model: options.model }),
            ...(options?.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
            ...(options?.agent === undefined ? {} : { agent: options.agent }),
            ...(images.length === 0 ? {} : { images }),
            ...this.#boundSkills(options?.skills),
            ...(attachments.length === 0 ? {} : { attachments }),
          });
          await this.#switch(conversationId);
        }),
      archive: (id, archived) =>
        this.#command(async () => {
          await this.#call("archive", { conversationId: id, archived });
          if (archived && id === this.#current) this.#unshow();
          // Archiving a root takes its descendants with it — a side into that
          // family is gone too.
          if (archived && this.#side !== undefined && this.#descendsFrom(this.#side, id)) await this.#showSide(undefined);
        }),
      submit: (text, whenBusy, options) => {
        const requestId = options?.requestId ?? newRequestId();
        if (this.#submissions.has(requestId)) return Promise.resolve();
        const target = options?.target ?? this.#current;
        const shown = target === undefined ? undefined : (this.#values.get(conversationStream(target)) as ConversationView | undefined);
        const record: SubmissionRecord = {
          requestId,
          text,
          whenBusy,
          // Placement is fixed at send time: confirming later must not move the row.
          placement: shown !== undefined && isBusy(shown) ? "queue" : "conversation",
          images: options?.images ?? [],
          ...(options?.imageViews === undefined ? {} : { imageViews: options.imageViews }),
          ...(options?.skills === undefined ? {} : { skills: options.skills }),
          attachments: options?.attachments ?? [],
          ...(options?.attachmentDetails === undefined ? {} : { attachmentDetails: options.attachmentDetails }),
          phase: "queued",
          ...(target === undefined ? {} : { conversationId: target }),
          fixed: options?.target !== undefined,
          admitted: false,
          confirming: false,
        };
        this.#submissions.set(requestId, record);
        this.#submissionOrder.push(record);
        this.#touchSubmissions();
        return this.#request(() => this.#runSubmission(record)).then(
          () => {},
          () => {},
        );
      },
      retrySubmission: (requestId) => {
        const record = this.#submissions.get(requestId);
        if (record === undefined || this.#submissionLocks.has(requestId)) return Promise.resolve();
        this.#submissionLocks.add(requestId);
        return this.#request(() => this.#retrySubmission(record)).finally(() => this.#submissionLocks.delete(requestId));
      },
      takeBackSubmission: (requestId) => {
        const record = this.#submissions.get(requestId);
        if (record === undefined || this.#submissionLocks.has(requestId)) return Promise.resolve(undefined);
        this.#submissionLocks.add(requestId);
        return this.#request(() => this.#takeBackSubmission(record)).finally(() => this.#submissionLocks.delete(requestId));
      },
      compact: (instructions) =>
        this.#command(() =>
          this.#call("compact", { conversationId: conversationId(), ...(instructions === undefined ? {} : { instructions }) }),
        ),
      runCommand: (name, args, target) =>
        this.#command(() => {
          if (!hostSupportsCall(this.#hostMinor, "runCommand")) {
            throw new Error("The host is too old for this (needs protocol 5.17); run `pinomad upgrade` on the host");
          }
          return this.#call("runCommand", {
            conversationId: target ?? conversationId(),
            name,
            ...(args === undefined ? {} : { args }),
          });
        }),
      // Not queued: it resolves once the conversation is idle.
      abort: (target) => {
        const targetConversation = target ?? this.#current;
        if (targetConversation === undefined) {
          this.#notice("error", "No conversation selected");
          return Promise.resolve();
        }
        return this.#call("abort", { conversationId: targetConversation }).then(
            () => {},
            (error: unknown) => this.#notice("error", error instanceof Error ? error.message : String(error)),
          );
      },
      // Requests, not commands: a failed withdraw/steer must reach the
      // caller's Undo/Edit affordance instead of becoming a notice.
      withdrawQueued: (submissionId, target) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "withdrawQueued")) {
            throw new Error("The host is too old for this (needs protocol 5.14); run `pinomad upgrade` on the host");
          }
          const { outcome } = await this.#call("withdrawQueued", {
            conversationId: target ?? conversationId(),
            submissionId,
          });
          return outcome;
        }),
      steerQueued: (submissionId, target) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "steerQueued")) {
            throw new Error("The host is too old for this (needs protocol 5.14); run `pinomad upgrade` on the host");
          }
          const { outcome } = await this.#call("steerQueued", {
            conversationId: target ?? conversationId(),
            submissionId,
          });
          return outcome;
        }),
      setThinkingLevel: (level) => this.#command(() => this.#call("setThinkingLevel", { conversationId: conversationId(), level })),
      setModel: (model) => this.#command(() => this.#call("setModel", { conversationId: conversationId(), model })),
      setAgent: (agent) =>
        this.#command(() => {
          if (!hostSupportsCall(this.#hostMinor, "setAgent")) {
            throw new Error("The host is too old for this (needs protocol 5.18); run `pinomad upgrade` on the host");
          }
          return this.#call("setAgent", { conversationId: conversationId(), agent });
        }),
      toggleTasks: () =>
        this.#command(async () => {
          if (this.#wanted.delete("tasks")) {
            this.#send({ type: "unsubscribe", stream: "tasks" });
            this.#values.delete("tasks");
            this.#refresh();
            return;
          }
          this.#wanted.add("tasks");
          const shown = this.#snapshot("tasks");
          this.#send({ type: "subscribe", stream: "tasks" });
          await shown;
        }),
      switchConversation: (id) => this.#command(() => this.#switch(id)),
      showSide: (id) => this.#command(() => this.#showSide(id)),
      clearConversation: () => this.#command(() => this.#clear()),
      fork: (entryId, prompt, removeTools, options) =>
        this.#command(async () => {
          const { conversationId: forked } = await this.#call("fork", {
            conversationId: conversationId(),
            entryId,
            ...(removeTools === undefined ? {} : { removeTools }),
          });
          // The fork is listed once its creating commit reaches the conversation list; switching does not need that.
          if (options?.show === "side") await this.#showSide(forked);
          else await this.#switch(forked);
          await this.#call("submit", { conversationId: forked, text: prompt, whenBusy: "followUp", requestId: newRequestId() });
        }),
      answer: (kind, requestId, answers, target) =>
        this.#command(() => this.#call("answer", { conversationId: target ?? conversationId(), kind, requestId, answers })),
      changes: () => this.#request(() => this.#call("changes", { conversationId: conversationId() })),
      // Sent directly, not through #request: a read-only completion query must
      // not queue behind a hanging command — that would stall the composer.
      listFiles: (scope, query) => {
        if (!hostSupportsCall(this.#hostMinor, "listFiles")) {
          return Promise.reject(new Error("The host is too old for this (needs protocol 5.10); run `pinomad upgrade` on the host"));
        }
        return this.#call("listFiles", { scope, query });
      },
      // Unqueued like listFiles (issue #321): upload chunks run beside the
      // command queue, so a send/abort is never stuck behind a large frame.
      beginAttachment: (name, size) => {
        if (!hostSupportsCall(this.#hostMinor, "beginAttachment")) {
          return Promise.reject(new Error("The host is too old for attachments (needs protocol 5.19); run `pinomad upgrade` on the host"));
        }
        return this.#call("beginAttachment", { name, size }).then(({ attachmentId }) => attachmentId);
      },
      appendAttachment: (attachmentId, offset, data) => {
        if (!hostSupportsCall(this.#hostMinor, "appendAttachment")) {
          return Promise.reject(new Error("The host is too old for attachments (needs protocol 5.19); run `pinomad upgrade` on the host"));
        }
        return this.#call("appendAttachment", { attachmentId, offset, data });
      },
      // Same unqueued shape as listFiles: fetching image bytes is read-only
      // and must not wait behind a hanging command (ADR-0027).
      image: (ref, variant: ImageVariant = "original") => {
        if (!hostSupportsCall(this.#hostMinor, "image")) {
          return Promise.reject(new Error("The host is too old for this (needs protocol 5.15); run `pinomad upgrade` on the host"));
        }
        const derived = variant !== "original" && hostSupportsFeature(this.#hostMinor, "imageVariants");
        return this.#call("image", { ref, ...(derived ? { variant } : {}) });
      },
      // Same unqueued shape as listFiles: a read-only completion query must
      // not wait behind a hanging command (issue #143).
      listSkills: (scope) => {
        if (!hostSupportsCall(this.#hostMinor, "listSkills")) {
          return Promise.reject(new Error("The host is too old for this (needs protocol 5.13); run `pinomad upgrade` on the host"));
        }
        return this.#call("listSkills", { scope });
      },
      // Same unqueued shape as listSkills (issue #254).
      listCommands: (id) => {
        if (!hostSupportsCall(this.#hostMinor, "listCommands")) {
          return Promise.reject(new Error("The host is too old for this (needs protocol 5.17); run `pinomad upgrade` on the host"));
        }
        return this.#call("listCommands", { conversationId: id });
      },
      createPairing: () => this.#request(() => this.#call("createPairing", {})),
      revokeDevice: (publicKey) => this.#command(() => this.#call("revokeDevice", { publicKey })),
      logout: (providerId) =>
        this.#command(() => {
          if (!hostSupportsCall(this.#hostMinor, "logout")) {
            throw new Error(
              "The host is too old for this (needs protocol 5.1); run `pinomad upgrade` on the host",
            );
          }
          return this.#call("logout", { providerId });
        }),
      beginLogin: (providerId, method) =>
        this.#request(async () => {
          this.#requireProviders();
          return (await this.#call("beginLogin", { providerId, method })).loginId;
        }),
      answerLogin: (loginId, promptId, value) =>
        this.#request(async () => {
          this.#requireProviders();
          await this.#call("answerLogin", { loginId, promptId, value });
        }),
      cancelLogin: (loginId) =>
        this.#request(async () => {
          this.#requireProviders();
          await this.#call("cancelLogin", { loginId });
        }),
      saveCustomProvider: (provider, apiKey) =>
        this.#request(async () => {
          this.#requireProviders();
          await this.#call("saveCustomProvider", apiKey === undefined ? { provider } : { provider, apiKey });
        }),
      removeCustomProvider: (providerId) =>
        this.#request(async () => {
          this.#requireProviders();
          await this.#call("removeCustomProvider", { providerId });
        }),
      // Unqueued like listCommands: the host waits on a remote endpoint.
      listEndpointModels: async (input) => {
        this.#requireProviders();
        return (await this.#call("listEndpointModels", input)).models;
      },
      updateSettings: (patch) =>
        this.#command(() => {
          if (!hostSupportsCall(this.#hostMinor, "updateSettings")) {
            throw new Error(
              "The host is too old for this (needs protocol 5.2); run `pinomad upgrade` on the host",
            );
          }
          // A 5.2–5.7 host rejects the unknown key as malformed and closes
          // with 4400 — refuse locally instead (ADR-0018 §2).
          if (
            patch.acceptAccountDevices !== undefined
            && !hostSupportsFeature(this.#hostMinor, "acceptAccountDevices")
          ) {
            throw new Error(
              "The host is too old for this (needs protocol 5.8); run `pinomad upgrade` on the host",
            );
          }
          // Same for hostName on a pre-5.12 host — even the `null` reset.
          if (patch.hostName !== undefined && !hostSupportsFeature(this.#hostMinor, "hostName")) {
            throw new Error(
              "The host is too old for this (needs protocol 5.12); run `pinomad upgrade` on the host",
            );
          }
          return this.#call("updateSettings", { patch });
        }),
      createAgent: (role) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "createAgent")) {
            throw new Error("The host is too old for this (needs protocol 5.6); run `pinomad upgrade` on the host");
          }
          await this.#call("createAgent", { role });
        }),
      updateAgent: (role) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "updateAgent")) {
            throw new Error("The host is too old for this (needs protocol 5.6); run `pinomad upgrade` on the host");
          }
          await this.#call("updateAgent", { role });
        }),
      deleteAgent: (name) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "deleteAgent")) {
            throw new Error("The host is too old for this (needs protocol 5.6); run `pinomad upgrade` on the host");
          }
          await this.#call("deleteAgent", { name });
        }),
      // A request, not a command: registration failures (old host, rejected
      // token, revoked device) must reach the caller — the mobile client shows
      // them on its notification toggle instead of swallowing them as a notice.
      setPushToken: (token) =>
        this.#request(async () => {
          if (!hostSupportsCall(this.#hostMinor, "setPushToken")) {
            throw new Error("The host is too old for this (needs protocol 5.7); run `pinomad upgrade` on the host");
          }
          // The object form would be malformed to a 5.7/5.8 host — it 4400s
          // the connection, so gate it on the feature like `images` (ADR-0018).
          if (token !== null && typeof token !== "string" && !hostSupportsFeature(this.#hostMinor, "apnsPush")) {
            throw new Error("The host is too old for this (needs protocol 5.9); run `pinomad upgrade` on the host");
          }
          await this.#call("setPushToken", { token });
        }),
    };
  }

  async #switch(id: ConversationId): Promise<void> {
    const previous = this.#current;
    if (id === previous) return;
    await this.#acquire(id);
    this.#current = id;
    if (previous !== undefined) this.#release(previous, this.#side);
    this.#refresh();
  }

  /** Stop showing the current conversation, for example after archiving it. */
  #unshow(): void {
    const previous = this.#current;
    if (previous === undefined) return;
    this.#current = undefined;
    this.#release(previous, this.#side);
    this.#refresh();
  }

  /**
   * Release both slots in order: the main releases first while the side still
   * keeps any streams they share, then the side releases the rest. Host-level
   * streams are never touched because they are not in either slot.
   */
  async #clear(): Promise<void> {
    this.#unshow();
    await this.#showSide(undefined);
  }

  /** Show a second conversation beside the main one, or close it. */
  async #showSide(id: ConversationId | undefined): Promise<void> {
    const previous = this.#side;
    if (id === previous) return;
    if (id !== undefined) await this.#acquire(id);
    this.#side = id;
    if (previous !== undefined) this.#release(previous, this.#current);
    this.#refresh();
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    this.#stopCoordination();
    this.#stopListeners();
    this.#abandonDial();
    this.#rejectPending();
    this.#rejectSnapshotWaiters(new DisconnectedError());
    this.#update({ connection: "closed" });
  }
}
