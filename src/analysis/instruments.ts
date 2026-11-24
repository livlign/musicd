// "Ears": listens to whatever is playing (song playback or a live stream) and
// keeps a smoothed estimate of which instrument families are audible, so the
// visuals only show what is really there.
import type { ListenReply, ListenRequest } from './listen.worker';

export type Instrument = 'drums' | 'voice' | 'keys' | 'strings' | 'guitar' | 'bass' | 'synth';
export const INSTRUMENTS: Instrument[] = ['drums', 'voice', 'keys', 'strings', 'guitar', 'bass', 'synth'];
export type Presence = Record<Instrument, number>;

const TAP_SOURCE = `
class MusicdTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const len = chans[0].length;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < chans.length; c++) s += chans[c][i];
        this.buf[this.n++] = s / chans.length;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('musicd-tap', MusicdTap);
`;

const WINDOW_S = 1.0;
const HOP_MS = 450;

export class Ears {
  presence: Presence = { drums: 0, voice: 0, keys: 0, strings: 0, guitar: 0, bass: 0, synth: 0 };
  /** 0 = lively/aggressive … 1 = calm/tender. */
  calm = 0.5;
  /** Smoothed genre evidence used to choose a layout. */
  electronic = 0;
  orchestral = 0;
  /** True once at least one classification has arrived. */
  heard = false;
  /** Development/testing only: force some families on or off. */
  override: Partial<Presence> | null = null;
  private worker: Worker;
  private ready = false;
  private ring: Float32Array;
  private pos = 0;
  private filled = 0;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode;
  private timer = 0;
  private busy = false;
  private source: AudioNode | null = null;

  constructor(private ctx: AudioContext, vendorBase: string) {
    this.ring = new Float32Array(Math.ceil(ctx.sampleRate * WINDOW_S));
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
    this.worker = new Worker(new URL('./listen.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<ListenReply>) => this.onReply(e.data);
    this.worker.postMessage({ type: 'init', modelUrl: `${vendorBase}yamnet/model.json` } satisfies ListenRequest);
    void this.setupTap();
  }

  private async setupTap() {
    const url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, 'musicd-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
    this.node.connect(this.sink);
    if (this.source) this.source.connect(this.node);
  }

  /** Listen to a different node (song output or live stream). Resets what was heard. */
  listenTo(source: AudioNode | null) {
    if (this.source && this.node) {
      try {
        this.source.disconnect(this.node);
      } catch {
        /* already disconnected */
      }
    }
    this.source = source;
    if (source && this.node) source.connect(this.node);
    this.reset();
    clearInterval(this.timer);
    if (source) this.timer = window.setInterval(() => this.classify(), HOP_MS);
  }

  reset() {
    for (const k of INSTRUMENTS) this.presence[k] = 0;
    this.calm = 0.5;
    this.electronic = 0;
    this.orchestral = 0;
    this.heard = false;
    this.filled = 0;
  }

  private push(chunk: Float32Array) {
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.pos] = chunk[i];
      this.pos = (this.pos + 1) % this.ring.length;
    }
    this.filled = Math.min(this.ring.length, this.filled + chunk.length);
  }

  private classify() {
    if (!this.ready || this.busy || this.filled < this.ring.length) return;
    // Unroll the ring buffer and resample to 16 kHz (linear interpolation is
    // plenty for a classifier).
    const n = this.ring.length;
    const src = new Float32Array(n);
    for (let i = 0; i < n; i++) src[i] = this.ring[(this.pos + i) % n];
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(src[i]));
    if (peak < 0.003) return; // silence: keep the last estimate
    const outLen = Math.floor((n * 16000) / this.ctx.sampleRate);
    const out = new Float32Array(outLen);
    const r = this.ctx.sampleRate / 16000;
    for (let i = 0; i < outLen; i++) {
      const x = i * r;
      const j = Math.floor(x);
      const f = x - j;
      out[i] = src[j] * (1 - f) + (src[j + 1] ?? src[j]) * f;
    }
    this.busy = true;
    this.worker.postMessage({ type: 'classify', audio: out } satisfies ListenRequest, [out.buffer]);
  }

  private onReply(msg: ListenReply) {
    if (msg.type === 'ready') {
      this.ready = true;
      return;
    }
    this.busy = false;
    if (msg.type === 'error') {
      console.warn('instrument recognition:', msg.message);
      return;
    }
    // Rise quickly when an instrument appears, fade slowly when it stops, so
    // the lineup doesn't flicker between phrases.
    for (const k of INSTRUMENTS) {
      const target = Math.min(1, msg.presence[k] * 2.2);
      const cur = this.presence[k];
      this.presence[k] = this.heard ? cur + (target - cur) * (target > cur ? 0.6 : 0.12) : target;
    }
    this.calm = this.heard ? this.calm + (msg.calm - this.calm) * 0.2 : msg.calm;
    this.electronic = this.heard ? this.electronic + (msg.electronic - this.electronic) * 0.1 : msg.electronic;
    this.orchestral = this.heard ? this.orchestral + (msg.orchestral - this.orchestral) * 0.1 : msg.orchestral;
    this.heard = true;
  }
}
