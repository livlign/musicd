// musicd: open the page, allow audio, watch. No interface on screen.
//
// - On load it asks to hear this computer's sound (the speaker output where the
//   system offers it, otherwise the microphone) and follows it live.
// - Dropping a song file anywhere plays it with full AI separation; when it
//   ends, live listening resumes.
// - Double-click: fullscreen. Space: pause a dropped song.
import './style.css';
import { quickAnalysis } from './analysis/bands';
import { deepAnalysis } from './analysis/deep';
import { Ears } from './analysis/instruments';
import type { SongAnalysis } from './analysis/types';
import { Player } from './audio/player';
import type { Frame } from './feed/frame';
import { idleFrame } from './feed/frame';
import { applyPresence } from './feed/gate';
import { LiveFeed, NoSpeakerMonitorError, captureSpeakers } from './feed/live';
import { SpectrumTap } from './feed/spectrum';
import { TimelineFeed } from './feed/timeline';
import { Cosmos } from './viz/cosmos';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const player = new Player();
const playerTap = new SpectrumTap(player.ctx, player.output);
const ears = new Ears(player.ctx, new URL('vendor/', document.baseURI).href);
const scene = new Cosmos();

let mode: 'idle' | 'live' | 'file' = 'idle';
let live: LiveFeed | null = null;
let timeline: TimelineFeed | null = null;
let timelineMode: SongAnalysis['mode'] = 'quick';
let cancelDeep: (() => void) | null = null;
let loadId = 0;
let listening = false;

// Exposed for automated testing in development builds only.
const debug: Record<string, unknown> = { ears, scene };
if (import.meta.env.DEV) (window as unknown as { __musicd: unknown }).__musicd = debug;

// --- canvas -----------------------------------------------------------------------------
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  scene.resize(canvas.width, canvas.height, dpr);
}
new ResizeObserver(resize).observe(canvas);
resize();

// --- live listening ---------------------------------------------------------------------
async function listen() {
  if (listening || mode === 'file') return;
  listening = true;
  try {
    let streams: MediaStream[];
    try {
      ({ streams } = await captureSpeakers());
    } catch (err) {
      if (!(err instanceof NoSpeakerMonitorError)) throw err;
      // No speaker-output input offered: hear the room through the microphone.
      streams = [
        await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        }),
      ];
    }
    // A song may have been dropped while the permission prompt was open.
    if ((mode as string) === 'file') {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      return;
    }
    live?.stop();
    live = new LiveFeed(player.ctx, streams);
    debug.liveFeed = live;
    debug.live = true;
    ears.listenTo(live.source);
    mode = 'live';
    void player.ctx.resume();
  } catch (err) {
    console.info('musicd: listening not available yet', err);
  } finally {
    listening = false;
  }
}

function stopLive() {
  live?.stop();
  live = null;
}

// The browser may hold audio until the first interaction, and a refused
// permission can be retried with a click: any click or key does both.
function wake() {
  void player.ctx.resume();
  if (mode === 'idle') void listen();
}
window.addEventListener('pointerdown', wake);
window.addEventListener('keydown', wake);
void listen();

// --- a dropped song ---------------------------------------------------------------------
async function playFile(blob: Blob) {
  const id = ++loadId;
  void player.ctx.resume();
  cancelDeep?.();
  stopLive();
  mode = 'file';
  let mix: AudioBuffer;
  try {
    mix = await player.decode(blob);
  } catch {
    return backToLive();
  }
  if (id !== loadId) return;
  player.load(mix);
  ears.listenTo(player.output);
  const quick = await quickAnalysis(mix);
  if (id !== loadId) return;
  timeline = new TimelineFeed(quick, 0);
  timelineMode = 'quick';
  await player.play();
  const job = deepAnalysis(mix, () => {});
  cancelDeep = job.cancel;
  try {
    const res = await job.promise;
    if (id !== loadId) return;
    timeline = new TimelineFeed(res.analysis, player.time);
    timelineMode = 'deep';
    player.setStems(res.stems);
  } catch (err) {
    console.info('musicd: separation unavailable, staying with the quick analysis', err);
  }
}

function backToLive() {
  loadId++;
  cancelDeep?.();
  cancelDeep = null;
  player.pause();
  player.load(null);
  timeline = null;
  mode = 'idle';
  void listen();
}
player.onEnded = backToLive;

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f) void playFile(f);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && mode === 'file') {
    e.preventDefault();
    if (player.playing) player.pause();
    else void player.play();
  } else if (e.code === 'Escape' && mode === 'file') backToLive();
});

// --- immersion: fullscreen on double-click, cursor hides when still -----------------------
canvas.addEventListener('dblclick', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
});
let stillTimer = 0;
window.addEventListener('pointermove', () => {
  document.body.classList.remove('still');
  clearTimeout(stillTimer);
  stillTimer = window.setTimeout(() => document.body.classList.add('still'), 1800);
});
document.body.classList.add('still');

// --- render loop --------------------------------------------------------------------------
let last = performance.now();
let clock = 0;
const counts: Record<string, number> = { hits: 0, notes: 0 };
debug.counts = counts;
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  clock += dt;
  let frame: Frame;
  if (mode === 'live' && live) {
    if (live.ended) {
      stopLive();
      mode = 'idle';
      window.setTimeout(() => void listen(), 800);
      frame = idleFrame(clock, dt);
    } else frame = live.next(dt);
  } else if (mode === 'file' && timeline) {
    frame = timeline.next(player.time, player.playing ? dt : dt * 0.25, new Set());
    frame.spectrum = playerTap.read(dt);
    frame.audible = frame.spectrum.audible;
  } else {
    frame = idleFrame(clock, dt);
  }
  if (!frame.idle) applyPresence(frame, ears, mode === 'file' && timelineMode === 'deep');
  scene.draw(ctx, frame);
  counts.hits += frame.hits.length;
  counts.notes += frame.notes.length;
  for (const h of frame.hits) counts[h.hit] = (counts[h.hit] ?? 0) + 1;
  for (const n of frame.notes) counts[n.voice] = (counts[n.voice] ?? 0) + 1;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
