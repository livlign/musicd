# musicd

Open the page, allow audio, and watch whatever your computer is playing become a landscape of light.

On load musicd asks to hear this computer's sound (its speaker output where the system offers it,
otherwise the microphone) and follows it live. The only interface is the logo in the top-left corner:
it spins while music plays and parks in silence, and a click opens a panel with what musicd is
listening to, settings and shortcuts.

- **Cosmos.** You drift forward through a universe made of the song. The whole sound streams toward
  you as stardust: low sounds are large warm motes near your path, high sounds fine cool sparks at the
  edges. The bass is the glowing core at the vanishing point, swelling with the bass. On every beat the
  whole field pulses: musicd follows the song's tempo and fires the pulse slightly ahead, so it is seen
  as the beat is heard. A kick sends a shockwave across space and a surge forward (the dust stretches
  into streaks); a snare throws a faint ring of light that flies past you; hi-hats glint; cymbals
  shimmer everything. The melody is a comet gliding ahead: warm when someone sings, cool when it is an
  instrument (a flute, a đàn bầu, a lead guitar). Notes of piano and other note instruments light
  stars around the centre, linked into constellations. Held sound (strings, pads, choirs) lights a Milky
  Way band across the sky that flows past as you fly and glows brighter as the strings swell. Harmony
  colours the nebulae. Silence and gaps between songs settle into a slow, quiet float instead of being
  amplified.
- **Debug mode** (in the panel, or press D): lists the parts musicd recognises right now (kick,
  snare, hi-hats, vocals, bass, melody, chords, guitar, keys…), each with a dotted line that grows
  for as long as the part keeps playing. Parts that stop fade out. Bottom right, musicd measures how
  far its picture runs behind the sound. **Start recording** in the panel saves what musicd heard
  (.wav) and everything it detected and showed (.json), on the same clock, to compare with the song.
- **Hidden extras:** drop a song file anywhere to play it with full AI separation (Demucs + Basic Pitch);
  Space pauses it, Escape returns to live listening. Double-click for fullscreen. The cursor hides
  while you watch.

Under the hood: live audio is split into percussive and tonal parts in real time; Google's YAMNet
recognises which instruments are present; drums are confirmed from the sound itself (a steady
percussive beat, or steady hi-hats); a beat tracker follows tempo and phase; the melody's pitch is
tracked continuously. Timing was measured on a recorded song: hits are detected 58–74 ms after they
sound, and the beat pulse is fired early by that plus the capture and drawing delays.

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
