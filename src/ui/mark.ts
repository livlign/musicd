// The live musicd mark: assembles from its shards on load, spins while music
// plays, lights its cracks with the loudness and sends a pulse out along them
// on every beat. In silence it parks upright, the light goes out and the play
// wedge slides out and waits, breathing softly.
import { COLOR, CRACKS, GROOVE_TRACKS, SHARDS, VIEWBOX, WEDGE, arc, crackLine, cutsPath, grooveRadii, polar, sector } from './mark-geometry';

const NS = 'http://www.w3.org/2000/svg';
const MAX_SPEED = 110; // degrees per second
const SPIN_UP = 0.8; // seconds to full speed
const COAST = 2.2; // nominal seconds to coast to a stop
const HOLD = 1.2; // seconds of quiet before it counts as silence

export interface MarkInput {
  dt: number;
  /** 0..1 how clearly music is audible. */
  audible: number;
  /** 0..1 loudness. */
  level: number;
  /** A beat landed this frame (kick or snare). */
  beat: boolean;
}

let uid = 0;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const snap = (t: number) => {
  t = clamp01(t);
  const c = 1.3;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const n = (x: number) => (Math.round(x * 1000) / 1000).toString();

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export class Mark {
  readonly svg: SVGSVGElement;
  private root: SVGGElement;
  private pieces: { g: SVGGElement; dx: number; dy: number; rot: number; delay: number }[] = [];
  private wedge: SVGGElement;
  private halo: SVGPathElement;
  private light: SVGGElement;
  private stops: SVGStopElement[];
  private rim: SVGCircleElement;
  private rimGlow: SVGCircleElement;
  private extras: SVGElement[] = [];
  private s = { t: 0, asm: 0, angle: 0, speed: 0, braking: false, remain: 0, brakeA: 0, play: 0, apart: 1, since: 9, level: 0, lastSound: -99 };

  /** `surface`: the colour behind the mark (the gaps between shards are cut in it). */
  constructor(size: number, surface: string = COLOR.space) {
    const id = `mk${++uid}`;
    this.svg = el('svg', { viewBox: VIEWBOX, width: size, height: size, 'aria-hidden': 'true' });
    this.svg.style.overflow = 'visible';
    const defs = el('defs', {}, this.svg);
    const radial = (name: string, stops: [number, string, number?][]) => {
      const g = el('radialGradient', { id: `${id}${name}`, cx: 0, cy: 0, r: 100, gradientUnits: 'userSpaceOnUse' }, defs);
      return stops.map(([o, c, a = 1]) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g));
    };
    radial('rec', [[0, COLOR.recordCentre], [1, COLOR.recordRim]]);
    radial('wg', [[0.05, COLOR.core], [0.32, COLOR.cyan], [1, COLOR.indigo]]);
    // Crack light: a base glow plus a bright band (the beat pulse) whose position moves outwards.
    this.stops = radial('lg', [[0, COLOR.cyan, 0.9], [0.2, COLOR.cyan, 0.6], [0.3, COLOR.pulse, 1], [0.4, COLOR.cyan, 0.5], [1, COLOR.indigo, 0.7]]);
    const blur = (name: string, sd: number) => {
      const f = el('filter', { id: `${id}${name}`, x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
      el('feGaussianBlur', { stdDeviation: sd }, f);
      return `url(#${id}${name})`;
    };
    const bloom = blur('bl', 5);
    const halo = blur('ha', 10);
    const soft = blur('sf', 7);
    el('circle', { r: 100 }, el('clipPath', { id: `${id}disc` }, defs));

    this.root = el('g', {}, this.svg);
    const grooves = grooveRadii();
    SHARDS.forEach(([a0, a1], i) => {
      const g = el('g', {}, this.root);
      const d = sector(0, 100, a0, a1);
      el('path', { d }, el('clipPath', { id: `${id}p${i}` }, defs));
      const body = el('g', { 'clip-path': `url(#${id}p${i})` }, g);
      el('path', { d, fill: `url(#${id}rec)` }, body);
      for (const r of grooves) el('circle', { r, fill: 'none', stroke: COLOR.groove, 'stroke-width': 0.45 }, body);
      for (const r of GROOVE_TRACKS) el('circle', { r, fill: 'none', stroke: COLOR.groove, 'stroke-width': 1.6 }, body);
      el('circle', { r: 99.2, fill: 'none', stroke: COLOR.edge, 'stroke-width': 0.9 }, body);
      el('path', { d: cutsPath(a0, a1), fill: 'none', stroke: surface, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, g);
      // Scattered starting positions, the same on every load.
      const k = Math.sin(i * 12.9898) * 43758.5453;
      const rnd = (j: number) => Math.abs(Math.sin(k + j * 78.233)) % 1;
      const [dx, dy] = polar(120 + rnd(1) * 60, (a0 + a1) / 2 + (rnd(2) - 0.5) * 40);
      this.pieces.push({ g, dx, dy, rot: (rnd(3) - 0.5) * 110, delay: 0.08 + i * 0.08 });
    });
    const label = el('circle', { r: 17, fill: 'none', stroke: COLOR.label, 'stroke-width': 0.8 }, this.root);
    this.extras.push(label);

    this.rim = el('circle', { r: 100.2, fill: 'none', stroke: COLOR.cyan, 'stroke-width': 1, opacity: 0 }, this.root);
    this.rimGlow = el('circle', { r: 100, fill: 'none', stroke: COLOR.indigo, 'stroke-width': 6, filter: soft, opacity: 0 }, this.root);

    const wrap = el('g', {}, this.root);
    this.halo = el('path', { d: sector(0, 94, WEDGE[0] + 4, WEDGE[1] - 4), fill: `url(#${id}wg)`, filter: halo, opacity: 0 }, wrap);
    const wedge = el('g', {}, wrap);
    el('path', { d: sector(0, 100, ...WEDGE), fill: `url(#${id}wg)` }, wedge);
    for (const r of GROOVE_TRACKS) {
      const pad = (2.4 / r) * (180 / Math.PI);
      el('path', { d: arc(r, WEDGE[0] + pad, WEDGE[1] - pad), fill: 'none', stroke: 'rgba(20,20,60,.16)', 'stroke-width': 1.2 }, wedge);
    }
    el('path', { d: arc(98.6, WEDGE[0] + 1.5, WEDGE[1] - 1.5), fill: 'none', stroke: 'rgba(255,255,255,.45)', 'stroke-width': 0.7 }, wedge);
    el('path', { d: cutsPath(...WEDGE), fill: 'none', stroke: surface, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, wedge);
    this.wedge = wrap;

    // Light along every crack, above the wedge so its two cuts glow too.
    this.light = el('g', { opacity: 0 }, this.root);
    const lines = (parent: SVGGElement, w: number) => {
      for (const a of CRACKS) {
        const [x1, y1, x2, y2] = crackLine(a);
        el('line', { x1, y1, x2, y2, stroke: `url(#${id}lg)`, 'stroke-width': w, 'stroke-linecap': 'round' }, parent);
      }
    };
    lines(el('g', { filter: bloom }, this.light), 6);
    lines(el('g', {}, this.light), 0.9);
    el('circle', { r: 4, fill: surface }, this.root);

    // A fixed reflection: it stays put while the record turns under it.
    const sheen = el('g', { 'clip-path': `url(#${id}disc)`, opacity: 0, 'pointer-events': 'none' }, this.svg);
    const sg = el('g', { filter: soft }, sheen);
    el('path', { d: sector(22, 100, -62, -30), fill: '#cfe0ff', opacity: 0.07 }, sg);
    el('path', { d: sector(22, 100, 118, 150), fill: '#cfe0ff', opacity: 0.05 }, sg);
    this.extras.push(sheen);
    this.update({ dt: 0, audible: 0, level: 0, beat: false });
  }

  /** Play the assembly again (e.g. when the page wakes up). */
  reassemble() {
    Object.assign(this.s, { asm: 0, angle: 0, speed: 0, braking: false });
  }

  update(input: MarkInput) {
    const s = this.s;
    const dt = Math.min(0.1, input.dt);
    s.t += dt;
    s.asm += dt;
    s.since += dt;
    if (input.audible > 0.3) s.lastSound = s.t;
    const playing = s.t - s.lastSound < HOLD;
    if (input.beat && playing) s.since = 0;
    s.level += (input.level - s.level) * (1 - Math.exp(-dt / 0.15));

    // Motor: spins up once assembled; on silence it brakes so it comes to rest upright.
    if (playing) {
      s.braking = false;
      if (s.asm > 1.3) s.speed = Math.min(MAX_SPEED, s.speed + (MAX_SPEED / SPIN_UP) * dt);
      s.angle = (s.angle + s.speed * dt) % 360;
    } else if (s.speed > 0) {
      if (!s.braking) {
        const v = s.speed;
        const minD = (v * v) / (2 * (MAX_SPEED / COAST));
        let d = (360 - (s.angle % 360)) % 360;
        while (d < minD) d += 360;
        s.remain = d;
        s.brakeA = (v * v) / (2 * d);
        s.braking = true;
      }
      const step = Math.min(s.remain, s.speed * dt);
      s.angle += step;
      s.remain -= step;
      s.speed = Math.max(0, s.speed - s.brakeA * dt);
      if (s.remain <= 0.05 || s.speed === 0) {
        s.speed = 0;
        s.angle = 0;
      }
    }
    s.play += ((playing ? 1 : 0) - s.play) * (1 - Math.exp(-3.5 * dt));
    s.apart += ((playing ? 0 : 1) - s.apart) * (1 - Math.exp(-(playing ? 9 : 1.3) * dt));
    this.render();
  }

  private render() {
    const s = this.s;
    this.root.setAttribute('transform', `rotate(${n(s.angle)})`);
    for (const p of this.pieces) {
      const k = snap((s.asm - p.delay) / 0.85);
      const q = 1 - k;
      p.g.setAttribute('transform', `translate(${n(p.dx * q)} ${n(p.dy * q)}) rotate(${n(p.rot * q)})`);
      p.g.setAttribute('opacity', n(clamp01((s.asm - p.delay) * 4)));
    }
    const done = clamp01((s.asm - 1.3) * 2);
    for (const e of this.extras) e.setAttribute('opacity', n(done));

    const k = snap((s.asm - 0.8) / 0.75);
    const out = (1 - k) * 160 + 30 * s.apart * k;
    this.wedge.setAttribute('transform', `translate(${n(-out)} 0)`);
    this.wedge.setAttribute('opacity', n(clamp01((s.asm - 0.8) * 4)));
    const breath = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(s.t * 1.6));
    const beat = Math.exp(-s.since / 0.1);
    this.halo.setAttribute('opacity', n(done * (breath * s.apart + (0.35 + 0.3 * beat) * s.play)));

    // Crack light: a base glow from loudness plus a pulse travelling outwards after each beat.
    const base = done * s.play * (0.35 + 0.5 * s.level);
    const pos = clamp01(s.since / 0.55);
    const amp = (1 - pos) * s.play;
    const p = 0.06 + pos * 0.94;
    const [, a, b, c] = this.stops;
    a.setAttribute('offset', n(Math.max(0, p - 0.14)));
    b.setAttribute('offset', n(p));
    c.setAttribute('offset', n(Math.min(1, p + 0.1)));
    b.setAttribute('stop-opacity', n(0.5 + 0.5 * amp));
    this.light.setAttribute('opacity', n(clamp01(base + 0.45 * amp * done)));
    const flare = done * s.play * (0.25 + 0.5 * s.level) + done * Math.max(0, 1 - Math.abs(pos - 0.95) * 6) * amp;
    this.rim.setAttribute('opacity', n(clamp01(flare) * 0.8));
    this.rimGlow.setAttribute('opacity', n(clamp01(flare)));
  }
}
