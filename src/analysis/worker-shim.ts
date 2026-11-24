// TensorFlow.js 3.x (used by Basic Pitch) reads `window` in a few places that
// work fine with the worker global scope. Must be imported before tfjs.
const g = globalThis as unknown as { window?: unknown };
g.window ??= globalThis;
