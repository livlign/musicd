// Runs the deep analysis worker and finishes the bits that need the main
// thread (OfflineAudioContext is not available inside workers).
import { drumHits } from './bands';
import type { DeepMessage, DeepRequest } from './deep.worker';
import type { PartId, SongAnalysis } from './types';
import { PARTS, splitLead } from './types';

export const MODEL_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';

export type DeepProgress = Extract<DeepMessage, { type: 'stage' }>;

export interface DeepResult {
  analysis: SongAnalysis;
  stems: Record<PartId, AudioBuffer>;
  backend: string;
}

export function deepAnalysis(mix: AudioBuffer, onProgress: (p: DeepProgress) => void): { promise: Promise<DeepResult>; cancel: () => void } {
  const worker = new Worker(new URL('./deep.worker.ts', import.meta.url), { type: 'module' });
  const cancel = () => worker.terminate();
  const promise = new Promise<DeepResult>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message || 'Analysis worker crashed'));
    worker.onmessage = async (e: MessageEvent<DeepMessage>) => {
      const msg = e.data;
      if (msg.type === 'stage') return onProgress(msg);
      worker.terminate();
      if (msg.type === 'error') return reject(new Error(msg.message));
      try {
        const stems = {} as Record<PartId, AudioBuffer>;
        for (const p of PARTS) {
          const b = new AudioBuffer({ numberOfChannels: 2, length: msg.stems[p].left.length, sampleRate: mix.sampleRate });
          b.copyToChannel(msg.stems[p].left as Float32Array<ArrayBuffer>, 0);
          b.copyToChannel(msg.stems[p].right as Float32Array<ArrayBuffer>, 1);
          stems[p] = b;
        }
        // A song without drums still leaves faint bleed in the drum stem;
        // don't turn that into hits.
        const rms = (b: AudioBuffer) => {
          const x = b.getChannelData(0);
          let s = 0;
          for (let i = 0; i < x.length; i += 16) s += x[i] * x[i];
          return Math.sqrt(s / Math.ceil(x.length / 16));
        };
        const mixRms = rms(mix);
        const hasDrums = rms(stems.drums) > mixRms * 0.12;
        const hasVocals = rms(stems.vocals) > mixRms * 0.1;
        const hits = hasDrums ? await drumHits(stems.drums) : { kick: [], snare: [], tom: [], hat: [], cymbal: [] };
        resolve({
          analysis: {
            mode: 'deep',
            duration: mix.duration,
            env: msg.env,
            notes: { bass: msg.notes.bass, vocals: hasVocals ? msg.notes.vocals : [], ...splitLead(msg.notes.other) },
            hits,
          },
          stems,
          backend: msg.backend,
        });
      } catch (err) {
        reject(err);
      }
    };
    const req: DeepRequest = {
      left: mix.getChannelData(0).slice(),
      right: (mix.numberOfChannels > 1 ? mix.getChannelData(1) : mix.getChannelData(0)).slice(),
      vendorBase: new URL('vendor/', document.baseURI).href,
      modelUrl: MODEL_URL,
    };
    worker.postMessage(req, [req.left.buffer, req.right.buffer]);
  });
  return { promise, cancel };
}
