/// <reference lib="webworker" />
// Recognises which instruments are audible, with Google's YAMNet sound
// classifier (521 AudioSet classes). Receives ~1 s of 16 kHz mono audio,
// returns a score per instrument family plus a "calm" estimate.
import * as tf from '@tensorflow/tfjs';
import type { Instrument } from './instruments';

export type ListenRequest = { type: 'init'; modelUrl: string } | { type: 'classify'; audio: Float32Array };
export type ListenReply =
  | { type: 'ready' }
  | { type: 'scores'; presence: Record<Instrument, number>; calm: number; music: number; electronic: number; orchestral: number }
  | { type: 'error'; message: string };

// YAMNet class indices (yamnet_class_map.csv) grouped into instrument families.
const GROUPS: Record<Instrument, number[]> = {
  drums: [156, 157, 158, 159, 160, 162, 163, 166, 167],
  // Singing in a dense mix is often heard as "Speech", so speech counts too.
  voice: [0, 24, 25, 29, 30, 31, 32, 249],
  keys: [147, 148, 149, 150, 151, 152, 155],
  // Sustained melodic instruments: bowed strings, and flutes (191).
  strings: [179, 184, 185, 186, 187, 188, 189, 191],
  // Plucked strings, including sitar (143), zither such as the đàn tranh (145) and harp (194).
  guitar: [134, 135, 136, 138, 139, 141, 142, 143, 144, 145, 146, 194],
  bass: [137, 189],
  synth: [153, 234, 241],
};
const CALM = [272, 273, 241, 232, 248]; // sad, tender, ambient, classical, new-age
const LIVELY = [275, 276, 214, 238, 240, 235, 269, 212]; // exciting, angry, rock, d&b, EDM, house, dance, hip hop
const MUSIC = 132;
// Genre groups that pick the Scene layout.
const ELECTRONIC = [234, 235, 238, 240, 242, 269]; // electronic, house, d&b, EDM, trance, dance
const ORCHESTRAL = [232, 179, 25, 241, 248]; // classical, orchestra, choir, ambient, new-age

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let model: tf.GraphModel | null = null;

ctx.onmessage = async (e: MessageEvent<ListenRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await tf.ready();
      model = await tf.loadGraphModel(msg.modelUrl);
      ctx.postMessage({ type: 'ready' } satisfies ListenReply);
      return;
    }
    if (!model) return;
    const scores = tf.tidy(() => {
      const out = model!.execute(tf.tensor1d(msg.audio)) as tf.Tensor | tf.Tensor[];
      const s = (Array.isArray(out) ? out[0] : out) as tf.Tensor2D;
      return s.max(0); // strongest evidence across the ~1 s window
    });
    const v = (await scores.data()) as Float32Array;
    scores.dispose();
    const group = (ids: number[]) => ids.reduce((m, i) => Math.max(m, v[i]), 0);
    const presence = Object.fromEntries(
      (Object.keys(GROUPS) as Instrument[]).map((k) => [k, group(GROUPS[k])]),
    ) as Record<Instrument, number>;
    const sum = (ids: number[]) => ids.reduce((s, i) => s + v[i], 0);
    const calm = Math.max(0, Math.min(1, 0.5 + (sum(CALM) - sum(LIVELY)) * 2));
    const top = (ids: number[]) => ids.reduce((m, i) => Math.max(m, v[i]), 0);
    ctx.postMessage({ type: 'scores', presence, calm, music: v[MUSIC], electronic: top(ELECTRONIC), orchestral: top(ORCHESTRAL) } satisfies ListenReply);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies ListenReply);
  }
};
