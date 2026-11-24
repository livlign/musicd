// Real-time analysis of a live audio stream (a shared tab, or an input
// device such as a PulseAudio/PipeWire "Monitor" of the speakers).
// No AI separation is possible here, so parts are estimated from frequency
// bands, streaming onset detection and spectral peaks.
import type { Voice } from '../analysis/types';
import type { Frame, HitEvent, NoteEvent } from './frame';
import { emptyLevels } from './frame';
import { SpectrumTap } from './spectrum';

// Calibrated on test clips: percussive share of the sound was ~0.19 for solo
// piano (regular notes, no drums), 0.24–0.30 for music with a drum kit.
const DRUM_SHARE_LO = 0.21;
const DRUM_SHARE_SPAN = 0.06;
const VOICE_CONF = 2.2;

/** Streaming onset detector on a band's energy, with automatic gain. */
class Onset {
  // Recent log-energies: frames overlap heavily at 60 fps, so compare with
  // the quietest of the last few frames (~50 ms) to see the whole attack.
  private hist = [0, 0, 0];
  private mean = 0;
  private sq = 0;
  private last = -1;
  peak = 1e-9;

  constructor(
    private minGap: number,
    private k: number,
    private floor: number,
  ) {}

  /** Returns hit strength 0..1, or 0 if no onset this frame. */
  push(energy: number, t: number, dt: number): number {
    const v = Math.log10(energy + 1e-12);
    const flux = Math.max(0, v - Math.min(...this.hist));
    this.hist.shift();
    this.hist.push(v);
    const a = 1 - Math.exp(-dt / 0.6);
    const sd = Math.sqrt(Math.max(0, this.sq - this.mean * this.mean));
    const thresh = this.mean + this.k * sd + 0.08;
    this.mean += (flux - this.mean) * a;
    this.sq += (flux * flux - this.sq) * a;
    this.peak = Math.max(energy, this.peak * Math.exp(-dt / 4));
    if (flux > thresh && energy > this.peak * this.floor && t - this.last > this.minGap) {
      this.last = t;
      return Math.min(1, Math.sqrt(energy / this.peak));
    }
    return 0;
  }
}

/** Slowly adapting normaliser so levels sit in 0..1 whatever the volume. */
class Agc {
  peak = 1e-9;
  norm(x: number, dt: number) {
    this.peak = Math.max(x, this.peak * Math.exp(-dt / 6));
    return Math.min(1, Math.sqrt(x / this.peak));
  }
}

export class LiveFeed {
  /** All captured streams mixed together (what gets analysed). */
  readonly source: GainNode;
  private inputs: MediaStreamAudioSourceNode[];
  private small: AnalyserNode;
  private big: AnalyserNode;
  private smallDb: Float32Array<ArrayBuffer>;
  private bigDb: Float32Array<ArrayBuffer>;
  private det = {
    kick: new Onset(0.12, 0.6, 0.25),
    snare: new Onset(0.1, 1.6, 0.55),
    high: new Onset(0.06, 1.3, 0.2),
    bass: new Onset(0.12, 1.3, 0.3),
    mid: new Onset(0.1, 1.3, 0.3),
    pres: new Onset(0.14, 1.3, 0.35),
  };
  private agc = { drums: new Agc(), bass: new Agc(), vocals: new Agc(), other: new Agc() };
  private level = emptyLevels();
  private lastVocal = { p: 0, t: -1 };
  // Signal-based drum evidence (the classifier often misses drums in a dense mix).
  private drumOnsets: number[] = [];
  private percShare = 0;
  private drumEvidence = 0;
  private evidenceAt = 0;
  /** Raw drum-evidence features, exposed for calibration/testing. */
  debugDrums = { reg: 0, rate: 0, share: 0 };
  // Continuous vocal pitch.
  private f0Hist: number[] = [];
  private voiceHeld: { p: number; t: number } | null = null;
  private jump = { p: 0, n: 0 };
  private voiceNote = { p: -1, count: 0, cand: -1 };
  debugVoice = { conf: 0, p: 0 };
  debugIntensity = { punch: 0, loud: 0, dens: 0, full: 0, bright: 0, i: 0, grit: 0, tonal: 0, swell: 0 };
  /** Typical high-band energy of a hi-hat hit; crashes are much louder. */
  private hatLevel = 0;
  private start: number;
  private tap: SpectrumTap;
  // Real-time harmonic/percussive separation (median filtering).
  private hist: Float32Array[] = [];
  private mag!: Float32Array;
  private perc!: Float32Array;
  private harm!: Float32Array;
  private kMax = 0;
  private lastChord = { t: -1, pcs: '' };
  private bassTrack = { cand: -1, count: 0, last: -1, t: -1 };
  private lastKick = -1;
  /** Every attack from any detector (drums or instruments), for intensity. */
  private attacks: number[] = [];
  private intensity = 0;
  /** Smoothed spectral flatness of the 1–5 kHz range: rough/distorted vs clean. */
  private grit = 0;
  private tonalAgc = new Agc();
  private tonal = 0;
  private swell = 0;
  private kickTimes: number[] = [];
  /** 0..1: kicks on every beat at a steady tempo (electronic dance music). */
  private fourFloor = 0;
  debugKicks = { median: 0, steady: 0, n: 0 };

  constructor(
    private ctx: AudioContext,
    readonly streams: MediaStream[],
  ) {
    this.source = ctx.createGain();
    this.inputs = streams.map((s) => {
      const n = ctx.createMediaStreamSource(s);
      n.connect(this.source);
      return n;
    });
    this.small = ctx.createAnalyser();
    this.small.fftSize = 2048;
    this.small.smoothingTimeConstant = 0;
    this.big = ctx.createAnalyser();
    this.big.fftSize = 8192;
    this.big.smoothingTimeConstant = 0.3;
    this.source.connect(this.small);
    this.source.connect(this.big);
    this.smallDb = new Float32Array(this.small.frequencyBinCount);
    this.bigDb = new Float32Array(this.big.frequencyBinCount);
    this.start = ctx.currentTime;
    this.tap = new SpectrumTap(ctx, this.source);
    // The browser marks a capture track muted when its source stops sending audio.
    const watch = () => (this.tap.muted = this.streams.every((s) => s.getAudioTracks().every((t) => t.muted)));
    for (const s of streams) for (const tr of s.getAudioTracks()) {
      tr.addEventListener('mute', watch);
      tr.addEventListener('unmute', watch);
    }
    this.kMax = Math.min(this.smallDb.length - 1, Math.ceil(16000 / (ctx.sampleRate / this.small.fftSize)));
    this.mag = new Float32Array(this.kMax + 1);
    this.perc = new Float32Array(this.kMax + 1);
    this.harm = new Float32Array(this.kMax + 1);
  }

  /**
   * Split the current spectrum into percussive (short, broadband: drums) and
   * harmonic (sustained, pitched: everything else) parts. A sound that stays
   * the same over time is harmonic; one that is smeared across frequencies
   * in a single frame is percussive.
   */
  private separate() {
    const n = this.kMax + 1;
    for (let k = 0; k < n; k++) this.mag[k] = Math.pow(10, this.smallDb[k] / 20);
    this.hist.push(Float32Array.from(this.mag));
    if (this.hist.length > 13) this.hist.shift();
    const tmp = new Float32Array(this.hist.length);
    const win = new Float32Array(13);
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < this.hist.length; j++) tmp[j] = this.hist[j][k];
      const H = median(tmp);
      let m = 0;
      for (let j = -6; j <= 6; j++) win[m++] = this.mag[Math.min(n - 1, Math.max(0, k + j))];
      const P = median(win);
      const mask = (P * P) / (P * P + H * H + 1e-20);
      this.perc[k] = this.mag[k] * mask;
      this.harm[k] = this.mag[k] * (1 - mask);
    }
  }

  private bandPower(spec: Float32Array, lo: number, hi: number) {
    const binHz = this.ctx.sampleRate / this.small.fftSize;
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.min(this.kMax, Math.ceil(hi / binHz));
    let s = 0;
    for (let i = a; i <= b; i++) s += spec[i] * spec[i];
    return s;
  }

  /** The stream ended (tab closed, sharing stopped). */
  get ended() {
    return this.streams.every((s) => s.getAudioTracks().every((t) => t.readyState === 'ended'));
  }

  stop() {
    for (const n of this.inputs) n.disconnect();
    this.source.disconnect();
    for (const s of this.streams) for (const t of s.getTracks()) t.stop();
  }

  /** Strongest distinct pitch classes in a frequency range, from the big FFT. */
  private pitches(lo: number, hi: number, voices: number): number[] {
    const db = this.bigDb;
    const binHz = this.ctx.sampleRate / this.big.fftSize;
    const a = Math.max(2, Math.floor(lo / binHz));
    const b = Math.min(db.length - 2, Math.ceil(hi / binHz));
    const peaks: { k: number; m: number }[] = [];
    for (let k = a; k <= b; k++) if (db[k] > db[k - 1] && db[k] >= db[k + 1]) peaks.push({ k, m: db[k] });
    peaks.sort((x, y) => y.m - x.m);
    const out: number[] = [];
    const top = peaks[0]?.m ?? -Infinity;
    for (const { k, m } of peaks) {
      if (out.length >= voices || m < top - 9) break;
      // Parabolic interpolation for a finer frequency estimate.
      const l = db[k - 1];
      const r = db[k + 1];
      const off = (0.5 * (l - r)) / (l - 2 * db[k] + r || 1);
      const midi = Math.round(69 + 12 * Math.log2(((k + off) * binHz) / 440));
      if (out.every((p) => p % 12 !== midi % 12)) out.push(midi);
    }
    return out;
  }

  next(dt: number): Frame {
    const t = this.ctx.currentTime - this.start;
    const step = Math.max(1 / 240, dt);
    this.small.getFloatFrequencyData(this.smallDb);
    this.big.getFloatFrequencyData(this.bigDb);
    this.separate();
    const spectrum = this.tap.read(step);
    // Drums from the percussive part only; pitched parts from the harmonic part.
    const pe = (lo: number, hi: number) => this.bandPower(this.perc, lo, hi);
    const he = (lo: number, hi: number) => this.bandPower(this.harm, lo, hi);
    const kickE = pe(35, 120);
    const snareE = pe(1500, 4500);
    const highE = pe(7000, 16000);
    const bassE = he(45, 250);
    const midE = he(250, 1000);
    const presE = he(1000, 3500);

    const hits: HitEvent[] = [];
    const notes: NoteEvent[] = [];
    const kick = this.det.kick.push(kickE, t, step);
    if (kick) {
      this.drumOnsets.push(t);
      this.kickTimes.push(t);
      hits.push({ hit: 'kick', v: kick });
      this.lastKick = t;
    }
    const snare = this.det.snare.push(snareE, t, step);
    if (snare) {
      this.drumOnsets.push(t);
      hits.push({ hit: 'snare', v: snare });
    }
    const high = this.det.high.push(highE, t, step);
    if (high) {
      // A crash is a splash of highs far louder than the usual hi-hat.
      const crash = this.hatLevel > 0 && highE > this.hatLevel * 3.5;
      this.hatLevel = this.hatLevel ? this.hatLevel * 0.85 + highE * 0.15 : highE;
      hits.push({ hit: crash ? 'cymbal' : 'hat', v: high });
      this.drumOnsets.push(t);
    }
    this.updateDrumEvidence(t, step);

    // Bass: a note starts when a steady new pitch appears, or on a fresh
    // attack in the (unseparated) low end for repeated notes.
    const attack = this.det.bass.push(this.bandPower(this.mag, 45, 250), t, step);
    // The kick's low thump looks like a bass note for ~150 ms: ignore that window.
    const afterKick = t - this.lastKick < 0.15;
    const [bp] = bassE > this.det.mid.peak * 0.02 && !afterKick ? this.pitches(40, 250, 1) : [];
    const bt = this.bassTrack;
    if (afterKick) bt.count = 0;
    else if (bp === undefined) bt.cand = -1;
    else {
      bt.count = bp === bt.cand ? bt.count + 1 : 1;
      bt.cand = bp;
      const steady = bt.count >= 5;
      if (steady && (bp !== bt.last || (attack && t - bt.t > 0.25))) {
        notes.push({ voice: 'bass', p: bp, v: Math.max(attack, 0.6), d: 0.4 });
        bt.last = bp;
        bt.t = t;
      }
    }
    // Chords from the overall harmony (chroma): announce the strongest pitch
    // classes on a new harmonic attack, or when the harmony clearly changes.
    const mid = this.det.mid.push(midE, t, step);
    const pcs = [...spectrum.chroma]
      .map((v, pc) => ({ v, pc }))
      .filter((c) => c.v > 0.55)
      .sort((a, b) => b.v - a.v)
      .slice(0, 4);
    const key = pcs.map((c) => c.pc).sort((a, b) => a - b).join(',');
    const harmonic = midE > this.det.mid.peak * 0.08;
    if (harmonic && pcs.length && (mid || (key !== this.lastChord.pcs && t - this.lastChord.t > 0.3))) {
      for (const c of pcs) notes.push({ voice: 'chords', p: 60 + c.pc, v: Math.max(mid, 0.4) * c.v, d: 0.6 });
      this.lastChord = { t, pcs: key };
    }
    if (mid) {
      const [top] = this.pitches(650, 2500, 1);
      if (top !== undefined) notes.push({ voice: 'lead' as Voice, p: top, v: mid, d: 0.4 });
    }
    // Voice: follow the sung pitch continuously, every frame.
    const pres = this.det.pres.push(presE, t, step);
    const voice = this.steadyVoice(this.trackVoice(presE), t);
    if (voice) {
      // Other themes get a note whenever the sung pitch settles on a new semitone.
      const n = Math.round(voice.p);
      const vn = this.voiceNote;
      vn.count = n === vn.cand ? vn.count + 1 : 1;
      vn.cand = n;
      if (vn.count === 3 && (n !== vn.p || pres)) {
        notes.push({ voice: 'vocals', p: n, v: Math.max(0.5, pres), d: 0.3 });
        vn.p = n;
      }
    } else this.voiceNote.cand = -1;

    const target = {
      drums: this.agc.drums.norm(kickE + snareE * 4 + highE * 8, step),
      bass: this.agc.bass.norm(bassE, step),
      vocals: this.agc.vocals.norm(presE, step),
      other: this.agc.other.norm(midE, step),
    };
    // Auto-levelling must never turn silence into motion: scale everything by
    // how audible the sound is in absolute terms, and drop events in silence.
    const audible = spectrum.audible;
    for (const k of Object.keys(target) as (keyof typeof target)[]) {
      const tg = target[k] * audible;
      this.level[k] += (tg - this.level[k]) * (tg > this.level[k] ? 0.5 : 0.12);
    }
    // Intensity straight from the sound, independent of instrument guesses:
    // loudness, how many attacks per second, how full and how bright it is.
    if (hits.length || attack || mid) this.attacks.push(t);
    while (this.attacks.length && this.attacks[0] < t - 3) this.attacks.shift();
    const c01 = (x: number) => Math.max(0, Math.min(1, x));
    // Loudness relative to the music's own level (independent of system volume).
    const loud = c01((spectrum.loudestDb - (this.tap.musicRef - 18)) / 18);
    const dens = c01(this.attacks.length / 3 / 7);
    let full = 0;
    let hiSum = 0;
    let allSum = 0;
    for (let i = 0; i < spectrum.bands.length; i++) {
      if (spectrum.bands[i] > 0.5) full++;
      allSum += spectrum.bands[i];
      if (i >= spectrum.bands.length - 14) hiSum += spectrum.bands[i];
    }
    const fullness = full / spectrum.bands.length;
    const bright = c01((hiSum / 14) / (allSum / spectrum.bands.length + 1e-6) - 0.4);
    // Punch (share of percussive, noisy sound: drums, distorted guitars) is
    // what separates intense music from busy-but-gentle music (measured: solo
    // piano 0.19, a ballad verse 0.17, a drummed chorus 0.30).
    const punch = c01((this.percShare - 0.19) / 0.1);
    const intense = audible * c01(0.55 * punch + 0.15 * loud + 0.15 * dens + 0.15 * Math.max(bright, c01(fullness * 1.6) * 0.5));
    this.intensity += (intense - this.intensity) * (1 - Math.exp(-step / (intense > this.intensity ? 2 : 4)));
    this.debugIntensity = { tonal: this.debugIntensity.tonal, swell: this.debugIntensity.swell, grit: this.debugIntensity.grit, punch: +punch.toFixed(2), loud: +loud.toFixed(2), dens: +dens.toFixed(2), full: +fullness.toFixed(2), bright: +bright.toFixed(2), i: +this.intensity.toFixed(2) };

    // Grit: how noise-like the 1–5 kHz range is. Distorted guitars are rough
    // (flat spectrum); piano and clean tones are peaky.
    {
      const binHz = this.ctx.sampleRate / this.small.fftSize;
      const a = Math.floor(1000 / binHz);
      const b = Math.min(this.kMax, Math.ceil(5000 / binHz));
      let logSum = 0;
      let sum = 0;
      for (let k = a; k <= b; k++) {
        const pw = this.mag[k] * this.mag[k] + 1e-20;
        logSum += Math.log(pw);
        sum += pw;
      }
      const n = b - a + 1;
      const flat = Math.exp(logSum / n) / (sum / n);
      if (audible > 0.5) this.grit += (flat - this.grit) * (1 - Math.exp(-step / 1.5));
    }
    this.debugIntensity.grit = +this.grit.toFixed(3);
    // Tonal: sustained pitched sound (strings, pads, choirs, held notes), and
    // little of it percussive. Swell: loudness against the music's usual level.
    const harmE = this.bandPower(this.harm, 120, 6000);
    const sustained = c01((0.3 - this.percShare) / 0.12);
    const tonalNow = audible * this.tonalAgc.norm(harmE, step) * (0.25 + 0.75 * sustained);
    this.tonal += (tonalNow - this.tonal) * (1 - Math.exp(-step / 0.8));
    const swellNow = audible * c01((spectrum.loudestDb - (this.tap.musicRef - 14)) / 14);
    this.swell += (swellNow - this.swell) * (1 - Math.exp(-step / 1.2));
    this.debugIntensity.tonal = +this.tonal.toFixed(2);
    this.debugIntensity.swell = +this.swell.toFixed(2);

    // Four-on-the-floor: are the kicks evenly spaced at a dance tempo?
    while (this.kickTimes.length && this.kickTimes[0] < t - 8) this.kickTimes.shift();
    if (this.kickTimes.length >= 6) {
      const iv: number[] = [];
      for (let i = 1; i < this.kickTimes.length; i++) iv.push(this.kickTimes[i] - this.kickTimes[i - 1]);
      const med = [...iv].sort((a, b) => a - b)[iv.length >> 1];
      const steady = iv.filter((d) => Math.abs(d - med) < med * 0.12).length / iv.length;
      const danceTempo = med > 0.36 && med < 0.56 ? 1 : 0;
      const ff = danceTempo * c01((steady - 0.55) / 0.3);
      this.fourFloor += (ff - this.fourFloor) * (1 - Math.exp(-step / 3));
      this.debugKicks = { median: +med.toFixed(3), steady: +steady.toFixed(2), n: this.kickTimes.length };
    } else this.fourFloor *= Math.exp(-step / 6);

    const quiet = audible < 0.35;
    return {
      t,
      dt,
      hits: quiet ? [] : hits,
      notes: quiet ? [] : notes,
      level: { ...this.level },
      reset: false,
      idle: false,
      spectrum,
      voice: quiet ? null : voice,
      drumEvidence: this.drumEvidence * audible,
      audible,
      intensity: this.intensity,
      grit: this.grit,
      fourFloor: this.fourFloor,
      tonal: this.tonal,
      swell: this.swell,
    };
  }

  /**
   * Drums leave a steady, regular pattern of short broadband attacks. Measure
   * how much of the sound is percussive, how often attacks come, and how
   * regular their spacing is (a beat). Piano attacks are pitched and fade,
   * so they score low.
   */
  private updateDrumEvidence(t: number, dt: number) {
    const P = this.bandPower(this.perc, 35, 16000);
    const Hh = this.bandPower(this.harm, 35, 16000);
    const share = P / (P + Hh + 1e-20);
    this.percShare += (share - this.percShare) * (1 - Math.exp(-dt / 3));
    while (this.drumOnsets.length && this.drumOnsets[0] < t - 6) this.drumOnsets.shift();
    if (t - this.evidenceAt < 0.5) return;
    this.evidenceAt = t;
    const ts = this.drumOnsets;
    const rate = ts.length / 6;
    let reg = 0;
    if (ts.length >= 8) {
      for (let lag = 0.2; lag <= 1.0; lag += 0.01) {
        let hit = 0;
        for (let i = 0; i < ts.length; i++) {
          const want = ts[i] + lag;
          if (want > t) break;
          for (let j = i + 1; j < ts.length && ts[j] < want + 0.04; j++) {
            if (Math.abs(ts[j] - want) < 0.035) {
              hit++;
              break;
            }
          }
        }
        reg = Math.max(reg, hit / ts.length);
      }
    }
    this.debugDrums = { reg: +reg.toFixed(2), rate: +rate.toFixed(2), share: +this.percShare.toFixed(3) };
    const c = (x: number) => Math.max(0, Math.min(1, x));
    const target = c((reg - 0.45) / 0.2) * c((rate - 1.5) / 2) * c((this.percShare - DRUM_SHARE_LO) / DRUM_SHARE_SPAN);
    this.drumEvidence += (target - this.drumEvidence) * (target > this.drumEvidence ? 0.5 : 0.15);
  }

  /**
   * Make the tracked pitch read like a voice: bridge short dropouts (a breath,
   * a consonant), and accept a big leap only once it persists, so octave
   * errors don't draw spikes.
   */
  private steadyVoice(v: { p: number; level: number } | null, t: number) {
    const held = this.voiceHeld;
    if (!v) {
      if (held && t - held.t < 0.3) return { p: held.p, level: this.level.vocals };
      this.voiceHeld = null;
      return null;
    }
    if (held && Math.abs(v.p - held.p) > 7) {
      this.jump.n = Math.abs(v.p - this.jump.p) < 1 ? this.jump.n + 1 : 1;
      this.jump.p = v.p;
      if (this.jump.n < 5) return { p: held.p, level: v.level };
    }
    this.voiceHeld = { p: v.p, t };
    return v;
  }

  /**
   * Sung pitch by harmonic summation on the high-resolution spectrum: the
   * fundamental whose overtones carry the most energy. Returns null when no
   * clear pitched voice is present.
   */
  private trackVoice(presE: number): { p: number; level: number } | null {
    const db = this.bigDb;
    const binHz = this.ctx.sampleRate / this.big.fftSize;
    const mag = (f: number) => {
      const k = f / binHz;
      const i = Math.floor(k);
      if (i < 1 || i + 1 >= db.length) return 0;
      const a = Math.pow(10, db[i] / 20);
      const b = Math.pow(10, db[i + 1] / 20);
      return a + (b - a) * (k - i);
    };
    let best = -1;
    let bestS = 0;
    let sum = 0;
    let count = 0;
    const sal = new Map<number, number>();
    for (let m = 45; m <= 84; m += 0.25) {
      const f0 = 440 * Math.pow(2, (m - 69) / 12);
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.pow(0.85, h - 1) * mag(f0 * h);
      sal.set(m, s);
      sum += s;
      count++;
      if (s > bestS) {
        bestS = s;
        best = m;
      }
    }
    // Harmonic summation tends to pick the octave below; prefer the octave up
    // when it explains almost as much.
    const up = sal.get(best + 12);
    if (up !== undefined && up > bestS * 0.85) best += 12;
    const conf = bestS / (sum / count + 1e-12);
    this.debugVoice = { conf: +conf.toFixed(2), p: best };
    const loud = presE > this.det.pres.peak * 0.12;
    if (conf < VOICE_CONF || !loud) {
      this.f0Hist = [];
      return null;
    }
    this.f0Hist.push(best);
    if (this.f0Hist.length > 5) this.f0Hist.shift();
    const sorted = [...this.f0Hist].sort((a, b) => a - b);
    return { p: sorted[sorted.length >> 1], level: this.level.vocals };
  }
}

function median(a: Float32Array): number {
  const s = Float32Array.from(a).sort();
  return s[s.length >> 1];
}

/** Ask the user to share a browser tab (or screen) with its audio. */
export async function captureTab(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chrome hints: prefer tabs and keep the tab's audio playing locally.
    ...({ preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include', suppressLocalAudioPlayback: false } as object),
  } as DisplayMediaStreamOptions);
  for (const v of stream.getVideoTracks()) v.stop();
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio was shared. Pick a tab and make sure "Share tab audio" is switched on.');
  }
  return stream;
}

/** Audio input devices, with labels (asks for microphone permission once). */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.kind === 'audioinput' && d.label)) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  // Put "Monitor of …" devices (what the PC is playing) first.
  return inputs.sort((a, b) => Number(/monitor/i.test(b.label)) - Number(/monitor/i.test(a.label)));
}

export function captureInput(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

export class NoSpeakerMonitorError extends Error {}

/**
 * Listen to everything this computer plays (any app: Spotify, a browser tab,
 * a video player…). Uses the system's "Monitor of …" inputs, which carry the
 * speaker output; all of them are captured and mixed, so whichever output is
 * in use is heard. Needs microphone permission once.
 */
export async function captureSpeakers(): Promise<{ streams: MediaStream[]; label: string }> {
  // Speaker-sound inputs: PulseAudio/PipeWire monitors (Firefox lists them;
  // Chrome hides them), a remapped copy such as "PC-sound", Windows "Stereo
  // Mix", macOS loopback drivers.
  const monitors = (await listInputs()).filter((d) => /monitor|pc.?sound|loopback|stereo mix|what u hear|blackhole|soundflower/i.test(d.label));
  if (!monitors.length) throw new NoSpeakerMonitorError('No speaker monitor input on this computer.');
  const streams = await Promise.all(monitors.map((d) => captureInput(d.deviceId)));
  return { streams, label: "This computer's sound" };
}

/** Whether microphone permission is already granted (so listening can start without a prompt). */
export async function micGranted(): Promise<boolean> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state === 'granted';
  } catch {
    return false;
  }
}
