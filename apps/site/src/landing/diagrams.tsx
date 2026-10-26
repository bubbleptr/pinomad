import { createContext, type ReactNode, useContext, useId } from "react";
import type { LandingCopy } from "./copy.tsx";

// The landing page's diagrams, drawn as miniature product UI on a hatched plate:
// opaque cards lifted by a shadow, placeholder bars where a screen would show
// text, line icons, and real words only as names and captions. Coordinates are
// in a 360-unit-wide viewBox; page.css caps the drawn width, so a 14-unit name
// lands between about 11px on a phone and 16px on a desktop.
//
// The page's CSP allows no inline styles, so colours and sizes are classes in
// page.css (the .dg-* rules, on the --dg-* tokens). The shadow is an SVG filter,
// one per diagram, with an id from useId so several can share the page.
//
// Shipped things are raised cards; planned ones are dashed outlines with no
// shadow. No accent colour: the one bright element is the @planner mention.

const Shadow = createContext("");

function Diagram({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  const id = `dg-shadow${useId().replace(/[^\w-]/g, "")}`;
  return (
    <figure className="diagram">
      <svg viewBox={`0 0 360 ${height}`} role="img" aria-label={label} focusable="false">
        <defs>
          {/* In user space, sized to the whole drawing, so no shadow is clipped at its element's edge. */}
          <filter id={id} filterUnits="userSpaceOnUse" x="-20" y="-20" width="400" height={height + 40}>
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.5" />
          </filter>
        </defs>
        <Shadow.Provider value={`url(#${id})`}>{children}</Shadow.Provider>
      </svg>
    </figure>
  );
}

/** An opaque raised card: shadow, hairline edge, and a faint highlight along the top. */
function Card({ x, y, w, h, r = 12, back }: { x: number; y: number; w: number; h: number; r?: number; back?: boolean }) {
  const shadow = useContext(Shadow);
  if (back) return <rect className="dg-card is-back" x={x} y={y} width={w} height={h} rx={r} />;
  return (
    <>
      <rect className="dg-card" x={x} y={y} width={w} height={h} rx={r} filter={shadow} />
      <path className="dg-shine" d={`M${x + r} ${y + 0.5}H${x + w - r}`} />
    </>
  );
}

/** A planned thing: dashed outline, nothing filled in yet. */
function Ghost({ x, y, w, h, r = 10 }: { x: number; y: number; w: number; h: number; r?: number }) {
  return <rect className="dg-ghost" x={x} y={y} width={w} height={h} rx={r} />;
}

/** A line of text on a miniature screen. */
function Bar({ x, y, w, strong }: { x: number; y: number; w: number; strong?: boolean }) {
  return <rect className={strong ? "dg-bar is-strong" : "dg-bar"} x={x} y={y} width={w} height="6" rx="3" />;
}

/** A window's title bar: three dots and a hairline under them. */
function TitleBar({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <circle key={i} className="dg-dot" cx={x + 14 + i * 10} cy={y + 13} r="3" />
      ))}
      <path className="dg-rule" d={`M${x} ${y + 26.5}H${x + w}`} />
    </>
  );
}

// Lucide icons (ISC licence, see docs/licenses/lucide.md), path data copied from
// lucide-react 1.52 on its 24-unit grid.
const icons = {
  terminal: (
    <>
      <path d="M12 19h8" />
      <path d="m4 17 6-6-6-6" />
    </>
  ),
  folderGit: (
    <>
      <path d="M18 19a5 5 0 0 1-5-5v8" />
      <path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5" />
      <circle cx="13" cy="12" r="2" />
      <circle cx="20" cy="19" r="2" />
    </>
  ),
  key: (
    <>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  server: (
    <>
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
      <path d="M20 2v4M22 4h-4" />
      <circle cx="4" cy="20" r="2" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
};

/** A Lucide icon with its top-left corner at (x, y). */
function Icon({ name, x, y, size = 16 }: { name: keyof typeof icons; x: number; y: number; size?: number }) {
  return (
    <g className="dg-icon" transform={`translate(${x} ${y}) scale(${size / 24})`}>
      {icons[name]}
    </g>
  );
}

/** A small raised disc with a padlock on it, centred on (x, y). */
function LockBadge({ x, y }: { x: number; y: number }) {
  const shadow = useContext(Shadow);
  return (
    <>
      <circle className="dg-card" cx={x} cy={y} r="13" filter={shadow} />
      <Icon name="lock" x={x - 7} y={y - 7.5} size={14} />
    </>
  );
}

/** An arrowhead pointing down, its tip at (x, y). */
function Down({ x, y }: { x: number; y: number }) {
  return <path className="dg-line" d={`M${x - 3.5} ${y - 4.5}L${x} ${y}L${x + 3.5} ${y - 4.5}`} />;
}

// A pairing code as the host shows it: 9 × 9 modules, finder squares in three corners.
const QR = ["111010111", "101001101", "111010111", "000110100", "101011011", "010100110", "111001010", "101010110", "111011101"];
const qrPath = QR.flatMap((row, y) =>
  [...row].flatMap((bit, x) => (bit === "1" ? [`M${x * 5} ${y * 5}h4.4v4.4h-4.4z`] : [])),
).join("");

/** The host on your own machine, and the three things of that machine the agent uses. */
export function MachineDiagram({ t }: { t: LandingCopy["core"]["machine"]["diagram"] }) {
  const uses = [
    { icon: "terminal", x: 76 },
    { icon: "folderGit", x: 180 },
    { icon: "key", x: 284 },
  ] as const;
  return (
    <Diagram label={t.label} height={236}>
      <Card x={10} y={8} w={340} h={220} r={14} />
      <TitleBar x={10} y={8} w={340} />
      <text className="dg-title dg-start" x="56" y="25.5">
        {t.machine}
      </text>
      <text className="dg-note dg-mono dg-end" x="336" y="25.5">
        {t.kinds}
      </text>

      <rect className="dg-screen" x="26" y="48" width="308" height="72" rx="10" />
      <Icon name="terminal" x={38} y={60} />
      <text className="dg-code" x="62" y="72.5">
        pinomad host
      </text>
      <Bar x={62} y={86} w={150} />
      <Bar x={62} y={100} w={104} />
      <circle className="dg-live" cx="314" cy="68" r="3.5" />
      <text className="dg-note dg-end" x="302" y="72.5">
        {t.host}
      </text>

      <path className="dg-line" d="M180 120V131M76 131H284M76 131V142M180 131V142M284 131V142" />
      {uses.map((use, i) => (
        <g key={use.icon}>
          <Down x={use.x} y={142} />
          <rect className="dg-tile" x={use.x - 50} y="142" width="100" height="72" rx="10" />
          <Icon name={use.icon} x={use.x - 8} y={154} />
          <text className="dg-name is-small" x={use.x} y="190">
            {t.uses[i]!.name}
          </text>
          <text className="dg-note dg-mono" x={use.x} y="206">
            {t.uses[i]!.example}
          </text>
        </g>
      ))}
    </Diagram>
  );
}

/** An agent's card: avatar initial, name, and three pills for its own prompt, model, and thinking level. */
function AgentCard({ x, y, name, w = 100 }: { x: number; y: number; name: string; w?: number }) {
  return (
    <>
      <Card x={x} y={y} w={w} h={54} />
      <circle className="dg-avatar" cx={x + 18} cy={y + 27} r="10" />
      <text className="dg-initial" x={x + 18} y={y + 31}>
        {name[0]}
      </text>
      <text className="dg-name dg-start" x={x + 34} y={y + 25}>
        {name}
      </text>
      <Bar x={x + 34} y={y + 33} w={20} strong />
      <Bar x={x + 57} y={y + 33} w={14} />
      <Bar x={x + 74} y={y + 33} w={10} />
    </>
  );
}

/** You mention @planner; the planner hands the work to the other roles. */
export function AgentsDiagram({ t, roles }: { t: LandingCopy["agents"]["diagram"]; roles: string[] }) {
  const [planner, ...team] = roles;
  const columns = [66, 180, 294];
  return (
    <Diagram label={t.label} height={262}>
      <path
        className="dg-line"
        d="M180 54V80M180 134V150M66 150H294M66 150V166M180 150V166M294 150V166"
      />
      <circle className="dg-avatar" cx="40" cy="31" r="15" />
      <Icon name="user" x={32} y={23} />
      <text className="dg-note" x="40" y="66">
        {t.you}
      </text>
      <Card x={66} y={8} w={228} h={46} r={16} />
      <rect className="dg-chip" x="78" y="20" width="80" height="22" rx="11" />
      <text className="dg-chip-text" x="118" y="35">
        @{planner!.toLowerCase()}
      </text>
      <Bar x={166} y={28} w={112} />

      <Down x={180} y={80} />
      <AgentCard x={114} y={80} w={132} name={planner!} />

      {/* A second card behind the worker: there can be several. */}
      <Card x={22} y={160} w={100} h={54} back />
      {team.map((name, i) => (
        <g key={name}>
          <Down x={columns[i]!} y={166} />
          <AgentCard x={columns[i]! - 50} y={166} name={name} />
        </g>
      ))}
      <text className="dg-note" x="180" y="248">
        {t.own}
      </text>
    </Diagram>
  );
}

/**
 * A device and the host, paired once by QR code, then joined by one encrypted
 * channel: straight across the LAN or tailnet, or through a relay. The channel
 * runs over the relay's card unbroken, lock and all, because the relay never opens it.
 */
export function ConnectionDiagram({ t }: { t: LandingCopy["connection"]["diagram"] }) {
  return (
    <Diagram label={t.label} height={272}>
      <path className="dg-line is-strong" d="M82 100H258" />

      <text className="dg-title" x="51" y="36">
        {t.device}
      </text>
      <Card x={20} y={48} w={62} h={120} r={14} />
      <rect className="dg-screen" x="25" y="53" width="52" height="110" rx="10" />
      <rect className="dg-island" x="41" y="58" width="20" height="6" rx="3" />
      <Bar x={46} y={76} w={26} strong />
      <Bar x={30} y={90} w={36} />
      <Bar x={30} y={100} w={24} />
      <Bar x={50} y={116} w={22} strong />
      <Bar x={30} y={130} w={32} />

      <text className="dg-title" x="300" y="36">
        {t.host}
      </text>
      <Card x={258} y={48} w={84} h={120} />
      <TitleBar x={258} y={48} w={84} />
      <path className="dg-qr" transform="translate(278 86)" d={qrPath} />
      <text className="dg-note" x="300" y="156">
        {t.pair}
      </text>

      <text className="dg-title" x="170" y="80">
        {t.direct}
      </text>
      <LockBadge x={170} y={100} />
      <text className="dg-note dg-mono" x="170" y="132">
        {t.directVia}
      </text>

      <Card x={90} y={190} w={160} h={74} />
      <Icon name="server" x={150} y={199} size={14} />
      <text className="dg-title dg-start" x="170" y="210.5">
        {t.relay}
      </text>
      <path className="dg-line is-strong" d="M51 168V214Q51 228 65 228H286Q300 228 300 214V168" />
      <LockBadge x={170} y={228} />
      <text className="dg-note" x="170" y="256">
        {t.relayNote}
      </text>
    </Diagram>
  );
}

/** Planned: the model stays on the host; the tools run on other machines over SSH. */
export function EnvironmentsDiagram({ t }: { t: LandingCopy["next"]["diagram"] }) {
  const columns = [49, 137, 223, 311];
  return (
    <Diagram label={t.label} height={266}>
      <path className="dg-line dg-planned" d="M180 90V128M49 128H311M49 128V152M137 128V152M223 128V152M311 128V152" />
      <Card x={104} y={8} w={152} h={82} />
      <TitleBar x={104} y={8} w={152} />
      <text className="dg-title dg-start" x="150" y="25.5">
        {t.host}
      </text>
      <Icon name="sparkles" x={118} y={46} />
      <text className="dg-note dg-start" x="142" y="58.5">
        {t.hostNote}
      </text>
      <Bar x={118} y={72} w={96} />
      <text className="dg-note dg-mono dg-start" x="190" y="113">
        SSH · pi-env
      </text>
      {t.machines.map((machine, i) => (
        <g key={machine}>
          <Down x={columns[i]!} y={152} />
          <Ghost x={columns[i]! - 41} y={152} w={82} h={64} />
          <Icon name="terminal" x={columns[i]! - 8} y={164} />
          <text className="dg-name is-small is-planned" x={columns[i]!} y="202">
            {machine}
          </text>
        </g>
      ))}
      <path className="dg-line" d="M8 226V232H352V226" />
      <text className="dg-note" x="180" y="254">
        {t.machinesNote}
      </text>
    </Diagram>
  );
}
