import { Collapsible } from "@base-ui-components/react/collapsible";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { ChatThoughtStep } from "@/shared/ui/chat/chat-thought-step";
import type { ChatToolItem } from "@/shared/ui/chat/chat-tool";
import { ChatOutcomeMeta, ChatToolStep, summarizeOutcome, summarizeTools } from "@/shared/ui/chat/chat-tool-step";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ChevronRight } from "@/shared/ui/icons";
import type { CotPhase, CotStep } from "@pinomad/client/cot-view.ts";
import { toolDisplayName } from "@pinomad/client/tool-item.ts";

/**
 * A settled run's duration as the number alone ("16s", "6m 0s"), for the end
 * of its last trace row. The number covers reasoning, issuing calls and
 * executing them — everything the user waited through before the answer
 * began (ADR-0030 §6). Unmeasured waits claim no number.
 */
export function formatElapsed(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }

  // Round to whole seconds first, then split: a 59.6s wait should read as
  // 1m 0s, not 60s, and a 59m 59.6s wait as 1h 0m 0s, not 60m 0s.
  const totalSeconds = Math.max(1, Math.round(ms / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

/** The running clock: tenths while it moves, so it visibly ticks. */
export function formatLiveElapsed(ms: number) {
  const total = Math.max(0, ms) / 1000;

  if (total < 60) {
    return `${total.toFixed(1)}s`;
  }

  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/**
 * One run's body in the transcript (ADR-0026): its trace rows and Interim
 * Output in Turn order. Nothing here unfolds by itself — each trace row is
 * the user's to open, live or settled — and nothing is added while the run
 * is live: the last row carries what is happening and the clock.
 */
type ChatChainOfThoughtOwnProps = {
  children?: ReactNode;
  phase: CotPhase;
};

export type ChatChainOfThoughtProps = Omit<
  ComponentProps<"div">,
  keyof ChatChainOfThoughtOwnProps
> &
  ChatChainOfThoughtOwnProps;

export function ChatChainOfThought({ children, className = "", phase, ...rest }: ChatChainOfThoughtProps) {
  if (phase === "hidden") {
    return null;
  }

  return (
    <div
      className={`chain-of-thought ${className}`.trim()}
      data-phase={phase}
      data-slot="chain-of-thought"
      {...rest}
    >
      {children}
    </div>
  );
}

type RunClock = {
  /** The Run's anchor; absent during a retry gap, and then there is no number. */
  startedAtMs?: number;
  /** Ticking until the answer's first token; then it holds that moment. */
  running: boolean;
};

/**
 * The Run's clock, walked here at 100ms so the page does not re-derive its
 * whole view that often. With no anchor there is no number: a clock started at
 * mount would report how long the page has been open (ADR-0030 §6). It stops
 * where the answer starts; a page that never saw it running (opened
 * mid-answer) does not know that moment and shows nothing.
 */
function TraceClock({ startedAtMs, running }: RunClock) {
  const [now, setNow] = useState(() => Date.now());
  const [sawRunning, setSawRunning] = useState(running);

  if (running && !sawRunning) {
    setSawRunning(true);
  }

  useEffect(() => {
    if (!running) {
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => {
      window.clearInterval(id);
      // Freeze on the moment the run stopped ticking, not the last tick.
      setNow(Date.now());
    };
  }, [running]);

  if (startedAtMs === undefined || !sawRunning) {
    return null;
  }

  return (
    <>
      {" "}
      <span className="chat-step__meta" data-slot="chat-trace-clock">
        · {formatLiveElapsed(now - startedAtMs)}
      </span>
    </>
  );
}

type TraceStep = Exclude<CotStep, { kind: "interim" }>;

type ChatTraceRowOwnProps = {
  /** The segment's thinking and tool steps, listed in order when opened. */
  steps: TraceStep[];
  /** The calls the summary counts — the caller leaves out what it reports elsewhere. */
  counted: ChatToolItem[];
  /** The run is in flight and this row is its last: it names the work in progress. */
  live?: boolean;
  /**
   * What the run is doing when no step in the row is: a model call between
   * rounds ("Thinking…"), or the whole row before the first step lands.
   */
  waiting?: string;
  /** Appended after a middle dot: the settled run's duration on its last row. */
  tail?: string;
  /** The live run's clock on its last row, in the place the settled duration takes. */
  clock?: RunClock;
};

export type ChatTraceRowProps = Omit<ComponentProps<"div">, keyof ChatTraceRowOwnProps | "children"> &
  ChatTraceRowOwnProps;

/** What the segment is doing right now: its live tail step, named as a step row would. */
function currentAction(steps: TraceStep[]) {
  const step = steps.findLast((each) => each.live);

  if (step?.kind === "thinking") {
    return "Thinking…";
  }
  if (step?.kind !== "tools") {
    return undefined;
  }

  const active = step.tools.find((tool) => tool.toolCallId === step.activeToolCallId) ?? step.tools[step.tools.length - 1];
  return active?.toolName ? `Running ${toolDisplayName(active.toolName)}…` : "Running…";
}

/**
 * The tool calls and thinking between two passages of Interim Output, folded
 * into one grey line: the burst's verbs summed over the whole segment, with
 * its diff stat and failures (ADR-0026 §2). Closed until the user opens it.
 */
export function ChatTraceRow({ className = "", clock, counted, live = false, steps, tail, waiting, ...rest }: ChatTraceRowProps) {
  // Past tense only for what has finished; whatever is still in flight is
  // named after it, the way a live step row names its running call.
  const finished = counted.filter((tool) => tool.state === "output-available" || tool.state === "output-error");
  const current = live ? (currentAction(steps) ?? waiting) : undefined;
  const thought = steps.some((step) => step.kind === "thinking" && !step.live);
  const label =
    finished.length > 0
      ? summarizeTools(finished)
      : current !== undefined
        ? undefined
        : thought
          ? "Thought"
          : // Only a todo_write that landed: the todo card says what changed.
            "Updated the todo list";

  const line = (
    <>
      {label === undefined ? null : <span className="chat-trace__label">{label}</span>}
      <ChatOutcomeMeta {...summarizeOutcome(finished)} />
      {current === undefined ? null : (
        <>
          {label === undefined ? null : (
            <>
              {" "}
              <span className="chat-step__meta">·</span>{" "}
            </>
          )}
          <TextShimmer className="chat-trace__label" data-slot="chat-trace-current">
            {current}
          </TextShimmer>
        </>
      )}
      {tail === undefined ? null : (
        <>
          {" "}
          <span className="chat-step__meta" data-slot="chat-trace-tail">
            · {tail}
          </span>
        </>
      )}
      {clock === undefined ? null : <TraceClock {...clock} />}
    </>
  );

  // Before the first step there is nothing to open: the row is a plain line.
  if (steps.length === 0) {
    return (
      <div className={`chat-trace ${className}`.trim()} data-slot="chat-trace" {...rest}>
        <p className="chain-of-thought__label">{line}</p>
      </div>
    );
  }

  return (
    <Collapsible.Root className={`chat-trace ${className}`.trim()} data-slot="chat-trace" {...rest}>
      <Collapsible.Trigger className="chain-of-thought__trigger" data-slot="chat-trace-trigger">
        {line}
        <ChevronRight aria-hidden="true" className="chat-step__chevron" />
      </Collapsible.Trigger>
      <Collapsible.Panel
        keepMounted
        className="chain-of-thought__content"
        data-slot="chain-of-thought-content"
      >
        <ol className="chain-of-thought__steps" data-slot="chain-of-thought-steps">
          {steps.map((step) => (
            <li key={step.id} className="chain-of-thought__step" data-slot="chain-of-thought-step">
              {step.kind === "thinking" ? <ChatThoughtStep step={step} /> : <ChatToolStep step={step} />}
            </li>
          ))}
        </ol>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
