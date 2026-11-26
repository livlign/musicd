# musicd logo

A dark record broken into shards, with a play-button wedge. While music plays the
wedge sits in place, the record spins and light runs along the cracks; in silence
the record parks upright, the light goes out and the wedge waits outside.

| File | Use |
| --- | --- |
| `mark.svg`, `mark-1024.png` | The mark, lit, transparent background |
| `mark-silent.svg` | The resting state (wedge out, cracks dark) |
| `mark-small.svg` | Favicon drawing for 16–32 px (lifted record, no grooves, wider cuts) |
| `app-icon.svg`, `app-icon-1024.png` | App icon on its dark tile |
| `lockup-on-dark.svg/.png` | Mark + name for dark backgrounds (transparent) |
| `lockup-on-light.svg/.png` | Mark + name for light backgrounds (transparent) |
| `lockup-dark-tile.svg/.png` | Mark + name on a space-black tile |

The name is set in Unbounded 500 (SIL Open Font License, `public/fonts/OFL.txt`),
tracked −4 %, and outlined in the SVG lockups so they need no font.

## Colours

| | |
| --- | --- |
| Space | `#030308` |
| Record | `#1b1e33` → `#0c0d19` (centre → rim) |
| Cyan | `#8fe8ff` |
| Indigo | `#6a5cf0` |
| Wedge and light | cyan at the centre → indigo at the rim |

## Changing it

The shapes and colours live in `src/ui/mark-geometry.ts`, shared by the live logo
(`src/ui/mark.ts`) and the static files. After a change, regenerate the files
(PNG rendering needs a local Chrome or Chromium):

```bash
node --experimental-strip-types scripts/build-logo.mjs
```

The HTML pages in `design/` are the explorations that led here.
