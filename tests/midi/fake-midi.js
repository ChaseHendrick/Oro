// A fake Web MIDI implementation: ports with onmidimessage / send spies and a
// MIDIAccess that can hot-plug ports and fire statechange events.

export function fakeInput(id, name, manufacturer = '') {
  return {
    id, name, manufacturer, type: 'input', state: 'connected', connection: 'closed',
    onmidimessage: null,
    fire(bytes, timeStamp = 0) {
      if (this.onmidimessage) this.onmidimessage({ data: Uint8Array.from(bytes), timeStamp });
    },
  };
}

export function fakeOutput(id, name, manufacturer = '') {
  return {
    id, name, manufacturer, type: 'output', state: 'connected', connection: 'closed',
    sent: [],
    send(data, timestamp) {
      if (this.state !== 'connected') {
        const err = new Error('Port is disconnected');
        err.name = 'InvalidStateError';
        throw err;
      }
      this.sent.push({ data: [...data], timestamp });
    },
    bytes() { return this.sent.map(s => s.data); },
  };
}

export function fakeAccess({ inputs = [], outputs = [] } = {}) {
  const access = {
    inputs: new Map(inputs.map(p => [p.id, p])),
    outputs: new Map(outputs.map(p => [p.id, p])),
    sysexEnabled: false,
    onstatechange: null,
    plug(port) {
      port.state = 'connected';
      (port.type === 'input' ? access.inputs : access.outputs).set(port.id, port);
      if (access.onstatechange) access.onstatechange({ port });
    },
    unplug(port) {
      port.state = 'disconnected';
      if (access.onstatechange) access.onstatechange({ port });
    },
  };
  return access;
}

export function fakeNavigator(access, { permission = 'prompt', reject = null } = {}) {
  const calls = [];
  return {
    calls,
    requestMIDIAccess(opts) {
      calls.push(opts);
      if (reject) return Promise.reject(reject);
      return Promise.resolve(access);
    },
    permissions: { query: async ({ name }) => ({ state: name === 'midi' ? permission : 'prompt' }) },
  };
}
