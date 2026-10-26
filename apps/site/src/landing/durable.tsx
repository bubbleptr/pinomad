import { type Ref, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import type { LandingCopy } from "./copy.tsx";

// One run as a track: each finished model or tool call plants a flag (a Pi
// Durable checkpoint). The markup is the finished story, a crash between two
// steps and the run resuming from the last flag, so it reads before hydration;
// the effect turns it into a run the visitor can start and pull the plug on.
// The run resumes from the last flag it planted, never from the crash point and
// never from the start once a flag is down: that's the claim the diagram makes.

const FLAGS = [120, 240, 360, 480, 600, 720, 840];
const STEPS = ["model", "bash", "model", "edit", "model", "bash", "model"] as const;
const START = 60;
const END = 900;
const SPEED = 0.11; // viewBox units per ms: about 7.6 s for the whole run
const BOLT_X = 664;

type Phase = "idle" | "running" | "crashed" | "done";

export function DurableDemo({ t }: { t: LandingCopy["durable"] }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const clickRef = useRef<() => void>(undefined);
  const [ready, setReady] = useState(false);
  const [label, setLabel] = useState(t.start);
  const [status, setStatus] = useState("");
  const [disabled, setDisabled] = useState(false);

  // Everything below writes through classes, SVG attributes, and the CSSOM
  // (el.style.x = …): allowed under the page's style-src 'self', unlike a
  // style prop, which the prerender would write out as style="".
  useEffect(() => {
    const svg = svgRef.current!;
    const scroller = scrollerRef.current!;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const find = <T extends Element>(selector: string) => svg.querySelector<T>(selector)!;
    const runner = find<SVGGElement>(".runner");
    const trail = find<SVGPathElement>(".trail");
    const crash = find<SVGGElement>(".crash");
    const resume = find<SVGGElement>(".resume");
    const resumeArc = find<SVGPathElement>(".resume-arc");
    const resumeHead = find<SVGPathElement>(".resume-head");
    const resumeNote = find<SVGTextElement>(".resume .art-note");
    const flags = [...svg.querySelectorAll<SVGGElement>(".flag")].map((el, i) => ({ el, x: FLAGS[i]! }));

    let phase: Phase = "idle";
    let x = END;
    let planted = 0;
    let crashes = 0;
    let last = 0;
    let frame = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    // Keep the runner in view when the diagram is wider than its scroller (phones).
    function follow(at: number) {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      const box = svg.viewBox.baseVal;
      scroller.scrollLeft = (at / box.width) * svg.clientWidth - scroller.clientWidth / 2;
    }

    function lastFlagX() {
      return planted ? flags[planted - 1]!.x : START;
    }

    // With reduced motion the runner steps from flag to flag instead of gliding.
    function place() {
      const shown = reduceMotion.matches && x < END ? lastFlagX() : x;
      runner.style.transform = `translateX(${shown}px)`;
      trail.style.strokeDashoffset = String(END - shown);
      follow(shown);
    }

    function tick(now: number) {
      x = Math.min(END, x + (now - last) * SPEED);
      last = now;
      while (planted < flags.length && x >= flags[planted]!.x) {
        flags[planted]!.el.classList.remove("is-down");
        planted += 1;
      }
      place();
      if (x >= END) finish();
      else frame = requestAnimationFrame(tick);
    }

    function run() {
      phase = "running";
      setLabel(t.pull);
      setDisabled(false);
      setStatus(t.running);
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }

    function start() {
      x = START;
      planted = 0;
      crashes = 0;
      for (const flag of flags) flag.el.classList.add("is-down");
      crash.classList.add("is-hidden");
      resume.classList.add("is-hidden");
      runner.classList.remove("is-down");
      place();
      run();
    }

    function pull() {
      cancelAnimationFrame(frame);
      phase = "crashed";
      crashes += 1;
      setDisabled(true);
      setStatus(t.crashed);

      const crashX = x;
      const resumeX = lastFlagX();
      crash.style.transform = `translateX(${crashX - BOLT_X}px)`;
      crash.classList.remove("is-hidden");
      resume.classList.add("is-hidden");
      runner.classList.add("is-down");
      trail.classList.add("is-retracting");
      trail.style.strokeDashoffset = String(END - resumeX);

      later(() => {
        trail.classList.remove("is-retracting");
        resumeArc.setAttribute("d", `M${crashX} 232 C ${crashX - 8} 270, ${resumeX + 8} 270, ${resumeX + 2} 236`);
        resumeHead.setAttribute("d", `M${resumeX - 4} 244 L ${resumeX + 2} 233 L ${resumeX + 11} 242`);
        resumeNote.setAttribute("x", String((crashX + resumeX) / 2));
        resume.classList.toggle("is-hidden", crashX - resumeX < 4);
        x = resumeX;
        place();
        runner.classList.remove("is-down");
        setStatus(planted ? t.resumed(planted) : t.restartedEmpty);
        later(run, 900);
      }, 1100);
    }

    function finish() {
      phase = "done";
      setLabel(t.again);
      setStatus(crashes ? t.done : t.doneClean);
    }

    clickRef.current = () => {
      if (phase === "running") pull();
      else if (phase !== "crashed") start();
    };
    follow(640); // phones: open on the crash, the point of the story
    setReady(true);
    setLabel(t.start);
    setDisabled(false);
    setStatus(t.idle);

    return () => {
      cancelAnimationFrame(frame);
      for (const id of timers) clearTimeout(id);
    };
  }, [t]);

  return (
    <div className="durable-demo">
      <div className="diagram-scroll" ref={scrollerRef}>
        <DurableArt t={t} svgRef={svgRef} />
      </div>
      <p className="visually-hidden">{t.description}</p>
      <div className="diagram-controls">
        <Button size="sm" hidden={!ready} disabled={disabled} onClick={() => clickRef.current?.()}>
          {label}
        </Button>
        <p className="diagram-status" aria-live="polite">
          {status}
        </p>
      </div>
    </div>
  );
}

function DurableArt({ t, svgRef }: { t: LandingCopy["durable"]; svgRef: Ref<SVGSVGElement> }) {
  return (
    <svg ref={svgRef} className="durable-art" viewBox="0 56 960 248" aria-hidden="true" focusable="false">
      <path className="track" d="M60 180 H 900" />
      <circle className="start-cap" cx="60" cy="180" r="6" />
      <path className="trail" d="M60 180 H 900" />

      <g className="flags">
        {FLAGS.map((x) => (
          <g key={x} className="flag">
            <path className="flag-pole" d={`M${x} 170 V 118`} />
            <path className="flag-cloth" d={`M${x} 118 L ${x + 26} 127 L ${x} 136 Z`} />
          </g>
        ))}
      </g>

      <g className="nodes">
        {FLAGS.map((x) => (
          <circle key={x} cx={x} cy="180" r="7" />
        ))}
      </g>
      <g className="finish">
        <circle cx="900" cy="180" r="12" />
        <path d="M894 180 l4.5 4.5 l8 -9" />
      </g>

      <g className="node-labels">
        {FLAGS.map((x, i) => (
          <text key={x} x={x} y="214">
            {STEPS[i] === "model" ? t.model : STEPS[i]}
          </text>
        ))}
      </g>

      {/* Crash mark and resume arc; the effect moves them to where the plug was pulled. */}
      <g className="crash">
        <path className="bolt" d="M668 96 L 650 134 L 662 134 L 646 172 L 682 124 L 669 124 L 682 96 Z" />
        <text className="art-note" x="664" y="80">
          {t.crash}
        </text>
      </g>
      <g className="resume">
        <path className="resume-arc" d="M660 232 C 652 270, 610 270, 602 236" />
        <path className="resume-head" d="M596 244 L 602 233 L 611 242" />
        <text className="art-note" x="630" y="294">
          {t.resume}
        </text>
      </g>

      <g className="runner">
        <circle className="runner-halo" cx="0" cy="180" r="15" />
        <circle className="runner-dot" cx="0" cy="180" r="8" />
      </g>
    </svg>
  );
}
