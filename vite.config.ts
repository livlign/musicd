import { defineConfig } from 'vite';

// Cross-origin isolation enables SharedArrayBuffer, which lets ONNX Runtime
// use multiple threads when WebGPU is unavailable.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
