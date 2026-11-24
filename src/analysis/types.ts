/** The four stems Demucs separates (what can be muted). */
export type PartId = 'drums' | 'bass' | 'vocals' | 'other';
export const PARTS: PartId[] = ['drums', 'bass', 'vocals', 'other'];

/** Drum pieces. */
export type Hit = 'kick' | 'snare' | 'tom' | 'hat' | 'cymbal';
export const HITS: Hit[] = ['kick', 'snare', 'tom', 'hat', 'cymbal'];

/** Pitched voices. "other" is split into chords and the high lead line. */
export type Voice = 'bass' | 'vocals' | 'chords' | 'lead';
export const VOICES: Voice[] = ['bass', 'vocals', 'chords', 'lead'];

/** Which stem each voice comes from. */
export const VOICE_PART: Record<Voice, PartId> = { bass: 'bass', vocals: 'vocals', chords: 'other', lead: 'other' };

/** A note event. Times in seconds, pitch as MIDI number, velocity 0..1. */
export interface Note {
  t: number;
  d: number;
  p: number;
  v: number;
}

/** Loudness over time, normalised to 0..1, sampled at `rate` frames/second. */
export interface Envelope {
  rate: number;
  data: Float32Array;
}

export type DrumHits = Record<Hit, number[]>;

/**
 * Everything the visualiser needs. "quick" comes from frequency bands of the
 * full mix (approximate); "deep" comes from AI stem separation + note
 * transcription.
 */
export interface SongAnalysis {
  mode: 'quick' | 'deep';
  duration: number;
  env: Record<PartId, Envelope>;
  notes: Record<Voice, Note[]>;
  hits: DrumHits;
}

export type Stems = Record<PartId, { left: Float32Array; right: Float32Array }>;

/**
 * Split the "other" stem's notes into a lead (the top line, when it sits high)
 * and chords (everything else).
 */
export function splitLead(notes: Note[]): { chords: Note[]; lead: Note[] } {
  const chords: Note[] = [];
  const lead: Note[] = [];
  let i = 0;
  while (i < notes.length) {
    let j = i + 1;
    while (j < notes.length && notes[j].t - notes[i].t < 0.06) j++;
    const group = notes.slice(i, j);
    let top = group[0];
    for (const n of group) if (n.p > top.p) top = n;
    for (const n of group) (n === top && n.p >= 69 ? lead : chords).push(n);
    i = j;
  }
  return { chords, lead };
}
