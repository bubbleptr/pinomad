// Draws the landing page's contour lines: the shore that edges the blue stretch
// (page.css, .zone-abyss::before) and the top of the plates the product stands on
// (.plate). Both are the contour lines of a seeded height field. Output is static
// SVG, so the page needs no script and the lines stay hairlines at any width.
//
// The fields are periodic in x: a tile repeats sideways without a seam, which is
// how the page uses them, so a wider screen shows more shore rather than a
// stretched one.
//
// Usage: bun scripts/shore.ts   (writes src/landing/shore.svg and plate.svg; commit both)

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 1600;
const CELL = 4;
const MIST = "#e4e4e4";
const ABYSS = "#2b3b79";

// —— Seeded 3D gradient noise. A fixed seed keeps the drawing stable between runs. ——
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20261111);
const perm = Array.from({ length: 256 }, (_, i) => i);
for (let i = 255; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [perm[i], perm[j]] = [perm[j]!, perm[i]!];
}
const p = [...perm, ...perm];
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad(hash: number, x: number, y: number, z: number) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function noise3(x: number, y: number, z: number) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  z -= Math.floor(z);
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = p[X]! + Y;
  const AA = p[A]! + Z;
  const AB = p[A + 1]! + Z;
  const B = p[X + 1]! + Y;
  const BA = p[B]! + Z;
  const BB = p[B + 1]! + Z;
  return lerp(
    lerp(
      lerp(grad(p[AA]!, x, y, z), grad(p[BA]!, x - 1, y, z), u),
      lerp(grad(p[AB]!, x, y - 1, z), grad(p[BB]!, x - 1, y - 1, z), u),
      v,
    ),
    lerp(
      lerp(grad(p[AA + 1]!, x, y, z - 1), grad(p[BA + 1]!, x - 1, y, z - 1), u),
      lerp(grad(p[AB + 1]!, x, y - 1, z - 1), grad(p[BB + 1]!, x - 1, y - 1, z - 1), u),
      v,
    ),
    w,
  );
}

/** Noise over the tile, wrapped in x by walking a circle, with features about `size` px across. */
function wrapped(x: number, y: number, size: number, offset: number) {
  const angle = (x / W) * Math.PI * 2;
  const radius = W / (Math.PI * 2 * size);
  return noise3(Math.cos(angle) * radius + offset, Math.sin(angle) * radius + offset, y / size + offset);
}

// —— The height field. 0 is the coast, negative is land (mist), positive is sea (blue). ——
type Coast = (x: number) => number;

/** Heights on the grid for a tile `tall` px high. `warp` is how far the noise bends the
    lines away from the coast's shape; `offset` picks a different patch of noise. */
function sample(coast: Coast, tall: number, warp: number, offset: number) {
  const height = (x: number, y: number) => {
    const d = (y - coast(x)) / 100;
    const n = wrapped(x, y, 210, offset) + 0.4 * wrapped(x, y, 85, offset + 11.7);
    // The warp fades out at the coast, so the coast itself stays the single line drawn by coast().
    return d + n * warp * ((d * d) / (d * d + 0.1));
  };
  const field: number[][] = [];
  for (let j = 0; j <= tall / CELL; j++) {
    const row: number[] = [];
    for (let i = 0; i <= cols; i++) row.push(height((i % cols) * CELL, j * CELL));
    field.push(row);
  }
  return field;
}

const cols = W / CELL;

// —— Marching squares, then the segments chained into polylines. ——
type Point = [number, number];
type Segment = { a: string; b: string; pa: Point; pb: Point };

function segments(field: number[][], level: number): Segment[] {
  const rows = field.length - 1;
  const out: Segment[] = [];
  // A cell edge is named by its lower corner and direction, so neighbours agree on it.
  const cross = (i: number, j: number, horizontal: boolean): [string, Point] => {
    const v0 = field[j]![i]!;
    const v1 = horizontal ? field[j]![i + 1]! : field[j + 1]![i]!;
    const t = (level - v0) / (v1 - v0);
    return [
      `${i},${j},${horizontal ? "h" : "v"}`,
      horizontal ? [(i + t) * CELL, j * CELL] : [i * CELL, (j + t) * CELL],
    ];
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const tl = field[j]![i]! > level;
      const tr = field[j]![i + 1]! > level;
      const br = field[j + 1]![i + 1]! > level;
      const bl = field[j + 1]![i]! > level;
      const top = () => cross(i, j, true);
      const bottom = () => cross(i, j + 1, true);
      const left = () => cross(i, j, false);
      const right = () => cross(i + 1, j, false);
      const add = (from: [string, Point], to: [string, Point]) => out.push({ a: from[0], pa: from[1], b: to[0], pb: to[1] });
      switch ((tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)) {
        case 1:
        case 14:
          add(left(), bottom());
          break;
        case 2:
        case 13:
          add(bottom(), right());
          break;
        case 3:
        case 12:
          add(left(), right());
          break;
        case 4:
        case 11:
          add(top(), right());
          break;
        case 6:
        case 9:
          add(top(), bottom());
          break;
        case 7:
        case 8:
          add(left(), top());
          break;
        case 5:
          add(left(), top());
          add(bottom(), right());
          break;
        case 10:
          add(left(), bottom());
          add(top(), right());
          break;
      }
    }
  }
  return out;
}

function chain(list: Segment[]): Point[][] {
  const at = new Map<string, number[]>();
  list.forEach((segment, index) => {
    for (const key of [segment.a, segment.b]) at.set(key, [...(at.get(key) ?? []), index]);
  });
  const used = new Set<number>();
  const lines: Point[][] = [];
  const walk = (start: number, fromKey: string) => {
    const first = list[start]!;
    const points: Point[] = [first.a === fromKey ? first.pa : first.pb];
    let index = start;
    let key = fromKey;
    for (;;) {
      used.add(index);
      const segment = list[index]!;
      const forward = segment.a === key;
      points.push(forward ? segment.pb : segment.pa);
      key = forward ? segment.b : segment.a;
      const next = (at.get(key) ?? []).find((each) => !used.has(each));
      if (next === undefined) break;
      index = next;
    }
    lines.push(points);
  };
  // Open lines first, from an end; whatever is left is closed loops.
  list.forEach((segment, index) => {
    if (used.has(index)) return;
    if (at.get(segment.a)!.length === 1) walk(index, segment.a);
    else if (at.get(segment.b)!.length === 1) walk(index, segment.b);
  });
  list.forEach((segment, index) => {
    if (!used.has(index)) walk(index, segment.a);
  });
  return lines;
}

/** Drops points that sit within `tolerance` of the line through their neighbours. */
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = keep[keep.length - 1]!;
    const [bx, by] = points[i]!;
    const [cx, cy] = points[i + 1]!;
    const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    if (area / Math.hypot(cx - ax, cy - ay) > tolerance) keep.push(points[i]!);
  }
  keep.push(points[points.length - 1]!);
  return keep;
}

const fmt = (value: number) => String(Math.round(value * 10) / 10);
const xy = ([x, y]: Point) => `${fmt(x)},${fmt(y)}`;
const mid = ([ax, ay]: Point, [bx, by]: Point): Point => [(ax + bx) / 2, (ay + by) / 2];

/** A smooth curve through the polyline: each point is a control point, each midpoint a knot. */
function curve(points: Point[]) {
  const line = simplify(points, 0.25);
  if (line.length < 3) return `M${line.map(xy).join(" ")}`;
  let d = `M${xy(line[0]!)}L${xy(mid(line[0]!, line[1]!))}`;
  for (let i = 1; i < line.length - 1; i++) d += `Q${xy(line[i]!)} ${xy(mid(line[i]!, line[i + 1]!))}`;
  return `${d}L${xy(line[line.length - 1]!)}`;
}

const path = (lines: Point[][]) =>
  lines
    .filter((line) => line.length > 4)
    .map(curve)
    .join("");

/** Sea levels: close together at the coast, opening out and fading to nothing at `far`. */
function levels(far: number, near: number) {
  const out: { level: number; opacity: number }[] = [];
  for (let k = 1; ; k++) {
    const level = 0.075 * k ** 1.25;
    if (level > far) return out;
    out.push({ level, opacity: 0.08 + near * (1 - level / far) ** 1.4 });
  }
}

const stroke = (field: number[][], color: string, level: number, opacity: number) =>
  `<path stroke="${color}" stroke-opacity="${opacity.toFixed(2)}" d="${path(chain(segments(field, level)))}"/>`;

function write(name: string, tall: number, paths: string[]) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${tall}" width="${W}" height="${tall}" fill="none" stroke-width="1" stroke-linejoin="round">`,
    ...paths,
    "</svg>",
    "",
  ].join("\n");
  const out = join(import.meta.dirname, "../src/landing", name);
  writeFileSync(out, svg);
  console.log(`${name}: ${paths.length} paths, ${(svg.length / 1024).toFixed(1)} KB -> ${out}`);
}

// —— shore.svg: the edge of the blue stretch. Mist land above the coast, with a few faint
// lines in the page's ink; blue sea below. ——
{
  const tall = 400;
  const coast: Coast = (x) => 150 + 40 * wrapped(x, 0, 260, 7.3) + 14 * wrapped(x, 0, 90, 3.1);
  const field = sample(coast, tall, 1.05, 0);
  let land = `M0,0H${W}V${fmt(coast(0))}`;
  for (let x = W - CELL; x >= 0; x -= CELL) land += `L${x},${fmt(coast(x))}`;
  land += "Z";
  write("shore.svg", tall, [
    `<path fill="${MIST}" d="${land}"/>`,
    ...[-0.22, -0.5, -0.85].map((level, index) => stroke(field, ABYSS, level, 0.2 - index * 0.05)),
    ...levels(2.3, 0.72).map(({ level, opacity }) => stroke(field, MIST, level, opacity)),
  ]);
}

// —— plate.svg: the top of the plates the product stands on (page.css, .plate). The same
// sea with the coast just off the top edge and no land: a plate is a solid blue card, and
// the window on it leaves only a strip along the top showing, so the close lines go there. ——
{
  const tall = 320;
  const coast: Coast = (x) => -16 + 9 * wrapped(x, 0, 260, 5.1) + 4 * wrapped(x, 0, 90, 9.4);
  const field = sample(coast, tall, 0.7, 23.5);
  const sea = levels(2.6, 0.62);
  write(
    "plate.svg",
    tall,
    sea.map(({ level, opacity }) => stroke(field, MIST, level, opacity)),
  );
  // How many lines cross the top 48 units (about 40px as the page draws it), column by
  // column. Levels already passed at the top edge are off the tile, so they don't count.
  const edge = field[0]!;
  const strip = field[48 / CELL]!;
  const counts = strip.map((value, i) => sea.filter(({ level }) => value > level && edge[i]! <= level).length);
  console.log(`plate.svg: ${Math.min(...counts)}-${Math.max(...counts)} lines in the top 48 units`);
}
