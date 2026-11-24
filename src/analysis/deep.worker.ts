/// <reference lib="webworker" />
// Deep analysis, off the main thread:
//   1. Demucs (ONNX, WebGPU or WASM) splits the song into drums/bass/other/vocals
//   2. Basic Pitch (TensorFlow.js) transcribes notes for the pitched stems
import './worker-shim';
import type * as Ort from 'onnxruntime-web';
import { DemucsProcessor } from 'demucs-web';
import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { decimate2, envelope, toMono } from './dsp';
import type { Envelope, Note, PartId, Stems } from './types';
import { PARTS } from './types';

type PitchedPart = 'bass' | 'vocals' | 'other';
const PITCHED: PitchedPart[] = ['bass', 'vocals', 'other'];

export type DeepRequest = {
  left: Float32Array;
  right: Float32Array;
  vendorBase: string;
  modelUrl: string;
};

export type DeepMessage =
  | { type: 'stage'; stage: 'download' | 'init' | 'separate' | 'notes'; progress: number; detail?: string }
  | { type: 'done'; stems: Stems; env: Record<PartId, Envelope>; notes: Record<PitchedPart, Note[]>; backend: string }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: DeepMessage, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

ctx.onmessage = async (e: MessageEvent<DeepRequest>) => {
  try {
    await run(e.data);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

async function run({ left, right, vendorBase, modelUrl }: DeepRequest) {
  // ONNX Runtime is loaded as a plain file so it can find its own wasm siblings.
  const ort: typeof Ort = await import(/* @vite-ignore */ `${vendorBase}ort/ort.webgpu.min.mjs`);
  ort.env.wasm.wasmPaths = `${vendorBase}ort/`;
  const hasWebGPU = 'gpu' in navigator && !!(await (navigator as any).gpu.requestAdapter().catch(() => null));

  post({ type: 'stage', stage: 'download', progress: 0 });
  const model = await cachedFetch(modelUrl, (p) => post({ type: 'stage', stage: 'download', progress: p }));

  post({ type: 'stage', stage: 'init', progress: 0 });
  const device = hasWebGPU ? 'GPU' : 'CPU';
  const demucs = new DemucsProcessor({
    ort,
    sessionOptions: { executionProviders: hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'] },
    onProgress: ({ progress }: { progress: number }) => post({ type: 'stage', stage: 'separate', progress, detail: device }),
  });
  await demucs.loadModel(model);
  post({ type: 'stage', stage: 'separate', progress: 0, detail: device });
  const stems = (await demucs.separate(left, right)) as Stems;

  const mono = {} as Record<PartId, Float32Array>;
  const env = {} as Record<PartId, Envelope>;
  for (const p of PARTS) {
    mono[p] = toMono(stems[p].left, stems[p].right);
    env[p] = envelope(mono[p], 44100);
  }

  const basicPitch = new BasicPitch(`${vendorBase}basic-pitch/model.json`);
  const notes = {} as Record<PitchedPart, Note[]>;
  for (let i = 0; i < PITCHED.length; i++) {
    const part = PITCHED[i];
    notes[part] = await transcribe(basicPitch, decimate2(mono[part]), part, (p) =>
      post({ type: 'stage', stage: 'notes', progress: (i + p) / PITCHED.length, detail: part }),
    );
  }

  const transfer = PARTS.flatMap((p) => [stems[p].left.buffer, stems[p].right.buffer, env[p].data.buffer]);
  post({ type: 'done', stems, env, notes, backend: hasWebGPU ? 'webgpu' : 'wasm' }, transfer);
}

async function transcribe(bp: BasicPitch, audio22k: Float32Array, part: PitchedPart, progress: (p: number) => void) {
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];
  await bp.evaluateModel(
    audio22k,
    (f, o, c) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    progress,
  );
  // Vocals and bass are mostly monophonic; the "melodia trick" cleans them up.
  const mono = part !== 'other';
  const [onsetThresh, frameThresh] = part === 'vocals' ? [0.5, 0.35] : [0.5, 0.3];
  const minFreq = part === 'bass' ? 30 : part === 'vocals' ? 70 : 60;
  const maxFreq = part === 'bass' ? 400 : part === 'vocals' ? 1400 : 4200;
  const events = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, onsetThresh, frameThresh, 11, true, maxFreq, minFreq, mono),
    ),
  );
  return events
    .map((n) => ({ t: n.startTimeSeconds, d: n.durationSeconds, p: n.pitchMidi, v: Math.min(1, n.amplitude) }))
    .sort((a, b) => a.t - b.t);
}

/** Fetch once, then serve from the Cache API so the model downloads only once. */
async function cachedFetch(url: string, progress: (p: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open('musicd-models-v1');
  const hit = await cache.match(url);
  if (hit) {
    progress(1);
    return hit.arrayBuffer();
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || 180_000_000;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    progress(Math.min(1, loaded / total));
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return buf.buffer;
}
