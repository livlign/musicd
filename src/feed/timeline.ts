// Turns a precomputed SongAnalysis into per-frame events while a song plays.
import type { Hit, Note, PartId, SongAnalysis, Voice } from '../analysis/types';
import { HITS, PARTS, VOICES, VOICE_PART } from '../analysis/types';
import type { Frame, HitEvent, NoteEvent } from './frame';
import { emptyLevels } from './frame';

export class TimelineFeed {
  private lastT = 0;
  private hitCursor = {} as Record<Hit, number>;
  private noteCursor = {} as Record<Voice, number>;
  private level = emptyLevels();
  private pendingReset = true;

  constructor(private a: SongAnalysis, t = 0) {
    this.seek(t);
  }

  private seek(t: number) {
    this.lastT = t;
    this.pendingReset = true;
    const first = (n: number, get: (i: number) => number) => {
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (get(m) <= t) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    for (const h of HITS) this.hitCursor[h] = first(this.a.hits[h].length, (i) => this.a.hits[h][i]);
    for (const v of VOICES) this.noteCursor[v] = first(this.a.notes[v].length, (i) => this.a.notes[v][i].t);
  }

  next(t: number, dt: number, muted: ReadonlySet<PartId>): Frame {
    const a = this.a;
    if (t < this.lastT - 0.05 || t > this.lastT + 1) this.seek(t);
    const reset = this.pendingReset;
    const hits: HitEvent[] = [];
    const notes: NoteEvent[] = [];

    if (reset) {
      // Re-announce notes that are still sounding at the new position.
      for (const voice of VOICES) {
        const list = a.notes[voice];
        for (let i = Math.max(0, this.noteCursor[voice] - 48); i < this.noteCursor[voice]; i++) {
          const n = list[i];
          if (n.t + n.d > t) notes.push(noteEvent(voice, n, t));
        }
      }
      this.pendingReset = false;
    }

    const drumEnv = a.env.drums;
    const drumLevel = (time: number) => Math.min(1, Math.max(0.35, drumEnv.data[Math.floor(time * drumEnv.rate) + 2] ?? 0.7));
    for (const h of HITS) {
      const list = a.hits[h];
      while (this.hitCursor[h] < list.length && list[this.hitCursor[h]] <= t) {
        const time = list[this.hitCursor[h]++];
        hits.push({ hit: h, v: drumLevel(time) });
      }
    }
    for (const voice of VOICES) {
      const list = a.notes[voice];
      while (this.noteCursor[voice] < list.length && list[this.noteCursor[voice]].t <= t) {
        notes.push(noteEvent(voice, list[this.noteCursor[voice]++], t));
      }
    }

    for (const p of PARTS) {
      const e = a.env[p];
      const target = muted.has(p) ? 0 : (e.data[Math.floor(t * e.rate)] ?? 0);
      this.level[p] += (target - this.level[p]) * (target > this.level[p] ? 0.5 : 0.12);
    }
    this.lastT = t;
    return {
      t,
      dt,
      hits: muted.has('drums') ? [] : hits,
      notes: notes.filter((n) => !muted.has(VOICE_PART[n.voice])),
      level: { ...this.level },
      reset,
      idle: false,
    };
  }
}

function noteEvent(voice: Voice, n: Note, t: number): NoteEvent {
  return { voice, p: n.p, v: n.v, d: Math.max(0.05, n.t + n.d - t) };
}
