// Follows the beat: works out the tempo and where the beats fall from the drum
// hits detected so far, then fires on each predicted beat, a little early, so
// the picture lands together with the beat you hear instead of after it.
//
// Why not just pulse on every hit? A raw hit stream includes off-beat drums,
// the odd mistake, and misses some beats; pulsing on it reads as out of time
// even when every single hit is on time. The beat grid fills missed beats,
// ignores off-beat hits, and can be predicted ahead of the sound.
import type { Frame } from './frame';

const WINDOW = 6; // seconds of hits considered
const MIN_P = 60 / 180; // fastest beat: 180 bpm
const MAX_P = 60 / 75; // slowest: 75 bpm
const REESTIMATE = 0.25; // seconds between tempo estimates
const LOCK = 0.3; // phase agreement needed to trust the grid (0..1)
/**
 * How long after the real attack each kind of hit is detected in live
 * listening (seconds). Measured on a recorded song against the exact attack
 * times in its audio. A dropped song's hits come from its timeline, on time.
 */
export const DETECT_DELAY: Record<string, number> = { kick: 0.074, snare: 0.058, tom: 0.07, hat: 0.058, cymbal: 0.058 };

// Hi-hats tick both on and between beats, so they count for little.
const WEIGHT: Record<string, number> = { kick: 1, snare: 0.8, tom: 0.6, hat: 0.25, cymbal: 0.3 };

export interface BeatState {
  /** Seconds between beats, or 0 when no beat is followed. */
  period: number;
  /** 0..1 how well the hits agree with the beat grid. */
  confidence: number;
  locked: boolean;
}

export class BeatTracker {
  private onsets: { t: number; w: number }[] = [];
  private period = 0;
  /** Time (on the onset clock) of one beat on the grid. */
  private anchor = 0;
  private confidence = 0;
  private nextEstimate = 0;
  private lastFired = -Infinity;

  get state(): BeatState {
    return { period: this.period, confidence: this.confidence, locked: this.locked };
  }

  private get locked() {
    return this.period > 0 && this.confidence >= LOCK;
  }

  /**
   * `now`: the frame's time (s). `lead`: how long before a beat is heard the
   * frame showing it must be drawn (capture delay + drawing delay).
   * Returns the strength of a beat that lands in this frame, or 0.
   */
  update(f: Frame, now: number, lead: number, live: boolean): number {
    for (const h of f.hits) {
      const w = (WEIGHT[h.hit] ?? 0.3) * h.v;
      const age = live ? (DETECT_DELAY[h.hit] ?? 0.06) : 0;
      if (w > 0.02) this.onsets.push({ t: now - age, w });
    }
    while (this.onsets.length && this.onsets[0].t < now - WINDOW) this.onsets.shift();
    if (now >= this.nextEstimate) {
      this.nextEstimate = now + REESTIMATE;
      this.estimate(now);
    }
    // Nothing heard for a while, or no steady beat: no pulses from the grid.
    const last = this.onsets.length ? this.onsets[this.onsets.length - 1].t : -Infinity;
    if (!this.locked || now - last > 2.5 || f.idle) return 0;
    // The beat about to be heard: fire once for it, `lead` seconds before.
    const P = this.period;
    const target = now + lead;
    const k = Math.round((target - this.anchor) / P);
    const beat = this.anchor + k * P;
    if (Math.abs(target - beat) > P * 0.25 || beat - this.lastFired < P * 0.5) return 0;
    if (target < beat - 1 / 120) return 0; // not yet: fire on the frame that reaches it
    this.lastFired = beat;
    return 0.45 + 0.55 * Math.min(1, (this.confidence - LOCK) / 0.4 + 0.3);
  }

  private estimate(now: number) {
    const on = this.onsets;
    if (on.length < 6) {
      this.confidence *= 0.7;
      return;
    }
    // Tempo: which beat period best explains the gaps between hits
    // (pairs of hits 1–4 beats apart), favouring the current tempo.
    let bestP = 0;
    let best = 0;
    for (let P = MIN_P; P <= MAX_P; P += 0.004) {
      let s = 0;
      for (let i = 0; i < on.length; i++)
        for (let j = i + 1; j < on.length; j++) {
          const d = on[j].t - on[i].t;
          if (d > 4 * P + 0.05) break;
          const k = Math.round(d / P);
          if (k < 1) continue;
          const e = d - k * P;
          if (Math.abs(e) < 0.04) s += (on[i].w * on[j].w * Math.exp(-(e * e) / (2 * 0.012 * 0.012))) / Math.sqrt(k);
        }
      // Mild preference for everyday tempos (about 90–150 bpm), and for staying put.
      s *= Math.exp(-Math.pow(Math.log(P / 0.5), 2) / (2 * 0.45 * 0.45));
      if (this.period) s *= 1 + 0.35 * Math.exp(-Math.pow((P - this.period) / 0.015, 2));
      if (s > best) {
        best = s;
        bestP = P;
      }
    }
    if (!bestP) return;
    // Where the beats fall: the position within the beat where the most hits
    // (recent ones counting most) line up. Taking the strongest cluster, not
    // the average, keeps syncopated off-beat kicks from dragging the grid
    // half a beat off. Staying put is favoured, so the grid doesn't flip.
    const P = bestP;
    const SIG = 0.025;
    let bestPh = 0;
    let bestS = -1;
    let total = 0;
    for (const o of on) total += o.w * Math.exp(-(now - o.t) / 3);
    const prevPh = this.period ? (((this.anchor % P) + P) % P) : -1;
    for (let ph = 0; ph < P; ph += 0.005) {
      let s = 0;
      for (const o of on) {
        let d = ((o.t - ph) % P + P) % P;
        if (d > P / 2) d -= P;
        s += o.w * Math.exp(-(now - o.t) / 3) * Math.exp(-(d * d) / (2 * SIG * SIG));
      }
      if (prevPh >= 0) {
        let dp = Math.abs(ph - prevPh);
        dp = Math.min(dp, P - dp);
        s *= 1 + 0.25 * Math.exp(-(dp * dp) / (2 * 0.03 * 0.03));
      }
      if (s > bestS) {
        bestS = s;
        bestPh = ph;
      }
    }
    this.period = P;
    this.anchor = bestPh;
    // Confidence: the share of the hits that sit on this grid.
    let on1 = 0;
    for (const o of on) {
      let d = ((o.t - bestPh) % P + P) % P;
      if (d > P / 2) d -= P;
      if (Math.abs(d) < 0.05) on1 += o.w * Math.exp(-(now - o.t) / 3);
    }
    const c = on1 / (total + 1e-9);
    this.confidence += (c - this.confidence) * 0.5;
  }
}
