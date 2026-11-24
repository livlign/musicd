// Sample-accurate playback of either the full mix or the separated stems
// (with per-part mute), all driven from one AudioContext clock.
import type { PartId } from '../analysis/types';
import { PARTS } from '../analysis/types';

export class Player {
  readonly ctx: AudioContext;
  private mix: AudioBuffer | null = null;
  private stems: Record<PartId, AudioBuffer> | null = null;
  private gains = new Map<PartId | 'mix', GainNode>();
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0; // ctx time corresponding to song time 0
  private pausedAt = 0;
  private muted = new Set<PartId>();
  playing = false;
  onEnded: () => void = () => {};

  /** Everything that plays passes through here (tap it for visuals). */
  readonly output: GainNode;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    this.output = this.ctx.createGain();
    this.output.connect(this.ctx.destination);
  }

  get duration() {
    return this.mix?.duration ?? 0;
  }

  get hasStems() {
    return this.stems !== null;
  }

  /** Current song position in seconds, compensated for output latency. */
  get time() {
    if (!this.playing) return this.pausedAt;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.min(this.duration, Math.max(0, this.ctx.currentTime - this.startedAt - lat));
  }

  async decode(file: Blob): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(await file.arrayBuffer());
  }

  load(mix: AudioBuffer | null) {
    this.stop();
    this.mix = mix;
    this.stems = null;
    this.pausedAt = 0;
  }

  /** Switch to stem playback without interrupting the music. */
  setStems(stems: Record<PartId, AudioBuffer>) {
    this.stems = stems;
    if (this.playing) this.restart(this.time);
  }

  isMuted(p: PartId) {
    return this.muted.has(p);
  }

  toggleMute(p: PartId) {
    if (this.muted.has(p)) this.muted.delete(p);
    else this.muted.add(p);
    this.applyGains();
  }

  solo(p: PartId) {
    const alreadySolo = PARTS.every((q) => (q === p) !== this.muted.has(q));
    this.muted.clear();
    if (!alreadySolo) for (const q of PARTS) if (q !== p) this.muted.add(q);
    this.applyGains();
  }

  async play() {
    if (!this.mix || this.playing) return;
    await this.ctx.resume();
    if (this.pausedAt >= this.duration - 0.05) this.pausedAt = 0;
    this.restart(this.pausedAt);
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this.stop();
  }

  seek(t: number) {
    const clamped = Math.max(0, Math.min(this.duration, t));
    if (this.playing) this.restart(clamped);
    else this.pausedAt = clamped;
  }

  private restart(offset: number) {
    this.stop();
    const when = this.ctx.currentTime + 0.03;
    const buffers: [PartId | 'mix', AudioBuffer][] = this.stems
      ? PARTS.map((p) => [p, this.stems![p]])
      : [['mix', this.mix!]];
    for (const [id, buf] of buffers) {
      let g = this.gains.get(id);
      if (!g) {
        g = this.ctx.createGain();
        g.connect(this.output);
        this.gains.set(id, g);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start(when, offset);
      this.sources.push(src);
    }
    this.sources[0].onended = () => {
      if (this.playing && this.time >= this.duration - 0.1) {
        this.pausedAt = this.duration;
        this.stop();
        this.onEnded();
      }
    };
    this.startedAt = when - offset;
    this.playing = true;
    this.applyGains();
  }

  private stop() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    this.sources = [];
    this.playing = false;
  }

  private applyGains() {
    const t = this.ctx.currentTime;
    for (const [id, g] of this.gains) {
      const on = id === 'mix' ? !this.stems : !!this.stems && !this.muted.has(id);
      g.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
    }
  }
}
