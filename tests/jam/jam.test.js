import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { packCode, unpackCode, CodeError } from '../../src/jam/codes.js';
import { decodeMessage, encodeMessage } from '../../src/jam/protocol.js';
import { splitMessage, createAssembler } from '../../src/jam/framing.js';
import { createClockSync } from '../../src/jam/clock.js';
import { createJitterBuffer, scheduleNote, snapBeats, MIN_DELAY_MS } from '../../src/jam/jitter.js';
import { createOwnership } from '../../src/jam/ownership.js';
import { createChat } from '../../src/jam/chat.js';
import { createModeration } from '../../src/jam/moderation.js';
import { createHostRoom, createGuestRoom } from '../../src/jam/relay.js';
import { createMemoryLink } from '../../src/jam/rtc.js';
import { createVoiceSink } from '../../src/jam/voice.js';
import { createSpeaking } from '../../src/jam/speaking.js';
import { shouldSendSched, guardAutosave } from '../../src/jam/sync.js';

const sdp = { type: 'offer', sdp: 'v=0\r\n' };

describe('jam codes and protocol', () => {
  it('packs and unpacks an invite, and rejects a damaged code', async () => {
    const code = await packCode('invite', { v: 1, jam: 'jamroom1', desc: sdp });
    expect(code).toMatch(/^ORO-JAM-I/);
    const back = await unpackCode(code, 'invite');
    expect(back.payload.jam).toBe('jamroom1');
    expect(back.word).toBeTruthy();
    await expect(unpackCode('not a code', 'invite')).rejects.toBeInstanceOf(CodeError);
  });

  it('drops unknown messages and caps chat', () => {
    expect(decodeMessage(encodeMessage({ t: 'nope' }), 'up')).toBeNull();
    const long = 'x'.repeat(600);
    const msg = decodeMessage(encodeMessage({ t: 'chat', text: long }), 'up');
    expect(msg.text.length).toBeLessThanOrEqual(500);
  });

  it('frames a message and refuses one that is too large', () => {
    const asm = createAssembler();
    const parts = splitMessage('hello jam', 'm1');
    let done = null;
    for (const p of parts) done = asm.push(p);
    expect(done).toBe('hello jam');
    const big = createAssembler({ maxChars: 8 });
    expect(big.push(splitMessage('this is too big', 'm2')[0])).toBeNull();
  });
});

describe('jam clock, jitter and ownership', () => {
  it('estimates offset under asymmetric delay', () => {
    const clock = createClockSync();
    const truth = 40;
    for (let i = 0; i < 8; i++) {
      const skew = i % 2 ? 20 : 2;
      const t0 = 1000 + i * 100;
      const t1 = t0 + truth + skew;
      const t2 = t1 + 1;
      const t3 = t0 + skew + 1 + 4;
      clock.add(t0, t1, t2, t3);
    }
    expect(clock.ready).toBe(true);
    expect(Math.abs(clock.offset - truth)).toBeLessThan(15);
  });

  it('holds notes at least 40 ms and drops a very late one', () => {
    const buf = createJitterBuffer();
    buf.observe(0, 10, 0);
    expect(buf.delay).toBeGreaterThanOrEqual(MIN_DELAY_MS);
    expect(scheduleNote({ at: 0, on: true, now: 5000, buffer: buf })).toBeNull();
    expect(snapBeats('16')).toBe(0.25);
  });

  it('lets only the owner edit, and caps tracks at four', () => {
    const own = createOwnership();
    expect(own.canEditTrack('h', 't1')).toBe(true);
    expect(own.claim('p1', 't1')).toBe(true);
    expect(own.canEditTrack('h', 't1')).toBe(false);
    expect(own.canEditTrack('p1', 't1')).toBe(true);
    expect(own.release('p1', 't1')).toBe(true);
    for (let i = 0; i < 4; i++) expect(own.claim('p1', `t${i + 1}`)).toBe(true);
    expect(own.claim('p1', 't5')).toBe(false);
    expect(own.handGlobal('p1')).toBe(true);
    expect(own.canEditGlobal('p1')).toBe(true);
  });
});

describe('jam relay', () => {
  it('delivers chat, then drops a muted one, and rejects a ban', () => {
    const [a, b] = createMemoryLink();
    const host = createHostRoom();
    const joined = host.accept(a, { fp: 'ABCD-1234' });
    const guest = createGuestRoom({ link: b, name: 'Sam' });
    guest.say('hello there');
    expect(host.chat.entries().some((e) => e.text === 'hello there')).toBe(true);
    expect(guest.seen().some((m) => m.t === 'welcome')).toBe(true);
    host.muteChat(joined.id);
    const before = host.chat.entries().length;
    guest.say('second line');
    expect(host.chat.entries().length).toBe(before);
    host.ban('ABCD-1234');
    const [c] = createMemoryLink();
    expect(host.accept(c, { fp: 'ABCD-1234' }).reason).toBe('ban');
    host.localBlock(joined.id);
    expect(host.visible().some((e) => e.from === joined.id)).toBe(false);
  });

  it('relays a note to the other guest and to the host', () => {
    const [ha, ga] = createMemoryLink();
    const [hb, gb] = createMemoryLink();
    const host = createHostRoom();
    host.accept(ha);
    host.accept(hb);
    const heard = [];
    host.on('note', (m) => heard.push(m));
    const other = [];
    const sender = createGuestRoom({ link: ga, name: 'Ann' });
    createGuestRoom({ link: gb, name: 'Bea', onNote: (m) => other.push(m) });
    sender.send({ t: 'note', track: 'lead', n: 60, v: 0.4, at: 1 });
    expect(heard.map((m) => m.n)).toEqual([60]);
    expect(other.map((m) => m.from)).toEqual(['p1']);
    expect(sender.seen().some((m) => m.t === 'note')).toBe(false);
  });

  it('keeps voice off the synth engine', () => {
    const sink = createVoiceSink();
    expect(() => sink.play({ oroEngine: true })).toThrow(/synth engine/);
    const src = readFileSync(new URL('../../src/jam/voice.js', import.meta.url), 'utf8');
    expect(src.includes("from '../audio")).toBe(false);
    expect(src.includes('src/audio')).toBe(false);
  });

  it('rate limits chat and holds the speaking ring', () => {
    const chat = createChat({ now: () => 1000 });
    for (let i = 0; i < 5; i++) expect(chat.post({ from: 'p1', text: `m${i}` }).ok).toBe(true);
    expect(chat.post({ from: 'p1', text: 'too many' }).reason).toBe('rate');
    const mod = createModeration();
    expect(mod.act('p1', 'lock').ok).toBe(false);
    expect(mod.act('h', 'lock').ok).toBe(true);
    const speak = createSpeaking({ now: () => 0 });
    expect(speak.push(0.2, 0)).toBe(true);
    expect(speak.push(0.01, 10)).toBe(true);
    expect(speak.push(0.01, 500)).toBe(false);
    expect(shouldSendSched('seq')).toBe(false);
    expect(shouldSendSched('keys')).toBe(true);
    expect(guardAutosave(true, '{"a":1}', '{"b":2}')).toBe('{"a":1}');
  });
});
