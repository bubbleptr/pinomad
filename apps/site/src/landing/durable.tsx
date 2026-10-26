import type { LandingCopy } from "./copy.tsx";
import { Card, Drawing, Icon, Shown, TitleBar, useMotion } from "./diagrams.tsx";

// The same task run twice, in two windows on one clock, and one host crash that
// hits both. Pi Durable flags a checkpoint after every call; after the restart
// the plain run's finished calls are struck out and it starts over, while the
// Pi Durable run keeps its flagged calls and reruns only the one that was cut off.
// No captions: the card's body text says what happens, the drawing shows it.
//
// One loop of LOOP seconds, times below in seconds. Rows appear when they start
// and stay until END, then the windows empty and the story plays again. Under
// reduced motion the clock holds at STILL, the finished story.

const LOOP = 14;
const END = 12.6;
const STILL = 12;
const CRASH = 3.6;
const RESTART = 5;

type Row = { step: number; run: number; done?: number; cut?: number; lost?: number; kept?: number };

// Rows before the divider are the first attempt, the rest the second.
const PLAIN: Row[] = [
  { step: 0, run: 0.4, done: 1.2, lost: RESTART },
  { step: 1, run: 1.2, done: 2, lost: RESTART },
  { step: 2, run: 2, done: 2.8, lost: RESTART },
  { step: 3, run: 2.8, cut: CRASH },
  { step: 0, run: 5.2, done: 6 },
  { step: 1, run: 6 },
];
const DURABLE: Row[] = [
  { step: 0, run: 0.4, done: 1.2, kept: RESTART },
  { step: 1, run: 1.2, done: 2, kept: RESTART },
  { step: 2, run: 2, done: 2.8, kept: RESTART },
  { step: 3, run: 2.8, cut: CRASH },
  { step: 3, run: 5.2, done: 6 },
  { step: 4, run: 6, done: 6.8 },
];

const loop = { dur: `${LOOP}s`, fade: 0.012 };
/** Shown from `from` seconds until `to` (END by default). */
const at = (from: number, to = END) => <Shown {...loop} from={from / LOOP} to={to / LOOP} />;

const ROW = 28;
const TOP = 42;
const slot = (i: number) => TOP + (i < 4 ? i : i + 1) * ROW;

export function DurableDiagram({ t }: { t: LandingCopy["durable"] }) {
  const ref = useMotion<HTMLElement>(STILL);
  return (
    <figure className="diagram durable-diagram" ref={ref} role="img" aria-label={t.description}>
      <RunWindow t={t} title={t.plain} rows={PLAIN} />
      <RunWindow t={t} title={t.durable} rows={DURABLE} durable />
    </figure>
  );
}

function RunWindow({ t, title, rows, durable }: { t: LandingCopy["durable"]; title: string; rows: Row[]; durable?: boolean }) {
  const divider = TOP + 4 * ROW + ROW / 2;
  return (
    <Drawing height={254}>
      <Card x={10} y={8} w={340} h={238} r={14} />
      <TitleBar x={10} y={8} w={340} title={title} />
      <circle className="dg-live" cx="334" cy="21" r="3.5" />
      <circle className="dg-down" cx="334" cy="21" r="3.5" opacity="0">
        {at(CRASH, RESTART)}
      </circle>

      {rows.map((row, i) => (
        <RunRow key={i} y={slot(i)} row={row} step={t.steps[row.step]!} durable={durable} />
      ))}

      <g opacity="0">
        {at(RESTART)}
        <path className="dg-line dg-planned" d={`M24 ${divider}H164M196 ${divider}H336`} />
        <Icon name="restart" x={172} y={divider - 8} size={16} />
      </g>

      {/* The crash: everything in the window goes dark under one badge. */}
      <g opacity="0">
        {at(CRASH, RESTART)}
        <rect className="dg-veil is-heavy" x="11" y="35" width="338" height="210" rx="13" />
        <circle className="dg-alarm" cx="180" cy="98" r="22" />
        <Icon name="bolt" x={169} y={87} size={22} className="dg-icon is-alarm" />
      </g>
    </Drawing>
  );
}

function RunRow({ y, row, step, durable }: { y: number; row: Row; step: { tool: string; detail: string }; durable?: boolean }) {
  const mid = y + ROW / 2;
  const settled = row.done ?? row.cut ?? END;
  return (
    <g opacity="0">
      {at(row.run)}
      {row.kept !== undefined && (
        <rect className="dg-kept" x="18" y={y + 2} width="324" height={ROW - 4} rx="7" opacity="0">
          {at(row.kept)}
        </rect>
      )}
      <g opacity="0">
        {at(row.run, settled)}
        <g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`0 32 ${mid}`}
            to={`360 32 ${mid}`}
            dur="0.9s"
            repeatCount="indefinite"
          />
          <Icon name="loader" x={24} y={mid - 8} size={16} className="dg-icon is-lit" />
        </g>
      </g>
      {row.done !== undefined && (
        <Icon name="check" x={24} y={mid - 8} size={16}>
          {at(row.done)}
        </Icon>
      )}
      {row.cut !== undefined && (
        <Icon name="cut" x={24} y={mid - 8} size={16} className="dg-icon is-alarm">
          {at(row.cut)}
        </Icon>
      )}
      <text className="dg-row-tool" x="48" y={mid + 4}>
        {step.tool}
      </text>
      <text className="dg-row-detail" x="100" y={mid + 4}>
        {step.detail}
      </text>
      {durable && row.done !== undefined && (
        <Icon name="flag" x={321} y={mid - 7} size={14} className="dg-icon is-secure">
          {at(row.done)}
        </Icon>
      )}
      {row.lost !== undefined && (
        <g opacity="0">
          {at(row.lost)}
          <rect className="dg-veil" x="18" y={y + 1} width="324" height={ROW - 2} />
          <path className="dg-strike" d={`M46 ${mid}H${100 + textWidth(step.detail) + 2}`} />
        </g>
      )}
    </g>
  );
}

/** Roughly how wide a 12-unit monospace label is: CJK characters take two columns. */
function textWidth(text: string) {
  return [...text].reduce((width, char) => width + (char.codePointAt(0)! > 0x2e80 ? 12 : 7.2), 0);
}
