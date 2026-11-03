// One terminal's screen (ADR-0041), loaded on first use: xterm.js fed from
// the host's output stream. A `reset` clears the screen before the replay;
// typing goes straight to the host; the fitted size goes to the host whenever
// it changes. Colors come from the app's tokens and follow light and dark.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { RemoteTerminals } from "@pinomad/protocol/remote-durable.ts";
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

function themeFor(element: HTMLElement): ITheme {
  const foreground = resolveColor(element, "var(--foreground)");
  return {
    ...(matchMedia(DARK).matches ? ANSI_DARK : ANSI_LIGHT),
    background: resolveColor(element, "var(--background)"),
    foreground,
    cursor: foreground,
    cursorAccent: resolveColor(element, "var(--background)"),
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

export default function XtermView({
  terminals,
  terminalId,
  enabled,
}: {
  terminals: Pick<RemoteTerminals, "attach" | "input" | "resize">;
  terminalId: TerminalId;
  /** Off while disconnected or after the process exited: keys go nowhere. */
  enabled: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(undefined);

  useEffect(() => {
    const element = container.current!;
    const screen = new Terminal({
      fontFamily: getComputedStyle(element).getPropertyValue("--font-family-code").trim() || "monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFor(element),
    });
    const fit = new FitAddon();
    screen.loadAddon(fit);
    screen.open(element);
    terminal.current = screen;

    let sent: TerminalSize | undefined;
    const fitNow = (): void => {
      // A hidden panel measures as zero; its size stays what the host has.
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
      if (sent?.cols === screen.cols && sent.rows === screen.rows) return;
      sent = { cols: screen.cols, rows: screen.rows };
      terminals.resize(terminalId, sent);
    };
    const detach = terminals.attach(terminalId, {
      output: (data, reset) => writeOutput(screen, data, reset),
      ended: () => {},
    });
    // After attach: the client keeps an attached terminal's size to send
    // again after a reconnect, and the replay doesn't wait on the size.
    fitNow();
    const typing = screen.onData((data) => terminals.input(terminalId, data));
    const observer = new ResizeObserver(fitNow);
    observer.observe(element);
    const scheme = matchMedia(DARK);
    const retheme = (): void => {
      screen.options.theme = themeFor(element);
    };
    scheme.addEventListener("change", retheme);
    screen.focus();
    return () => {
      scheme.removeEventListener("change", retheme);
      observer.disconnect();
      typing.dispose();
      detach();
      screen.dispose();
      terminal.current = undefined;
    };
  }, [terminals, terminalId]);

  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.disableStdin = !enabled;
  }, [enabled]);

  return <div ref={container} className="pinomad-terminal h-full min-h-0 w-full px-2 pt-1" />;
}
