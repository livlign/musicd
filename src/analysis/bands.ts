// Main-thread analysis built on OfflineAudioContext band filters.
// Used for the instant "quick" preview (on the full mix) and for splitting
// the separated drum stem into kick / snare / tom / hi-hat / cymbal hits.
import { ENV_RATE, envelope, normalise, onsets } from './dsp';
import type { DrumHits, Envelope, Note, SongAnalysis } from './types';
import { splitLead } from './types';

const SR = 22050;

type Filter = { type: BiquadFilterType; freq: number; q?: number };
type Band = Filter[];

const lp = (freq: number): Filter => ({ type: 'lowpass', freq, q: 0.707 });
const hp = (freq: number): Filter => ({ type: 'highpass', freq, q: 0.707 });

/** Render each band (a chain of biquads) into its own mono channel at 22.05 kHz. */
async function renderBands(buffer: AudioBuffer, bands: Band[]): Promise<Float32Array[]> {
  const length = Math.ceil(buffer.duration * SR);
  const ctx = new OfflineAudioContext({ numberOfChannels: bands.length, length, sampleRate: SR });
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const merger = ctx.createChannelMerger(bands.length);
  bands.forEach((chain, i) => {
    let node: AudioNode = src;
    for (const f of chain) {
      const bq = ctx.createBiquadFilter();
      bq.type = f.type;
      bq.frequency.value = f.freq;
      if (f.q !== undefined) bq.Q.value = f.q;
      node.connect(bq);
      node = bq;
    }
    node.connect(merger, 0, i);
  });
  merger.connect(ctx.destination);
  ctx.destination.channelCount = bands.length;
  ctx.destination.channelCountMode = 'explicit';
  ctx.destination.channelInterpretation = 'discrete';
  src.start();
  const out = await ctx.startRendering();
  return bands.map((_, i) => out.getChannelData(i));
}

const DRUM_BANDS: Band[] = [
  [lp(110), lp(110)], // kick
  [hp(1500), hp(1500), lp(4500), lp(4500), lp(4500)], // snare crack
  [hp(8000), hp(8000)], // hats / cymbals
  [hp(90), hp(90), lp(300), lp(300)], // tom bodies
];

const peakAt = (env: Float32Array, t: number, frames = 4) => {
  const i = Math.floor(t * ENV_RATE);
  let m = 0;
  for (let j = i; j < i + frames && j < env.length; j++) m = Math.max(m, env[j]);
  return m;
};
const loudLevel = (env: Float32Array) => {
  const sorted = Float32Array.from(env).sort();
  return sorted[Math.floor(sorted.length * 0.97)] || 1e-6;
};
const near = (times: number[], t: number, tol: number) => times.some((x) => Math.abs(x - t) < tol);

/**
 * Classify drum hits from band signals. `fromMix` = the bands come from the
 * full mix rather than an isolated drum stem, so be stricter and skip toms
 * (the tom band is full of bass and vocals in a mix).
 */
function hitsFromBands(kick: Float32Array, snare: Float32Array, high: Float32Array, tom: Float32Array, fromMix: boolean): DrumHits {
  const raw = (x: Float32Array) => envelope(x, SR, ENV_RATE, false).data;
  const kickEnv = raw(kick);
  const snareEnv = raw(snare);
  const highEnv = raw(high);
  const tomEnv = raw(tom);
  const s = fromMix ? 1.4 : 1;

  const kicks = onsets(kickEnv, ENV_RATE, { minGap: 0.12, sensitivity: 1.2 * s, minLevel: 0.35 });
  const snares = pickSnares(onsets(snareEnv, ENV_RATE, { minGap: 0.1, sensitivity: 1.2 * s, minLevel: 0.3 }), snareEnv);

  // High band: a cymbal keeps ringing, a hi-hat dies away quickly.
  const hats: number[] = [];
  const cymbals: number[] = [];
  const highLoud = loudLevel(highEnv);
  for (const t of onsets(highEnv, ENV_RATE, { minGap: 0.06, sensitivity: 1.0 * s, minLevel: 0.12 })) {
    const peak = peakAt(highEnv, t);
    const tail = peakAt(highEnv, t + 0.35, 3);
    if (peak > highLoud * 0.6 && tail > peak * 0.45) cymbals.push(t);
    else hats.push(t);
  }

  // Toms: low-mid hits that are not a kick or snare, louder in the tom band
  // than in the kick band.
  const toms: number[] = [];
  if (!fromMix) {
    for (const t of onsets(tomEnv, ENV_RATE, { minGap: 0.08, sensitivity: 1.5, minLevel: 0.6 })) {
      if (near(kicks, t, 0.07) || near(snares, t, 0.07)) continue;
      if (peakAt(tomEnv, t) > peakAt(kickEnv, t) * 1.5) toms.push(t);
    }
  }
  return { kick: kicks, snare: snares, tom: toms, hat: hats, cymbal: cymbals };
}

/**
 * Hi-hats also light up the snare band, but a real snare hit is much louder
 * there. Keep candidates whose crack-band peak is close to the strongest hits
 * of this song (self-calibrating; drops ghost notes, which is fine visually).
 */
function pickSnares(candidates: number[], snareEnv: Float32Array): number[] {
  if (candidates.length === 0) return [];
  const levels = candidates.map((t) => peakAt(snareEnv, t));
  const sorted = [...levels].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.9)];
  return candidates.filter((_, i) => levels[i] >= ref * 0.72);
}

/** Drum hits from an isolated drum stem. */
export async function drumHits(drums: AudioBuffer): Promise<DrumHits> {
  const [k, s, h, t] = await renderBands(drums, DRUM_BANDS);
  return hitsFromBands(k, s, h, t, false);
}

/** Instant approximation of every part, from frequency bands of the full mix. */
export async function quickAnalysis(mix: AudioBuffer): Promise<SongAnalysis> {
  const [full, kick, snare, high, tom, bass, mid, presence] = await renderBands(mix, [
    [],
    ...DRUM_BANDS,
    [hp(45), lp(250), lp(250)], // bass
    [hp(250), hp(250), lp(1000)], // keys / guitars body
    [hp(1000), lp(3500), lp(3500)], // vocal presence
  ]);
  const hits = hitsFromBands(kick, snare, high, tom, true);

  const rawEnv = (x: Float32Array) => envelope(x, SR, ENV_RATE, false);
  const norm = (e: Envelope): Envelope => {
    const data = Float32Array.from(e.data);
    normalise(data);
    return { rate: e.rate, data };
  };
  const bassRaw = rawEnv(bass);
  const midRaw = rawEnv(mid);
  const presRaw = rawEnv(presence);
  const drumEnv = rawEnv(kick);
  const highEnv = rawEnv(high).data;
  for (let i = 0; i < drumEnv.data.length; i++) drumEnv.data[i] += (highEnv[i] ?? 0) * 2;

  const bassEnv = norm(bassRaw);
  const midEnv = norm(midRaw);
  const presEnv = norm(presRaw);

  const notesFrom = (raw: Envelope, env: Envelope, lo: number, hi: number, voices: number, minGap: number): Note[] => {
    const times = onsets(raw.data, ENV_RATE, { minGap, sensitivity: 1.3 });
    const notes: Note[] = [];
    times.forEach((t, i) => {
      const next = times[i + 1] ?? t + 1;
      const d = Math.min(1.2, Math.max(0.12, next - t));
      const v = Math.min(1, env.data[Math.floor(t * ENV_RATE) + 2] ?? 0.5);
      for (const p of spectralPitches(full, t + 0.04, lo, hi, voices)) notes.push({ t, d, p, v });
    });
    return notes;
  };
  const { chords, lead } = splitLead(notesFrom(midRaw, midEnv, 200, 1600, 3, 0.1));

  return {
    mode: 'quick',
    duration: mix.duration,
    env: { drums: norm(drumEnv), bass: bassEnv, other: midEnv, vocals: presEnv },
    notes: {
      bass: notesFrom(bassRaw, bassEnv, 40, 250, 1, 0.12),
      vocals: notesFrom(presRaw, presEnv, 150, 900, 1, 0.15),
      chords,
      lead,
    },
    hits,
  };
}

// ---------------------------------------------------------------------------
// Rough pitch guess: strongest spectral peaks in a frequency range.

const FFT_N = 8192;
const hann = (() => {
  const w = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_N - 1));
  return w;
})();

export function spectralPitches(signal: Float32Array, t: number, lo: number, hi: number, voices: number): number[] {
  const start = Math.floor(t * SR);
  if (start + FFT_N > signal.length) return [];
  const re = new Float32Array(FFT_N);
  const im = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) re[i] = signal[start + i] * hann[i];
  fft(re, im);
  const binHz = SR / FFT_N;
  const a = Math.ceil(lo / binHz);
  const b = Math.min(FFT_N / 2 - 1, Math.floor(hi / binHz));
  const mag = (k: number) => Math.hypot(re[k], im[k]);
  const peaks: { k: number; m: number }[] = [];
  for (let k = a; k <= b; k++) {
    const m = mag(k);
    if (m > mag(k - 1) && m >= mag(k + 1)) peaks.push({ k, m });
  }
  peaks.sort((x, y) => y.m - x.m);
  const out: number[] = [];
  const top = peaks[0]?.m ?? 0;
  for (const { k, m } of peaks) {
    if (out.length >= voices || m < top * 0.35) break;
    const midi = Math.round(69 + 12 * Math.log2((k * binHz) / 440));
    if (out.every((p) => p % 12 !== midi % 12)) out.push(midi);
  }
  return out;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}
