// One terminal's or background process's screen (ADR-0041, ADR-0045),
// loaded on first use: xterm.js fed from the host's output stream. A `reset`
// clears the screen before the replay; typing goes straight to a terminal and
// the fitted size goes to the host whenever it changes. A process screen is
// read-only and never reports a size: its host pty is fixed at 120×40.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { ProcessId } from "@pinomad/protocol/processes.ts";
import type { RemoteProcesses, RemoteTerminals } from "@pinomad/protocol/remote-durable.ts";
import type { TerminalId, TerminalSize } from "@pinomad/protocol/terminals.ts";

const DARK = "(prefers-color-scheme: dark)";

// ANSI colors readable on the app's light and dark backgrounds.
const ANSI_LIGHT: ITheme = {
  black: "#1f2328",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#136061",
  brightWhite: "#8c959f",
};
const ANSI_DARK: ITheme = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/**
 * A token as a color xterm can parse. Tokens are light-dark() and oklch, and
 * computed styles keep oklch, so the color is painted once and read back.
 */
function resolveColor(element: HTMLElement, value: string): string | undefined {
  const probe = document.createElement("span");
  probe.style.color = value;
  element.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context === null) return computed === "" ? undefined : computed;
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${((a ?? 255) / 255).toFixed(3)})`;
}

/** The app's effective scheme, falling back to the OS when the theme leaves it to the system. */
function isDark(element: HTMLElement): boolean {
  const scheme = getComputedStyle(element).colorScheme;
  if (scheme.includes("dark") && !scheme.includes("light")) return true;
  if (scheme.includes("light") && !scheme.includes("dark")) return false;
  return matchMedia(DARK).matches;
}

function themeFor(element: HTMLElement): ITheme {
  const foreground = resolveColor(element, "var(--foreground)");
  return {
    ...(isDark(element) ? ANSI_DARK : ANSI_LIGHT),
    background: resolveColor(element, "var(--surface)"),
    foreground,
    cursor: foreground,
    cursorAccent: resolveColor(element, "var(--surface)"),
    selectionBackground: resolveColor(element, "var(--color-overlay-pressed)"),
  };
}

/**
 * Write host output, clearing first on a replay. The clear goes into the
 * stream (RIS) rather than `reset()`, which runs at once while writes are
 * still waiting to be parsed: a second replay would land after a clear that
 * already happened.
 */
export function writeOutput(screen: Pick<Terminal, "write">, data: string, reset: boolean): void {
  screen.write(reset ? `\x1bc${data}` : data);
}

type XtermViewProps =
  | {
      readonly terminals: Pick<RemoteTerminals, "attach" | "input" | "resize">;
      readonly terminalId: TerminalId;
      /** Off while disconnected or after the process exited: keys go nowhere. */
      readonly enabled: boolean;
      readonly processes?: never;
      readonly processId?: never;
      readonly since?: never;
      readonly onEnded?: never;
    }
  | {
      readonly processes: Pick<RemoteProcesses, "attach">;
      readonly processId: ProcessId;
      /** The raw output position to replay from; undefined replays the retained start. */
      readonly since?: number;
      /** The host has no more output for this process (released, lost, or a restart). */
      readonly onEnded?: (reason: string) => void;
      readonly terminals?: never;
      readonly terminalId?: never;
      readonly enabled?: never;
    };

export default function XtermView(props: XtermViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(undefined);
  const readOnly = props.processes !== undefined;
  const enabled = props.terminals === undefined ? false : props.enabled;

  useEffect(() => {
    const element = container.current!;
    const screen = new Terminal({
      fontFamily: getComputedStyle(element).getPropertyValue("--font-family-code").trim() || "monospace",
      fontSize: 13,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      scrollback: 5000,
      theme: themeFor(element),
      // The host runs a process under a fixed 120×40 pty (ADR-0045 §3), so
      // its output's cursor addressing must stay on that same grid.
      ...(readOnly ? { cols: 120, rows: 40 } : {}),
    });
    let fit: FitAddon | undefined;
    if (!readOnly) {
      fit = new FitAddon();
      screen.loadAddon(fit);
    }
    screen.open(element);
    if (readOnly) screen.resize(120, 40);
    terminal.current = screen;

    let sent: TerminalSize | undefined;
    const fitNow = (): void => {
      if (fit === undefined) return;
      // A hidden panel measures as zero; its size stays what the host has.
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
      if (props.terminals === undefined || props.terminalId === undefined) return;
      if (sent?.cols === screen.cols && sent.rows === screen.rows) return;
      sent = { cols: screen.cols, rows: screen.rows };
      props.terminals.resize(props.terminalId, sent);
    };
    let detach: () => void;
    let typing: { dispose(): void } | undefined;
    if (props.processes !== undefined) {
      const processes = props.processes;
      detach = processes.attach(props.processId, props.since, {
        output: (data, reset) => writeOutput(screen, data, reset),
        ended: (reason) => props.onEnded?.(reason),
      });
    } else {
      const terminals = props.terminals;
      detach = terminals.attach(props.terminalId, {
        output: (data, reset) => writeOutput(screen, data, reset),
        ended: () => {},
      });
      typing = screen.onData((data) => terminals.input(props.terminalId, data));
    }
    // After attach: the client keeps an attached terminal's size to send
    // again after a reconnect, and the replay doesn't wait on the size.
    let observer: ResizeObserver | undefined;
    if (!readOnly) {
      fitNow();
      observer = new ResizeObserver(fitNow);
      observer.observe(element);
      screen.focus();
    }
    const scheme = matchMedia(DARK);
    const retheme = (): void => {
      screen.options.theme = themeFor(element);
    };
    scheme.addEventListener("change", retheme);
    return () => {
      scheme.removeEventListener("change", retheme);
      observer?.disconnect();
      typing?.dispose();
      detach();
      screen.dispose();
      terminal.current = undefined;
    };
  }, [props.terminals, props.terminalId, props.processes, props.processId, props.since, props.onEnded, readOnly]);

  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.disableStdin = readOnly || !enabled;
  }, [readOnly, enabled]);

  // A process keeps the host's 120-column grid, so a narrow panel scrolls
  // sideways rather than shrinking the font or the columns.
  return (
    <div className={readOnly ? "h-full min-h-0 w-full overflow-x-auto" : "h-full min-h-0 w-full"}>
      <div
        ref={container}
        className={readOnly ? "pinomad-terminal h-full min-h-0 w-max px-2 pt-1" : "pinomad-terminal h-full min-h-0 w-full px-2 pt-1"}
      />
    </div>
  );
}
