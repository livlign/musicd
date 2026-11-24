import type { Hit, Voice } from '../analysis/types';
import type { Frame } from '../feed/frame';

export interface Theme {
  readonly id: string;
  readonly name: string;
  /** Canvas size in device pixels, plus the pixel ratio. */
  resize(w: number, h: number, dpr: number): void;
  draw(ctx: CanvasRenderingContext2D, f: Frame): void;
}

export type Lane = Hit | Voice;

/** Base hue for every lane (chords are mostly coloured by pitch instead). */
export const HUE: Record<Lane, number> = {
  kick: 16,
  snare: 44,
  tom: 28,
  hat: 56,
  cymbal: 48,
  bass: 285,
  vocals: 185,
  chords: 140,
  lead: 330,
};

export const LANE_LABEL: Record<Lane, string> = {
  kick: 'Kick',
  snare: 'Snare',
  tom: 'Toms',
  hat: 'Hats',
  cymbal: 'Cymbals',
  bass: 'Bass',
  vocals: 'Vocals',
  chords: 'Chords',
  lead: 'Lead',
};

/** Pitch class -> hue, ordered by the circle of fifths so consonance = neighbours. */
export const pcHue = (midi: number) => ((((Math.round(midi) % 12) * 7) % 12) * 30 + 200) % 360;
/** Pitch class -> angle on a circle of fifths (12 o'clock = C). */
export const fifthsAngle = (midi: number) => ((((Math.round(midi) % 12) * 7) % 12) / 12) * Math.PI * 2 - Math.PI / 2;
/** Pitch class -> angle on a chromatic clock (12 o'clock = C). */
export const clockAngle = (midi: number) => ((Math.round(midi) % 12) / 12) * Math.PI * 2 - Math.PI / 2;

export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const decay = (x: number, dt: number, rate: number) => x * Math.exp(-dt * rate);

/** Soft glowing dot. */
export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, hue: number, alpha: number, sat = 90, light = 65) {
  if (alpha <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `hsla(${hue} ${sat}% ${Math.min(95, light + 20)}% / ${alpha})`);
  g.addColorStop(0.3, `hsla(${hue} ${sat}% ${light}% / ${alpha * 0.45})`);
  g.addColorStop(1, `hsla(${hue} ${sat}% ${light}% / 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Fade the previous frame instead of clearing it (motion trails). */
export function fade(ctx: CanvasRenderingContext2D, w: number, h: number, alpha: number, rgb = '5,5,12') {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(${rgb},${alpha})`;
  ctx.fillRect(0, 0, w, h);
}

/** Note lifetimes shared by several themes. */
export interface Held {
  voice: Voice;
  p: number;
  v: number;
  age: number;
  life: number; // sounding duration
  seed: number;
}
export const RELEASE = 0.45;

export function updateHeld(held: Held[], f: Frame): Held[] {
  const out = f.reset ? [] : held.filter((h) => (h.age += f.dt) < h.life + RELEASE);
  for (const n of f.notes) out.push({ voice: n.voice, p: n.p, v: n.v, age: 0, life: n.d, seed: Math.random() });
  return out;
}
/** 0..1 brightness of a held note: quick attack, hold, release. */
export function heldAlpha(h: Held) {
  const attack = clamp(h.age / 0.03);
  const rel = h.age > h.life ? 1 - (h.age - h.life) / RELEASE : 1;
  return clamp(attack * rel);
}

/**
 * How energetic the music is right now, 0.15 (gentle, no drums) … 1 (driving).
 * Themes scale motion, particle counts and flashes by it, so a quiet piece
 * looks quiet.
 */
export function energyOf(f: Frame): number {
  const drums = f.presence ? f.presence.drums : 0.5;
  const calm = f.calm ?? 0.5;
  return clamp(0.25 + drums * 0.6 + (0.5 - calm) * 0.4, 0.15, 1);
}

/** How present a part is (0..1); 1 when nothing has been recognised yet. */
export function presenceOf(f: Frame, fam: 'drums' | 'voice'): number {
  return f.presence ? clamp(f.presence[fam] * 2.5) : 1;
}
