// Check, write, render or export an Oro score from the shell. No page needed.
//
//   node scripts/oro-score.mjs schema
//   node scripts/oro-score.mjs check score.txt            (or a score on stdin)
//   node scripts/oro-score.mjs compose --prompt "anime opening song in D minor" [--text] [--out score.txt]
//   node scripts/oro-score.mjs render score.txt --out piece.wav [--bits 24|32] [--rate 48000]
//        [--quality pristine|high|standard|eco] [--loudness -14|off] [--ceiling -1] [--voicing patch|tint] [--tail 3]
//   node scripts/oro-score.mjs render --prompt "lofi with rain" --out lofi.wav
//   node scripts/oro-score.mjs midi score.txt --out piece.mid
//   node scripts/oro-score.mjs link score.txt [--base https://www.hendrickresearch.com/music/oro/]
//
// Every command prints a JSON receipt and exits 1 when the score is wrong.
// render runs the real Oro DSP offline (src/music/score-render.js).

import { readFileSync, writeFileSync } from 'node:fs';
import { check, compose, schema } from '../src/music/score.js';
import { scoreMidi, scoreLink } from '../src/music/score-export.js';

const [cmd, ...rest] = process.argv.slice(2);

function readArg(flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (flag) => rest.includes(flag);
const FLAGS_WITH_VALUES = new Set(['--prompt', '--style', '--bpm', '--key', '--mode', '--bars', '--seed', '--out', '--bits', '--rate', '--quality', '--loudness', '--ceiling', '--voicing', '--tail', '--base']);
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (FLAGS_WITH_VALUES.has(rest[i])) { i++; continue; }
    if (rest[i].startsWith('--')) continue;
    out.push(rest[i]);
  }
  return out;
}

function composeArgs() {
  return {
    prompt: readArg('--prompt') || positional().join(' '),
    style: readArg('--style'),
    bpm: readArg('--bpm') != null ? Number(readArg('--bpm')) : undefined,
    key: readArg('--key'),
    mode: readArg('--mode'),
    bars: readArg('--bars') != null ? Number(readArg('--bars')) : undefined,
    seed: readArg('--seed') != null ? Number(readArg('--seed')) : undefined,
    voicing: readArg('--voicing'),
  };
}

/** The score to work on: a file, stdin, or --prompt (composed on the spot). */
function scoreText() {
  if (readArg('--prompt') != null || readArg('--style') != null) {
    const r = compose(composeArgs());
    return r.ok ? r.text : r;
  }
  const file = positional()[0];
  return file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
}

function finish(receipt) {
  const text = has('--text') && receipt.text ? receipt.text : JSON.stringify(receipt, null, 2);
  console.log(text);
  process.exit(receipt && receipt.ok === false ? 1 : 0);
}

/** A receipt without the long fields, for commands that also write a file. */
function brief(r) {
  const { score, text, ...restOf } = r;
  return { ...restOf, title: score && score.title, bpm: score && score.bpm, bars: score && score.bars };
}

if (!cmd || cmd === 'schema') finish(schema());
else if (cmd === 'check') {
  const text = scoreText();
  finish(typeof text === 'string' ? check(text) : text);
} else if (cmd === 'compose') {
  const r = compose(composeArgs());
  if (r.ok && readArg('--out')) { writeFileSync(readArg('--out'), r.text); finish({ ...brief(r), wrote: readArg('--out') }); }
  finish(r);
} else if (cmd === 'render') {
  const text = scoreText();
  if (typeof text !== 'string') finish(text);
  const out = readArg('--out') || 'oro-score.wav';
  const { renderScore, encodeScoreWav } = await import('../src/music/score-render.js');
  const loud = readArg('--loudness');
  const started = Date.now();
  let last = -1;
  const r = await renderScore(text, {
    sampleRate: readArg('--rate') != null ? Number(readArg('--rate')) : undefined,
    quality: readArg('--quality'),
    voicing: readArg('--voicing'),
    tail: readArg('--tail') != null ? Number(readArg('--tail')) : undefined,
    loudness: loud === 'off' ? null : loud != null ? Number(loud) : undefined,
    ceiling: readArg('--ceiling') != null ? Number(readArg('--ceiling')) : undefined,
    onProgress: (f) => { const p = Math.floor(f * 10); if (p !== last && !has('--quiet')) { last = p; process.stderr.write(`render ${p * 10}%\n`); } },
  });
  if (!r.ok) finish(r.receipt);
  const bits = Number(readArg('--bits') || 24);
  const wav = encodeScoreWav(r, { format: bits === 32 ? 'float32' : 'pcm24' });
  writeFileSync(out, wav);
  finish({ ...brief(r.receipt), wrote: out, format: bits === 32 ? '32-bit float' : '24-bit PCM, TPDF dither', sampleRate: r.sampleRate, tracks: r.tracks, stats: r.stats, renderSeconds: (Date.now() - started) / 1000 });
} else if (cmd === 'midi') {
  const text = scoreText();
  if (typeof text !== 'string') finish(text);
  const r = check(text);
  if (!r.ok) finish(r);
  const out = readArg('--out') || 'oro-score.mid';
  writeFileSync(out, scoreMidi(r));
  finish({ ...brief(r), wrote: out });
} else if (cmd === 'link') {
  const text = scoreText();
  if (typeof text !== 'string') finish(text);
  const r = check(text);
  if (!r.ok) finish(r);
  finish({ ok: true, url: await scoreLink(r.text, readArg('--base')), hash: r.hash, durationSeconds: r.durationSeconds });
} else {
  console.error('Use: oro-score.mjs schema | check [file] | compose --prompt "..." | render [file] --out x.wav | midi [file] --out x.mid | link [file]');
  process.exit(2);
}
