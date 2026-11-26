// Writes the static musicd logo files from the same geometry as the live logo
// (src/ui/mark-geometry.ts):
//
//   public/favicon.svg, public/logo.svg, public/icon-*.png, public/apple-touch-icon.png
//   design/logo/*.svg and *.png   (marks, app icon, lockups with the name)
//
// Run with:  node --experimental-strip-types scripts/build-logo.mjs
// PNGs are rendered with a local Chrome/Chromium (skipped if none is found).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLOR, CRACKS, GROOVE_TRACKS, SHARDS, WEDGE, arc, crackLine, cutsPath, grooveRadii, sector } from '../src/ui/mark-geometry.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const out = join(root, 'design', 'logo');
mkdirSync(out, { recursive: true });

/**
 * The mark as SVG content (no <svg> wrapper), in the -120..120 coordinate space.
 * `small`: favicon drawing (lifted record, no grooves, wider cuts).
 * `silent`: the resting state (wedge out, cracks dark).
 * The gaps between shards are cut out with a mask, so the mark works on any background.
 */
function markContent(id, { small = false, silent = false } = {}) {
  const gap = small ? 7 : 2.4;
  const hole = small ? 9 : 4;
  const recC = small ? COLOR.smallCentre : COLOR.recordCentre;
  const recR = small ? COLOR.smallRim : COLOR.recordRim;
  const wedgeShift = silent ? -30 : 0;
  const lit = !silent;
  const defs = `
    <radialGradient id="${id}rec" cx="0" cy="0" r="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${recC}"/><stop offset="1" stop-color="${recR}"/></radialGradient>
    <radialGradient id="${id}wg" cx="0" cy="0" r="100" gradientUnits="userSpaceOnUse"><stop offset=".05" stop-color="${COLOR.core}"/><stop offset=".32" stop-color="${COLOR.cyan}"/><stop offset="1" stop-color="${COLOR.indigo}"/></radialGradient>
    <radialGradient id="${id}lg" cx="0" cy="0" r="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${COLOR.cyan}" stop-opacity=".9"/><stop offset=".55" stop-color="${COLOR.cyan}" stop-opacity=".6"/><stop offset="1" stop-color="${COLOR.indigo}" stop-opacity=".7"/></radialGradient>
    <filter id="${id}bl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="${id}ha" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="10"/></filter>
    <filter id="${id}sf" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter>
    <clipPath id="${id}disc"><circle r="100"/></clipPath>
    <mask id="${id}cut" maskUnits="userSpaceOnUse" x="-130" y="-130" width="260" height="260">
      <rect x="-130" y="-130" width="260" height="260" fill="#fff"/>
      ${SHARDS.map(([a0, a1]) => `<path d="${cutsPath(a0, a1)}" fill="none" stroke="#000" stroke-width="${gap}" stroke-linejoin="round"/>`).join('')}
      <circle r="${hole}" fill="#000"/>
    </mask>
    <mask id="${id}wcut" maskUnits="userSpaceOnUse" x="-130" y="-130" width="260" height="260">
      <rect x="-130" y="-130" width="260" height="260" fill="#fff"/>
      <path d="${cutsPath(...WEDGE)}" fill="none" stroke="#000" stroke-width="${gap}" stroke-linejoin="round"/>
      <circle r="${hole}" fill="#000"/>
    </mask>`;
  const grooves = small
    ? ''
    : grooveRadii().map((r) => `<circle r="${r}" fill="none" stroke="${COLOR.groove}" stroke-width=".45"/>`).join('') +
      GROOVE_TRACKS.map((r) => `<circle r="${r}" fill="none" stroke="${COLOR.groove}" stroke-width="1.6"/>`).join('') +
      `<circle r="99.2" fill="none" stroke="${COLOR.edge}" stroke-width=".9"/>`;
  const shards = SHARDS.map(([a0, a1], i) => {
    const d = sector(0, 100, a0, a1);
    return `<clipPath id="${id}p${i}"><path d="${d}"/></clipPath><g clip-path="url(#${id}p${i})"><path d="${d}" fill="url(#${id}rec)"/>${grooves}</g>`;
  }).join('');
  const label = small ? '' : `<circle r="17" fill="none" stroke="${COLOR.label}" stroke-width=".8"/>`;
  const wedgeGrooves = small
    ? ''
    : GROOVE_TRACKS.map((r) => {
        const pad = (gap / r) * (180 / Math.PI);
        return `<path d="${arc(r, WEDGE[0] + pad, WEDGE[1] - pad)}" fill="none" stroke="rgba(20,20,60,.16)" stroke-width="1.2"/>`;
      }).join('') + `<path d="${arc(98.6, WEDGE[0] + 1.5, WEDGE[1] - 1.5)}" fill="none" stroke="rgba(255,255,255,.45)" stroke-width=".7"/>`;
  const halo = small ? '' : `<path d="${sector(0, 94, WEDGE[0] + 4, WEDGE[1] - 4)}" fill="url(#${id}wg)" filter="url(#${id}ha)" opacity="${lit ? 0.35 : 0.2}"/>`;
  const lines = (w) => CRACKS.map((a) => {
    const [x1, y1, x2, y2] = crackLine(a);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="url(#${id}lg)" stroke-width="${w}" stroke-linecap="round"/>`;
  }).join('');
  const light = lit
    ? `<g opacity=".62"><g filter="url(#${id}bl)">${lines(6)}</g>${small ? '' : lines(0.9)}</g>` +
      (small ? '' : `<circle r="100" fill="none" stroke="${COLOR.indigo}" stroke-width="6" filter="url(#${id}sf)" opacity=".5"/><circle r="100.2" fill="none" stroke="${COLOR.cyan}" stroke-width="1" opacity=".42"/>`)
    : '';
  const sheen = small
    ? ''
    : `<g clip-path="url(#${id}disc)"><g filter="url(#${id}sf)"><path d="${sector(22, 100, -62, -30)}" fill="#cfe0ff" opacity=".07"/><path d="${sector(22, 100, 118, 150)}" fill="#cfe0ff" opacity=".05"/></g></g>`;
  return `<defs>${defs}</defs>
  <g mask="url(#${id}cut)">${shards}${label}</g>
  ${light}
  <g transform="translate(${wedgeShift} 0)">${halo}<g mask="url(#${id}wcut)"><path d="${sector(0, 100, ...WEDGE)}" fill="url(#${id}wg)"/>${wedgeGrooves}</g></g>
  ${sheen}`;
}

const svg = (viewBox, w, h, body, title = 'musicd') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

/** The word "musicd" as outlines (Unbounded 500), from design/logo/wordmark-glyphs.json. */
function wordmark(x, baseline, size, fill) {
  const font = JSON.parse(readFileSync(join(out, 'wordmark-glyphs.json'), 'utf8'));
  const s = size / font.upm;
  const track = -0.04 * font.upm;
  let pen = 0;
  const paths = font.glyphs.map((g) => {
    const p = `<path transform="translate(${(x + pen * s).toFixed(2)} ${baseline}) scale(${s} ${-s})" d="${g.d}"/>`;
    pen += g.adv + track;
    return p;
  });
  return { body: `<g fill="${fill}">${paths.join('')}</g>`, width: (pen - track) * s, capHeight: font.capHeight * s };
}

/** Mark + name side by side. The record is 100 units across; the name's caps are centred on it. */
function lockup(textColor, bg) {
  const size = 78;
  const x = 82; // the record spans -50..50; the name starts a third of a record to its right
  const word = wordmark(x, ((750 * size) / 1000 / 2).toFixed(2), size, textColor);
  const vbW = Math.ceil(x + word.width + 24 + 70);
  const back = bg ? `<rect x="-70" y="-70" width="${vbW}" height="140" rx="28" fill="${bg}"/>` : '';
  return svg(`-70 -70 ${vbW} 140`, vbW * 2, 280, `${back}<g transform="scale(.5)">${markContent('m')}</g>${word.body}`);
}

const files = {
  [join(pub, 'favicon.svg')]: svg('-120 -120 240 240', 32, 32, markContent('f', { small: true })),
  [join(pub, 'logo.svg')]: svg('-120 -120 240 240', 240, 240, markContent('m')),
  [join(out, 'mark.svg')]: svg('-120 -120 240 240', 480, 480, markContent('m')),
  [join(out, 'mark-silent.svg')]: svg('-160 -120 280 240', 560, 480, markContent('m', { silent: true }), 'musicd (silent)'),
  [join(out, 'mark-small.svg')]: svg('-120 -120 240 240', 32, 32, markContent('f', { small: true })),
  [join(out, 'app-icon.svg')]: svg('-150 -150 300 300', 512, 512, `<rect x="-150" y="-150" width="300" height="300" rx="68" fill="#0b0c16"/>${markContent('m')}`),
  [join(out, 'lockup-on-dark.svg')]: lockup('#e6e9f5'),
  [join(out, 'lockup-on-light.svg')]: lockup('#0b0c18'),
  [join(out, 'lockup-dark-tile.svg')]: lockup('#e6e9f5', COLOR.space),
};
for (const [path, content] of Object.entries(files)) writeFileSync(path, content);
console.log(`wrote ${Object.keys(files).length} SVG files`);

// --- PNGs, rendered by Chrome -----------------------------------------------------------
const chrome = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((b) => {
  try {
    execFileSync('which', [b], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!chrome) {
  console.log('no Chrome found: skipping PNGs');
  process.exit(0);
}
const tmp = mkdtempSync(join(tmpdir(), 'musicd-logo-'));
// Chrome keeps a socket in TMPDIR and refuses to start if that path is long: let it use the system default.
const chromeEnv = { ...process.env };
delete chromeEnv.TMPDIR;
function png(svgFile, target, w, h) {
  const html = join(tmp, 'page.html');
  writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${readFileSync(svgFile, 'utf8')}`);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000',
    `--window-size=${w},${h}`, `--screenshot=${target}`, `file://${html}`], { stdio: 'ignore', env: chromeEnv });
}
png(join(out, 'app-icon.svg'), join(pub, 'icon-512.png'), 512, 512);
png(join(out, 'app-icon.svg'), join(pub, 'icon-192.png'), 192, 192);
png(join(out, 'app-icon.svg'), join(pub, 'apple-touch-icon.png'), 180, 180);
png(join(out, 'app-icon.svg'), join(out, 'app-icon-1024.png'), 1024, 1024);
png(join(out, 'mark.svg'), join(out, 'mark-1024.png'), 1024, 1024);
const lw = (f) => Number(/width="([\d.]+)"/.exec(readFileSync(join(out, f), 'utf8'))[1]);
for (const f of ['lockup-on-dark', 'lockup-on-light', 'lockup-dark-tile']) png(join(out, `${f}.svg`), join(out, `${f}.png`), lw(`${f}.svg`), 280);
rmSync(tmp, { recursive: true, force: true });
console.log('wrote PNGs');
