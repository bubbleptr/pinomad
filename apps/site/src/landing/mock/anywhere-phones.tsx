import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { type AnywhereContent, anywhereContent, type DiffLine, type PhoneBlock, type Question } from "./anywhere-content.ts";
import { useClock } from "./clock.ts";
import { mockContent } from "./content.ts";
import { iosIcons, ModelLogo } from "./icons.tsx";
import { elapsedText } from "./runs.ts";

// "Away from your desk", drawn in HTML: two screens of the iPhone app in dark mode.
// Behind, the home list, a group per machine. In front, omarchy's conversation at
// the step the section's buttons pick: the task as sent, the agent's question card
// (answerable; Submit moves on to the diff), or a file from its Changes.
//
// Sizes are iOS points: --p is one point of a 402pt-wide iPhone 17 Pro screen,
// measured off simulator screenshots of the app's demo modes. The status bar is left
// out. Everything is prerendered; script only ticks the live label's clock.

export const STEPS = ["start", "ask", "review"] as const;
export type Step = (typeof STEPS)[number];

/** omarchy's conversation in the hero, the one the phone follows. */
const CHAT = "api";

/** A single-choice tap moves on after this long, as in the app. */
const ADVANCE_MS = 250;

export function AnywherePhones({
  lang,
  step,
  label,
  onStep,
}: {
  lang: Lang;
  step: Step;
  label: string;
  onStep: (step: Step) => void;
}) {
  const content = anywhereContent[lang];
  const machines = mockContent[lang].machines;
  const chats = machines.flatMap((machine) => machine.projects.flatMap((project) => project.chats));
  const title = chats.find((chat) => chat.id === CHAT)!.title;
  const ref = useRef<HTMLElement>(null);
  const clock = useClock(ref);
  // Waiting on you, the conversation counts as needing an answer, not running.
  const asking = step === "ask" ? 1 : 0;
  const running = chats.filter((chat) => chat.running).length - asking;

  return (
    <figure className="phones" ref={ref} aria-label={label}>
      <div className="ios ios-back" aria-hidden="true">
        <div className="ios-screen">
          <div className="ios-nav">
            <span className="ios-glass">{iosIcons.userRound}</span>
            <span className="ios-grow" />
            <span className="ios-glass">{iosIcons.settings}</span>
          </div>
          <div className="ios-tiles">
            <Tile tint="indigo" icon={iosIcons.inbox} title="All" />
            <Tile tint="orange" icon={iosIcons.bellCheck} title="Needs Answer" count={asking} />
            <Tile tint="green" icon={iosIcons.circleDashed} title="Running" count={running} />
            <Tile tint="red" icon={iosIcons.ban} title="Failed" count={0} />
          </div>
          {machines.map((machine) => (
            <div className="ios-machine" key={machine.name}>
              <div className="ios-machine-head">
                {iosIcons.monitor}
                <span>{machine.name}</span>
                <i className="ios-online" />
              </div>
              {machine.projects.map((project) => (
                <div className="ios-row" key={project.name}>
                  {iosIcons.folder}
                  <span className="ios-grow">{project.name}</span>
                  <span className="ios-count">{project.chats.length}</span>
                  {iosIcons.chevronRight}
                </div>
              ))}
              <div className="ios-row ios-add">
                {iosIcons.plus}
                <span className="ios-grow">Add project</span>
              </div>
            </div>
          ))}
          <div className="ios-bottom">
            <span className="ios-glass ios-search">
              {iosIcons.search}
              Search conversations
            </span>
            <span className="ios-glass">{iosIcons.squarePen}</span>
          </div>
        </div>
      </div>

      <div className="ios ios-front">
        <div className="ios-screen" key={step}>
          {step === "review" ? (
            <DiffScreen file={content.file} />
          ) : (
            <ChatScreen
              title={title}
              content={content}
              step={step}
              clock={clock}
              onSubmit={() => onStep("review")}
            />
          )}
        </div>
      </div>
    </figure>
  );
}

function Tile({ tint, icon, title, count }: { tint: string; icon: ReactNode; title: string; count?: number }) {
  return (
    <div className="ios-tile" data-tint={tint}>
      {icon}
      <span>
        {title}
        {count === undefined ? null : <span className="ios-count"> {count}</span>}
      </span>
    </div>
  );
}

function Nav({ title, trailing }: { title: string; trailing?: ReactNode }) {
  return (
    <div className="ios-nav" aria-hidden="true">
      <span className="ios-glass">{iosIcons.chevronLeft}</span>
      <span className="ios-title">{title}</span>
      {trailing === undefined ? <span className="ios-gap" /> : <span className="ios-glass">{trailing}</span>}
    </div>
  );
}

function ChatScreen({
  title,
  content,
  step,
  clock,
  onSubmit,
}: {
  title: string;
  content: AnywhereContent;
  step: "start" | "ask";
  clock: number;
  onSubmit: () => void;
}) {
  const blocks = step === "start" ? content.start : content.ask;
  const busy = step === "start";
  return (
    <>
      <Nav title={title} trailing={iosIcons.layoutGridCircles} />
      <div className="ios-transcript" aria-hidden="true">
        {blocks.map((block, index) => (
          <BlockView key={index} block={block} clock={clock} />
        ))}
      </div>
      {step === "ask" ? <QuestionCard questions={content.questions} onSubmit={onSubmit} /> : null}
      <div className="ios-composer" aria-hidden="true">
        <span className="ios-placeholder">{busy ? "Add a follow-up…" : "Ask"}</span>
        <div className="ios-composer-bar">
          <span className="ios-round">{iosIcons.plus}</span>
          <span className="ios-capsule">
            <ModelLogo model="claude" />
            Claude Opus 5.5
            {iosIcons.chevronDown}
          </span>
          <span className="ios-grow" />
          <span className="ios-round ios-send" data-busy={busy || undefined}>
            {busy ? <i className="ios-stop" /> : iosIcons.arrowUp}
          </span>
        </div>
      </div>
    </>
  );
}

function BlockView({ block, clock }: { block: PhoneBlock; clock: number }) {
  switch (block.kind) {
    case "user":
      return (
        <div className="ios-sent">
          <p className="ios-bubble">{block.text}</p>
          {iosIcons.checkCheck}
        </div>
      );
    case "worked":
      return (
        <p className="ios-step">
          {iosIcons.circleCheck}
          <b>Worked</b>
          <span>
            {elapsedText(block.seconds)} · {block.tools} tools
          </span>
          {iosIcons.chevronRight}
        </p>
      );
    case "text":
      return (
        <div className="ios-reply">
          <p>{block.text}</p>
          {iosIcons.copy}
        </div>
      );
    case "trace":
      return (
        <p className="ios-step">
          <b className="mock-shimmer">{block.label}</b>
          <span>{elapsedText(block.since + clock)}</span>
          {iosIcons.chevronRight}
        </p>
      );
  }
}

/**
 * The agent's questions, a page each, as QuestionCards.swift draws them: a tap on a
 * single-choice option moves on by itself; the last page offers Submit.
 */
function QuestionCard({ questions, onSubmit }: { questions: Question[]; onSubmit: () => void }) {
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<(number | undefined)[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const question = questions[page]!;
  const last = page === questions.length - 1;
  const answered = picked[page] !== undefined;
  const all = questions.every((_, index) => picked[index] !== undefined);

  const pick = (option: number) => {
    setPicked((current) => {
      const next = [...current];
      next[page] = option;
      return next;
    });
    clearTimeout(timer.current);
    if (!last) timer.current = setTimeout(() => setPage(page + 1), ADVANCE_MS);
  };

  return (
    <div className="ios-card">
      <p className="ios-question">{question.question}</p>
      <div className="ios-options" role="radiogroup" aria-label={question.question}>
        {question.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={picked[page] === index}
            className="ios-option"
            onClick={() => pick(index)}
          >
            {picked[page] === index ? iosIcons.circleDot : iosIcons.circle}
            <span>
              {option.label}
              <small>{option.detail}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="ios-card-foot">
        <span className="ios-side">
          {page > 0 ? (
            <button type="button" className="ios-plain" onClick={() => setPage(page - 1)}>
              Back
            </button>
          ) : null}
        </span>
        <span className="ios-segments" aria-hidden="true">
          {questions.map((_, index) => (
            <i
              key={index}
              data-state={picked[index] !== undefined ? "answered" : index === page ? "current" : undefined}
            />
          ))}
        </span>
        <span className="ios-side ios-end">
          {last || all ? (
            <button type="button" className="ios-primary" onClick={onSubmit}>
              Submit
            </button>
          ) : answered ? (
            <button type="button" className="ios-secondary" onClick={() => setPage(page + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="ios-plain" onClick={() => setPage(page + 1)}>
              Skip
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function DiffScreen({ file }: { file: { path: string; lines: DiffLine[] } }) {
  return (
    <>
      <Nav title={file.path.split("/").pop()!} />
      <pre className="ios-diff" aria-hidden="true">
        {file.lines.map((line, index) => (
          <span key={index} data-kind={line.kind}>
            {line.text}
          </span>
        ))}
      </pre>
    </>
  );
}
