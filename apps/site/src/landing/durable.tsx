import { Fragment, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { LandingCopy } from "./copy.tsx";

// The same task run twice, side by side, and one host crash that hits both. The
// run without checkpoints loses its finished calls and starts over; the Pi
// Durable run keeps them and redoes only the call that was cut off. The point is
// what survives, so the kept calls are what lights up after the restart.
//
// The markup is the finished story (after the restart, Pi Durable done, the other
// run back at step 2), so it reads before hydration and with reduced motion. When
// the demo starts below the first screen, the effect clears it and plays the
// story once it scrolls into view; Replay plays it again.

type Row = { step: number; end: "lost" | "kept" | "cut" | "done" | "running"; tag?: keyof LandingCopy["durable"]["tags"] };

// Rows before the divider are the first attempt, rows after it the second.
const BEFORE: Row["end"][] = ["done", "done", "done", "cut"];
const PLAIN: Row[] = [
  { step: 0, end: "lost", tag: "lost" },
  { step: 1, end: "lost", tag: "lost" },
  { step: 2, end: "lost", tag: "lost" },
  { step: 3, end: "cut", tag: "cut" },
  { step: 0, end: "done" },
  { step: 1, end: "running" },
];
const DURABLE: Row[] = [
  { step: 0, end: "kept", tag: "kept" },
  { step: 1, end: "kept", tag: "kept" },
  { step: 2, end: "kept", tag: "kept" },
  { step: 3, end: "cut", tag: "cut" },
  { step: 3, end: "done", tag: "rerun" },
  { step: 4, end: "done" },
];
const STATES = ["is-pending", "is-running", "is-done", "is-cut", "is-lost", "is-kept"] as const;
const BEAT = 850; // ms from a call starting to the next one starting

type Phase = "running" | "crashed" | "restarted" | "done";

export function DurableDemo({ t }: { t: LandingCopy["durable"] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const playRef = useRef<() => void>(undefined);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [phase, setPhase] = useState<Phase>("done");
  // Autoplay changes the status four times while someone scrolls past; only a
  // run the visitor asked for (Replay) is announced.
  const [announce, setAnnounce] = useState(false);

  // Everything below writes through classes, never a style prop, so the
  // prerendered page keeps its hash-only style-src.
  useEffect(() => {
    const root = rootRef.current!;
    const panes = [...root.querySelectorAll<HTMLElement>(".run-pane")];
    const rows = panes.map((pane) => [...pane.querySelectorAll<HTMLElement>(".run-row")]);
    const dividers = panes.map((pane) => pane.querySelector<HTMLElement>(".run-divider")!);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const at = (ms: number, fn: () => void) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };
    const set = (row: HTMLElement, state: (typeof STATES)[number]) => {
      row.classList.remove(...STATES);
      row.classList.add(state);
    };
    // The same row index in both panes: the first attempt is identical in both.
    const both = (i: number, state: (typeof STATES)[number]) => {
      for (const pane of rows) set(pane[i]!, state);
    };

    function play() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      for (const pane of rows) for (const row of pane) set(row, "is-pending");
      for (const divider of dividers) divider.classList.add("is-pending");
      root.classList.remove("is-offline");
      setPlaying(true);
      setPhase("running");

      // First attempt: three calls finish, the fourth is in flight when the host dies.
      BEFORE.forEach((end, i) => {
        at(300 + i * BEAT, () => both(i, "is-running"));
        if (end === "done") at(300 + i * BEAT + BEAT * 0.7, () => both(i, "is-done"));
      });
      const crash = 300 + 3 * BEAT + BEAT;
      at(crash, () => {
        both(3, "is-cut");
        root.classList.add("is-offline");
        setPhase("crashed");
      });

      // Restart: the plain run's finished calls are gone, Pi Durable's are still there.
      const restart = crash + 1600;
      at(restart, () => {
        root.classList.remove("is-offline");
        for (const divider of dividers) divider.classList.remove("is-pending");
        for (let i = 0; i < 3; i += 1) {
          set(rows[0]![i]!, "is-lost");
          set(rows[1]![i]!, "is-kept");
        }
        setPhase("restarted");
      });

      // Second attempt, both panes in step: rows 4 and 5.
      const resume = restart + 1100;
      for (let i = 4; i < 6; i += 1) {
        const start = resume + (i - 4) * BEAT;
        at(start, () => both(i, "is-running"));
        for (const [p, pane] of [PLAIN, DURABLE].entries()) {
          if (pane[i]!.end === "done") at(start + BEAT * 0.7, () => set(rows[p]![i]!, "is-done"));
        }
      }
      at(resume + 2 * BEAT, () => {
        setPhase("done");
        setPlaying(false);
      });
    }

    playRef.current = play;
    setReady(true);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Only clear the finished story while it's off screen, so nothing visible jumps.
    let observer: IntersectionObserver | undefined;
    if (panes[1]!.getBoundingClientRect().top >= innerHeight) {
      for (const pane of rows) for (const row of pane) set(row, "is-pending");
      for (const divider of dividers) divider.classList.add("is-pending");
      observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          observer?.disconnect();
          play();
        },
        { threshold: 0.5 },
      );
      // The Pi Durable pane: beside the other on wide screens, below it on phones,
      // so once it's half in view the whole story is.
      observer.observe(panes[1]!);
    }

    return () => {
      observer?.disconnect();
      for (const id of timers) clearTimeout(id);
    };
  }, []);

  return (
    <div className="durable-demo" ref={rootRef}>
      <p className="visually-hidden">{t.description}</p>
      <div className="run-host" aria-hidden="true">
        <span className="host-dot" />
        <span className="host-state host-up">{t.host.up}</span>
        <span className="host-state host-down">{t.host.down}</span>
      </div>
      <div className="runs" aria-hidden="true">
        <RunPane t={t} label={t.plain} rows={PLAIN} restart={t.restartPlain} />
        <RunPane t={t} label={t.durable} rows={DURABLE} restart={t.restartDurable} durable />
        <div className="run-crash">
          <svg viewBox="0 0 16 16" focusable="false">
            <path d="M9.5 1 L3 9 H7.5 L6.5 15 L13 7 H8.5 Z" />
          </svg>
          {t.host.down}
        </div>
      </div>
      <div className="diagram-controls">
        <Button
          size="sm"
          variant="quiet"
          hidden={!ready}
          disabled={playing}
          onClick={() => {
            setAnnounce(true);
            playRef.current?.();
          }}
        >
          {t.replay}
        </Button>
        <p className="diagram-status" aria-live={announce ? "polite" : "off"}>
          {t.status[phase]}
        </p>
      </div>
    </div>
  );
}

function RunPane({ t, label, rows, restart, durable }: { t: LandingCopy["durable"]; label: string; rows: Row[]; restart: string; durable?: boolean }) {
  return (
    <figure className={durable ? "run-pane run-durable" : "run-pane"}>
      <figcaption className="run-label">{label}</figcaption>
      <ol className="run-rows">
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i === 4 && <li className="run-divider">{restart}</li>}
            <li className={`run-row is-${row.end}`}>
              <RunMark />
              <span className="run-tool">{t.steps[row.step]!.tool}</span>
              <span className="run-detail">{t.steps[row.step]!.detail}</span>
              {row.tag && <span className={`run-tag tag-${row.tag}`}>{t.tags[row.tag]}</span>}
            </li>
          </Fragment>
        ))}
      </ol>
    </figure>
  );
}

/** All three marks are drawn; the row's state class shows one. */
function RunMark() {
  return (
    <svg className="run-mark" viewBox="0 0 16 16" focusable="false">
      <circle className="mark-spin" cx="8" cy="8" r="6" />
      <path className="mark-done" d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />
      <path className="mark-cut" d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5" />
    </svg>
  );
}
