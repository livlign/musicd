// Debug: is what you see in time with what you hear? musicd measures this by
// itself while music plays, in three parts:
//   capture   – the system and browser handing the sound to the page (reported by Chrome)
//   analysis  – how old each kick or snare already is when musicd detects it
//   drawing   – from the frame that shows it to the screen (from the frame rate)
// plus a scrolling strip of the last few seconds: loudness, and every kick and
// snare as it was detected.
import type { Frame } from '../feed/frame';

const SPAN = 4; // seconds shown
const W = 360;
const H = 48;
const KEEP = 40; // beats in the analysis average

interface Mark {
  t: number;
  kind: 'kick' | 'snare';
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

export class SyncView {
  readonly el: HTMLDivElement;
  private ctx: CanvasRenderingContext2D;
  private readout: HTMLDivElement;
  private marks: Mark[] = [];
  private levels: { t: number; v: number }[] = [];
  private ages: number[] = [];
  private capture: number | null = null;
  private frame = 1 / 60;
  private last = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'sync';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement('canvas');
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.readout = document.createElement('div');
    this.readout.className = 'sync-readout';
    this.el.append(canvas, this.readout);
    this.show(false);
  }

  show(on: boolean) {
    this.el.hidden = !on;
  }

  /** `captureDelay`: seconds, as the browser reports it, or null if it doesn't. */
  update(f: Frame, now: number, captureDelay: number | null) {
    if (this.el.hidden) return;
    if (this.last) this.frame += (Math.min(0.1, now - this.last) - this.frame) * 0.05;
    this.last = now;
    if (captureDelay !== null) this.capture = this.capture === null ? captureDelay : this.capture + (captureDelay - this.capture) * 0.05;
    if (f.hitAge !== undefined) {
      this.ages.push(f.hitAge);
      if (this.ages.length > KEEP) this.ages.shift();
    }
    const lv = f.idle ? 0 : Math.max(f.level.drums, f.level.bass, f.level.vocals, f.level.other) * (f.audible ?? 1);
    this.levels.push({ t: now, v: lv });
    for (const h of f.hits) if ((h.hit === 'kick' || h.hit === 'snare') && h.v > 0.25) this.marks.push({ t: now, kind: h.hit });
    const old = now - SPAN;
    while (this.levels.length && this.levels[0].t < old) this.levels.shift();
    while (this.marks.length && this.marks[0].t < old) this.marks.shift();
    this.draw(now);
  }

  private draw(now: number) {
    const g = this.ctx;
    const x = (t: number) => W - ((now - t) / SPAN) * W;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,9,18,.55)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(150,170,255,.15)';
    for (let s = Math.ceil(now - SPAN); s <= now; s++) g.fillRect(x(s), 0, 1, H);
    g.beginPath();
    g.moveTo(x(this.levels[0]?.t ?? now), H);
    for (const p of this.levels) g.lineTo(x(p.t), H - 3 - p.v * (H - 20));
    g.lineTo(W, H);
    g.fillStyle = 'rgba(143,232,255,.18)';
    g.fill();
    for (const m of this.marks) {
      g.fillStyle = m.kind === 'kick' ? 'hsl(16 85% 65%)' : 'hsl(44 85% 65%)';
      g.fillRect(x(m.t) - 1, m.kind === 'kick' ? 4 : 18, 2, 12);
    }
    const text = this.summary();
    if (this.readout.textContent !== text) this.readout.textContent = text;
  }

  private summary(): string {
    const ms = (s: number) => Math.round(s * 1000);
    const fps = Math.round(1 / this.frame);
    // The frame is drawn now and shown at the next screen refresh or the one after.
    const drawing = this.frame * 1.5;
    const capture = this.capture === null ? 'not reported by this browser' : `${ms(this.capture)} ms`;
    if (this.ages.length < 4) return `Measuring the delay… (needs music with a beat)\ncapture ${capture} · ${fps} fps\norange: kicks, yellow: snares, as musicd detects them`;
    const analysis = median(this.ages);
    const total = (this.capture ?? 0) + analysis + drawing;
    return [
      `Picture is about ${ms(total)} ms behind the sound${this.capture === null ? ' (capture not included)' : ''}`,
      `capture ${capture} · analysis ${ms(analysis)} ms · drawing ~${ms(drawing)} ms · ${fps} fps`,
      'Speakers and headphones add their own delay after this',
      '(Bluetooth: 150–300 ms): that makes the picture run early, not late.',
    ].join('\n');
  }
}
