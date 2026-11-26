// Debug view: the song parts musicd recognises right now, each with a dotted
// line that grows for as long as the part keeps playing. A part that stops
// keeps its line and fades away; if it comes back it starts a new line.
import type { Instrument } from '../analysis/instruments';
import type { Frame } from '../feed/frame';

type Key = 'kick' | 'snare' | 'hat' | 'cymbal' | 'tom' | 'vocals' | 'bass' | 'lead' | 'chords' | Exclude<Instrument, 'drums' | 'voice' | 'bass'>;

interface PartDef {
  label: string;
  /**
   * Seconds a part counts as still playing after its last sign of life. Live
   * detection has short gaps (a missed hit, a held note), so this bridges them.
   */
  hold: number;
  hue: number;
}

const DEFS: Record<Key, PartDef> = {
  kick: { label: 'Kick', hold: 2.5, hue: 16 },
  snare: { label: 'Snare', hold: 2.5, hue: 44 },
  hat: { label: 'Hi-hats', hold: 2.0, hue: 56 },
  cymbal: { label: 'Cymbals', hold: 3.5, hue: 48 },
  tom: { label: 'Toms', hold: 3.0, hue: 28 },
  vocals: { label: 'Vocals', hold: 2.5, hue: 185 },
  bass: { label: 'Bass', hold: 3.0, hue: 285 },
  lead: { label: 'Melody', hold: 2.5, hue: 330 },
  chords: { label: 'Chords', hold: 3.0, hue: 140 },
  guitar: { label: 'Guitar', hold: 1.5, hue: 20 },
  keys: { label: 'Keys', hold: 1.5, hue: 210 },
  strings: { label: 'Strings', hold: 1.5, hue: 165 },
  synth: { label: 'Synth', hold: 1.5, hue: 265 },
};
const CLASSIFIED: Key[] = ['guitar', 'keys', 'strings', 'synth'];
/** Classifier confidence to switch a family on, and to keep it on. */
const ON = 0.35;
const STAY = 0.2;
/** Smallest hit strength that counts (hits are already scaled by how sure we are drums exist). */
const MIN_HIT = 0.25;
const PX_PER_S = 10;
const FADE = 3;

interface Row {
  key: Key;
  start: number;
  last: number;
  end: number | null;
  flash: number;
  el: HTMLDivElement;
  bar: HTMLSpanElement;
  time: HTMLSpanElement;
}

const fmt = (s: number) => (s < 60 ? `${Math.floor(s)}s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

export class PartsView {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private status: HTMLDivElement;
  private rows: Row[] = [];
  private current = new Map<Key, Row>();
  private t = 0;
  private visible = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'parts';
    this.el.setAttribute('aria-live', 'off');
    this.status = document.createElement('div');
    this.status.className = 'parts-status';
    this.list = document.createElement('div');
    this.list.className = 'parts-list';
    this.el.append(this.status, this.list);
    this.show(false);
  }

  show(on: boolean) {
    this.visible = on;
    this.el.hidden = !on;
    if (!on) this.clear();
  }

  setStatus(text: string) {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  clear() {
    for (const r of this.rows) r.el.remove();
    this.rows = [];
    this.current.clear();
  }

  update(f: Frame) {
    if (!this.visible) return;
    this.t += f.dt;
    const now = this.t;

    // What showed signs of life this frame.
    const seen = new Map<Key, number>();
    const mark = (k: Key, v: number) => seen.set(k, Math.max(seen.get(k) ?? 0, v));
    for (const h of f.hits) if (h.v >= MIN_HIT) mark(h.hit, h.v);
    for (const nt of f.notes) mark(nt.voice, nt.v);
    if (f.voice) mark('vocals', 0.5);
    if (!f.idle && (f.audible ?? 1) > 0.3 && f.presence) {
      for (const k of CLASSIFIED) {
        const p = f.presence[k as Instrument];
        if (p >= ON || (this.current.has(k) && p >= STAY)) mark(k, 0);
      }
    }

    for (const [k, v] of seen) {
      let row = this.current.get(k);
      if (!row) {
        row = this.addRow(k, now);
        this.current.set(k, row);
      }
      row.last = now;
      if (v > 0) row.flash = Math.max(row.flash, Math.min(1, 0.4 + v));
    }
    for (const [k, row] of this.current) {
      if (now - row.last > DEFS[k].hold) {
        row.end = now;
        row.el.classList.add('ended');
        this.current.delete(k);
      }
    }

    // Draw: lines grow while playing; ended ones fade out, then go.
    const keep: Row[] = [];
    for (const row of this.rows) {
      const dur = (row.end ?? now) - row.start;
      row.bar.style.width = `${Math.max(4, dur * PX_PER_S)}px`;
      row.time.textContent = fmt(dur);
      row.flash *= Math.exp(-f.dt / 0.18);
      row.el.style.setProperty('--flash', row.flash.toFixed(2));
      if (row.end !== null) {
        const a = 1 - (now - row.end) / FADE;
        if (a <= 0) {
          row.el.remove();
          continue;
        }
        row.el.style.opacity = a.toFixed(2);
      }
      keep.push(row);
    }
    this.rows = keep;
  }

  private addRow(key: Key, now: number): Row {
    const d = DEFS[key];
    const el = document.createElement('div');
    el.className = 'part';
    el.style.setProperty('--hue', String(d.hue));
    const label = document.createElement('span');
    label.className = 'part-label';
    label.textContent = d.label;
    const track = document.createElement('span');
    track.className = 'part-track';
    const bar = document.createElement('span');
    bar.className = 'part-bar';
    track.append(bar);
    const time = document.createElement('span');
    time.className = 'part-time';
    el.append(label, track, time);
    this.list.append(el);
    const row: Row = { key, start: now, last: now, end: null, flash: 1, el, bar, time };
    this.rows.push(row);
    return row;
  }
}
