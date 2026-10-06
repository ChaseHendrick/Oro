#!/usr/bin/env node
// Oro as an MCP server (2.17): score tools for any agent that speaks the
// Model Context Protocol over stdio. No page, no browser, no network.
//
//   claude mcp add oro -- node /path/to/Oro/scripts/oro-mcp.mjs
//   (or in a client's config: { "command": "node", "args": ["/path/to/Oro/scripts/oro-mcp.mjs"] })
//
// Tools: oro_schema, oro_compose, oro_check, oro_render (WAV, 24-bit or
// 32-bit float), oro_midi, oro_link. Files are written under --out-dir
// (default ./oro-renders), never anywhere else.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { check, compose, schema } from '../src/music/score.js';
import { scoreMidi, scoreLink } from '../src/music/score-export.js';

const argv = process.argv.slice(2);
const outDir = resolve(argv.includes('--out-dir') ? argv[argv.indexOf('--out-dir') + 1] : 'oro-renders');
const VERSION = '2.17.0';

const scoreProp = { type: 'string', description: 'A text score (headers, cues, notes) or a JSON score. Use oro_schema for the grammar.' };
const TOOLS = [
  { name: 'oro_schema', description: 'The Oro score grammar: voices (orchestra, drums, ambience), chords, styles, limits.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'oro_compose',
    description: 'Write an Oro score from a short prompt or a style (anime-song, opening, epic, symphonic, lullaby, drums, ambient, lofi, orchestra-type, strings, brass-choir, sparse, atlas). Returns the score text and its receipt.',
    inputSchema: { type: 'object', properties: {
      prompt: { type: 'string' }, style: { type: 'string' }, bpm: { type: 'number' }, key: { type: 'string' },
      mode: { type: 'string', enum: ['major', 'minor'] }, bars: { type: 'number' }, seed: { type: 'number' }, voicing: { type: 'string', enum: ['patch', 'tint'] },
    } },
  },
  { name: 'oro_check', description: 'Check a score. Returns ok, errors (each with a fix), warnings, cue times in seconds and the duration.', inputSchema: { type: 'object', properties: { score: scoreProp }, required: ['score'] } },
  {
    name: 'oro_render',
    description: 'Render a score to a WAV file with the real Oro DSP (offline, faster than real time for most pieces). Give a score, or a prompt to compose one.',
    inputSchema: { type: 'object', properties: {
      score: scoreProp, prompt: { type: 'string', description: 'Compose from this prompt when no score is given.' },
      file: { type: 'string', description: 'File name (written in the server\'s output folder).' },
      bits: { type: 'number', enum: [24, 32], description: '24-bit PCM with dither, or 32-bit float.' },
      quality: { type: 'string', enum: ['pristine', 'high', 'standard', 'eco'] },
      loudness: { type: 'number', description: 'Target LUFS (default -14).' },
      sampleRate: { type: 'number' },
    } },
  },
  { name: 'oro_midi', description: 'Write a score as a standard MIDI file (one track per voice, drums on channel 10).', inputSchema: { type: 'object', properties: { score: scoreProp, file: { type: 'string' } }, required: ['score'] } },
  { name: 'oro_link', description: 'A link that opens Oro in a browser with the score ready to play.', inputSchema: { type: 'object', properties: { score: scoreProp }, required: ['score'] } },
];

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const brief = (r) => { const { score, ...rest } = r; return { ...rest, title: score && score.title, bpm: score && score.bpm, bars: score && score.bars }; };
function safeFile(name, ext) {
  const base = basename(String(name || `oro-${Date.now()}`)).replace(/[^\w.-]+/g, '-').replace(/^\.+/, '') || 'oro';
  mkdirSync(outDir, { recursive: true });
  return join(outDir, base.endsWith(ext) ? base : base + ext);
}

async function call(name, a = {}) {
  if (name === 'oro_schema') return text(schema());
  if (name === 'oro_compose') {
    const r = compose(a);
    return { ...text(r.ok ? { ...brief(r), text: r.text } : r), isError: !r.ok };
  }
  if (name === 'oro_check') { const r = check(a.score); return { ...text(brief(r)), isError: !r.ok }; }
  if (name === 'oro_render') {
    let score = a.score;
    if (!score && a.prompt) { const c = compose({ prompt: a.prompt }); if (!c.ok) return { ...text(c), isError: true }; score = c.text; }
    const { renderScore, encodeScoreWav } = await import('../src/music/score-render.js');
    const t0 = Date.now();
    const r = await renderScore(score, { quality: a.quality, loudness: a.loudness, sampleRate: a.sampleRate });
    if (!r.ok) return { ...text(brief(r.receipt)), isError: true };
    const file = safeFile(a.file || r.receipt.score.title, '.wav');
    writeFileSync(file, encodeScoreWav(r, { format: a.bits === 32 ? 'float32' : 'pcm24' }));
    return text({ ok: true, file, format: a.bits === 32 ? '32-bit float' : '24-bit PCM', stats: r.stats, tracks: r.tracks, cues: r.receipt.cues, renderSeconds: (Date.now() - t0) / 1000 });
  }
  if (name === 'oro_midi') {
    const r = check(a.score);
    if (!r.ok) return { ...text(brief(r)), isError: true };
    const file = safeFile(a.file || r.score.title, '.mid');
    writeFileSync(file, scoreMidi(r));
    return text({ ok: true, file });
  }
  if (name === 'oro_link') {
    const r = check(a.score);
    if (!r.ok) return { ...text(brief(r)), isError: true };
    return text({ ok: true, url: await scoreLink(r.text) });
  }
  return { ...text(`Unknown tool ${name}`), isError: true };
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const { id, method, params = {} } = msg;
  const respond = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  try {
    if (method === 'initialize') {
      respond({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oro', version: VERSION } });
    } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      // notifications get no reply
    } else if (method === 'ping') respond({});
    else if (method === 'tools/list') respond({ tools: TOOLS });
    else if (method === 'tools/call') respond(await call(params.name, params.arguments || {}));
    else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: { ...text(String(err && err.stack || err)), isError: true } });
  }
});
