// Cosmos: drifting forward through a universe made of the song.
//
// The whole sound streams toward you as stardust: low sounds are large, warm,
// slow motes near your path; high sounds are fine cool sparks out at the edges.
// The bass is the core at the vanishing point, swelling with every bass note.
// A kick sends a shockwave across space and a surge forward (the dust stretches
// into streaks); a snare throws a ring of light that flies past you; hi-hats
// make the stars twinkle; cymbals shimmer everything. A sung melody is a
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
  /** Seconds since the mote was born from a sound (undefined: background dust). */
  age?: number;
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
  private stars: { x: number; y: number; z: number; r: number; hue: number; sat: number; tw: number; bright: number; spark: number }[] = [];
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
  /** A short pulse on every kick and snare: the whole field brightens for a moment. */
  private beatFlash = 0;
  /** The melody line: a comet. `voice` 1 = a singing voice (warm), 0 = an instrument (cool). */
  private comet = { x: 0, y: 0, p: 60, target: 60, lo: 127, hi: 0, lv: 0, lastAt: -9, voice: 1 };
  /**
   * Notes of keys and other note instruments (piano, đàn tranh, harp…): each
   * lights a star around the centre, placed by its note name (angle) and how
   * high it is (distance). Chords make small constellations; melody notes are
   * linked by faint lines.
   */
  private noteStars: { x: number; y: number; v: number; age: number; life: number; hue: number; from?: [number, number] }[] = [];
  private lastLead: { x: number; y: number; t: number } | null = null;
  private spawnDebt = new Float32Array(SPECTRUM_BANDS);
  /** 0 = chill … 1 = intense: drives colour, saturation and brightness. */
  private intensity = 0.25;
  private sat = 50;
  private hitTimes: number[] = [];
  /** Continuous treble makes the odd star twinkle too (accumulated fractional twinkles). */
  private twinkleDebt = 0;
  /** 0 = the melodic instruments are keys … 1 = they are guitars. */
  private guitarness = 0.3;
  private lastChordAt = -1;
  /**
   * Guitar pick strokes: hair-fine arcs of warm light swept across the view.
   * Angles in radians around the centre; `r` is a share of the screen; `dir`
   * alternates like down and up strokes; `drift` how far the line moves outward
   * along its sweep (so it reads as a brush stroke, not part of a ring).
   */
  private picks: { a0: number; span: number; r: number; dir: number; life: number; max: number; v: number; drift: number }[] = [];
  private pickDir = 1;
  private grit = 0;
  /** Sustained, tonal sound (strings, pads, choirs, held notes) and its swell. */
  private tonal = 0;
  private swell = 0;
  /** How clearly bowed strings / string sections are recognised (0..1). */
  private strings = 0;
  /**
   * The Milky Way band (sustained sound). Positions along the band (u, -1.2..1.2)
   * and across it (v); `depth` 0.5 = far layer, 1 = near layer (flows faster).
   */
  private band = {
    flow: 0,
    wave: 9, // position of the light wave running outward along the band (9 = none)
    slow: 0, // slowly following strength, to notice held sound coming in
    // Natural colours: warm cream starlight along the dense middle, blue-white
    // towards the edges (`warm` 1..0), as in photographs of the Milky Way.
    motes: Array.from({ length: 1600 }, () => {
      const v = gauss() * 0.4;
      return { u: Math.random() * 2.4 - 1.2, v, b: Math.pow(Math.random(), 1.8), depth: Math.random() < 0.5 ? 0.5 : 1, warm: Math.random() < Math.exp(-v * v * 12) ? 1 : 0 };
    }),
    nebulae: Array.from({ length: 7 }, (_, i) => ({ u: Math.random() * 2.4 - 1.2, v: gauss() * 0.25, r: 0.025 + Math.random() * 0.03, pink: i % 3 !== 2, depth: Math.random() < 0.5 ? 0.5 : 1 })),
    clouds: Array.from({ length: 30 }, () => ({ u: Math.random() * 2.4 - 1.2, v: gauss() * 0.22, r: 0.07 + Math.random() * 0.12, h: Math.random(), b: 0.25 + 0.75 * Math.pow(Math.random(), 1.5), depth: Math.random() < 0.5 ? 0.5 : 1 })),
    lanes: Array.from({ length: 24 }, () => ({ u: Math.random() * 2.4 - 1.2, v: gauss() * 0.14, r: 0.03 + Math.random() * 0.08, stretch: 1.5 + Math.random() * 2.5, depth: Math.random() < 0.5 ? 0.5 : 1 })),
  };

  constructor() {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    void rnd;
    for (let i = 0; i < 520; i++) this.stars.push(this.newStar(40 + Math.random() * 140));
    for (let i = 0; i < 4; i++) this.lanes.push(this.newLane());
    // Start with some dust already in the field, so the first frame isn't empty.
    for (let i = 0; i < 400; i++) this.spawn(Math.random(), 0.25, 8 + Math.random() * (FAR - 8));
    for (const m of this.dust) m.age = undefined;
  }

  private newStar(z: number) {
    // Star colours by temperature: mostly white, some blue, a few gold and ember.
    const t = Math.random();
    const [hue, sat] = t < 0.55 ? [220, 10] : t < 0.8 ? [210, 55] : t < 0.93 ? [45, 60] : [20, 70];
    const bright = Math.random() < 0.03 ? 0.8 : Math.pow(Math.random(), 2.4) * 0.6;
    return { x: (Math.random() * 2 - 1) * 60, y: (Math.random() * 2 - 1) * 40, z, r: 0.4 + Math.random() * 0.9 + bright * 0.6, hue, sat, tw: Math.random() * 6.28, bright, spark: 0 };
  }

  private newLane() {
    return { ang: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.12, width: 0.25 + Math.random() * 0.4, life: 12 + Math.random() * 30 };
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
  private spawn(f: number, level: number, z = FAR - Math.random() * 6) {
    if (this.dust.length >= MAX_DUST) this.dust.shift();
    // Some dust gathers into loose drifting lanes; most scatters freely, so no
    // shape repeats long enough to be noticed.
    const lane = this.lanes.length && Math.random() < 0.3 ? this.lanes[Math.floor(Math.random() * this.lanes.length)] : null;
    const ang = lane ? lane.ang + gauss() * lane.width : Math.random() * Math.PI * 2;
    // Low sounds tend to stay close to the path and high sounds out at the
    // edges, but each mote is scattered widely around its band's distance so
    // the bands never line up into visible rings.
    const r = Math.max(0.15, (0.25 + Math.pow(f, 0.85) * 3.2) * (0.65 + Math.random() * 0.7) + gauss() * 0.3);
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
      age: 0,
    });
  }

  /**
   * Guitar: a strum releases a warm sweep of sparks along one of the dust
   * lanes, flying past like everything else. Grittier guitar, more sparks.
   */
  /**
   * Make `n` background stars twinkle with strength `v`. With `patch`, they are
   * the stars around one spot, so a patch of sky lights up together.
   */
  private twinkle(n: number, v: number, patch: boolean) {
    const visible = this.stars.filter((st) => Math.abs(st.x / st.z) < 0.7 && Math.abs(st.y / st.z) < 0.45);
    if (!visible.length) return;
    if (patch) {
      const c = visible[Math.floor(Math.random() * visible.length)];
      const near = visible
        .map((st) => ({ st, d: Math.hypot(st.x / st.z - c.x / c.z, st.y / st.z - c.y / c.z) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, n * 2);
      for (const { st, d } of near) st.spark = Math.max(st.spark, v * (1 - d * 2));
      return;
    }
    for (let i = 0; i < n; i++) {
      const st = visible[Math.floor(Math.random() * visible.length)];
      st.spark = Math.max(st.spark, v * (0.7 + 0.3 * Math.random()));
    }
  }

  /** A note of keys or another note instrument lights a star (see `noteStars`). */
  private noteStar(p: number, v: number, d: number, lead: boolean) {
    const pc = ((Math.round(p) % 12) + 12) % 12;
    const ang = (pc / 12) * Math.PI * 2 - Math.PI / 2;
    const r = 0.17 + clamp((p - 36) / 60) * 0.22 + (Math.random() - 0.5) * 0.02;
    const x = Math.cos(ang) * r * 1.15;
    const y = Math.sin(ang) * r;
    const star: (typeof this.noteStars)[number] = { x, y, v: clamp(0.35 + v * 0.65), age: 0, life: clamp(d, 0.4, 2) + 0.4, hue: 38 + pc * 3 };
    if (lead) {
      if (this.lastLead && this.t - this.lastLead.t < 0.8) star.from = [this.lastLead.x, this.lastLead.y];
      this.lastLead = { x, y, t: this.t };
    }
    this.noteStars.push(star);
    if (this.noteStars.length > 160) this.noteStars.shift();
  }

  /** A guitar strum (or a single picked note): a pick stroke of light (see `picks`). */
  private strum(p: number, v: number, single: boolean) {
    if (!single && this.t - this.lastChordAt < 0.12) return; // one stroke per strum
    if (!single) {
      this.lastChordAt = this.t;
      this.pickDir = -this.pickDir; // down, up, down…
    }
    this.picks.push({
      a0: Math.random() * Math.PI * 2,
      span: single ? 0.22 + Math.random() * 0.12 : 0.7 + 0.45 * v,
      // Higher notes sit further out, like the high strings.
      r: (single ? 0.17 + clamp((p - 50) / 40) * 0.2 : 0.24 + Math.random() * 0.12) * (0.95 + Math.random() * 0.1),
      dir: single ? (Math.random() < 0.5 ? -1 : 1) : this.pickDir,
      life: 0,
      max: single ? 0.8 : 1.1,
      v: clamp(0.4 + 0.6 * v),
      drift: (single ? 0.02 : 0.05) * (0.6 + Math.random() * 0.8),
    });
    if (this.picks.length > 40) this.picks.shift();
  }


  private listen(f: Frame) {
    const dt = f.dt;
    this.t += dt;
    const audible = f.audible ?? (f.idle ? 0 : 1);
    // Everything wakes up within a fraction of a second when music starts, and
    // settles slowly when it stops (that slow fall is what keeps it calm).
    this.calm += ((1 - audible) - this.calm) * (1 - Math.exp(-dt * (audible > 1 - this.calm ? 10 : 0.8)));
    // Energy from the sound itself (loudness against the song's own level,
    // intensity, drums), so sections show; the recogniser's guess only when
    // these measures are missing (a dropped song).
    const drumsNow = Math.max(f.presence?.drums ?? 0, f.drumEvidence ?? 0);
    const energyNow =
      (f.intensity !== undefined ? clamp(0.1 + 0.5 * f.intensity + 0.3 * (f.swell ?? 0) + 0.2 * drumsNow) : energyOf(f)) * audible;
    this.energy += (energyNow - this.energy) * (1 - Math.exp(-dt * (energyNow > this.energy ? 6 : 0.8)));
    // The bass core swells with the bass, and with every kick.
    const bassNow = f.level.bass * audible;
    this.bass += (bassNow - this.bass) * (1 - Math.exp(-dt * (bassNow > this.bass ? 14 : 3)));

    for (const hh of f.hits) {
      if (hh.hit === 'kick' || hh.hit === 'tom') {
        this.surge = Math.max(this.surge, hh.v);
        // Without a steady beat to follow, strong kicks pulse the field themselves.
        if (!f.beatLocked && hh.v > 0.5) {
          this.kickFlash = Math.max(this.kickFlash, hh.v);
          this.beatFlash = Math.max(this.beatFlash, hh.v);
        }
        this.waves.push({ age: 0, v: hh.v });
      } else if (hh.hit === 'snare' && hh.v > 0.35) {
        if (!f.beatLocked && hh.v > 0.5) this.beatFlash = Math.max(this.beatFlash, hh.v * 0.7);
        this.rings.push({ z: 9, r: 1.6 + Math.random() * 0.8, hue: (this.hue + 180) % 360, a: Math.pow(hh.v, 1.5), spin: Math.random() * 6 });
      } else if (hh.hit === 'hat') {
        // The sky keeps time: a few stars twinkle on each hi-hat; a loud one
        // (an open hi-hat) sets a whole patch of sky twinkling.
        this.twinkle(Math.round(3 + 5 * hh.v), hh.v, hh.v > 0.8);
      } else this.shimmer = Math.max(this.shimmer, hh.v);
    }
    // On the beat: the whole field brightens and the bass core flashes, timed by
    // the beat tracker to land as the beat is heard.
    if (f.beat) {
      this.beatFlash = Math.max(this.beatFlash, f.beat);
      this.kickFlash = Math.max(this.kickFlash, f.beat * 0.9);
    }
    for (const n of f.notes) if (n.voice === 'bass') this.bassHit = Math.max(this.bassHit, 0.5 + n.v * 0.5);

    // Guitar or keys? The recogniser hears piano, organ and strings well but
    // rarely hears guitars inside a full band mix, so notes count as guitar
    // unless something says keys: the recogniser hearing keys or strings, or a
    // very clean, pure tone. Grit (distortion is noise-like) and the
    // recogniser hearing guitar push further towards guitar.
    this.grit = f.grit ?? this.grit;
    const gritG = clamp((this.grit - 0.08) / 0.15);
    const pres = f.presence;
    const keys = pres ? clamp(Math.max(pres.keys, pres.synth * 0.6, pres.strings * 0.8) * 4) : 0;
    const guitarHeard = pres ? clamp(pres.guitar * 4) : 0;
    const pure = gritG < 0.1 ? 0.25 : 0;
    let g = clamp(0.55 + 0.45 * gritG + 0.4 * guitarHeard - keys - pure);
    // Electronic music is gritty too (supersaws): that grit is synth, not guitar.
    if (f.layout === 'center') g *= 0.15;
    if (audible > 0.5) this.guitarness += (g - this.guitarness) * (1 - Math.exp(-dt / 2.5));
    for (const n of f.notes) {
      if (n.voice !== 'chords' && n.voice !== 'lead') continue;
      if (Math.random() < this.guitarness) this.strum(n.p, n.v, n.voice === 'lead');
      else this.noteStar(n.p, n.v, n.d, n.voice === 'lead');
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
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt / (target > this.intensity ? 0.6 : 6)));
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
    this.hue = (this.hue + dh * (1 - Math.exp(-dt * 1.2)) + 360) % 360;

    // Sustained, tonal sound (strings, pads, choirs) and its swell feed the Milky Way band.
    const tonalNow = f.tonal !== undefined ? f.tonal : clamp(((f.level.other + f.level.vocals) / 2) * (1 - f.level.drums * 0.6)) * audible;
    this.tonal += (tonalNow - this.tonal) * (1 - Math.exp(-dt / (tonalNow > this.tonal ? 0.4 : 2.5)));
    const swellNow = f.swell !== undefined ? f.swell : lvAvg * audible;
    this.swell += (swellNow - this.swell) * (1 - Math.exp(-dt / (swellNow > this.swell ? 0.4 : 1.5)));
    const strNow = f.presence ? clamp(Math.max(f.presence.strings, f.presence.synth * 0.5)) : 0;
    this.strings += (strNow - this.strings) * (1 - Math.exp(-dt / 2));

    // The melody line → the comet ahead: warm for a singing voice, cool for an
    // instrument's melody (or a voice the recogniser missed).
    const c = this.comet;
    let sung: number | null = f.voice ? f.voice.p : null;
    for (const n of f.notes) if (n.voice === 'vocals') sung = n.p;
    const isVoice = sung !== null;
    if (sung === null && f.melody) sung = f.melody.p;
    if (sung !== null) c.voice += ((isVoice ? 1 : 0) - c.voice) * (1 - Math.exp(-dt * 2));
    if (sung !== null) {
      c.target = sung;
      c.lastAt = this.t;
      c.lo = Math.min(c.lo, sung);
      c.hi = Math.max(c.hi, sung);
    }
    const singing = this.t - c.lastAt < 0.6;
    c.p += (c.target - c.p) * (1 - Math.exp(-dt * 4));
    const melodyLevel = isVoice ? Math.max(0.4, f.level.vocals) : Math.max(0.3, f.level.other) * 0.8;
    c.lv += ((singing ? melodyLevel : 0) - c.lv) * (1 - Math.exp(-dt * (singing ? 6 : 1.5)));

    // The whole spectrum becomes dust: louder bands emit more motes, and a
    // swelling passage makes the whole field bloom.
    const bands = f.spectrum?.bands;
    // Kept modest: energy now follows the real sound (often high in loud music),
    // and a crowded stream pulls the eye away from everything else.
    const rate = (30 + this.energy * 90 + this.swell * 50) * audible;
    for (let i = 0; i < SPECTRUM_BANDS; i++) {
      const fq = i / (SPECTRUM_BANDS - 1);
      const lv = bands ? bands[i] : 0;
      this.spawnDebt[i] += (Math.pow(lv, 2.2) * rate * dt * (1.2 - fq * 0.6)) / SPECTRUM_BANDS * 3;
      while (this.spawnDebt[i] >= 1) {
        this.spawnDebt[i] -= 1;
        this.spawn(fq, lv);
      }
    }
    // Continuous treble keeps the odd star softly twinkling.
    if (bands) {
      let hi = 0;
      for (let i = SPECTRUM_BANDS - 10; i < SPECTRUM_BANDS; i++) hi += bands[i] / 10;
      this.twinkleDebt += Math.pow(hi, 2.5) * 25 * audible * dt;
      if (this.twinkleDebt >= 1) {
        const n = Math.floor(this.twinkleDebt);
        this.twinkleDebt -= n;
        this.twinkle(n, 0.35 + hi * 0.4, false);
      }
    }
    // Quiet dust keeps space alive in silence: a calm drift, never a stop.
    if (Math.random() < dt * (3 + 7 * this.calm)) this.spawn(Math.random(), 0.12 + Math.random() * 0.1);
  }

  /** A very soft round puff of light (no bright core, unlike the dust sprites): band clouds and note halos. */
  private puffSprite(hue: number, sat = 70, light = 58) {
    const h = Math.round(hue / 8) * 8;
    const key = `puff${h}|${sat}|${light}`;
    const cache = (this.sprites as unknown as { cache: Map<string, HTMLCanvasElement> }).cache;
    let c = cache.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      for (let i = 0; i <= 6; i++) {
        const u = i / 6;
        grad.addColorStop(u, `hsla(${h} ${sat}% ${light}% / ${(0.5 * Math.exp(-u * u * 4.5)).toFixed(3)})`);
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      cache.set(key, c);
    }
    return c;
  }

  /**
   * The Milky Way band: sustained, tonal sound (strings, pads, choirs, held
   * notes) as a band of countless faint stars and soft light across the sky,
   * with dark dust lanes. It is never a still picture:
   *  - it flows along its length as you fly, its near layer faster than its
   *    far one, so it has depth;
   *  - when held sound comes in, a wave of light runs outward from its middle;
   *  - its angle and gentle curve drift over minutes.
   * Held sound makes it brighter and wider; drum-led music keeps it faint.
   */
  private drawBand(ctx: CanvasRenderingContext2D, dt: number) {
    const B = this.band;
    const strength = clamp(this.tonal * (0.45 + this.swell * 0.9) * (1 + this.strings * 0.7) * (1 - this.calm * 0.75));
    // Held sound arriving: a light wave runs out along the band.
    if (strength - B.slow > 0.12 && B.wave > 1.4) B.wave = 0;
    B.slow += (strength - B.slow) * (1 - Math.exp(-dt / 2.5));
    B.wave += dt * 0.55;
    B.flow += dt * (0.006 + this.speed * 0.0022);
    if (strength < 0.02) return;
    const M = Math.max(this.w, this.h);
    const S = this.S;
    // Real galaxy colours, with about a quarter of the music's mood blended in,
    // so a calm song gives a cooler band and an intense one a warmer one.
    const MOOD = 0.25;
    const tint = (hue: number) => lerpHue(hue, this.hue, MOOD);
    const cream = tint(40);
    const blue = tint(215);
    const width = M * (0.09 + 0.11 * strength);
    const bend = Math.sin(this.t * 0.031) * 0.12;
    const wrap = (u: number) => ((((u + 1.2) % 2.4) + 2.4) % 2.4) - 1.2;
    const wave = (u: number) => (B.wave < 1.4 ? Math.exp(-Math.pow((Math.abs(u) - B.wave) / 0.14, 2)) * (1 - B.wave / 1.4) : 0);
    // Off-centre: the band sweeps across the sky beside the vanishing point
    // rather than through it, so it never merges with the core into a flare.
    const offset = M * (0.13 + 0.03 * Math.sin(this.t * 0.013));
    const at = (u: number, v: number): [number, number] => [u * M * 0.75, offset + v * width + bend * u * u * M * 0.25];
    ctx.save();
    ctx.rotate(-0.42 + Math.sin(this.t * 0.02) * 0.15);
    // The glow: soft clouds of light, far ones dimmer.
    for (const c of B.clouds) {
      const u = wrap(c.u + B.flow * c.depth);
      const edge = clamp((1.2 - Math.abs(u)) / 0.35);
      // Clouds are stretched along the band, so it reads as one long river of light.
      const R = M * c.r * 0.6 * (0.8 + 0.5 * strength) * (0.75 + 0.25 * c.depth);
      const [x, y] = at(u, c.v);
      ctx.globalAlpha = strength * 0.13 * c.b * edge * (0.6 + 0.4 * c.depth) * (1 + 1.5 * wave(u));
      // Warm cream light along the middle, cooler blue-white further out.
      const warm = Math.exp(-c.v * c.v * 30);
      ctx.drawImage(this.puffSprite(warm > 0.5 ? cream : blue, 28, 64), x - R * 2.2, y - R * 0.6, R * 4.4, R * 1.2);
    }
    // Countless faint stars packed into it, thickest along its middle:
    // warm cream in the dense middle, blue-white towards the edges.
    const creamStar = `hsl(${cream} 40% 90%)`;
    const blueStar = `hsl(${blue} 35% 92%)`;
    for (const m of B.motes) {
      const u = wrap(m.u + B.flow * m.depth);
      const a = strength * (0.36 + m.b * 0.8) * Math.exp(-m.v * m.v * 1.6) * clamp((1.2 - Math.abs(u)) / 0.3) * (1 + 2 * wave(u)) * (0.6 + 0.4 * m.depth);
      if (a < 0.01) continue;
      const [x, y] = at(u, m.v * 1.2);
      const r = (0.9 + m.depth * 0.7 + m.b * 0.6) * S;
      ctx.globalAlpha = clamp(a);
      ctx.fillStyle = m.warm ? creamStar : blueStar;
      ctx.fillRect(x, y, r, r);
    }
    // A few small, faint nebulae, like real star-forming regions: pink and blue.
    for (const n of B.nebulae) {
      const u = wrap(n.u + B.flow * n.depth);
      const R = M * n.r * (0.8 + 0.4 * strength);
      const [x, y] = at(u, n.v);
      ctx.globalAlpha = strength * 0.22 * clamp((1.2 - Math.abs(u)) / 0.35);
      ctx.drawImage(this.puffSprite(n.pink ? tint(340) : tint(200), 55, 62), x - R * 1.6, y - R, R * 3.2, R * 2);
    }
    // Dark dust lanes through it.
    ctx.globalCompositeOperation = 'destination-out';
    for (const l of B.lanes) {
      const u = wrap(l.u + B.flow * l.depth);
      const R = M * l.r;
      const [x, y] = at(u, l.v);
      ctx.globalAlpha = 0.45 * strength * clamp((1.2 - Math.abs(u)) / 0.35);
      ctx.drawImage(this.puffSprite(0), x - R * l.stretch, y - R * 0.5, R * l.stretch * 2, R);
    }
    // ...and the dust itself, faintly brown where it blocks the light.
    ctx.globalCompositeOperation = 'source-over';
    for (const l of B.lanes) {
      const u = wrap(l.u + B.flow * l.depth);
      const R = M * l.r;
      const [x, y] = at(u, l.v);
      ctx.globalAlpha = 0.5 * strength * clamp((1.2 - Math.abs(u)) / 0.35);
      ctx.drawImage(this.puffSprite(25, 40, 10), x - R * l.stretch, y - R * 0.5, R * l.stretch * 2, R);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private step(dt: number) {
    const move = reduceMotion ? 0.5 : 1;
    // Cruise speed follows the energy; silence slows to a gentle float.
    const cruise = (0.9 + this.energy * 6) * (1 - this.calm * 0.4) * move;
    this.speed += (cruise - this.speed) * (1 - Math.exp(-dt * (cruise > this.speed ? 4 : 1.5)));
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
      if (m.age !== undefined) m.age += dt;
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
    for (const st of this.stars) st.spark *= Math.exp(-dt * 7);
    this.picks = this.picks.filter((pk) => (pk.life += dt) < pk.max);
    this.noteStars = this.noteStars.filter((st) => (st.age += dt) < st.life * 2.5);
    this.surge *= Math.exp(-dt * 6);
    this.kickFlash *= Math.exp(-dt * 7);
    this.beatFlash *= Math.exp(-dt * 9);
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

  /** What the scene is doing right now (for the debug recorder). */
  debugState() {
    return {
      energy: this.energy,
      intensity: this.intensity,
      speed: this.speed,
      calm: this.calm,
      surge: this.surge,
      beatFlash: this.beatFlash,
      kickFlash: this.kickFlash,
      bass: this.bass,
      bassHit: this.bassHit,
      hue: this.hue,
      dust: this.dust.length,
      guitarness: this.guitarness,
      comet: this.comet.lv,
      cometVoice: this.comet.voice,
      noteStars: this.noteStars.length,
      tonal: this.tonal,
    };
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
      const a = (0.16 + st.bright * 0.45) * (0.75 + 0.25 * Math.sin(this.t * (0.5 + st.bright) + st.tw)) * (1 + 0.5 * this.beatFlash) + this.shimmer * 0.2 + st.spark * 0.9;
      const r = st.r * this.S * (0.6 + 25 / st.z) * (1 + st.spark * 1.4);
      ctx.fillStyle = `hsla(${st.hue} ${st.sat}% 90% / ${clamp(a)})`;
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
      // A twinkling star gets a soft halo for a moment.
      if (st.spark > 0.15) {
        const R = (2.5 + 4 * st.spark) * this.S;
        ctx.globalAlpha = clamp(st.spark * 0.7);
        ctx.drawImage(this.puffSprite(st.hue, Math.min(40, st.sat), 86), x - R * 2, y - R * 2, R * 4, R * 4);
        ctx.globalAlpha = 1;
      }
    }
    this.drawBand(ctx, f.dt);
    this.drawSights(ctx, F, live);

    // The bass core at the vanishing point.
    const coreR = Math.min(w, h) * (0.05 + this.bass * 0.22 + this.bassHit * 0.08 + this.kickFlash * 0.05) * (0.45 + live * 0.55);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 3.2);
    const ch = this.warm;
    core.addColorStop(0, `hsla(${ch + 20} ${this.sat}% 72% / ${0.08 + this.bass * 0.22 + this.kickFlash * 0.3})`);
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
      // Faint and fine, and gone before the ring grows past the edge of view.
      const a = 0.4 * r.a * clamp((9 - r.z) / 1.2 + 0.3) * clamp((r.z - 1.5) / 3);
      if (a <= 0.003) continue;
      ctx.strokeStyle = `hsla(${r.hue} 60% 82% / ${a})`;
      ctx.lineWidth = Math.max(0.9 * S, 0.008 * s);
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
      // A mote lights up the instant its sound plays (a short flash, stronger for
      // louder sounds), so what you see is in time with what you hear; then it
      // settles into the dim stream drifting towards you.
      const age = m.age ?? 9;
      const born = clamp(age / 0.08);
      const flash = clamp((m.a - 0.3) / 0.7) * Math.exp(-age / 0.25);
      const haze = 0.55 + 0.45 * clamp((FAR - m.z) / 9);
      // Motes dissolve well before they reach you, so the nearest (largest) ones
      // stay soft background instead of pulling the eye.
      const fadeOut = Math.pow(clamp((m.z - NEAR) / 7), 1.5);
      const a = Math.max(m.a, 0.55 * this.calm) * born * haze * fadeOut * (0.22 + live * 0.3) * (1 + 1.8 * flash) * (1 + 0.45 * this.beatFlash);
      const R = Math.max(0.6 * S, Math.min(15 * S, m.size * s * 0.75)) * (1 + 0.6 * flash);
      if (streak && m.seen) {
        ctx.strokeStyle = `hsla(${m.hue} 85% ${m.light}% / ${a * 0.4})`;
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


    const M = Math.min(w, h);

    // Notes of keys and other note instruments: stars that bloom and fade.
    for (const st of this.noteStars) {
      const a = st.v * (st.age < 0.03 ? st.age / 0.03 : Math.exp(-(st.age - 0.03) / (st.life * 0.45)));
      if (a < 0.01) continue;
      const x = st.x * M;
      const y = st.y * M;
      if (st.from) {
        ctx.strokeStyle = `hsla(${st.hue} 70% 82% / ${a * 0.45})`;
        ctx.lineWidth = 0.8 * S;
        ctx.beginPath();
        ctx.moveTo(st.from[0] * M, st.from[1] * M);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      // A star like the others in the sky, only brighter: a small cream-white
      // point with a soft halo, blooming for a moment as the note sounds.
      const bloom = Math.exp(-st.age / 0.1);
      const R = (3 + 4 * st.v) * S * (1 + 0.8 * bloom);
      ctx.globalAlpha = clamp(a * (0.55 + 0.45 * bloom));
      ctx.drawImage(this.puffSprite(st.hue, 35, 80), x - R * 2, y - R * 2, R * 4, R * 4);
      ctx.globalAlpha = 1;
      const core = (1.1 + 1.1 * st.v + bloom) * S;
      ctx.fillStyle = `hsla(${st.hue} 30% 96% / ${clamp(a * 1.2)})`;
      ctx.beginPath();
      ctx.arc(x, y, core, 0, Math.PI * 2);
      ctx.fill();
    }

    // Guitar: pick strokes. Each is one hair-fine line of warm light swept
    // across the view in a flash, in the direction of the stroke, drifting a
    // little outward as it goes like a brush stroke. It tapers in and out,
    // brightest just behind its leading edge, then fades away gently.
    const pickHue = lerpHue(36, this.hue, 0.15);
    ctx.lineCap = 'round';
    for (const pk of this.picks) {
      const k = pk.life / pk.max;
      const drawn = 1 - Math.pow(1 - clamp(pk.life / 0.16), 3);
      const fade = Math.pow(1 - k, 1.6) * pk.v;
      const SEG = 28;
      let px = 0;
      let py = 0;
      for (let i = 0; i <= SEG; i++) {
        const u = (i / SEG) * drawn;
        const a = pk.a0 + pk.dir * pk.span * u;
        const R = (pk.r + pk.drift * u) * M;
        const x = Math.cos(a) * R * 1.15;
        const y = Math.sin(a) * R;
        if (i > 0) {
          // Soft at both ends: rises from the start, peaks near the head, eases off at the very tip.
          const along = Math.sin(Math.PI * Math.pow(i / SEG, 0.8)) * 0.85 + 0.15 * (i / SEG);
          ctx.strokeStyle = `hsla(${pickHue} 55% 78% / ${clamp(fade * along * 0.12)})`;
          ctx.lineWidth = 3 * S;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.strokeStyle = `hsla(${pickHue} 50% 90% / ${clamp(fade * along * 0.8)})`;
          ctx.lineWidth = 0.75 * S;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        px = x;
        py = y;
      }
    }

    // The melody line: a comet ahead, its trail drifting past you.
    const c = this.comet;
    if (c.lv > 0.02) {
      const cometHue = lerpHue(32, 190, 1 - c.voice);
      const range = Math.max(10, c.hi - c.lo);
      const pitch = clamp((c.p - c.lo) / range);
      const z = 5;
      const s = F / z;
      const tx = Math.sin(this.t * 0.35) * 0.9;
      const ty = 0.9 - pitch * 1.8;
      c.x += (tx - c.x) * 0.05;
      c.y += (ty - c.y) * 0.08;
      // A soft glowing head leaving a trail of glowing dust that drifts past you.
      if (this.dust.length >= MAX_DUST) this.dust.shift();
      this.dust.push({ x: c.x + (Math.random() - 0.5) * 0.06, y: c.y + (Math.random() - 0.5) * 0.06, z, size: 0.05 * (0.5 + c.lv) * (0.7 + 0.3 * c.voice), hue: cometHue, light: 76, a: 0.85 * c.lv, sx: 0, sy: 0, seen: false });
      const R = (18 + 30 * c.lv) * S * (0.8 + 0.2 * c.voice);
      ctx.globalAlpha = clamp(c.lv * 1.4);
      ctx.drawImage(this.sprites.get(cometHue + 2, 82), c.x * s - R * 2, c.y * s - R * 2, R * 4, R * 4);
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

