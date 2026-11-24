// Cosmos: drifting forward through a universe made of the song.
//
// The whole sound streams toward you as stardust: low sounds are large, warm,
// slow motes near your path; high sounds are fine cool sparks out at the edges.
// The bass is the core at the vanishing point, swelling with every bass note.
// A kick sends a shockwave across space and a surge forward (the dust stretches
// into streaks); a snare throws a ring of light that flies past you; hi-hats
// glint at the edge of vision; cymbals shimmer everything. A sung melody is a
// comet gliding ahead, shedding a warm trail that drifts past you. Harmony
// colours the distant nebulae. Silence settles into a slow, quiet float.
import type { Frame } from '../feed/frame';
import { SPECTRUM_BANDS } from '../feed/spectrum';
import { clamp, energyOf } from './common';

const FAR = 34; // spawn depth (world units)
const NEAR = 0.35;
const MAX_DUST = 2600;
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Mote {
  x: number;
  y: number;
  z: number;
  size: number; // world radius
  hue: number;
  light: number;
  a: number; // brightness 0..1
  sx: number; // last screen position (for streaks)
  sy: number;
  seen: boolean;
}

interface Ring {
  z: number;
  r: number;
  hue: number;
  a: number;
  spin: number;
}

/** Soft round glow sprites, one per hue step, drawn with drawImage (fast). */
class Sprites {
  private cache = new Map<string, HTMLCanvasElement>();
  get(hue: number, light: number, sat = 90) {
    const h = Math.round(hue / 6) * 6;
    const l = Math.round(light / 8) * 8;
    const s = Math.round(sat / 15) * 15;
    const key = `${h}|${l}|${s}`;
    let c = this.cache.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, `hsla(${h} ${s}% ${Math.min(95, l + 15)}% / 0.85)`);
      grad.addColorStop(0.18, `hsla(${h} ${s}% ${l}% / 0.4)`);
      grad.addColorStop(0.5, `hsla(${h} ${s}% ${l - 10}% / 0.12)`);
      grad.addColorStop(1, `hsla(${h} ${s}% ${l - 20}% / 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this.cache.set(key, c);
    }
    return c;
  }
}

export class Cosmos {
  private w = 1;
  private h = 1;
  private S = 1;
  private sprites = new Sprites();
  private dust: Mote[] = [];
  private rings: Ring[] = [];
  private waves: { age: number; v: number }[] = [];
  /** Deep star field in 3-D: stars of different colours and brightness, recycled as you travel. */
  private stars: { x: number; y: number; z: number; r: number; hue: number; sat: number; tw: number; bright: number }[] = [];
  /** Scenery that comes and goes: nebula clouds, galaxies, star clusters. */
  private sights: { kind: 'nebula' | 'cluster'; x: number; y: number; z: number; size: number; hue: number; spin: number; seed: number; pts?: [number, number][] }[] = [];
  private nextSight = 4;
  /** The flight path wanders: a slowly changing lateral heading, never repeating. */
  private cam = { vx: 0, vy: 0, tx: 0, ty: 0, next: 0 };
  /** Dust gathers into lanes that drift and are replaced over time. */
  private lanes: { ang: number; spin: number; width: number; life: number }[] = [];
  private t = 0;
  private roll = 0;
  private speed = 3;
  private surge = 0;
  private shimmer = 0;
  private hue = 248;
  private hueTarget = 248;
  private energy = 0.3;
  private calm = 1; // 1 = silence / near-silence, 0 = full sound
  private bass = 0;
  private bassHit = 0;
  private kickFlash = 0;
  private comet = { x: 0, y: 0, p: 60, target: 60, lo: 127, hi: 0, lv: 0, lastAt: -9 };
  private spawnDebt = new Float32Array(SPECTRUM_BANDS);
  /** 0 = chill … 1 = intense: drives colour, saturation and brightness. */
  private intensity = 0.25;
  private sat = 50;
  private hitTimes: number[] = [];
  /** Treble halo: crisp glints around the edge of view (hi-hats, highs). */
  private glints: { ang: number; r: number; life: number; max: number; size: number }[] = [];
  private glintDebt = 0;
  /** 0 = the melodic instruments are keys … 1 = they are guitars. */
  private guitarness = 0.3;
  private lastChordAt = -1;
  private grit = 0;
  /** Sustained, tonal sound (strings, pads, choirs, held notes) and its swell. */
  private tonal = 0;
  private swell = 0;
  /** How clearly bowed strings / string sections are recognised (0..1). */
  private strings = 0;
  private aurora = [0, 1].map((i) => ({ phase: i * 2.6, drift: 0.05 + i * 0.04, y: 0.16 + i * 0.16, hueOff: (i - 0.5) * 40 }));

  constructor() {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    void rnd;
    for (let i = 0; i < 520; i++) this.stars.push(this.newStar(40 + Math.random() * 140));
    for (let i = 0; i < 4; i++) this.lanes.push(this.newLane());
    // Start with some dust already in the field, so the first frame isn't empty.
    for (let i = 0; i < 400; i++) this.spawn(Math.random(), 0.25, 8 + Math.random() * (FAR - 8));
  }

  private newStar(z: number) {
    // Star colours by temperature: mostly white, some blue, a few gold and ember.
    const t = Math.random();
    const [hue, sat] = t < 0.55 ? [220, 10] : t < 0.8 ? [210, 55] : t < 0.93 ? [45, 60] : [20, 70];
    const bright = Math.random() < 0.06 ? 1 : Math.pow(Math.random(), 2.2) * 0.7;
    return { x: (Math.random() * 2 - 1) * 60, y: (Math.random() * 2 - 1) * 40, z, r: 0.4 + Math.random() * 1.1 + bright, hue, sat, tw: Math.random() * 6.28, bright };
  }

  private newLane() {
    return { ang: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.12, width: 0.12 + Math.random() * 0.3, life: 12 + Math.random() * 30 };
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w;
    this.h = h;
    this.S = dpr;
  }

  /** The warm complement of the current space hue: the bass core and low dust. */
  private get warm() {
    // Curated, never green: amber against blue, coral against violet,
    // gold against magenta, teal against an already warm space.
    // Pale cyan when chill, through lilac and rose, to gold when intense:
    // the long way round the colour wheel, never through green.
    return stopsHue(clamp(this.intensity * 1.2 - 0.05), [
      [0, 195],
      [0.35, 250],
      [0.65, 318],
      [1, 38],
    ]);
  }

  private get F() {
    return Math.min(this.w, this.h) * 0.85;
  }

  /** Add one mote for a slice of the spectrum (f = 0 lowest … 1 highest). */
  private spawn(f: number, level: number, z = FAR) {
    if (this.dust.length >= MAX_DUST) this.dust.shift();
    // Most dust gathers into drifting lanes; the rest scatters freely.
    const lane = this.lanes.length && Math.random() < 0.62 ? this.lanes[Math.floor(Math.random() * this.lanes.length)] : null;
    const ang = lane ? lane.ang + (Math.random() - 0.5) * lane.width : Math.random() * Math.PI * 2;
    // Low sounds close to the path, high sounds out at the edges.
    const r = 0.25 + Math.pow(f, 0.85) * 3.2 + Math.random() * 0.35;
    // Warm lows (the complement of the space hue), cool highs.
    const hue = lerpHue(this.warm, (this.hue + 30) % 360, Math.pow(f, 0.8));
    this.dust.push({
      x: Math.cos(ang) * r,
      y: Math.sin(ang) * r,
      z,
      size: (0.05 * (1 - f) + 0.012) * (0.7 + level * 0.8),
      hue,
      light: 58 + f * 22,
      a: 0.35 + level * 0.65,
      sx: 0,
      sy: 0,
      seen: false,
    });
  }

  /**
   * Guitar: a strum releases a warm sweep of sparks along one of the dust
   * lanes, flying past like everything else. Grittier guitar, more sparks.
   */
  private strum(p: number, v: number, single: boolean) {
    if (!single && this.t - this.lastChordAt < 0.12) return; // one sweep per strum
    this.lastChordAt = this.t;
    const lane = this.lanes.length ? this.lanes[Math.floor(Math.random() * this.lanes.length)] : null;
    const base = lane ? lane.ang : Math.random() * Math.PI * 2;
    const n = Math.round((single ? 4 : 10) * (0.6 + v) * (0.7 + this.grit * 2));
    const hot = (this.warm + 350) % 360;
    for (let i = 0; i < n; i++) {
      if (this.dust.length >= MAX_DUST) this.dust.shift();
      const ang = base + (i / Math.max(1, n - 1) - 0.5) * 0.9;
      const r = 1.4 + (p - 40) / 60 + Math.random() * 0.3;
      this.dust.push({ x: Math.cos(ang) * r, y: Math.sin(ang) * r, z: 9 + Math.random() * 3, size: 0.018 + v * 0.01, hue: hot, light: 72, a: 0.5 + v * 0.4, sx: 0, sy: 0, seen: false });
    }
  }

  private listen(f: Frame) {
    const dt = f.dt;
    this.t += dt;
    const audible = f.audible ?? (f.idle ? 0 : 1);
    this.calm += ((1 - audible) - this.calm) * (1 - Math.exp(-dt * (audible > 1 - this.calm ? 3 : 0.8)));
    this.energy += (energyOf(f) * audible - this.energy) * (1 - Math.exp(-dt * 0.8));

    for (const hh of f.hits) {
      if (hh.hit === 'kick' || hh.hit === 'tom') {
        this.surge = Math.max(this.surge, hh.v);
        this.kickFlash = Math.max(this.kickFlash, hh.v);
        this.waves.push({ age: 0, v: hh.v });
      } else if (hh.hit === 'snare') {
        this.rings.push({ z: 9, r: 1.6 + Math.random() * 0.8, hue: (this.hue + 180) % 360, a: Math.pow(hh.v, 1.5), spin: Math.random() * 6 });
      } else if (hh.hit === 'hat') {
        // A burst of crisp glints on the halo around the edge of view.
        const base = Math.random() * Math.PI * 2;
        const n = Math.round(2 + 8 * hh.v);
        for (let i = 0; i < n; i++) this.glints.push({ ang: base + (Math.random() - 0.5) * 2.4, r: 0.4 + Math.random() * 0.1, life: 0, max: 0.22 + Math.random() * 0.12, size: 0.3 + hh.v * 1.1 });
      } else this.shimmer = Math.max(this.shimmer, hh.v);
    }
    for (const n of f.notes) if (n.voice === 'bass') this.bassHit = Math.max(this.bassHit, 0.5 + n.v * 0.5);

    // Guitar or keys? Two weak clues together: how gritty the mids sound
    // (distortion is noise-like; piano is pure), and which of the two the
    // sound classifier rates higher, even when both scores are small.
    this.grit = f.grit ?? this.grit;
    const gritG = clamp((this.grit - 0.08) / 0.15);
    let g = gritG;
    if (f.presence) {
      const gp = f.presence.guitar;
      const kp = Math.max(f.presence.keys, f.presence.synth * 0.6);
      if (gp + kp > 0.02) g = 0.5 * gritG + 0.5 * (gp / (gp + kp));
    }
    // Electronic music is gritty too (supersaws): that grit is synth, not guitar.
    if (f.layout === 'center') g *= 0.15;
    if (audible > 0.5) this.guitarness += (g - this.guitarness) * (1 - Math.exp(-dt / 2.5));
    for (const n of f.notes) {
      if (n.voice !== 'chords' && n.voice !== 'lead') continue;
      if (Math.random() < this.guitarness) this.strum(n.p, n.v, n.voice === 'lead');
    }

    // Colour follows the mood of the music: chill music sits in soft deep
    // blues; intensity warms it through violet to hot rose.
    const now = this.t;
    for (const hh of f.hits) if (hh.hit !== 'hat') this.hitTimes.push(now);
    while (this.hitTimes.length && this.hitTimes[0] < now - 4) this.hitTimes.shift();
    const hitRate = this.hitTimes.length / 4;
    const lvAvg = (f.level.drums + f.level.bass + f.level.other + f.level.vocals) / 4;
    const drums = f.presence ? clamp(f.presence.drums * 2) : 0;
    const calmMood = f.calm ?? 0.5;
    // Live listening measures intensity from the sound itself; a dropped song
    // estimates it from its hits, levels and mood.
    const target = f.intensity !== undefined ? f.intensity : clamp(0.08 + Math.min(1, hitRate / 5) * 0.4 + lvAvg * 0.3 + drums * 0.25 + (0.5 - calmMood) * 0.3) * audible;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt / (target > this.intensity ? 3 : 6)));
    this.sat = 32 + this.intensity * 58;
    let nudge = 0;
    const chroma = f.spectrum?.chroma;
    if (chroma && audible > 0.5) {
      let best = 0;
      for (let i = 1; i < 12; i++) if (chroma[i] > chroma[best]) best = i;
      if (chroma[best] > 0.6) nudge = (((best * 7) % 12) / 11 - 0.5) * 24;
    }
    this.hueTarget = (moodHue(this.intensity) + nudge + 360) % 360;
    const dh = ((this.hueTarget - this.hue + 540) % 360) - 180;
    this.hue = (this.hue + dh * (1 - Math.exp(-dt * 0.5)) + 360) % 360;

    // Sustained, tonal sound (strings, pads, choirs) and its swell feed the aurora.
    const tonalNow = f.tonal !== undefined ? f.tonal : clamp(((f.level.other + f.level.vocals) / 2) * (1 - f.level.drums * 0.6)) * audible;
    this.tonal += (tonalNow - this.tonal) * (1 - Math.exp(-dt / (tonalNow > this.tonal ? 1.2 : 2.5)));
    const swellNow = f.swell !== undefined ? f.swell : lvAvg * audible;
    this.swell += (swellNow - this.swell) * (1 - Math.exp(-dt / 1.5));
    const strNow = f.presence ? clamp(Math.max(f.presence.strings, f.presence.synth * 0.5)) : 0;
    this.strings += (strNow - this.strings) * (1 - Math.exp(-dt / 2));

    // Sung melody → the comet ahead.
    const c = this.comet;
    let sung: number | null = f.voice ? f.voice.p : null;
    for (const n of f.notes) if (n.voice === 'vocals') sung = n.p;
    if (sung !== null) {
      c.target = sung;
      c.lastAt = this.t;
      c.lo = Math.min(c.lo, sung);
      c.hi = Math.max(c.hi, sung);
    }
    const singing = this.t - c.lastAt < 0.6;
    c.p += (c.target - c.p) * (1 - Math.exp(-dt * 4));
    c.lv += ((singing ? Math.max(0.4, f.level.vocals) : 0) - c.lv) * (1 - Math.exp(-dt * (singing ? 6 : 1.5)));

    // The whole spectrum becomes dust: louder bands emit more motes, and a
    // swelling passage makes the whole field bloom.
    const bands = f.spectrum?.bands;
    const rate = (40 + this.energy * 160 + this.swell * 90) * audible;
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      const fq = i / (SPECTRUM_BANDS - 1);
      const lv = bands ? bands[i] : 0;
      this.spawnDebt[i] += (Math.pow(lv, 2.2) * rate * dt * (1.2 - fq * 0.6)) / SPECTRUM_BANDS * 3;
      while (this.spawnDebt[i] >= 1) {
        this.spawnDebt[i] -= 1;
        this.spawn(fq, lv);
      }
    }
    // Continuous treble keeps the halo softly sparkling.
    if (bands) {
      let hi = 0;
      for (let i = SPECTRUM_BANDS - 10; i < SPECTRUM_BANDS; i++) hi += bands[i] / 10;
      this.glintDebt += Math.pow(hi, 2.5) * 40 * audible * dt;
      while (this.glintDebt >= 1) {
        this.glintDebt -= 1;
        this.glints.push({ ang: Math.random() * Math.PI * 2, r: 0.38 + Math.random() * 0.14, life: 0, max: 0.4, size: 0.4 + hi * 0.5 });
      }
    }
    if (this.glints.length > 300) this.glints.splice(0, this.glints.length - 300);
    // Quiet dust keeps space alive in silence: a calm drift, never a stop.
    if (Math.random() < dt * (3 + 7 * this.calm)) this.spawn(Math.random(), 0.12 + Math.random() * 0.1);
  }

  /** A vertical ray of aurora light: bright near the top, fading downward. */
  private raySprite(hue: number) {
    const h = Math.round(hue / 10) * 10;
    const key = `ray${h}`;
    const cache = (this.sprites as unknown as { cache: Map<string, HTMLCanvasElement> }).cache;
    let c = cache.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = 4;
      c.height = 128;
      const g = c.getContext('2d')!;
      const grad = g.createLinearGradient(0, 0, 0, 128);
      grad.addColorStop(0, `hsla(${h} 85% 75% / 0)`);
      grad.addColorStop(0.1, `hsla(${h} 85% 72% / 0.9)`);
      grad.addColorStop(0.35, `hsla(${h + 15} 80% 60% / 0.45)`);
      grad.addColorStop(1, `hsla(${h + 30} 75% 45% / 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 128);
      cache.set(key, c);
    }
    return c;
  }

  /**
   * The aurora: curtains of fine vertical rays hanging from flowing curves,
   * driven by sustained tonal sound (strings, pads, choirs, held notes). A
   * swelling orchestra lifts, lengthens and brightens them; drum-led music
   * keeps them faint. Brightness drifts along each curtain in patches.
   */
  private drawAurora(ctx: CanvasRenderingContext2D, dt: number) {
    const { w, h, S } = this;
    // Recognised strings (or pads) are exactly what the aurora is for: let them fill the sky.
    const strength = clamp(this.tonal * (0.45 + this.swell * 0.9) * (1 + this.strings * 0.7) * (1 - this.calm * 0.75));
    if (strength < 0.02) return;
    const step = Math.max(3, Math.round(4 * S));
    for (const a of this.aurora) {
      a.phase += dt * (0.12 + this.energy * 0.25) * (0.7 + a.drift * 6);
      const hue = stopsHue(clamp(this.intensity), [
        [0, 190],
        [0.4, 250],
        [0.7, 300],
        [1, 335],
      ]) + a.hueOff;
      const sprite = this.raySprite((hue + 360) % 360);
      const top0 = h * (a.y - this.swell * 0.05);
      const len = h * (0.14 + strength * 0.26);
      for (let x = -step; x < w + step; x += step) {
        const u = x / w;
        const top = top0 + Math.sin(u * 2.3 + a.phase) * h * 0.09 + Math.sin(u * 5.7 - a.phase * 0.7) * h * 0.03;
        // Patches of brightness drifting along the curtain, plus fine ray texture.
        const patch = clamp(0.5 + 0.5 * Math.sin(u * 5.3 + a.phase * 1.3) * Math.sin(u * 2.2 - a.phase * 0.5 + a.hueOff));
        // Irregular rays: a hashed brightness per column that drifts slowly.
        const col = Math.floor(x / step);
        const n1 = hash(col * 1.7 + a.hueOff);
        const ray = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(n1 * 40 + a.phase * (0.8 + n1)), 2);
        const alpha = strength * patch * ray * 0.6;
        if (alpha < 0.01) continue;
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite, x, top - len * 0.1, step * 1.3, len * (0.6 + 0.7 * hash(col * 3.1 + 7)));
      }
    }
    ctx.globalAlpha = 1;
  }

  private step(dt: number) {
    const move = reduceMotion ? 0.5 : 1;
    // Cruise speed follows the energy; silence slows to a gentle float.
    const cruise = (0.9 + this.energy * 10) * (1 - this.calm * 0.4) * move;
    this.speed += (cruise - this.speed) * (1 - Math.exp(-dt * 1.5));
    const v = this.speed * (1 + this.surge * 2.2 * move);
    // The heading wanders: a new random direction every so often, eased in,
    // so the path curves and never repeats.
    const cam = this.cam;
    if (this.t > cam.next) {
      const ang = Math.random() * Math.PI * 2;
      const mag = (0.2 + Math.random() * 0.9) * (0.5 + this.energy);
      cam.tx = Math.cos(ang) * mag;
      cam.ty = Math.sin(ang) * mag * 0.7;
      cam.next = this.t + 6 + Math.random() * 14;
    }
    const ease = 1 - Math.exp(-dt / 4);
    cam.vx += (cam.tx - cam.vx) * ease;
    cam.vy += (cam.ty - cam.vy) * ease;
    const sx = cam.vx * dt * move;
    const sy = cam.vy * dt * move;
    for (const m of this.dust) {
      m.z -= v * dt;
      m.x -= sx;
      m.y -= sy;
    }
    for (const s of this.stars) {
      s.z -= v * dt * 0.08;
      s.x -= sx * 0.6;
      s.y -= sy * 0.6;
      if (s.z < 30 || Math.abs(s.x) > 70 || Math.abs(s.y) > 48) Object.assign(s, this.newStar(150 + Math.random() * 30));
    }
    for (const g of this.sights) {
      g.z -= v * dt * 0.35;
      g.x -= sx * 0.8;
      g.y -= sy * 0.8;
    }
    this.sights = this.sights.filter((g) => g.z > 1.5);
    this.nextSight -= dt * (0.6 + this.energy);
    if (this.nextSight <= 0 && this.sights.length < 3) {
      const r = Math.random();
      const kind = r < 0.6 ? 'nebula' : 'cluster';
      const ang = Math.random() * Math.PI * 2;
      const dist = 2 + Math.random() * 6;
      this.sights.push({
        kind,
        x: Math.cos(ang) * dist,
        y: Math.sin(ang) * dist * 0.7,
        z: FAR * 1.8,
        size: kind === 'nebula' ? 3 + Math.random() * 4 : 0.8 + Math.random() * 1.2,
        hue: (this.hue + (Math.random() - 0.5) * 120 + 360) % 360,
        spin: (Math.random() - 0.5) * 0.3,
        seed: Math.random() * 100,
        pts: kind === 'cluster' ? Array.from({ length: 60 }, () => [gauss() * 0.4, gauss() * 0.4] as [number, number]) : undefined,
      });
      this.nextSight = 14 + Math.random() * 26;
    }
    for (const l of this.lanes) {
      l.ang += l.spin * dt;
      l.life -= dt;
    }
    this.lanes = this.lanes.map((l) => (l.life > 0 ? l : this.newLane()));
    // Everything transient ages and fades.
    this.dust = this.dust.filter((m) => m.z > NEAR);
    for (const r of this.rings) r.z -= v * dt * 1.15;
    this.rings = this.rings.filter((r) => r.z > NEAR);
    this.waves = this.waves.filter((w) => (w.age += dt) < 0.9);
    this.glints = this.glints.filter((g) => (g.life += dt) < g.max);
    this.surge *= Math.exp(-dt * 6);
    this.kickFlash *= Math.exp(-dt * 7);
    this.bassHit *= Math.exp(-dt * 5);
    this.shimmer *= Math.exp(-dt * 1.8);
    this.roll += dt * (0.008 + this.energy * 0.022) * move;
  }

  /** Passing scenery: nebula clouds, galaxies and star clusters. */
  private drawSights(ctx: CanvasRenderingContext2D, F: number, live: number) {
    for (const g of this.sights) {
      const s = F / g.z;
      const x = g.x * s;
      const y = g.y * s;
      const R = g.size * s;
      const fade = clamp((FAR * 1.8 - g.z) / 10) * clamp((g.z - 1.5) / 4) * (0.5 + live * 0.5);
      if (fade < 0.01) continue;
      if (g.kind === 'nebula') {
        for (let i = 0; i < 4; i++) {
          const ox = Math.cos(g.seed + i * 2.3) * R * 0.45;
          const oy = Math.sin(g.seed * 1.7 + i * 1.9) * R * 0.3;
          const gr = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, R * (0.6 + 0.15 * i));
          const hh = (g.hue + i * 14) % 360;
          gr.addColorStop(0, `hsla(${hh} ${this.sat}% 55% / ${0.07 * fade})`);
          gr.addColorStop(1, `hsla(${hh} ${this.sat}% 40% / 0)`);
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, R * (0.6 + 0.15 * i), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (g.pts) {
        ctx.fillStyle = `hsla(${g.hue} 30% 88% / ${0.6 * fade})`;
        for (const [px, py] of g.pts) ctx.fillRect(x + px * R, y + py * R, 1.3 * this.S, 1.3 * this.S);
        const gr = ctx.createRadialGradient(x, y, 0, x, y, R * 0.8);
        gr.addColorStop(0, `hsla(${g.hue} 40% 80% / ${0.12 * fade})`);
        gr.addColorStop(1, `hsla(${g.hue} 40% 60% / 0)`);
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(x, y, R * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, f: Frame) {
    if (f.reset) this.rings = [];
    this.listen(f);
    this.step(f.dt);
    const { w, h, S } = this;
    const cx = w / 2;
    const cy = h / 2;
    const F = this.F;
    const live = 1 - this.calm;

    // Deep space.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#020208';
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'lighter';
    this.drawAurora(ctx, f.dt);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.roll);
    ctx.globalCompositeOperation = 'lighter';

    // A faint wash of the mood colour, then the deep star field and any
    // scenery drifting past.
    const wash = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) * 0.8);
    wash.addColorStop(0, `hsla(${this.hue} ${this.sat}% ${18 + this.intensity * 12}% / ${0.05 + live * 0.05 + this.shimmer * 0.04})`);
    wash.addColorStop(1, `hsla(${this.hue} ${this.sat}% 15% / 0)`);
    ctx.fillStyle = wash;
    ctx.fillRect(-w, -h, w * 2, h * 2);
    for (const st of this.stars) {
      const s = F / st.z;
      const x = st.x * s;
      const y = st.y * s;
      if (Math.abs(x) > w || Math.abs(y) > h) continue;
      const a = (0.25 + st.bright * 0.6) * (0.75 + 0.25 * Math.sin(this.t * (0.5 + st.bright) + st.tw)) + this.shimmer * 0.3;
      const r = st.r * this.S * (0.6 + 40 / st.z);
      ctx.fillStyle = `hsla(${st.hue} ${st.sat}% 88% / ${clamp(a)})`;
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
    this.drawSights(ctx, F, live);

    // The bass core at the vanishing point.
    const coreR = Math.min(w, h) * (0.05 + this.bass * 0.22 + this.bassHit * 0.08) * (0.45 + live * 0.55);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 3.2);
    const ch = this.warm;
    core.addColorStop(0, `hsla(${ch + 20} ${this.sat}% 72% / ${0.08 + this.bass * 0.22 + this.kickFlash * 0.08})`);
    core.addColorStop(0.2, `hsla(${ch} ${this.sat}% 50% / ${0.06 + this.bass * 0.2 + this.bassHit * 0.08})`);
    core.addColorStop(0.55, `hsla(${ch} 85% 45% / ${0.03 + this.bass * 0.07})`);
    core.addColorStop(1, `hsla(${ch} 80% 40% / 0)`);
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, coreR * 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Kick shockwaves rolling out across space.
    for (const wv of this.waves) {
      const k = wv.age / 0.9;
      const R = Math.max(w, h) * (0.05 + (1 - Math.pow(1 - k, 2.4)) * 0.75);
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${this.warm} 70% 55% / ${(1 - k) * 0.05 * wv.v})`;
      ctx.lineWidth = (60 * (1 - k) + 6) * S;
      ctx.stroke();
      ctx.strokeStyle = `hsla(${this.warm + 10} 70% 80% / ${(1 - k) * 0.32 * wv.v})`;
      ctx.lineWidth = (3 * (1 - k) + 1) * S;
      ctx.stroke();
    }

    // Snare rings flying past.
    for (const r of this.rings) {
      const s = F / r.z;
      const R = r.r * s;
      const a = r.a * clamp((FAR * 0.5 - r.z) / 4) * clamp(r.z / 1.2);
      ctx.strokeStyle = `hsla(${r.hue} 70% 82% / ${a})`;
      ctx.lineWidth = Math.max(1.2 * S, 0.014 * s);
      ctx.lineCap = 'round';
      ctx.setLineDash([0.001, 0.07 * s]);
      ctx.lineDashOffset = r.spin * s;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // The stream of stardust. During a surge, motes stretch into streaks.
    const streak = this.surge > 0.15 && !reduceMotion;
    for (const m of this.dust) {
      const s = F / m.z;
      const x = m.x * s;
      const y = m.y * s;
      const fadeIn = clamp((FAR - m.z) / 6);
      // Motes dissolve before they reach you instead of ballooning into blobs.
      const fadeOut = clamp((m.z - NEAR) / 3.5);
      const a = Math.max(m.a, 0.55 * this.calm) * fadeIn * fadeOut * (0.3 + live * 0.38);
      const R = Math.max(0.6 * S, Math.min(22 * S, m.size * s * 0.8));
      if (streak && m.seen) {
        ctx.strokeStyle = `hsla(${m.hue} 85% ${m.light}% / ${a * 0.55})`;
        ctx.lineWidth = Math.min(3 * S, Math.max(0.7 * S, R * 0.35));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(m.sx, m.sy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.globalAlpha = clamp(a);
      ctx.drawImage(this.sprites.get(m.hue, m.light, this.sat + 10), x - R * 2, y - R * 2, R * 4, R * 4);
      ctx.globalAlpha = 1;
      m.sx = x;
      m.sy = y;
      m.seen = true;
    }


    // The treble halo: crisp four-point glints around the edge of view.
    const M = Math.min(w, h);
    for (const g of this.glints) {
      const k = g.life / g.max;
      const a = (1 - k) * (k < 0.15 ? k / 0.15 : 1);
      const x = Math.cos(g.ang) * g.r * M * 1.15;
      const y = Math.sin(g.ang) * g.r * M;
      const L = (3 + 7 * g.size) * S * (1 - k * 0.4);
      ctx.strokeStyle = `hsla(${(this.hue + 150) % 360} 60% 92% / ${a * 0.9})`;
      ctx.lineWidth = 0.9 * S;
      ctx.beginPath();
      ctx.moveTo(x - L, y);
      ctx.lineTo(x + L, y);
      ctx.moveTo(x, y - L);
      ctx.lineTo(x, y + L);
      ctx.stroke();
      ctx.fillStyle = `hsla(0 0% 100% / ${a})`;
      ctx.fillRect(x - S, y - S, 2 * S, 2 * S);
    }

    // The sung melody: a comet ahead, its trail drifting past you.
    const c = this.comet;
    if (c.lv > 0.02) {
      const range = Math.max(10, c.hi - c.lo);
      const pitch = clamp((c.p - c.lo) / range);
      const z = 5;
      const s = F / z;
      const tx = Math.sin(this.t * 0.35) * 0.9;
      const ty = 0.9 - pitch * 1.8;
      c.x += (tx - c.x) * 0.05;
      c.y += (ty - c.y) * 0.08;
      if (Math.random() < 0.9) {
        if (this.dust.length >= MAX_DUST) this.dust.shift();
        this.dust.push({ x: c.x + (Math.random() - 0.5) * 0.05, y: c.y + (Math.random() - 0.5) * 0.05, z, size: 0.03 * (0.5 + c.lv), hue: 32, light: 74, a: 0.8 * c.lv, sx: 0, sy: 0, seen: false });
      }
      const R = (10 + 18 * c.lv) * S;
      ctx.globalAlpha = clamp(c.lv * 1.4);
      ctx.drawImage(this.sprites.get(34, 82), c.x * s - R * 2, c.y * s - R * 2, R * 4, R * 4);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

/** Interpolate between two hues the short way round the colour wheel. */
function lerpHue(a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

/** Mood → hue: chill deep blue → violet → magenta → hot rose/ember. */
function moodHue(intensity: number) {
  return stopsHue(intensity, [
    [0, 212],
    [0.3, 236],
    [0.5, 268],
    [0.7, 312],
    [0.85, 340],
    [1, 12],
  ]);
}

/** Piecewise hue ramp; each step is short, so it never crosses green. */
function stopsHue(t: number, stops: [number, number][]) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a0, h0] = stops[i - 1];
      const [a1, h1] = stops[i];
      return lerpHue(h0, h1, (t - a0) / (a1 - a0));
    }
  }
  return stops[stops.length - 1][1];
}

function M0(w: number, h: number) {
  return Math.min(w, h);
}

/** A standard normal sample (Box–Muller). */
function gauss() {
  return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

/** Deterministic 0..1 noise for a number. */
function hash(x: number) {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
