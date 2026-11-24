declare module 'demucs-web' {
  type Stereo = { left: Float32Array; right: Float32Array };
  export class DemucsProcessor {
    constructor(options: {
      ort: unknown;
      sessionOptions?: Record<string, unknown>;
      onProgress?: (info: { progress: number; currentSegment: number; totalSegments: number }) => void;
      onLog?: (phase: string, message: string) => void;
    });
    loadModel(pathOrBuffer?: string | ArrayBuffer): Promise<unknown>;
    separate(left: Float32Array, right: Float32Array): Promise<Record<'drums' | 'bass' | 'other' | 'vocals', Stereo>>;
  }
  export const CONSTANTS: { DEFAULT_MODEL_URL: string; SAMPLE_RATE: number };
}
