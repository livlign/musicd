// The musicd logo in the top-left corner. Clicking it opens a small panel
// with what musicd is, what it is listening to, settings and shortcuts.
import { Mark } from './mark';

export interface Settings {
  debug: boolean;
}

const KEY = 'musicd.settings';

function loadSettings(): Settings {
  try {
    return { debug: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { debug: false };
  }
}

export class Menu {
  readonly mark = new Mark(34);
  readonly settings = loadSettings();
  /** Called whenever a setting changes (and once at start). */
  onChange: (s: Settings) => void = () => {};
  /** Start or stop the debug recording. */
  onRecord: () => void = () => {};
  private root: HTMLDivElement;
  private panel: HTMLDivElement;
  private button: HTMLButtonElement;
  private statusEl: HTMLParagraphElement;
  private debugBox: HTMLInputElement;
  private tools: HTMLElement;
  private recordBtn: HTMLButtonElement;
  private recordHelp: HTMLElement;
  private recPill: HTMLButtonElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'brand';
    this.button = document.createElement('button');
    this.button.className = 'brand-button';
    this.button.type = 'button';
    this.button.setAttribute('aria-expanded', 'false');
    this.button.setAttribute('aria-controls', 'musicd-panel');
    this.button.title = 'About musicd and settings';
    const word = document.createElement('span');
    word.className = 'wordmark';
    word.textContent = 'musicd';
    this.button.append(this.mark.svg, word);

    this.panel = document.createElement('div');
    this.panel.className = 'panel';
    this.panel.id = 'musicd-panel';
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <p class="panel-lede">Play any song on your computer and watch it become a landscape of light.</p>
      <p class="panel-status"></p>
      <section>
        <h2>Settings</h2>
        <label class="setting">
          <span>
            <b>Debug mode</b>
            <small>Show the parts musicd recognises in the music, and how long each has been playing.</small>
          </span>
          <input type="checkbox" role="switch" name="debug">
        </label>
        <div class="debug-note">
          <p>In debug mode musicd also measures, by itself, how far its picture runs behind the sound, and shows
            it at the bottom right.</p>
          <p><button type="button" class="record">Start recording</button></p>
          <small class="record-help">Records what musicd hears and everything it detects and shows, from now until
            you stop. Stopping saves two files to your downloads: the audio (.wav) and a log (.json).</small>
        </div>
      </section>
      <section>
        <h2>How to use</h2>
        <dl class="keys">
          <dt>Drop a song file</dt><dd>play it with full AI separation</dd>
          <dt><kbd>Space</kbd></dt><dd>pause or resume a dropped song</dd>
          <dt><kbd>Esc</kbd></dt><dd>back to live listening</dd>
          <dt><kbd>D</kbd></dt><dd>debug mode on or off</dd>
          <dt>Double-click</dt><dd>fullscreen</dd>
        </dl>
      </section>
      <p class="panel-foot">musicd ${__APP_VERSION__} · recognition by YAMNet, separation by Demucs, notes by Basic Pitch</p>`;
    this.statusEl = this.panel.querySelector('.panel-status')!;
    this.debugBox = this.panel.querySelector('input[name=debug]')!;
    this.debugBox.checked = this.settings.debug;
    this.debugBox.addEventListener('change', () => this.set({ debug: this.debugBox.checked }));
    this.tools = this.panel.querySelector('.debug-note')!;
    this.tools.hidden = !this.settings.debug;
    this.recordBtn = this.panel.querySelector('.record')!;
    this.recordHelp = this.panel.querySelector('.record-help')!;
    this.recordBtn.addEventListener('click', () => this.onRecord());
    // While recording, a button under the logo shows the time and stops it.
    this.recPill = document.createElement('button');
    this.recPill.type = 'button';
    this.recPill.className = 'rec';
    this.recPill.hidden = true;
    this.recPill.title = 'Stop recording and save the files';
    this.recPill.addEventListener('click', () => this.onRecord());

    this.root.append(this.button, this.recPill, this.panel);
    document.body.append(this.root);

    this.button.addEventListener('click', (e) => {
      this.toggle();
      // After a mouse click, give focus back so Space keeps controlling playback.
      if (e.detail) this.button.blur();
    });
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !this.root.contains(e.target as Node)) this.toggle(false);
    });
    // Clicks and keys inside the panel are not meant for the visuals.
    this.root.addEventListener('dblclick', (e) => e.stopPropagation());
    queueMicrotask(() => this.onChange(this.settings));
  }

  get isOpen() {
    return !this.panel.hidden;
  }

  toggle(open = !this.isOpen) {
    this.panel.hidden = !open;
    this.root.classList.toggle('open', open);
    this.button.setAttribute('aria-expanded', String(open));
  }

  set(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    this.debugBox.checked = this.settings.debug;
    this.tools.hidden = !this.settings.debug;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode: settings last for this visit only */
    }
    this.onChange(this.settings);
  }

  /** Show the recording state: seconds so far, or null when not recording. */
  setRecording(seconds: number | null, message?: string) {
    const on = seconds !== null;
    const time = on ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '';
    const btn = on ? `Stop recording (${time})` : 'Start recording';
    if (this.recordBtn.textContent !== btn) this.recordBtn.textContent = btn;
    this.recordBtn.classList.toggle('on', on);
    this.recPill.hidden = !on;
    const pill = `● REC ${time} · stop`;
    if (on && this.recPill.textContent !== pill) this.recPill.textContent = pill;
    if (message !== undefined) this.recordHelp.textContent = message;
  }

  setStatus(text: string) {
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
  }
}
