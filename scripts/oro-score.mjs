// Check or write an Oro score from the shell. No audio: the receipt says
// how long the piece is and where the cues fall. Playback is an open Oro page.

import { readFileSync } from 'node:fs';
import { check, compose, schema } from '../src/music/score.js';

const [cmd, ...rest] = process.argv.slice(2);

function readArg(flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

let receipt;
if (!cmd || cmd === 'schema') receipt = schema();
else if (cmd === 'check') {
  const file = rest.find((a) => !a.startsWith('--'));
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  receipt = check(text);
} else if (cmd === 'compose') {
  receipt = compose({
    prompt: readArg('--prompt') || rest.filter((a) => !a.startsWith('--')).join(' '),
    style: readArg('--style'),
    bpm: readArg('--bpm') != null ? Number(readArg('--bpm')) : undefined,
    key: readArg('--key'),
    mode: readArg('--mode'),
    bars: readArg('--bars') != null ? Number(readArg('--bars')) : undefined,
  });
} else {
  console.error('Use: oro-score.mjs schema | check [file] | compose --prompt "..."');
  process.exit(2);
}

const text = process.argv.includes('--text') && receipt.text ? receipt.text : JSON.stringify(receipt, null, 2);
console.log(text);
process.exit(receipt && receipt.ok === false ? 1 : 0);
