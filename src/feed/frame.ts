// A Frame is what every theme draws from: what happened since the last
// animation frame, plus how loud each part is right now. Both song playback
// (TimelineFeed) and live listening (LiveFeed) produce Frames.
import type { Hit, PartId, Voice } from '../analysis/types';
import type { Presence } from '../analysis/instruments';
import type { Spectrum } from './spectrum';

export interface HitEvent {
  hit: Hit;
  v: number; // 0..1
}

export interface NoteEvent {
  voice: Voice;
  p: number; // MIDI pitch
  v: number; // 0..1
  d: number; // remaining duration in seconds
}

export interface Frame {
  /** Song (or live clock) time in seconds. */
  t: number;
  /** Seconds since the previous frame (scaled down while paused). */
  dt: number;
  hits: HitEvent[];
  notes: NoteEvent[];
  /** Smoothed loudness of each stem, 0..1. */
  level: Record<PartId, number>;
  /** True after a seek/jump: themes should drop transient state. */
  reset: boolean;
  /** Nothing loaded: themes may draw an idle scene. */
  idle: boolean;
  /** What is actually sounding right now (all instruments together). */
  spectrum?: Spectrum;
  /** Which instrument families are audible (0..1), from sound recognition. */
  presence?: Presence;
  /** 0 = lively … 1 = calm/tender music. */
  calm?: number;
  /** Genre-driven arrangement for the Scene theme. */
  layout?: 'center' | 'stage' | 'pitch';
  /** Live only: the sung pitch right now (MIDI, fractional), or null. */
  voice?: { p: number; level: number } | null;
  /** Live only: 0..1 evidence of a drum kit from the sound itself. */
  drumEvidence?: number;
  /** 0 = silence … 1 = clearly audible, in absolute terms. */
  audible?: number;
  /** Live: 0 = calm … 1 = intense, measured from the sound itself. */
  intensity?: number;
  /** Live: 0..1 spectral flatness of the mids (distorted guitar → high, piano → low). */
  grit?: number;
  /** Live: 0..1 sustained tonal sound (strings, pads, held notes) vs punchy sound. */
  tonal?: number;
  /** Live: 0..1 how far the music has swelled relative to its usual level. */
  swell?: number;
  /** Live: 0..1 evidence of a four-on-the-floor dance beat (electronic music). */
  fourFloor?: number;
}

export const emptyLevels = (): Record<PartId, number> => ({ drums: 0, bass: 0, vocals: 0, other: 0 });

export function idleFrame(t: number, dt: number): Frame {
  return { t, dt, hits: [], notes: [], level: emptyLevels(), reset: false, idle: true };
}
