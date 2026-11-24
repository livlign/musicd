// Reads what is actually coming out of the speakers (or a live stream) and
// summarises it for "show every sound" visuals:
//   bands  – loudness in SPECTRUM_BANDS log-spaced bands from 30 Hz to 16 kHz
//   chroma – how strongly each of the 12 pitch classes is sounding (harmony)
export const SPECTRUM_BANDS = 40;
const F_LO = 30;
const F_HI = 16000;

export interface Spectrum {
  bands: Float32Array; // 0..1
  chroma: Float32Array; // 0..1, max = 1
  /** 0 = silence … 1 = clearly audible sound, in absolute terms (not auto-levelled). */
  audible: number;
  /** Loudest band right now, in dB (for calibration). */
  loudestDb: number;
}

// Loudness depends on the listener's volume (a speaker monitor is captured after
// the system volume: at 45% volume, music peaked near -68 dB per band). So
// silence is judged against the music's own recent level, remembered for a long
// time: SILENCE_BELOW dB under it is silence, AUDIBLE_BELOW under it is fully
// audible. Anything below ABS_SILENT_DB is silence whatever the volume.
const SILENCE_BELOW = 32;
const AUDIBLE_BELOW = 16;
const ABS_SILENT_DB = -100;
const REF_FLOOR_DB = -95;

export class SpectrumTap {
  readonly analyser: AnalyserNode;
  private db: Float32Array<ArrayBuffer>;
  private edges: number[];
  private out: Spectrum = { bands: new Float32Array(SPECTRUM_BANDS), chroma: new Float32Array(12), audible: 0, loudestDb: -120 };
  private ref = -40; // adaptive loudness reference (dB)
  /** The music's recent loudness (dB), held for minutes so pauses read as silence. */
  musicRef = -60;
  /** Seconds the input has not changed at all (a stalled or suspended source). */
  private stalled = 0;
  private lastSum = NaN;
  /** Set by the owner when the browser reports the capture track as muted. */
  muted = false;
  private pcOfBin: Int8Array;

  constructor(ctx: AudioContext, source?: AudioNode) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.5;
    source?.connect(this.analyser);
    this.db = new Float32Array(this.analyser.frequencyBinCount);
    const binHz = ctx.sampleRate / this.analyser.fftSize;
    this.edges = Array.from({ length: SPECTRUM_BANDS + 1 }, (_, i) =>
      Math.max(1, Math.round((F_LO * Math.pow(F_HI / F_LO, i / SPECTRUM_BANDS)) / binHz)),
    );
    // Each bin between ~110 Hz and 2 kHz that sits close to a semitone feeds chroma.
    this.pcOfBin = new Int8Array(this.db.length).fill(-1);
    for (let k = 1; k < this.db.length; k++) {
      const f = k * binHz;
      if (f < 110 || f > 2000) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      if (Math.abs(midi - Math.round(midi)) < 0.35) this.pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
    }
  }

  read(dt: number): Spectrum {
    this.analyser.getFloatFrequencyData(this.db);
    // When playback stops, some systems stop delivering audio altogether rather
    // than sending silence, and the analyser keeps the last moment of music.
    // An input that does not change at all for a moment is silence.
    let sum = 0;
    for (let k = 0; k < this.db.length; k += 7) sum += this.db[k];
    this.stalled = sum === this.lastSum ? this.stalled + dt : 0;
    this.lastSum = sum;
    if (this.stalled > 0.3 || this.muted) this.db.fill(-140);
    const { bands, chroma } = this.out;
    let loudest = -120;
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      const a = this.edges[i];
      const b = Math.max(a + 1, this.edges[i + 1]);
      let p = 0;
      for (let k = a; k < b && k < this.db.length; k++) p += Math.pow(10, this.db[k] / 10);
      const db = 10 * Math.log10(p / (b - a) + 1e-12);
      loudest = Math.max(loudest, db);
      const v = Math.max(0, Math.min(1, (db - (this.ref - 50)) / 50));
      bands[i] += (v - bands[i]) * (v > bands[i] ? 0.6 : 0.15);
    }
    // Follow the overall volume so quiet and loud sources both fill the range.
    this.ref += (loudest - this.ref) * (loudest > this.ref ? 0.3 : 1 - Math.exp(-dt / 3));
    this.ref = Math.max(this.ref, REF_FLOOR_DB);
    // Remember how loud the music is at this volume: rise quickly, forget slowly.
    if (loudest > this.musicRef) this.musicRef += (loudest - this.musicRef) * (1 - Math.exp(-dt / 0.5));
    else if (loudest > this.musicRef - SILENCE_BELOW) this.musicRef -= dt * 0.15;
    this.musicRef = Math.max(this.musicRef, ABS_SILENT_DB + SILENCE_BELOW);
    const lo = this.musicRef - SILENCE_BELOW;
    const hi = this.musicRef - AUDIBLE_BELOW;
    const a = loudest <= ABS_SILENT_DB ? 0 : Math.max(0, Math.min(1, (loudest - lo) / (hi - lo)));
    this.out.audible += (a - this.out.audible) * (1 - Math.exp(-dt * (a > this.out.audible ? 8 : 2.5)));
    this.out.loudestDb = loudest;

    const raw = new Float32Array(12);
    for (let k = 0; k < this.db.length; k++) {
      const pc = this.pcOfBin[k];
      if (pc >= 0) raw[pc] += Math.pow(10, this.db[k] / 10);
    }
    let max = 1e-12;
    for (let i = 0; i < 12; i++) max = Math.max(max, raw[i]);
    for (let i = 0; i < 12; i++) chroma[i] += (raw[i] / max - chroma[i]) * 0.25;
    return this.out;
  }
}
