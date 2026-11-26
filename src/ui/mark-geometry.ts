// Geometry and colours of the musicd mark: a dark record cut into shards, with a
// play-button wedge. Used both by the live logo on the page and by
// scripts/build-logo.mjs, which writes the static logo files, so keep this file
// free of imports and DOM access.
//
// Coordinates: the record is centred on 0,0 with radius 100; the drawing is
// meant for a viewBox of -120 -120 240 240. Angles are in degrees, 0 = up,
// increasing clockwise.

export const COLOR = {
  space: '#030308',
  recordCentre: '#1b1e33',
  recordRim: '#0c0d19',
  /** Lifted record colours for favicon sizes, where near-black disappears. */
  smallCentre: '#3a3f66',
  smallRim: '#2a2d4c',
  cyan: '#8fe8ff',
  indigo: '#6a5cf0',
  core: '#dffaff',
  pulse: '#e8fbff',
  groove: 'rgba(160,185,255,.055)',
  edge: 'rgba(170,195,255,.22)',
  label: 'rgba(160,190,255,.18)',
} as const;

/** The play wedge, pointing in at the centre from the left. */
export const WEDGE: [number, number] = [235, 305];
/** Cuts between the other shards (the last wraps past 360 back to the wedge). */
export const CUTS = [305, 371, 432, 493, 548, 595];
/** Every crack line, wedge edges included. */
export const CRACKS = [...CUTS.slice(0, -1), WEDGE[0]];
export const GROOVE_TRACKS = [56, 76];
export const VIEWBOX = '-120 -120 240 240';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r3(r * Math.sin(a)), r3(-r * Math.cos(a))];
}

/** A filled ring or pie slice between radii r0..r1 and angles a0..a1. */
export function sector(r0: number, r1: number, a0: number, a1: number): string {
  const lg = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  if (r0 <= 0) return `M0 0L${x0} ${y0}A${r1} ${r1} 0 ${lg} 1 ${x1} ${y1}Z`;
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${lg} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${lg} 0 ${x3} ${y3}Z`;
}

export function arc(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/** The two straight cuts of a slice (where the gap to its neighbours is drawn). */
export function cutsPath(a0: number, a1: number): string {
  const [x0, y0] = polar(101, a0);
  const [x1, y1] = polar(101, a1);
  return `M${x0} ${y0}L0 0L${x1} ${y1}`;
}

export function crackLine(a: number): [number, number, number, number] {
  return [...polar(6, a), ...polar(99.5, a)];
}

/** The shards other than the wedge, as [a0, a1] pairs. */
export const SHARDS: [number, number][] = CUTS.slice(0, -1).map((a, i) => [a, CUTS[i + 1]]);

/** Groove radii drawn on each shard. */
export function grooveRadii(): number[] {
  const out: number[] = [];
  for (let r = 30; r <= 96; r += 3.1) out.push(r3(r));
  return out;
}
