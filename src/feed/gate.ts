// Keep only what is really there: drum hits only when drums are heard, voice
// only when someone sings (otherwise that melody belongs to an instrument).
import type { Ears } from '../analysis/instruments';
import { clamp } from '../viz/common';
import type { Frame } from './frame';

const DRUMS_ON = 0.3;
const VOICE_ON = 0.15;

/**
 * `stemsChecked`: the frame comes from full AI separation, which already
 * verified that the drum and vocal stems are real; trust it over recognition.
 */
export function applyPresence(f: Frame, ears: Ears, stemsChecked = false): Frame {
  const pres = { ...ears.presence, ...ears.override };
  f.presence = { ...pres };
  f.calm = ears.calm;
  // Stage is the fallback when the genre is unclear.
  f.layout = ears.electronic > 0.25 && ears.electronic > ears.orchestral ? 'center' : ears.orchestral > 0.25 ? 'pitch' : 'stage';
  // Either the classifier hears a drum kit, or the sound itself has a steady
  // percussive beat (the classifier often misses drums in a finished mix).
  const drums = stemsChecked ? 1 : Math.max(ears.heard ? pres.drums : 0, f.drumEvidence ?? 0);
  const voice = stemsChecked ? 1 : ears.heard ? pres.voice : 0;
  // Soft gate: keep every hit, but scale it by how sure we are drums exist.
  // Real drums in a dense mix still land hard; a mistaken piano attack barely shows.
  const sure = clamp(drums / DRUMS_ON);
  if (sure < 1) for (const h of f.hits) h.v *= 0.2 + 0.8 * sure;
  if (voice < VOICE_ON) {
    f.voice = null;
    for (const n of f.notes) if (n.voice === 'vocals') n.voice = 'lead';
  }
  f.level.drums *= clamp(drums / DRUMS_ON);
  f.level.vocals *= clamp(voice / VOICE_ON);
  return f;
}
