import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChordRunner, CHORD_QUEUE_LIMIT } from '../../src/pedals/guitar-chord-runner.js';

afterEach(() => vi.unstubAllGlobals());

function fakeWorkers({ rejectBlob = false, handshake = true } = {}) {
  const workers = [];
  vi.stubGlobal('Worker', class {
    constructor(url) {
      if (rejectBlob && String(url).startsWith('blob:')) throw new Error('file origin');
      this.url = url; this.sent = []; this.terminate = vi.fn();
      workers.push(this);
    }
    postMessage(message) {
      this.sent.push(message);
      if (message.t === 'ping' && handshake) queueMicrotask(() => this.reply({ t: 'pong' }));
    }
    reply(data) { this.onmessage?.({ data }); }
  });
  return workers;
}

const samples = () => new Float32Array(1024);
const waitForWorker = runner => vi.waitFor(() => expect(runner.mode).toBe('worker'));

describe('chord worker bridge', () => {
  it('uses the bundled Blob worker and preserves streaming sample timestamps', async () => {
    const workers = fakeWorkers();
    const emit = vi.fn();
    const runner = createChordRunner({ sampleRate: 48000, emit });
    runner.process(samples(), 2);
    await waitForWorker(runner);
    const worker = workers[0];
    expect(worker.url).toMatch(/^blob:/);
    expect(worker.sent.find(message => message.t === 'config')).toMatchObject({ sampleRate: 48000, revision: 0 });
    const job = worker.sent.find(message => message.t === 'samples');
    expect(job).toMatchObject({ time: 2, revision: 0, sampleRate: 48000 });
    worker.reply({ t: 'result', id: job.id, revision: 0, events: [{ t: 'noteOn', note: 52, mode: 'chords', time: 2.1 }], pitch: { t: 'pitch', mode: 'chords', notes: [52] } });
    expect(emit.mock.calls.map(([event]) => event.t)).toEqual(['noteOn', 'pitch']);
    runner.dispose();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('falls back to a data URL if Blob workers cannot start', async () => {
    const workers = fakeWorkers({ rejectBlob: true });
    const runner = createChordRunner({ sampleRate: 48000, emit: vi.fn() });
    await waitForWorker(runner);
    expect(workers[0].url).toMatch(/^data:text\/javascript/);
    runner.dispose();
  });

  it('allows one sample job in flight and bounds queued audio, resetting after an overflow', async () => {
    const workers = fakeWorkers();
    const onReset = vi.fn();
    const runner = createChordRunner({ sampleRate: 48000, emit: vi.fn(), onReset });
    await waitForWorker(runner);
    for (let index = 0; index < CHORD_QUEUE_LIMIT * 3; index++) runner.process(samples(), index / 48);
    expect(workers[0].sent.filter(message => message.t === 'samples')).toHaveLength(1);
    expect(runner.queued).toBeLessThanOrEqual(CHORD_QUEUE_LIMIT);
    expect(runner.dropouts).toBeGreaterThan(0);
    expect(onReset).toHaveBeenCalledTimes(runner.dropouts);
    runner.dispose();
  });

  it('discards old worker results after a reset or disposal', async () => {
    const workers = fakeWorkers();
    const emit = vi.fn();
    const runner = createChordRunner({ sampleRate: 48000, emit });
    await waitForWorker(runner);
    const worker = workers[0];
    runner.process(samples(), 2);
    const old = worker.sent.at(-1);
    runner.configure({ gateDb: -40 }, { restart: true });
    runner.process(samples(), 3);
    worker.reply({ t: 'result', id: old.id, revision: old.revision, events: [{ t: 'noteOn', note: 52 }] });
    expect(emit).not.toHaveBeenCalled();
    const fresh = worker.sent.at(-1);
    expect(fresh.revision).toBeGreaterThan(old.revision);
    worker.reply({ t: 'result', id: fresh.id, revision: fresh.revision, events: [{ t: 'noteOn', note: 55 }] });
    expect(emit).toHaveBeenCalledWith({ t: 'noteOn', note: 55 });
    runner.process(samples(), 4);
    const pending = worker.sent.at(-1);
    const handler = worker.onmessage;
    runner.dispose();
    handler({ data: { t: 'result', id: pending.id, revision: pending.revision, events: [{ t: 'noteOn', note: 59 }] } });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('terminates a worker still starting when its input is disposed', () => {
    const workers = fakeWorkers({ handshake: false });
    const runner = createChordRunner({ sampleRate: 48000, emit: vi.fn() });
    expect(runner.mode).toBe('starting');
    runner.dispose();
    expect(workers[0].terminate).toHaveBeenCalled();
  });
});
