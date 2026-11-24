// Downloads Google's YAMNet sound classifier (Apache-2.0, TF.js format) into
// public/vendor/yamnet, once. Used to recognise which instruments are playing.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = 'public/vendor/yamnet';
if (existsSync(join(out, 'model.json'))) {
  console.log('yamnet already present');
} else {
  const url = 'https://www.kaggle.com/api/v1/models/google/yamnet/tfJs/tfjs/1/download';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YAMNet download failed: ${res.status}`);
  const tgz = join(tmpdir(), `yamnet-${process.pid}.tgz`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  mkdirSync(out, { recursive: true });
  execFileSync('tar', ['xzf', tgz, '-C', out]);
  console.log('yamnet downloaded to', out);
}
