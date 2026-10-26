import { createContext, type ReactNode, useContext, useEffect, useId, useRef } from "react";
import type { LandingCopy } from "./copy.tsx";

// The landing page's diagrams, drawn as miniature product UI on a hatched plate:
// opaque cards lifted by a shadow, placeholder bars where a screen would show
// text, and words only where something has a name. The motion carries the
// explanation (work fanning out, packets crossing the relay), so there are no
// captions; the card or section around each diagram has the prose.
//
// Coordinates are in a 360-unit-wide viewBox. The page's CSP allows no inline
// styles, so colours and sizes are classes in page.css (the .dg-* rules, on the
// --dg-* tokens). The motion is SMIL, which keeps it in step without script.
// Under reduced motion the moving parts (.dg-motion) are hidden and a still
// frame (.dg-still) shows the same state; off screen the animations pause.
//
// Shipped things are raised cards; planned ones are dashed outlines with no
// shadow. Colour only carries meaning: window controls, green for running and
// encrypted, violet for the model, and one hue per agent.

const Shadow = createContext("");

function Diagram({ label, height, children }: { label: string; height: number; children: ReactNode }) {
  const id = `dg-shadow${useId().replace(/[^\w-]/g, "")}`;
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = svg.current!;
    element.pauseAnimations();
    const observer = new IntersectionObserver(([entry]) => {
      if (entry!.isIntersecting) element.unpauseAnimations();
      else element.pauseAnimations();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <figure className="diagram">
      <svg ref={svg} viewBox={`0 0 360 ${height}`} role="img" aria-label={label} focusable="false">
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

// —— Timing. Every loop in a diagram shares one duration; a part is on screen
// for a window of it, given as fractions of the loop.

type Loop = { dur: string };

/** Opacity that is 1 between `from` and `to` of the loop and 0 otherwise, with short fades. */
function Shown({ dur, from, to }: Loop & { from: number; to: number }) {
  const fade = 0.03;
  return (
    <animate
      attributeName="opacity"
      dur={dur}
      repeatCount="indefinite"
      values="0;0;1;1;0;0"
      keyTimes={[0, from, from + fade, to - fade, to, 1].join(";")}
    />
  );
}

/** A dot that travels `path` between `from` and `to` of the loop. */
function Pulse({ path, dur, from, to, className = "dg-pulse" }: Loop & { path: string; from: number; to: number; className?: string }) {
  return (
    <circle className={`${className} dg-motion`} r="3" opacity="0">
      <animateMotion
        path={path}
        dur={dur}
        repeatCount="indefinite"
        calcMode="linear"
        keyPoints="0;0;1;1"
        keyTimes={[0, from, to, 1].join(";")}
      />
      <Shown dur={dur} from={from} to={to + 0.02} />
    </circle>
  );
}

/** An encrypted packet: a small green capsule travelling `path` between `from` and `to`. */
function Packet({ path, dur, from, to }: Loop & { path: string; from: number; to: number }) {
  return (
    <rect className="dg-packet dg-motion" x="-6" y="-4" width="12" height="8" rx="4" opacity="0">
      <animateMotion
        path={path}
        dur={dur}
        repeatCount="indefinite"
        calcMode="linear"
        keyPoints="0;0;1;1"
        keyTimes={[0, from, to, 1].join(";")}
      />
      <Shown dur={dur} from={from} to={to} />
    </rect>
  );
}

// —— Parts.

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

/** A window's title bar: the three window controls, a title, and a hairline under them. */
function TitleBar({ x, y, w, title }: { x: number; y: number; w: number; title: string }) {
  return (
    <>
      {["close", "min", "max"].map((name, i) => (
        <circle key={name} className={`dg-light is-${name}`} cx={x + 14 + i * 10} cy={y + 13} r="3" />
      ))}
      <text className="dg-title dg-start" x={x + 46} y={y + 17.5}>
        {title}
      </text>
      <path className="dg-rule" d={`M${x} ${y + 26.5}H${x + w}`} />
    </>
  );
}

// Remix Icon line icons (Remix Icon License v1.0, see docs/licenses/remixicon.md),
// path data copied from remixicon 4.9.1 on its 24-unit grid. They are filled outlines.
const icons = {
  terminal: "M10.9999 12L3.92886 19.0711L2.51465 17.6569L8.1715 12L2.51465 6.34317L3.92886 4.92896L10.9999 12ZM10.9999 19H20.9999V21H10.9999V19Z",
  terminalBox:
    "M3 3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3ZM4 5V19H20V5H4ZM12 15H18V17H12V15ZM8.66685 12L5.83842 9.17157L7.25264 7.75736L11.4953 12L7.25264 16.2426L5.83842 14.8284L8.66685 12Z",
  repo: "M13 21V23.5L10 21.5L7 23.5V21H6.5C4.567 21 3 19.433 3 17.5V5C3 3.34315 4.34315 2 6 2H20C20.5523 2 21 2.44772 21 3V20C21 20.5523 20.5523 21 20 21H13ZM13 19H19V16H6.5C5.67157 16 5 16.6716 5 17.5C5 18.3284 5.67157 19 6.5 19H7V17H13V19ZM19 14V4H6V14.0354C6.1633 14.0121 6.33024 14 6.5 14H19ZM7 5H9V7H7V5ZM7 8H9V10H7V8ZM7 11H9V13H7V11Z",
  key: "M10.7577 11.8281L18.6066 3.97919L20.0208 5.3934L18.6066 6.80761L21.0815 9.28249L19.6673 10.6967L17.1924 8.22183L15.7782 9.63604L17.8995 11.7574L16.4853 13.1716L14.364 11.0503L12.1719 13.2423C13.4581 15.1837 13.246 17.8251 11.5355 19.5355C9.58291 21.4882 6.41709 21.4882 4.46447 19.5355C2.51184 17.5829 2.51184 14.4171 4.46447 12.4645C6.17493 10.754 8.81633 10.5419 10.7577 11.8281ZM10.1213 18.1213C11.2929 16.9497 11.2929 15.0503 10.1213 13.8787C8.94975 12.7071 7.05025 12.7071 5.87868 13.8787C4.70711 15.0503 4.70711 16.9497 5.87868 18.1213C7.05025 19.2929 8.94975 19.2929 10.1213 18.1213Z",
  lock: "M6 8V7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7V8H20C20.5523 8 21 8.44772 21 9V21C21 21.5523 20.5523 22 20 22H4C3.44772 22 3 21.5523 3 21V9C3 8.44772 3.44772 8 4 8H6ZM19 10H5V20H19V10ZM11 15.7324C10.4022 15.3866 10 14.7403 10 14C10 12.8954 10.8954 12 12 12C13.1046 12 14 12.8954 14 14C14 14.7403 13.5978 15.3866 13 15.7324V18H11V15.7324ZM8 8H16V7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7V8Z",
  server:
    "M5 11H19V5H5V11ZM21 4V20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V4C3 3.44772 3.44772 3 4 3H20C20.5523 3 21 3.44772 21 4ZM19 13H5V19H19V13ZM7 15H10V17H7V15ZM7 7H10V9H7V7Z",
  sparkles:
    "M17.0007 1.20825 18.3195 3.68108 20.7923 4.99992 18.3195 6.31876 17.0007 8.79159 15.6818 6.31876 13.209 4.99992 15.6818 3.68108 17.0007 1.20825ZM10.6673 9.33325 15.6673 11.9999 10.6673 14.6666 8.00065 19.6666 5.33398 14.6666.333984 11.9999 5.33398 9.33325 8.00065 4.33325 10.6673 9.33325ZM11.4173 11.9999 9.18905 10.8115 8.00065 8.58325 6.81224 10.8115 4.58398 11.9999 6.81224 13.1883 8.00065 15.4166 9.18905 13.1883 11.4173 11.9999ZM19.6673 16.3333 18.0007 13.2083 16.334 16.3333 13.209 17.9999 16.334 19.6666 18.0007 22.7916 19.6673 19.6666 22.7923 17.9999 19.6673 16.3333Z",
  user: "M20 22H18V20C18 18.3431 16.6569 17 15 17H9C7.34315 17 6 18.3431 6 20V22H4V20C4 17.2386 6.23858 15 9 15H15C17.7614 15 20 17.2386 20 20V22ZM12 13C8.68629 13 6 10.3137 6 7C6 3.68629 8.68629 1 12 1C15.3137 1 18 3.68629 18 7C18 10.3137 15.3137 13 12 13ZM12 11C14.2091 11 16 9.20914 16 7C16 4.79086 14.2091 3 12 3C9.79086 3 8 4.79086 8 7C8 9.20914 9.79086 11 12 11Z",
};

/** A Remix icon with its top-left corner at (x, y); children animate it. */
function Icon({
  name,
  x,
  y,
  size = 18,
  className = "dg-icon",
  children,
}: {
  name: keyof typeof icons;
  x: number;
  y: number;
  size?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <path
      className={className}
      transform={`translate(${x} ${y}) scale(${size / 24})`}
      d={icons[name]}
      opacity={children ? 0 : undefined}
    >
      {children}
    </path>
  );
}

/** A small raised disc with a padlock on it, centred on (x, y). */
function LockBadge({ x, y }: { x: number; y: number }) {
  const shadow = useContext(Shadow);
  return (
    <>
      <circle className="dg-card" cx={x} cy={y} r="13" filter={shadow} />
      <Icon name="lock" x={x - 7} y={y - 7} size={14} className="dg-icon is-secure" />
    </>
  );
}

/** An arrowhead pointing down, its tip at (x, y). */
function Down({ x, y }: { x: number; y: number }) {
  return <path className="dg-line" d={`M${x - 3.5} ${y - 4.5}L${x} ${y}L${x + 3.5} ${y - 4.5}`} />;
}

/** A status light: grey when idle, green while it works. Lit in the still frame. */
function Status({ x, y, on }: { x: number; y: number; on: Loop & { from: number; to: number } }) {
  return (
    <>
      <circle className="dg-dot" cx={x} cy={y} r="3.5" />
      <circle className="dg-live dg-still" cx={x} cy={y} r="3.5" />
      <circle className="dg-live dg-motion" cx={x} cy={y} r="3.5" opacity="0">
        <Shown {...on} />
      </circle>
    </>
  );
}

// A pairing code as the host shows it: 9 × 9 modules, finder squares in three corners.
const QR = ["111010111", "101001101", "111010111", "000110100", "101011011", "010100110", "111001010", "101010110", "111011101"];
const qrPath = QR.flatMap((row, y) =>
  [...row].flatMap((bit, x) => (bit === "1" ? [`M${x * 5} ${y * 5}h4.4v4.4h-4.4z`] : [])),
).join("");

// —— The diagrams.

/** The host on your own machine sends work to the machine's shell, repositories, and credentials. */
export function MachineDiagram({ t }: { t: LandingCopy["core"]["machine"]["diagram"] }) {
  const loop = { dur: "3.2s" };
  const uses = [
    { icon: "terminal", x: 76 },
    { icon: "repo", x: 180 },
    { icon: "key", x: 284 },
  ] as const;
  return (
    <Diagram label={t.label} height={216}>
      <Card x={10} y={8} w={340} h={200} r={14} />
      <TitleBar x={10} y={8} w={340} title={t.machine} />

      <rect className="dg-screen" x="26" y="48" width="308" height="64" rx="10" />
      <text className="dg-code is-dim" x="40" y="70">
        $
      </text>
      <text className="dg-code" x="54" y="70">
        pinomad host
      </text>
      <rect className="dg-cursor" x="152" y="60" width="7" height="13" rx="1" />
      <Bar x={54} y={84} w={150} />
      <Bar x={54} y={96} w={100} />
      <circle className="dg-live dg-breathe" cx="316" cy="66" r="3.5" />

      <path className="dg-line" d="M180 112V124M76 124H284M76 124V136M180 124V136M284 124V136" />
      {uses.map((use, i) => (
        <g key={use.icon}>
          <Down x={use.x} y={136} />
          <rect className="dg-tile" x={use.x - 50} y="136" width="100" height="60" rx="10" />
          <rect className="dg-tile-lit dg-motion" x={use.x - 50} y="136" width="100" height="60" rx="10" opacity="0">
            <Shown {...loop} from={0.32} to={0.78} />
          </rect>
          <Icon name={use.icon} x={use.x - 9} y={146} />
          <text className="dg-name is-small" x={use.x} y="184">
            {t.uses[i]}
          </text>
          <Pulse {...loop} path={`M180 112V124H${use.x}V136`} from={0.05} to={0.3} />
        </g>
      ))}
    </Diagram>
  );
}

const hues = ["is-violet", "is-blue", "is-amber", "is-rose"];

/** An agent's card: avatar initial in the agent's own hue, name, three pills for its prompt, model, and thinking level, and a status light. */
function AgentCard({ x, y, name, hue, w = 100, on }: { x: number; y: number; name: string; hue: string; w?: number; on: Loop & { from: number; to: number } }) {
  return (
    <>
      <Card x={x} y={y} w={w} h={54} />
      <circle className={`dg-avatar ${hue}`} cx={x + 18} cy={y + 27} r="10" />
      <text className={`dg-initial ${hue}`} x={x + 18} y={y + 31}>
        {name[0]}
      </text>
      <text className="dg-name dg-start" x={x + 34} y={y + 25}>
        {name}
      </text>
      <Bar x={x + 34} y={y + 33} w={20} strong />
      <Bar x={x + 57} y={y + 33} w={14} />
      <Bar x={x + 74} y={y + 33} w={10} />
      <Status x={x + w - 11} y={y + 11} on={on} />
    </>
  );
}

/** You mention @planner; the planner hands the work to the other roles, and they light up. */
export function AgentsDiagram({ t, roles }: { t: LandingCopy["agents"]["diagram"]; roles: string[] }) {
  const loop = { dur: "4.4s" };
  const [planner, ...team] = roles;
  const columns = [66, 180, 294];
  return (
    <Diagram label={t.label} height={232}>
      <path className="dg-line" d="M180 54V80M180 134V150M66 150H294M66 150V166M180 150V166M294 150V166" />
      <circle className="dg-avatar" cx="40" cy="31" r="15" />
      <Icon name="user" x={31} y={22} />
      <Card x={66} y={8} w={228} h={46} r={16} />
      <rect className={`dg-mention ${hues[0]}`} x="78" y="20" width="80" height="22" rx="6" />
      <text className={`dg-mention-text ${hues[0]}`} x="118" y="35">
        @{planner!.toLowerCase()}
      </text>
      <Bar x={166} y={28} w={112} />

      <Down x={180} y={80} />
      <AgentCard x={114} y={80} w={132} name={planner!} hue={hues[0]!} on={{ ...loop, from: 0.22, to: 0.95 }} />
      <Pulse {...loop} path="M180 54V80" from={0.04} to={0.2} />

      {/* A second card behind the worker: there can be several. */}
      <Card x={22} y={160} w={100} h={54} back />
      {team.map((name, i) => (
        <g key={name}>
          <Down x={columns[i]!} y={166} />
          <AgentCard x={columns[i]! - 50} y={166} name={name} hue={hues[i + 1]!} on={{ ...loop, from: 0.56, to: 0.95 }} />
          <Pulse {...loop} path={`M180 134V150H${columns[i]}V166`} from={0.32} to={0.54} />
        </g>
      ))}
    </Diagram>
  );
}

/**
 * A phone and the host, paired once by scanning the host's QR code, then joined by
 * one encrypted channel: straight across, or through a relay. Packets cross the
 * relay without stopping, because the relay can't open them.
 */
export function ConnectionDiagram({ t }: { t: LandingCopy["connection"]["diagram"] }) {
  const loop = { dur: "4s" };
  const direct = "M82 80H258";
  const back = "M258 80H82";
  const relay = "M51 140V182Q51 196 65 196H286Q300 196 300 182V140";
  return (
    <Diagram label={t.label} height={226}>
      <path className="dg-line is-strong" d={direct} />
      <Card x={110} y={150} w={120} h={64} />
      <Icon name="server" x={146} y={160} size={14} />
      <text className="dg-title dg-start" x="166" y="171.5">
        {t.relay}
      </text>
      <path className="dg-line is-strong" d={relay} />

      <Packet {...loop} path={direct} from={0.05} to={0.3} />
      <Packet {...loop} path={back} from={0.4} to={0.65} />
      <Packet {...loop} path={relay} from={0.55} to={0.95} />

      <Card x={20} y={20} w={62} h={120} r={14} />
      <rect className="dg-screen" x="25" y="25" width="52" height="110" rx="10" />
      <rect className="dg-island" x="41" y="30" width="20" height="6" rx="3" />
      <Bar x={46} y={48} w={26} strong />
      <Bar x={30} y={62} w={36} />
      <Bar x={30} y={72} w={24} />
      <Bar x={50} y={88} w={22} strong />
      <Bar x={30} y={102} w={32} />

      <Card x={258} y={20} w={84} h={120} />
      <TitleBar x={258} y={20} w={84} title={t.host} />
      <path className="dg-qr" transform="translate(278 71)" d={qrPath} />
      <rect className="dg-scan dg-motion" x="274" y="0" width="52" height="2" rx="1" opacity="0">
        <animate attributeName="y" dur={loop.dur} repeatCount="indefinite" values="67;67;117;117" keyTimes="0;0.7;0.95;1" />
        <Shown {...loop} from={0.7} to={0.95} />
      </rect>

      <LockBadge x={170} y={80} />
      <LockBadge x={170} y={196} />
    </Diagram>
  );
}

/** Planned: the model stays on the host; its tool calls go out to the other machines. */
export function EnvironmentsDiagram({ t }: { t: LandingCopy["next"]["diagram"] }) {
  const loop = { dur: "3.6s" };
  const columns = [49, 137, 223, 311];
  return (
    <Diagram label={t.label} height={214}>
      <path className="dg-line dg-planned" d="M180 80V116M49 116H311M49 116V140M137 116V140M223 116V140M311 116V140" />
      <Card x={104} y={8} w={152} h={72} />
      <TitleBar x={104} y={8} w={152} title={t.host} />
      <Icon name="sparkles" x={118} y={44} className="dg-icon is-model" />
      <rect className="dg-bar dg-think" x="144" y="47" width="92" height="6" rx="3" />
      <rect className="dg-bar dg-think is-late" x="144" y="59" width="58" height="6" rx="3" />
      {t.machines.map((machine, i) => (
        <g key={machine}>
          <Down x={columns[i]!} y={140} />
          <Ghost x={columns[i]! - 41} y={140} w={82} h={64} />
          <Icon name="terminalBox" x={columns[i]! - 9} y={150} />
          <Icon name="terminalBox" x={columns[i]! - 9} y={150} className="dg-icon is-lit dg-motion">
            <Shown {...loop} from={0.3 + i * 0.12} to={0.9} />
          </Icon>
          <text className="dg-name is-small is-planned" x={columns[i]!} y="192">
            {machine}
          </text>
          <Pulse
            {...loop}
            path={`M180 80V116H${columns[i]}V140`}
            from={0.08 + i * 0.12}
            to={0.3 + i * 0.12}
          />
        </g>
      ))}
    </Diagram>
  );
}
