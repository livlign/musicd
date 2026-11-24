# musicd

Open the page, allow audio, and watch whatever your computer is playing become a landscape of light.

There is no interface. On load musicd asks to hear this computer's sound (its speaker output where the
system offers it, otherwise the microphone) and follows it live.

- **Cosmos.** You drift forward through a universe made of the song. The whole sound streams toward
  you as stardust: low sounds are large warm motes near your path, high sounds fine cool sparks at the
  edges. The bass is the glowing core at the vanishing point, swelling with every bass note. A kick sends
  a shockwave across space and a surge forward (the dust stretches into streaks); a snare throws a ring
  of light that flies past you; hi-hats glint; cymbals shimmer everything. A sung melody is a comet
  gliding ahead with a warm trail. Harmony colours the nebulae. Loudness is measured in absolute terms,
  so silence and gaps between songs settle into a slow, quiet float instead of being amplified.
- **Hidden extras:** drop a song file anywhere to play it with full AI separation (Demucs + Basic Pitch);
  Space pauses it, Escape returns to live listening. Double-click for fullscreen. The cursor hides
  while you watch.

Under the hood: live audio is split into percussive and tonal parts in real time; Google's YAMNet
recognises which instruments are present; drums are confirmed from the sound itself (a steady
percussive beat); the sung pitch is tracked continuously.

### Hearing the computer's sound

| System | What musicd uses |
| --- | --- |
| Linux, Firefox | "Monitor of …" inputs, found automatically |
| Linux, Chrome | Chrome hides monitors. Run once: `pactl load-module module-remap-source master=$(pactl get-default-sink).monitor source_name=musicd_pc_sound source_properties=device.description=PC-sound` |
| Windows | "Stereo Mix", if enabled in Sound settings |
| macOS | A loopback driver such as BlackHole |
| Anything else | The microphone |

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

## Deploy

`dist/` is a static site. It should be served with these headers (already in `public/_headers`,
which Netlify and Cloudflare Pages pick up):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They enable multi-threaded WASM for the CPU fallback. The WebGPU path also works without them.
Note: `ort-wasm-simd-threaded.asyncify.wasm` is ~29 MB, above Cloudflare Pages' 25 MiB per-file limit.

## Not yet

- Tempo tracking (ridge pace follows energy, not the beat yet).
