// Copies runtime assets that must be served as plain files (not bundled):
// ONNX Runtime's wasm + glue, and the Basic Pitch model.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = 'public/vendor';
const ortSrc = 'node_modules/onnxruntime-web/dist';
mkdirSync(join(out, 'ort'), { recursive: true });
// ort.webgpu.min.mjs loads the asyncify build for both WebGPU and CPU.
const wanted = (f) => f === 'ort.webgpu.min.mjs' || /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f);
// Remove stale files individually (deleting the whole folder confuses a running dev server).
for (const f of readdirSync(join(out, 'ort'))) if (!wanted(f)) rmSync(join(out, 'ort', f));
for (const f of readdirSync(ortSrc)) if (wanted(f)) cpSync(join(ortSrc, f), join(out, 'ort', f));
cpSync('node_modules/@spotify/basic-pitch/model', join(out, 'basic-pitch'), { recursive: true });
console.log('vendor assets copied to', out);
