// Debug recorder: captures what musicd hears (the audio, sample for sample) and
// what it does with it (a log of every frame), on the same clock, and saves
// both as files when stopped: musicd-<time>.wav and musicd-<time>.json.
// Comparing the two shows exactly what was detected, missed, late or invented.
import type { Frame } from '../feed/frame';

const WORKLET = `
class MusicdRecord extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.t = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const len = chans[0].length;
      for (let i = 0; i < len; i++) {
        if (this.n === 0) this.t = currentTime + i / sampleRate;
        let s = 0;
        for (let c = 0; c < chans.length; c++) s += chans[c][i];
        this.buf[this.n++] = s / chans.length;
        if (this.n === this.buf.length) {
          this.port.postMessage({ t: this.t, data: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('musicd-record', MusicdRecord);
`;

const r = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Everything the recorder notes about one frame, compactly. */
export interface FrameExtras {
  scene: Record<string, number>;
  live?: Record<string, unknown>;
  captureDelay?: number | null;
}

export class Recorder {
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private source: AudioNode | null = null;
  private ready: Promise<void> | null = null;
  private chunks: { t: number; data: Float32Array }[] = [];
  private frames: unknown[] = [];
  private meta: Record<string, unknown> = {};
  private startedAt = 0;
  private lastPresence = '';
  recording = false;

  constructor(private ctx: AudioContext) {}

  /** Seconds recorded so far. */
  get elapsed() {
    return this.recording ? this.ctx.currentTime - this.startedAt : 0;
  }

  async start(source: AudioNode, meta: Record<string, unknown>) {
    if (this.recording) return;
    if (!this.ready) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      this.ready = this.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    await this.ready;
    this.chunks = [];
    this.frames = [];
    this.lastPresence = '';
    this.node = new AudioWorkletNode(this.ctx, 'musicd-record', { numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent<{ t: number; data: Float32Array }>) => this.chunks.push(e.data);
    // The worklet only runs while connected to the output; keep it silent.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(this.ctx.destination);
    source.connect(this.node);
    this.source = source;
    this.startedAt = this.ctx.currentTime;
    this.meta = {
      ...meta,
      startedAt: new Date().toISOString(),
      sampleRate: this.ctx.sampleRate,
      userAgent: navigator.userAgent,
    };
    this.recording = true;
  }

  /** Note one frame. Call after the frame has been drawn. */
  log(f: Frame, x: FrameExtras) {
    if (!this.recording) return;
    const sp = f.spectrum;
    const entry: Record<string, unknown> = {
      t: r(this.ctx.currentTime, 4),
      dt: r(f.dt, 4),
      audible: r(f.audible ?? 0),
      level: [r(f.level.drums), r(f.level.bass), r(f.level.vocals), r(f.level.other)],
      scene: Object.fromEntries(Object.entries(x.scene).map(([k, v]) => [k, r(v)])),
    };
    if (sp) {
      entry.loudestDb = r(sp.loudestDb, 1);
      entry.aboveNoise = r(sp.aboveNoise, 1);
      entry.bands = Array.from(sp.bands, (v) => r(v, 2));
    }
    if (f.hits.length) entry.hits = f.hits.map((h) => [h.hit, r(h.v)]);
    if (f.notes.length) entry.notes = f.notes.map((n) => [n.voice, r(n.p, 2), r(n.v)]);
    if (f.voice) entry.voice = [r(f.voice.p, 2), r(f.voice.level)];
    if (f.hitAge !== undefined) entry.hitAge = r(f.hitAge, 4);
    if (f.beat) entry.beat = r(f.beat);
    if (f.beatLocked) entry.bpm = r(f.bpm ?? 0, 1);
    for (const k of ['intensity', 'drumEvidence', 'tonal', 'swell', 'grit', 'fourFloor', 'calm'] as const) {
      const v = f[k];
      if (typeof v === 'number') entry[k] = r(v);
    }
    if (f.layout) entry.layout = f.layout;
    // Recognised instruments change slowly: note them only when they change.
    if (f.presence) {
      const p = JSON.stringify(Object.fromEntries(Object.entries(f.presence).map(([k, v]) => [k, r(v, 2)])));
      if (p !== this.lastPresence) {
        entry.presence = JSON.parse(p);
        this.lastPresence = p;
      }
    }
    if (x.live) entry.live = x.live;
    if (x.captureDelay != null) entry.captureDelay = r(x.captureDelay, 4);
    this.frames.push(entry);
  }

  /** Stop and save both files. Resolves with their names. */
  async stop(): Promise<string[]> {
    if (!this.recording) return [];
    this.recording = false;
    // Let the last block of audio arrive.
    await new Promise((res) => setTimeout(res, 150));
    try {
      this.source?.disconnect(this.node!);
    } catch {
      /* already gone */
    }
    this.node?.disconnect();
    this.sink?.disconnect();
    this.node = null;

    const sr = this.ctx.sampleRate;
    const audioStart = this.chunks.length ? this.chunks[0].t : this.startedAt;
    const d = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
    const names = [`musicd-${stamp}.wav`, `musicd-${stamp}.json`];
    const log = {
      about:
        'musicd debug recording. Frame times t are on the audio clock; the WAV file starts at audioStart, so a frame at t matches the audio at (t - audioStart) seconds.',
      audioStart,
      meta: { ...this.meta, frames: this.frames.length, seconds: r(this.ctx.currentTime - this.startedAt, 2) },
      fields: {
        level: ['drums', 'bass', 'vocals', 'other'],
        hits: '[kind, strength] for each drum hit detected in this frame',
        notes: '[voice, MIDI pitch, strength] for each note that started in this frame',
        voice: '[sung MIDI pitch, level] when someone is singing',
        hitAge: 'how long ago (s) the strongest kick or snare of this frame actually sounded',
        bands: '40 loudness bands, 30 Hz to 16 kHz, 0..1 (auto-levelled)',
        scene: 'what Cosmos is doing',
      },
      frames: this.frames,
    };
    download(names[0], wav(this.chunks, audioStart, sr));
    download(names[1], new Blob([JSON.stringify(log)], { type: 'application/json' }));
    this.chunks = [];
    this.frames = [];
    return names;
  }
}

/** Mono 16-bit WAV, with each block placed at its own time (gaps stay silent). */
function wav(chunks: { t: number; data: Float32Array }[], start: number, sr: number): Blob {
  let end = 0;
  for (const c of chunks) end = Math.max(end, Math.round((c.t - start) * sr) + c.data.length);
  const pcm = new Int16Array(end);
  for (const c of chunks) {
    const at = Math.round((c.t - start) * sr);
    for (let i = 0; i < c.data.length; i++) pcm[at + i] = Math.max(-1, Math.min(1, c.data[i])) * 32767;
  }
  const head = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => head.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  head.setUint32(4, 36 + pcm.byteLength, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, sr, true);
  head.setUint32(28, sr * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  str(36, 'data');
  head.setUint32(40, pcm.byteLength, true);
  return new Blob([head, pcm], { type: 'audio/wav' });
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
