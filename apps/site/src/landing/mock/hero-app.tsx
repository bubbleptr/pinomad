import { type RefObject, useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { type Block, type Chat, type Inline, type Machine, mockContent } from "./content.ts";
import { icons, ModelLogo } from "./icons.tsx";
import { elapsedText, runAt, type Run } from "./runs.ts";

// The hero's product shot, drawn in HTML: the Mac app with two machines in its
// sidebar, and in front of it the same conversation open in a browser on another
// device. The sidebar's conversations switch the app's main column.
//
// Everything is prerendered, so the first frame is the whole picture with or without
// JS. The entrance (cards, the browser window, the machine that restarts) is CSS
// keyframes in mock.css, under prefers-reduced-motion: no-preference; script only
// ticks the cards' timers. Sizes are in em off the figure's width (mock.css), so the
// windows scale like a screenshot would.

const RUNNING = "Steer the running turn…";
const IDLE = "Ask · @ agent or file · / command · $ skill";

/**
 * Seconds the hero has been on screen: paused while it's scrolled away, and 0 for
 * good under reduced motion, which is also the prerendered value.
 */
function useClock(ref: RefObject<HTMLElement | null>) {
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry?.isIntersecting) timer = setInterval(() => setClock((seconds) => seconds + 1), 1000);
    });
    observer.observe(ref.current!);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [ref]);
  return clock;
}

export function HeroApp({ lang, label }: { lang: Lang; label: string }) {
  const content = mockContent[lang];
  const chats = content.machines.flatMap((machine) => machine.projects.flatMap((project) => project.chats));
  const ref = useRef<HTMLElement>(null);
  const clock = useClock(ref);
  const [shown, setShown] = useState(content.defaultChat);
  // The entrance plays once; switching conversations remounts the column, and
  // without this the cards would animate in again.
  const [switched, setSwitched] = useState(false);
  const chat = chats.find((each) => each.id === shown)!;
  const aside = content.aside;

  return (
    <figure className="hero-shot mock" ref={ref} aria-label={label} data-switched={switched || undefined}>
      <div className="mock-app mock-scale">
        <div className="mock-sidebar">
          <div className="mock-band">
            <span className="mock-lights" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {icons.panelLeft}
          </div>
          <div className="mock-row mock-new">
            {icons.newChat}
            New chat
          </div>
          {content.machines.map((machine) => (
            <MachineGroup
              key={machine.name}
              machine={machine}
              shown={shown}
              clock={clock}
              note={machine.restarts ? content.restarted : undefined}
              onOpen={(id) => {
                setSwitched(true);
                setShown(id);
              }}
            />
          ))}
          <div className="mock-foot">
            <span>MacBook Pro</span>
            {icons.monitor}
            {icons.settings}
          </div>
        </div>
        <div className="mock-main">
          <div className="mock-head">
            <span className="mock-title">{chat.title}</span>
            {icons.tasks}
            {icons.panelRight}
          </div>
          <Transcript key={chat.id} chat={chat} clock={clock} />
          <Composer running={chat.running} model="claude" modelName="Claude Opus 5.5 · High" />
        </div>
      </div>

      <div className="mock-browser mock-scale" aria-hidden="true" data-away={shown !== content.defaultChat || undefined}>
        <div className="mock-chrome">
          <span className="mock-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="mock-url">
            {icons.lock}
            {content.url}
          </span>
        </div>
        <div className="mock-head">
          {icons.panelLeft}
          <span className="mock-title">{aside.title}</span>
          <span className="mock-agent">
            <ModelLogo model={aside.model} />@{aside.agent}
          </span>
        </div>
        <Transcript chat={{ id: "aside", title: aside.title, blocks: aside.blocks }} clock={clock} />
      </div>
    </figure>
  );
}

function MachineGroup({
  machine,
  shown,
  clock,
  note,
  onOpen,
}: {
  machine: Machine;
  shown: string;
  clock: number;
  note?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="mock-machine" data-restarts={machine.restarts || undefined}>
      <div className="mock-machine-name">{machine.name}</div>
      {machine.projects.map((project) => (
        <div key={project.name}>
          <div className="mock-row">
            {icons.folder}
            <span className="mock-grow">{project.name}</span>
            {icons.chevronUp}
          </div>
          {project.chats.map((chat) => {
            const runs = chat.blocks.flatMap((block) => (block.kind === "agents" ? block.runs : []));
            const children = runs.filter((run) => chat.running || runAt(run, clock).status === "running");
            return (
              <div key={chat.id}>
                <button
                  type="button"
                  className="mock-row mock-chat"
                  aria-pressed={chat.id === shown}
                  onClick={() => onOpen(chat.id)}
                >
                  <Dot running={chat.running} />
                  <span className="mock-grow">{chat.title}</span>
                  {children.length === 0 ? null : icons.chevronUp}
                </button>
                {children.length === 0 ? null : (
                  <div className="mock-family">
                    {children.map((run) => (
                      <div className="mock-row mock-child" key={run.title}>
                        <ModelLogo model={run.model} />
                        <span className="mock-grow">{run.title}</span>
                        {runAt(run, clock).status === "running" ? <Dot running /> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {note === undefined ? null : (
        <p className="mock-note" aria-hidden="true">
          {note}
        </p>
      )}
    </div>
  );
}

function Dot({ running }: { running?: boolean }) {
  return <span className="mock-dot" data-running={running || undefined} />;
}

function Transcript({ chat, clock }: { chat: Chat; clock: number }) {
  return (
    <div className="mock-scroll">
      <div className="mock-column">
        {chat.blocks.map((block, index) => (
          <BlockView key={index} block={block} clock={clock} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block, clock }: { block: Block; clock: number }) {
  switch (block.kind) {
    case "user":
      return <p className="mock-user">{block.text}</p>;
    case "text":
      return (
        <p className="mock-text">
          <Parts parts={block.parts} />
        </p>
      );
    case "tools":
      return (
        <p className="mock-tools">
          {block.summary}
          {block.added === undefined ? null : <span className="mock-added"> +{block.added}</span>}
          {block.removed === undefined ? null : <span className="mock-removed"> -{block.removed}</span>}
          {block.seconds === undefined ? null : ` · ${elapsedText(block.seconds)}`}
          {icons.chevronRight}
        </p>
      );
    case "trace":
      return (
        <p className="mock-tools">
          <span className="mock-shimmer">{block.label}</span>
          {` · ${elapsedText(block.since + clock)}`}
        </p>
      );
    case "agents":
      return (
        <div className="mock-cards">
          {block.runs.map((run) => (
            <Card key={run.title} run={run} clock={clock} />
          ))}
        </div>
      );
  }
}

function Parts({ parts }: { parts: Inline[] }) {
  return parts.map((part, index) => (typeof part === "string" ? part : <code key={index}>{part.code}</code>));
}

function Card({ run, clock }: { run: Run; clock: number }) {
  const state = runAt(run, clock);
  const running = state.status === "running";
  return (
    <div className="mock-card">
      <div className="mock-card-head">
        <Dot running={running} />
        <span className="mock-grow">{run.title}</span>
        <span className="mock-button">View</span>
      </div>
      <div className="mock-meta">
        {running ? "Running" : "Done"} · @{run.agent} · {run.modelId} · {elapsedText(state.seconds)}
      </div>
      {running && run.activity !== undefined ? <div className="mock-meta">→ {run.activity}</div> : null}
    </div>
  );
}

function Composer({ running, model, modelName }: { running?: boolean; model: "claude"; modelName: string }) {
  return (
    <div className="mock-composer">
      <span className="mock-placeholder">{running ? RUNNING : IDLE}</span>
      <div className="mock-composer-bar">
        {icons.plus}
        <ModelLogo model={model} />
        <span className="mock-grow">{modelName}</span>
        <span className="mock-send" data-running={running || undefined}>
          {running ? icons.stop : icons.send}
        </span>
      </div>
    </div>
  );
}
