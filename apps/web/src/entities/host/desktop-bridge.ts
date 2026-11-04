import type { StoredHostConnectionChange } from "@pinomad/client/stored-host.ts";
import type { EndpointSet } from "@pinomad/protocol/endpoints.ts";
import type { UpdateStatus } from "../app-update/update-protocol.ts";
import type {
  LocalHostResult,
  LocalHostSetupResult,
  LocalHostState,
  LocalHostStopResult,
} from "../local-host/local-host-protocol.ts";
import type { StoredHost } from "./host-store.ts";

/**
 * What the desktop preload exposes on `window.pinomadDesktop`. The paired
 * hosts live in the Electron main process behind safeStorage; these invoke
 * channels are the renderer's only reach to them. The preload imports this
 * type so the two sides can't drift apart.
 */
export interface DesktopBridge {
  readonly hosts: {
    list(): Promise<StoredHost[]>;
    save(host: StoredHost): Promise<void>;
    remove(hostKey: string): Promise<void>;
    /** Cache the machine name the host announced (5.12); writes nothing when the entry is gone. */
    setName(hostKey: string, name: string): Promise<void>;
    /** Apply a secure-channel remote set; writes nothing when the entry is gone. */
    updateEndpoints(hostKey: string, endpointSet: EndpointSet): Promise<void>;
    /** Persist a connection preference or learned RTC hint; writes nothing when the entry is gone. */
    updateConnection(hostKey: string, change: StoredHostConnectionChange): Promise<void>;
  };
  /**
   * The bearer credential for the server-accounts API, kept in main's
   * encrypted store (ADR-0022). Optional like `updates`: older bridges lack
   * it, and a build without it just can't persist a session.
   */
  readonly account?: {
    get(): Promise<{ serverOrigin: string; token: string } | undefined>;
    save(account: { serverOrigin: string; token: string }): Promise<void>;
    clear(): Promise<void>;
  };
  /**
   * The label pairing registers on the host's device list ("Mac Desktop
   * (kieran-mbp)"). Optional like `updates`: the browser has no bridge, and a
   * missing one just falls back to the UA-derived name.
   */
  readonly deviceName?: () => Promise<string>;
  /**
   * Electron-updater control, owned by main. Optional only because the
   * browser has no bridge at all — inside the desktop app it always exists.
   */
  readonly updates?: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    install(): Promise<UpdateStatus>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
  /**
   * The "This Mac" switch over the host the user installed (#501): main runs
   * that install's `pinomad service` CLI. macOS only; absent elsewhere and in
   * the browser, where no switch shows.
   */
  readonly localHost?: {
    state(): Promise<LocalHostState>;
    start(): Promise<LocalHostResult>;
    /** Resolves once the CLI exits; what it prints while waiting for tasks arrives on onStopLines. A second call joins the first. */
    stop(): Promise<LocalHostStopResult>;
    /** Joins a stop still waiting (state's `stopping`), never starting one; undefined when it already ended. */
    followStop(): Promise<LocalHostStopResult | undefined>;
    /** Interrupts a stop still waiting for tasks; the service stays on and stop() resolves "cancelled". Too late once the CLI is stopping the service: stop() then resolves "stopped". */
    cancelStop(): Promise<void>;
    /** Runs install.sh in the background; what it prints arrives on onSetupLines. A second call joins the first. */
    install(): Promise<LocalHostSetupResult>;
    /** Kills a running install; install() then resolves "cancelled". */
    cancelInstall(): Promise<void>;
    /** `pinomad up` with a one-time join token for `serverOrigin`: joins the account and installs the service. */
    join(serverOrigin: string, token: string): Promise<LocalHostResult>;
    /** Every line the running stop printed so far, on each new one. */
    onStopLines(listener: (lines: readonly string[]) => void): () => void;
    /** Every line the running install printed so far, on each new one. */
    onSetupLines(listener: (lines: readonly string[]) => void): () => void;
  };
}

declare global {
  interface Window {
    pinomadDesktop?: DesktopBridge;
  }
}
