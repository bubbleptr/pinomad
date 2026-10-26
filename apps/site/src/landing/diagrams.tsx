import type { ReactNode } from "react";
import type { LandingCopy } from "./copy.tsx";

// The landing page's diagrams, drawn inline so the words come from copy.tsx and
// the colours from page.css's tokens. Coordinates are in a 360-unit-wide
// viewBox; page.css caps the drawn width, so a 15-unit label lands between
// about 12px on a phone and 17px on a desktop. The page's CSP allows no inline
// styles, so every colour and size is a class in page.css (the .dg-* rules).
//
// Solid lines are what ships today; dashed ones are planned.

function Diagram({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  return (
    <figure className="diagram">
      <svg viewBox={`0 0 360 ${height}`} role="img" aria-label={label} focusable="false">
        {children}
      </svg>
    </figure>
  );
}

/** A name with a smaller note under it, centred on x. */
function Caption({ x, y, name, note, mono }: { x: number; y: number; name: string; note?: string; mono?: boolean }) {
  return (
    <>
      <text className="dg-name" x={x} y={y}>
        {name}
      </text>
      {note && (
        <text className={mono ? "dg-note dg-mono" : "dg-note"} x={x} y={y + 20}>
          {note}
        </text>
      )}
    </>
  );
}

/** An arrowhead pointing down, its tip at (x, y). */
function Down({ x, y }: { x: number; y: number }) {
  return <path className="dg-line" d={`M${x - 4} ${y - 5}L${x} ${y}L${x + 4} ${y - 5}`} />;
}

/** A padlock centred on (x, y), on a disc that cuts the line it sits on; `inBox` when that line runs through a box. */
function Lock({ x, y, inBox }: { x: number; y: number; inBox?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle className={inBox ? "dg-cut in-box" : "dg-cut"} r="12" />
      <path className="dg-line is-strong" d="M-3.5 -1.5V-4.5a3.5 3.5 0 0 1 7 0V-1.5" />
      <rect className="dg-solid" x="-6" y="-1.5" width="12" height="9" rx="2" />
    </g>
  );
}

// A pairing code as the host shows it: 9 × 9 modules, finder squares in three corners.
const QR = ["111010111", "101001101", "111010111", "000110100", "101011011", "010100110", "111001010", "101010110", "111011101"];
const qrPath = QR.flatMap((row, y) =>
  [...row].flatMap((bit, x) => (bit === "1" ? [`M${x * 4} ${y * 4}h4v4h-4z`] : [])),
).join("");

/** The host on your own machine, and the three things of that machine the agent uses. */
export function MachineDiagram({ t }: { t: LandingCopy["core"]["machine"]["diagram"] }) {
  const columns = [66, 180, 294];
  return (
    <Diagram label={t.label} height={228}>
      <rect className="dg-box is-main" x="4" y="4" width="352" height="220" rx="16" />
      <text className="dg-name dg-start" x="22" y="34">
        {t.machine}
      </text>
      <text className="dg-note dg-mono dg-end" x="338" y="34">
        {t.kinds}
      </text>
      <rect className="dg-box is-main" x="116" y="58" width="128" height="58" rx="12" />
      <Caption x={180} y={82} name={t.host} note="pinomad host" mono />
      <path className="dg-line" d="M180 116V138M66 138H294M66 138V160M180 138V160M294 138V160" />
      {t.uses.map((use, i) => (
        <g key={use.name}>
          <Down x={columns[i]!} y={160} />
          <rect className="dg-box" x={columns[i]! - 54} y="160" width="108" height="50" rx="10" />
          <Caption x={columns[i]!} y={181} name={use.name} note={use.example} mono />
        </g>
      ))}
    </Diagram>
  );
}

/** You and the planner design the change; the planner hands the work to the other roles. */
export function AgentsDiagram({ t, roles }: { t: LandingCopy["agents"]["diagram"]; roles: string[] }) {
  const [planner, ...team] = roles;
  const columns = [62, 180, 298];
  const handle = (name: string) => `@${name.toLowerCase()}`;
  return (
    <Diagram label={t.label} height={240}>
      <rect className="dg-box" x="20" y="22" width="76" height="44" rx="22" />
      <text className="dg-name" x="58" y="49">
        {t.you}
      </text>
      <path className="dg-line is-strong" d="M100 44H120M105 39L100 44L105 49M115 39L120 44L115 49" />
      <rect className="dg-box is-main" x="124" y="12" width="112" height="64" rx="12" />
      <Caption x={180} y={39} name={planner!} note={handle(planner!)} mono />
      <path className="dg-line" d="M180 76V100M62 100H298M62 100V124M180 100V124M298 100V124" />
      {/* A second card behind the worker: there can be several. */}
      <rect className="dg-box" x="18" y="118" width="100" height="64" rx="12" />
      {team.map((name, i) => (
        <g key={name}>
          <Down x={columns[i]!} y={124} />
          <rect className="dg-box" x={columns[i]! - 50} y="124" width="100" height="64" rx="12" />
          <Caption x={columns[i]!} y={151} name={name} note={handle(name)} mono />
        </g>
      ))}
      <text className="dg-note" x="180" y="222">
        {t.own}
      </text>
    </Diagram>
  );
}

/**
 * A device and the host, paired once by QR code, then joined by one encrypted
 * channel: straight across the LAN or tailnet, or through a relay. The channel
 * runs through the relay unbroken, lock and all, because the relay never opens it.
 */
export function ConnectionDiagram({ t }: { t: LandingCopy["connection"]["diagram"] }) {
  return (
    <Diagram label={t.label} height={256}>
      <text className="dg-name" x="44" y="40">
        {t.device}
      </text>
      <rect className="dg-box is-main" x="20" y="56" width="48" height="92" rx="10" />
      <path className="dg-line" d="M36 66H52M30 84H58M30 96H52M30 108H56" />
      <text className="dg-name" x="304" y="40">
        {t.host}
      </text>
      <rect className="dg-box is-main" x="264" y="56" width="80" height="92" rx="12" />
      <path className="dg-solid" transform="translate(286 82)" d={qrPath} />
      <text className="dg-note" x="304" y="140">
        {t.pair}
      </text>

      <text className="dg-name" x="166" y="88">
        {t.direct}
      </text>
      <path className="dg-line is-strong" d="M68 102H264" />
      <Lock x={166} y={102} />
      <text className="dg-note dg-mono" x="166" y="130">
        {t.directVia}
      </text>

      <rect className="dg-box" x="86" y="176" width="160" height="72" rx="12" />
      <text className="dg-name" x="166" y="198">
        {t.relay}
      </text>
      <path className="dg-line is-strong" d="M44 148V202Q44 214 56 214H292Q304 214 304 202V148" />
      <Lock x={166} y={214} inBox />
      <text className="dg-note" x="166" y="240">
        {t.relayNote}
      </text>
    </Diagram>
  );
}

/** Planned: the model stays on the host; the tools run on other machines over SSH. */
export function EnvironmentsDiagram({ t }: { t: LandingCopy["next"]["diagram"] }) {
  const columns = [49, 137, 223, 311];
  return (
    <Diagram label={t.label} height={264}>
      <rect className="dg-box is-main" x="106" y="8" width="148" height="64" rx="12" />
      <Caption x={180} y={36} name={t.host} note={t.hostNote} />
      <path className="dg-line dg-planned" d="M180 72V122M49 122H311M49 122V150M137 122V150M223 122V150M311 122V150" />
      <text className="dg-note dg-mono dg-start" x="190" y="102">
        SSH · pi-env
      </text>
      {t.machines.map((machine, i) => (
        <g key={machine}>
          <Down x={columns[i]!} y={150} />
          <rect className="dg-box dg-planned" x={columns[i]! - 41} y="150" width="82" height="52" rx="10" />
          <text className="dg-name is-small" x={columns[i]!} y="181">
            {machine}
          </text>
        </g>
      ))}
      <path className="dg-line" d="M8 216V222H352V216" />
      <text className="dg-note" x="180" y="246">
        {t.machinesNote}
      </text>
    </Diagram>
  );
}
