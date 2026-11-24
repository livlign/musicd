// Small DSP helpers that work both on the main thread and in workers.
import type { Envelope } from './types';

export const ENV_RATE = 100; // envelope frames per second

/** RMS loudness per frame, normalised so the loud parts sit near 1. */
export function envelope(signal: Float32Array, sampleRate: number, rate = ENV_RATE, norm = true): Envelope {
  const hop = sampleRate / rate;
  const n = Math.floor(signal.length / hop);
  const data = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = Math.floor(f * hop);
    const b = Math.min(signal.length, Math.floor((f + 1) * hop));
    let s = 0;
    for (let i = a; i < b; i++) s += signal[i] * signal[i];
    data[f] = Math.sqrt(s / Math.max(1, b - a));
  }
  if (norm) normalise(data);
  return { rate, data };
}

/** Scale so the 98th percentile maps to 1 (robust against single spikes). */
export function normalise(data: Float32Array): void {
  if (data.length === 0) return;
  const sorted = Float32Array.from(data).sort();
  const ref = sorted[Math.floor(sorted.length * 0.98)] || sorted[sorted.length - 1] || 1;
  if (ref <= 1e-9) return;
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1.5, data[i] / ref);
}

/**
 * Onset times (seconds) from a raw (un-normalised) RMS envelope using
 * log-energy flux with an adaptive threshold.
 */
export function onsets(
  env: Float32Array,
  rate: number,
  opts: { minGap: number; sensitivity: number; minLevel?: number },
): number[] {
  const n = env.length;
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const d = Math.log1p(env[i] * 1000) - Math.log1p(env[i - 1] * 1000);
    flux[i] = d > 0 ? d : 0;
  }
  // Ignore near-silence so noise floors don't trigger hits.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, env[i]);
  // Optional loudness gate relative to the band's typical loud level, so
  // quieter sounds that leak into a band (hats in the snare band) are ignored.
  const sorted = Float32Array.from(env).sort();
  const loud = sorted[Math.floor(sorted.length * 0.97)] ?? peak;
  const floor = Math.max(peak * 0.04, loud * (opts.minLevel ?? 0));
  const levelAt = (i: number) => Math.max(env[i] ?? 0, env[i + 1] ?? 0, env[i + 2] ?? 0, env[i + 3] ?? 0);

  const out: number[] = [];
  const win = Math.round(rate * 0.5);
  let sum = 0;
  let sumSq = 0;
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    sum += flux[i];
    sumSq += flux[i] * flux[i];
    if (i >= win) {
      sum -= flux[i - win];
      sumSq -= flux[i - win] * flux[i - win];
    }
    const count = Math.min(i + 1, win);
    const mean = sum / count;
    const sd = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    const thresh = mean + opts.sensitivity * sd + 0.05;
    const isPeak = flux[i] > thresh && flux[i] >= (flux[i - 1] ?? 0) && flux[i] >= (flux[i + 1] ?? 0);
    const t = i / rate;
    if (isPeak && levelAt(i) > floor && t - last >= opts.minGap) {
      out.push(t);
      last = t;
    }
  }
  return out;
}

/** Halve the sample rate (44.1k -> 22.05k) with a windowed-sinc low-pass. */
export function decimate2(x: Float32Array): Float32Array {
  const taps = 31;
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let norm = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * 0.45 * k) / (Math.PI * 0.45 * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    norm += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= norm;
  const out = new Float32Array(Math.floor(x.length / 2));
  for (let o = 0; o < out.length; o++) {
    const c = o * 2;
    let s = 0;
    for (let i = 0; i < taps; i++) {
      const j = c + i - mid;
      if (j >= 0 && j < x.length) s += x[j] * h[i];
    }
    out[o] = s;
  }
  return out;
}

export function toMono(left: Float32Array, right: Float32Array): Float32Array {
  const m = new Float32Array(left.length);
  for (let i = 0; i < m.length; i++) m[i] = (left[i] + right[i]) * 0.5;
  return m;
}
