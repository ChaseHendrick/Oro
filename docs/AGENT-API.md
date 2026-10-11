# Oro agent controls

The running browser, offline HTML and desktop app expose `window.oro` (API version
2). Start with `oro.help()`, `oro.state()` and `oro.params(track)`. Help includes
argument examples and each method's `requiresAgentOptIn` permission; parameter
discovery includes current values, ranges, curves, units and enum option names.
`oro.schema()` describes the separate score grammar. There is no `/api/oro` HTTP
service: page control uses JavaScript or `postMessage`; headless score tools use
the [local CLI and MCP server](../README.md#for-agents-bots-and-scripts).

Controls return receipts with `ok`, and failures include an `error` and usually a
`fix`. Check `ok` before continuing. `getScore()` returns the current score,
`voice(alias)` returns a voice name or `null`, and `on(event, callback)` returns an
unsubscribe function. Score calls retain their score-specific validation receipts.

## Read, configure and perform

Tracks accept a zero-based index, a stable id from `oro.tracks()`, a unique name,
or `'sel'` for the selected track. Prefer stable ids when tracks may be reordered.
Duplicate names are rejected instead of choosing the first track.

```js
const { tracks } = oro.tracks();
const track = tracks[0].id;
console.log(oro.describe().text);
console.log(oro.params(track).params); // inspect ids and accepted option names

const sound = oro.set(track, { cutoff: 1200, resonance: 0.3 });
if (!sound.ok) throw new Error(sound.error);

const key = oro.setGlobal({ tempo: 112, scaleRoot: 'F#', scaleType: 'Minor' });
if (!key.ok) throw new Error(key.error);

const started = await oro.start();
if (!started.ok) throw new Error(started.fix);
console.log(oro.note(track, 'F#3', { vel: 0.7, dur: 0.5 }));
console.log(oro.chord(track, ['F#3', 'A3', 'C#4'], { dur: 1 }));
```

Browser audio still needs a user gesture on the Oro page; agent opt-in does not
bypass autoplay restrictions. A successful note receipt confirms routing, not
that a person heard the sound. Inspect `oro.state().audio` and verify audio output
separately. `oro.panic()` stops held notes. Repeated agent strikes on the same
track and pitch replace their release deadline; their releases do not release a
keyboard or another track's held note. Track reorders, removals, session loads and
Panic are handled without letting an old deadline release a new strike.

Parameter writes clamp finite numeric values to the discovered range, and round
integer/enum/bool parameters. Enum names are case insensitive; `scaleRoot` also
accepts names such as `D`, `F#` and `Bb`. Numeric strings and booleans are accepted
as parameter values where applicable. Null, blank, non-finite and object values
are rejected. **Parameter batches are atomic**: if any name or value is invalid,
`set`/`setGlobal` return `ok: false`, `set: {}` and `errors`, with no writes.
Earlier API v2 builds applied the valid subset of an invalid batch; callers should
now correct all reported errors and resend the complete batch.

Patch and scene loads accept exact names/ids or unique partial names. Empty or
ambiguous names fail with candidate `matches`. `addTrack({ patch, name })`
resolves the patch before adding a track, so an invalid patch leaves no empty
track behind. Use `oro.patches({ search: 'bass' })` or `oro.scenes()` to choose an
exact entry.

## Terrain motion and touch

The ball's centre moves over the terrain; the small closed audio path around it
still generates each oscillator cycle. Roll follows terrain slopes. Keep rolling
(`cruise`) supplies motion when gravity and friction would otherwise let it settle.
Pin and the existing Drift, Explore, Tour and Pendulum modes remain available.

```js
const track = oro.tracks().tracks[0].id;
oro.show('map');
const drop = oro.dot(track, {
  x: 0.23, y: 0.71, mode: 'Roll', gravity: 0.55, friction: 0.12, cruise: 0
});
if (!drop.ok) throw new Error(drop.error);
// The dot receipt reports the actual wrapped coordinates and clamped settings.
```

`dot` and `touch` need finite numeric terrain coordinates. Coordinates wrap into
`[0, 1)` on the tiling map: `1.25` becomes `0.25`. Dot gravity, friction and cruise
clamp to `0..1`; bounce clamps to `0..0.95`. An unknown option, invalid number or
unknown mode rejects the entire dot call before anything moves.

Touch uses the selected track, with `strum` for in-key terrain notes or `fx` for
temporary sound changes. Send `down`, then `move` updates, then `up` on completion
or interruption. A touch's effects glide back on release. The omitted mode uses
the map's current performance mode (FX when its tool is Move).

```js
oro.select(track);
oro.touch({ x: 0.2, y: 0.3, phase: 'down', mode: 'fx' });
try {
  oro.touch({ x: 0.5, y: 0.6, phase: 'move', mode: 'fx' });
} finally {
  oro.touch({ x: 0.5, y: 0.6, phase: 'up', mode: 'fx' });
}
```

Invalid touch phases/modes/options return an error without emitting a touch. The
same `down`/`move`/`up` sequence works with `mode: 'strum'` after audio starts.

## Sequencer validation

`oro.pattern(track, steps, { on: true })` takes 1–16 steps; shorter arrays repeat
to fill all 16. The default `on: true` enables the track's sequencer; `on: false`
preserves its current enable state. Each step is `null` or `false` (off), an integer scale degree, or
an object with these fields. Unspecified fields keep the existing step settings.
An invalid step rejects the complete pattern before changing or enabling it.

| Field | Accepted values |
| --- | --- |
| `degree` | Integer `-21..28`, relative to the current key/scale |
| `octave` | Integer `-2..2` |
| `vel`, `prob` | Number `0..1` |
| `gate` | Number `0.05..1` |
| `accent`, `slide` | Boolean or integer `0..1` |
| `ratchet` | Integer `1..4` |

```js
oro.pattern(track, [0, null, { degree: 2, vel: 0.7, ratchet: 2 }, null]);
oro.transport({ play: true, tempo: 112 });
oro.transport('stop');
```

Transport accepts `play`, `stop`, `toggle`, or an object containing one boolean
action plus optional tempo. Unknown or conflicting actions fail before tempo
changes. `note`/`chord` accept named notes or integer MIDI `0..127`, velocity
`0..1`, and positive finite duration in seconds within the browser timer limit
(`2147483.647` seconds); durations below 10 ms are held for 10 ms.

## Control from another page

Session-changing messages need Oro opened with `?agent=1` (or `#agent`). Reading
and score desk calls keep the existing permission behavior. The opt-in does not
create a server. Only documented methods are callable over this bridge.

For an already loaded iframe pointing at your local Oro dev server:

```js
const target = document.querySelector('iframe').contentWindow;
const origin = 'http://localhost:5173'; // use the actual Oro page's origin
let serial = 0;
function callOro(type, args = [], timeoutMs = 10000) {
  const id = `request-${++serial}`;
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
    };
    const receive = (event) => {
      if (event.source !== target || event.origin !== origin) return;
      const reply = event.data;
      if (!reply || reply.source !== 'oro' || reply.id !== id) return;
      cleanup();
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error || JSON.stringify(reply.result)));
    };
    window.addEventListener('message', receive);
    timer = setTimeout(() => { cleanup(); reject(new Error('Oro timed out')); }, timeoutMs);
    target.postMessage({ source: 'oro-agent', id, type, args }, origin);
  });
}
console.log(await callOro('help'));
const { tracks } = await callOro('tracks');
await callOro('dot', [tracks[0].id, { x: 0.23, y: 0.71, mode: 'Roll' }]);
```

When supplied, `args` must be an array; malformed args fail before execution.
Replies preserve the request `id` and `type`, with `result` and the legacy
`receipt` field. Validation failures also expose `error` and `fix` at the top
level. Score renders may need a longer request timeout.

Send `{ source: 'oro-agent', type: 'subscribe', events: ['score', 'step', 'note'] }`
to receive `{ source: 'oro', type: 'event', event, data }` messages. Re-subscribing
the same window replaces its event set rather than duplicating events. Send
`type: 'unsubscribe'` on teardown. Validate the reply source and origin just as
in the request example. Legacy `{ type: 'play', score }` and
`{ type: 'compose', prompt }` messages remain supported.
