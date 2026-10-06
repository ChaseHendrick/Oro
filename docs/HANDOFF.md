# Oro handoff

Updated 2026-10-06 for Oro 2.17.0 (section 0 is the current state; 10.12 is the 2.17 work and what is left). Earlier: written for 2.0.0, section 10 added for 2.12. Read this and `docs/ARCHITECTURE.md`
before continuing. The owner requested the complete expansion in
`docs/FEATURE-PARITY.md`, followed by desktop update controls. The measured checks and
limitations are in `docs/EXPANSION-VALIDATION.md`. Arrangement and Sound Match remain
separate future features; they are outside the 2.0 expansion.

---

## 0. Read first: where things stand (2026-10-06, Oro 2.17.0)

* **Code:** Oro **2.17.0** is on branch `claude/intelligent-feynman-i7wv3r` (not merged, no PR yet). `main` is 2.16.1 plus Grok's score desk (PR #32). A push to `main` publishes a desktop release (`.github/workflows/desktop.yml`), so merge only on purpose, after "Test and build the web app" is green.
* **What 2.17 is:** a review and repair of Grok's 2.16.1 score desk, then a large expansion asked for in one session: an orchestra, drums and ambience for the score desk, composer styles (anime-song and others), an offline WAV renderer, an agent API (`window.oro` + postMessage), an MCP server, the touch tool (Strum / FX on the map), Roll > Keep rolling, nine track effects, a pitch envelope, Link remap curves, and 32-bit float for Bounce and Record. Section **10.12** has the details, the file map, what is verified and what is not, and the next steps.
* **Checks at hand-off:** Vitest 2008 of 2009 pass; the one failure is the CPU timing test (`tests/dsp/perf.test.js`), which fails on this busy container on `main` too. `node dev/dsp/bench.mjs 1` on `main` and on the branch back to back showed no regression (10.12). `vite build` passes. A Chromium smoke test (preview build, `?agent=1`) exercised `window.oro`, a 15-track anime-song score, the touch API and the Score desk panel with no console errors. Nothing was tested on real audio hardware or by ear.
* **The owner has not listened to any 2.17 sound.** Levels were measured offline (10.12) and every voice makes sound, but whether the orchestra, drums and ambience sound good is unconfirmed. Treat "sounds good" as an open question, not a fact.
* **Still not done (from earlier):** a compiled plugin, a real Link session (GPL library not vendored), a TURN relay, a jam tried on two computers, live multi-out, and the hardware checks in 10.6.
* **Interface notes:** [docs/UI-NEXT.md](UI-NEXT.md) is research for a later layout. Not built.
* **App version:** bump only `package.json`. Do not edit the v2.13.0 tag fixture in `tests/packaging/mac-update.test.js`.
* **Agents:** never run broad `pkill` or `pkill -f <pattern>`: in this session `pkill -f "vite preview"` matched and killed the shell running the test suite. Kill only your own PIDs. Chromium checks here need `--disable-3d-apis --disable-webgl`, or the swiftshader flags in `tests/e2e/expansion.cjs` for a short run.
* **Network from the container:** x.com, fxtwitter, nitter and fullbucket.de are blocked by the egress proxy. The owner's reference post (an X post by Ingi Erlingsson, status 2106567435826446624) was never seen; see 10.12.

---

## 1. What this project is

**Oro** is a free, original wave terrain synthesizer by Chase Hendrick (GitHub
`ChaseHendrick`). A closed loop (the "path") is traced over a 2D height map (the "terrain")
once per oscillator cycle; the height under the moving point is the audio. The player sees
the land as a 3D map and drags a dot to move the loop. It was inspired by the Conductive
Labs Terrain Synth hardware, but it is a **clean-room** design: no code, art, text or sound
from that product (or any other) was copied. See section 9.

It ships as:

* a web app: https://hendrickresearch.com/music/oro/ (served by the owner's website);
* desktop apps for Mac, Windows and Linux, plus a single offline HTML file, attached to
  GitHub Releases: https://github.com/ChaseHendrick/Oro/releases/latest

Tech: plain JavaScript ES modules (no framework, no TypeScript), Vite 8, three.js for the
3D view, Rapier (physics, lazy loaded) for the rolling-marble mode, Web Audio
AudioWorklet for the synth engine, Web MIDI, Electron for the desktop apps, Vitest for
tests, Playwright (Chromium) for browser checks. Node 22.

## 2. Repositories

| Repo | What | Default branch | Deploys |
|---|---|---|---|
| `ChaseHendrick/Oro` | Oro | `main` | every push to `main` builds the desktop apps and publishes a GitHub Release for the version in `package.json` (`.github/workflows/desktop.yml`) |
| `ChaseHendrick/hendrickresearch.com` | the owner's website (Vite + TypeScript) | `main` | Vercel deploys `main` to hendrickresearch.com. Pull request previews are skipped (storage); see the website bullet in section 0 |
| `ChaseHendrick/music-field-manual` | the owner's notes, **PolyForm licensed** | | use facts from it only, never copy code |

Work happens on a branch and goes in through a pull request. The owner wants PRs merged
(squash) once CI is green, then the website updated (section 6). Keep releases coherent; the owner requested the
full set of 2.0 capabilities together.

## 3. State checked during this continuation

The earlier release blocker is resolved. Checked on 2026-10-02:

* Synth PR #9 is merged as `e47e6b4`; main's CI and Desktop apps workflows passed.
* GitHub Release **v1.4.0** has Mac ARM64 and x64 DMG/ZIP, Windows installer and
  portable EXE, Linux AppImage/tar.gz, web ZIP and the offline HTML file.
* Website PR #14 is merged. Its source declares Oro **1.4.0**.
* Synth PR #10 is merged as `058e03f`; main's CI and Desktop apps workflows passed.
  GitHub Release **v1.5.0** has all ten platform, web and offline assets uploaded.
  Website PR #15 is merged as `4ca638f`; the public app passed the generated-chord
  input and note cleanup checks after deployment.
* **1.5.0: experimental guitar chords** is published. The implementation
  replaces the unreliable draft with a conservative spectral detector, adds Single /
  Chords selection and per-note routing, and fixes stale source routes after Panic.
  Chords may miss quiet and octave-doubled strings. Physical guitar and pedal tests
  remain outstanding.
* The follow-up **1.5.1** patch adds the owner's brief pedal profile explanation to
  Settings > Pedals, the user guide and pedal notes: **Why these pedals?** These are
  the ones I have. Synth PR #11 and website PR #16 were merged; both builds, all ten release assets and
  the exact production copy were verified.

Follow the release routine in section 6: test both web builds, check browser input
paths, merge the feature PR only once CI is green, verify all download assets, then
sync the website. Check the current GitHub release and PR state before repeating a
step from this snapshot.

The macOS runner problem described in the original handoff was temporary. The
1.4.0 desktop workflow passed without changing runner labels or release behavior.

## 4. How to work on it

```bash
npm ci
npx vitest run            # all tests must pass; use --maxWorkers=4 on a busy local machine
npm run build             # web build into dist/
npm run build:single      # one offline HTML file into dist-single/
npx vite --port 5190 --strictPort &              # dev server
node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/   # browser smoke test
```

* The browser tests use a globally installed Playwright at
  `/opt/node22/lib/node_modules/playwright` with Chromium in `/opt/pw-browsers` (that is
  how the original environment was set up; adjust the `require` path elsewhere). Launch
  Chromium with `--autoplay-policy=no-user-gesture-required --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist` for audio and WebGL in headless mode.
  To test the microphone, add `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream` (Chromium's fake microphone is a short full-scale beep
  about once a second, so a meter sampled every 250 ms can look silent).
* Run browser tests on an idle machine: software WebGL is slow and they time out under load.
  `tests/audio/terrain-manager.test.js` has a timing budget that can fail on a busy machine.
* In the running app, `window.orograph` exposes `store`, `engine`, `visuals`, `music`,
  `midi`, `presets`, `tracks` and `ui` (for example `window.orograph.ui.openSettings('voice')`).
  The tests and the smoke script use these.
* The synth engine (`src/dsp/dsp-core.js`, class `OroDSP`) is pure JavaScript with no
  Web Audio dependency, so it can render offline in Node or a Worker.
  `tests/dsp/helpers.js` (`makeDSP`, `render`, `spectrum`) shows how.

## 5. Map of the code

`docs/ARCHITECTURE.md` is the contract between modules (coordinates, messages, parameter
registry). The short version:

| Path | What |
|---|---|
| `src/main.js` | boots everything |
| `src/core/params.js` | the parameter registry (`PART_PARAMS` with ids, ranges, defaults), `MAX_PARTS = 16`, `LINK_SOURCES`, state version. **Extend by appending only**: saved sessions depend on order |
| `src/core/store.js`, `src/core/migrate.js`, `src/core/tracks.js` | state store, migration of old saves, track list helpers (`partCount`, `watchTracks`, `permute`) |
| `src/dsp/` | the engine: `dsp-core.js` (voices, oversampling, filters, links), `terrains.js` (terrain generation, mip chains), `paths.js`, `catalog.js` (terrain and path names), `worklet.js` |
| `src/audio/` | Web Audio host: `engine.js` (creates the worklet, routing, bounce), `fx.js` (master effects), looper, recorder, importers, `resample.js`, `voice-host.js` / `voice-core.js` (microphone, 1.4) |
| `src/visual/` | three.js scene: terrain mesh, path, dot, physics, minimap (`hud.js`), post-processing |
| `src/ui/` | all panels and dialogs (no framework; `dom.js` has the `h()` helper) |
| `src/music/`, `src/midi/` | note router and arpeggiator, sequencer and transport, MIDI and the Akai MPC XL |
| `src/pedals/` | guitar pedal loop (1.1): pedal host, latency compensation, pitch tracker (`pitch.js`), guitar-to-notes |
| `electron/` | desktop wrapper |
| `tests/` | Vitest tests by area, plus `tests/e2e/*.cjs` browser scripts |
| `docs/USER-GUIDE.md` | the full user manual (keep it accurate when behaviour changes) |
| `docs/RESEARCH.md` | research brief: facts about the Terrain Synth (with sources), wave terrain theory, the original feature spec |
| `docs/BUGS.md`, `docs/PEDALS.md`, `docs/MPC-XL.md` | bug log, pedal design, MPC notes |
| `CHANGELOG.md` | one section per release |
| `src/pedals/chords.js`, `src/pedals/guitar-chord-worker.js` | experimental multi-pitch detector and background analysis |

## 6. Release and website routine

**Version bump checklist** (every release):

1. `package.json` `version`
2. `src/ui/settings.js` `VERSION`
3. `CHANGELOG.md`: new section at the top, `## X.Y.Z (Month YYYY): Title`
4. `docs/USER-GUIDE.md` line 5 ("It describes version X.Y.Z")
5. `README.md` if the feature list changes
6. this file

Then: run the tests and both builds, open a PR, wait for green, squash-merge. The push to
`main` publishes the release.

**Desktop app size.** Since 2.0.1 the `electronLanguages: ["en", "en-US"]` build option
bundles only English Chromium language files (about 50 MB less installed on Apple silicon).
Keep `en-US` in that list: electron-builder matches locale names exactly, and Windows and
Linux need `en-US.pak` as Chromium's fallback locale. Almost all of the remaining size is
Electron itself.

**Website update after a release** (in a clone of `hendrickresearch.com` next to `synth`):

```bash
git checkout -b claude/orograph-X.Y.Z origin/main
node scripts/sync-orograph.mjs ../synth   # builds the synth checkout (run npm ci there first) and copies it to public/music/oro/
# edit src/music.ts: Oro's softwareVersion (around line 16), and the feature text if needed
npm ci && npm run build
```

Open a PR, wait for the Vercel preview check, merge after the synth release is live.
Website SEO was set up on 2026-10-02: the site name shows as "Hendrick Research", the home
title is "Hendrick Research | Simulations & Scientific Research", and the WebSite
structured data has `alternateName: "HendrickResearch"`. Do not invent other names.

**Branches.** The previous assistant's tooling only allowed pushes to
`claude/magical-tesla-q993l8` in the synth repo, so that one branch was reset to
`origin/main` after each merge and reused. Website branches were named
`claude/orograph-X.Y.Z`. You can use any branch names you like.

## 7. Feature status

**Shipped** (see `CHANGELOG.md` for details):

* 1.0: the synth: 13 procedural terrains plus image/WAV/16-bit DEM import, 12 paths,
  oversampled engine with quality modes, filters, two envelopes, per-knob LFOs, Links
  (modulation routing) and macros, step sequencer, arpeggiator, effects, recording and
  bounce, MIDI with MPE and an Akai MPC XL guide, dark and light themes, phone layout,
  rolling marble physics.
* 1.1: guitar pedals: send a track out through real pedals and back, latency compensation,
  guitar plays notes (pitch tracking), Capture a guitar note as a terrain, pedal LFOs,
  pedal presets in scenes and patches, a 44.1 kHz option for the MPC. **Untested with
  real pedals or a real MPC.**
* 1.2: looper with overdub (32-bit float, 24-bit dithered or 32-bit float WAV export) and
  Resample (turn a loop into a new terrain). 1.2.1: smoother minimap and displays, no
  frame-rate caps. 1.2.2: the whole 3 x 3 map is playable, walls at the outer edge.
* 1.3: open-ended track list (1 to 16 tracks), several patterns per track.
* 1.4 (merged and published): voice and microphone input (Settings > Voice): input gain,
  meter and clip light, "Mic Cleanup" toggle, Monitor with a feedback guard, optional
  high-pass, compressor and de-esser, voice into the looper and Resample, "Voice plays
  notes", Capture a sung note, Voice Level as a Links source. Also fixes "Guitar plays
  notes" on tracks 5 to 16. **Untested with a real microphone.**

**Implemented in the 1.5.0 continuation:**

* **Experimental guitar chord tracking.** Single remains the default, Chords is an
  optional slower multi-pitch detector on a clean input, and Capture still requires
  one held note. Generated-signal tests establish the tested cases only, not real
  hardware accuracy. The superseded `wip/chords/` draft is removed.

**Requested by the owner, not started:**

1. **Arrangement timeline.** A song view: each track's patterns placed as clips on bars;
   move, resize, copy, loop and mute clips; playhead, loop region, song export; looper
   recordings droppable as audio clips. Hooks already exist: tracks and patterns have
   stable ids; `activeSeq(part)` and `patternPath(store, p)` in `src/core/params.js`.
2. **"Cutting edge" feature.** The owner asked for cutting-edge technology. The proposal
   (agreed in principle, not built) is **Sound Match**, automatic inverse synthesis: give it
   a sound (a file, a looper recording, or a sung note), and it searches Oro's own
   parameters for a patch that reproduces that timbre, keeping the result a playable,
   morphable patch (unlike Resample, which copies the sound into a terrain). Design notes:
   * Analyse a steady stretch of the target: pitch with the existing tracker
     (`src/pedals/pitch.js`), then the magnitudes of the first 32 to 64 harmonics in dB.
   * Score a candidate by rendering a short note at that pitch with the real engine
     (`OroDSP` in a Web Worker, as in `tests/dsp/helpers.js`), measuring the same
     harmonics, and taking a log-spectral distance. Estimated from the CPU benchmark in
     the 1.3.0 PR (about 0.7% of one core per sounding oscillator), rendering 0.1 s of one
     voice costs under a millisecond, so hundreds of candidates per second should be
     realistic. Measure before relying on it.
   * Terrain tables are slow to build (`generateTerrain` + `buildMipChain` in
     `src/dsp/terrains.js`), so build each built-in terrain once (13 of them, ids 0 to 12)
     and search the discrete choices (terrain, `pathShape` 0 to 11, `pathOrder` 1 to 8) by
     screening, then refine the continuous ones with a derivative-free optimiser such as
     CMA-ES: `pathParam`, `size` (0 to 0.5), `stretch`, `rotate`, `centerX`, `centerY`,
     `warp`, `lift` (0.25 to 4), `fold`, `laps`, `pace`, and optionally `cutoff` and
     `resonance`. Ranges are in `PART_PARAMS`.
   * UI idea: "Match a sound" in the import area or the Sound tab, with progress, a
     before/after A/B, the match score, and undo.
   * Be honest in the UI and docs about how close a match is; wave terrain cannot
     reproduce every sound.
3. The requested oscillator, terrain, modulation, effects, patch and display expansion
   is implemented in **2.0.0**. See `docs/FEATURE-PARITY.md` for every requested item and
   `docs/EXPANSION-VALIDATION.md` for evidence and performance bounds. A browser test is
   available at `tests/e2e/expansion.cjs`.

## 8. Things learned the hard way

* **Gray rectangle over the map (fixed in 1.1.x):** half-float overflow (Inf/NaN) in the
  render target spread by the bloom pass on Apple GPUs. Fixed by a sanitize shader pass
  after the render pass, and no MSAA on Apple GPUs (`src/visual/visuals.js`).
* **Dot jumping when grabbed (fixed 1.1.2):** the drawn dot included modulation; grabbing
  now starts from the drawn position and eases any offset away.
* **Feedback guard (fixed in 1.4):** a held sung vowel is as periodic as a feedback howl,
  so periodicity alone muted loud singing. The voice guard now also requires a steady
  pitch (within 10 cents) for a howl and an audible start for a runaway
  (`createFeedbackDetector` in `src/pedals/pedal-loop.js`, `VOICE_GUARD` in
  `src/audio/voice-core.js`). A very loud note held almost perfectly straight can still
  trip it; that is documented.
* **Track count:** since 1.3 there is no fixed `NUM_PARTS`. Use `MAX_PARTS` for array sizes
  and `partCount(store)` for the live count. Anything per track must follow reorders
  (`watchTracks` / `permute` in `src/core/tracks.js`).
* **Saved data compatibility:** append to `PART_PARAMS` and `LINK_SOURCES`, never reorder;
  bump the state version and add a migration in `src/core/migrate.js` when the saved shape
  changes.
* **Timing tests:** use the fake clock and timers the test helpers provide; real timers make
  scheduling tests flaky.
* **Agent worktrees:** if you use parallel agents with git worktrees, keep `.claude/worktrees/`
  out of commits (it is in `.gitignore`).

## 9. The owner's rules and preferences

* **Clean-room only.** Never copy Conductive Labs (Terrain Synth) or XLN Audio (XO, Life)
  code, art, text or sounds. `ChaseHendrick/music-field-manual` is PolyForm licensed: use
  facts from it, never code. Do not bypass Cloudflare or other protections when
  researching.
* **Writing style:** no em dashes in anything user-facing (app text, docs, changelog, PRs).
  Plain, accurate English.
* **Accuracy:** do not state anything you have not checked. Say clearly when something is
  untested; the hardware features (MPC XL, guitar pedals, microphone) have only been
  tested in software.
* **Quality:** high sound quality matters (32-bit float paths, no clicks, dithered
  exports). Smooth visuals: never cap the frame rate.
* **Process:** PR, CI green, squash merge, verify the release assets, then update and
  verify the website.
* **About the owner:** has a neuroscience degree and is in law school; technical
  explanations are welcome. Uses a Mac with Chrome, owns an Akai MPC XL and guitar pedals.
  Often asks for status and for a percentage of progress; give honest numbers.

---

## 10. Next features: specs ready to build

The owner approved these three during the 2.11 and 2.12 work and asked for them to be kept
here for later. Build each in its own module (for example `src/live/`, `src/jam/`,
`src/learn/`), load it lazily from one entry point, keep shared-file edits small, put new
saved fields through `src/core/migrate.js` (omitted when unused), keep output bit-identical
when unused, and follow section 9 (no em dashes, clean-room, accurate claims, mark anything
untested).

### 10.1 Live performance mode

**Implemented in 2.12** (`src/live/`: `setup.js` saved data and pure helpers, `controller.js`
pads, quantised queue and setlist, `wake.js` wake lock and full screen, `live-view.js` and
`live-edit.js` the lazy-loaded view and its dialogs, `src/styles/live.css`; tests in
`tests/live/live.test.js`). The saved setup is the optional session key `live`, sanitized by
`sanitizeLive` in `src/core/migrate.js` and left out when unused; scenes never carry it and
loading a scene or a setlist song keeps it. Untested on hardware: Screen Wake Lock (the desktop
app's permission policy now allows `screen-wake-lock`), Electron full screen, MIDI Learn on
pads with a physical controller. The spec as agreed:

- **Full-screen, distraction-free view** (Fullscreen API, with a maximised overlay as
  fallback; Esc or a visible Exit leaves). The map stays as a large backdrop (or a calmer
  flat view). Large, high-contrast controls readable at a distance, dark by default.
- **Pads** (4x4, adaptable): trigger a scene (quantised to the next bar or beat), a pattern
  on a track, a track mute or solo, a drum pad, a note or chord, or a macro or smart-control
  preset. Each pad has a label and colour and shows armed, active and queued states without
  blinking (steady fill plus a progress ring for quantised waits).
- **Big controls**: tempo with tap tempo, play and stop, the four macros and the selected
  track's eight smart knobs as large faders, master volume, panic.
- **Setlist**: ordered songs (saved scenes, or versions from version history), each with
  notes (key, tempo, cues), Next and Previous (MIDI and keyboard mappable), a large "Now /
  Next" display with a bar counter and clock.
- **Stage safety**: an optional lock that ignores clicks outside the pads (hold to unlock),
  confirm or quantise song changes while the transport runs, Screen Wake Lock where
  available, steady CPU.
- **Mapping**: reuse MIDI learn for pads, faders and setlist; default keys 1 to 0 and Q to P
  for pads, Space play/stop, arrows for the setlist.
- **Layouts** from phone to 5K2K ultrawide (5120x2160 at 100 to 200% scaling) and MacBook
  Retina sizes (1470x956, 1512x982, 1728x1117 at DPR 2).
- **Tests**: pad dispatch per type, quantised switching with the fake clock in
  `tests/music/fakes.js`, setlist navigation, lock, mapping persistence, migration.

### 10.2 Jam together (serverless, with chat, voice and moderation)

- **Connecting without a server, host-star**: Start a jam gives an invite code (SDP offer
  with all ICE candidates, deflate-raw plus base64url, with a short check word). A friend
  pastes it into Join and gets a reply code to send back. Each joiner connects only to the
  host, which relays messages; up to 6 people. STUN is off by default, with an opt-in
  "Use a public STUN server" (`stun:stun.l.google.com:19302`, labelled as Google's). Some
  networks need a TURN relay, which Oro does not provide; say so.
- **No audio streaming of music**: every computer renders every track locally. The network
  carries small messages: a sanitized session snapshot on join, track ownership, scheduled
  notes, knob changes on owned tracks, transport and tempo, pattern edits, scene changes.
- **Clock sync**: NTP-style ping/pong offset and round-trip estimates, keeping the best
  low-RTT samples; transport expressed on the host's timeline; remote notes scheduled at
  their musical time plus an adaptive jitter buffer (about 2x RTT jitter, at least 40 ms).
  Optional snap-to-grid for live remote notes (off, 1/16, 1/8). Show each peer's latency.
- **Ownership**: people own tracks; only owners edit them; the host owns global settings
  unless handed over. Undo covers only your own edits (a `jam` store source not recorded).
- **Text chat**: plain text only (textContent), 500 characters, rate limit 5 per 10 s per
  person enforced by the host relay too, timestamps, system lines, links shown as text, local
  history cleared on leave unless saved, @name highlights, unread badge.
- **Voice chat**: opt-in "Join voice", getUserMedia with echo cancellation, noise
  suppression and AGC; Opus tracks; the host forwards each joiner's voice to the others.
  Push-to-talk (N by default, rebindable; V is the keyboard velocity key) or open mic, per-person volume, mute, deafen, a steady speaking
  ring. Voice uses a separate gain path, never captured by bounces, recordings or stems, never
  through Oro's effects, never recorded. Recommend headphones.
- **Moderation**: the host is owner and can make moderators. Owner and moderators can mute a
  mic or chat for everyone, remove, ban for the jam (by a per-jam random key shown as a short
  fingerprint), lock the jam, clear chat, and reclaim tracks. Anyone can block someone
  locally (hide chat, mute voice, ignore notes on their own machine). Mod actions appear as
  system lines and are enforced in the host relay. Optional chat filter, off by default, with
  an empty user-editable word list.
- **Safety**: schema-check and sanitize every message, cap sizes, drop unknown types, rate
  limit, never execute code; ask before loading the host's session; snapshot your session
  before joining and restore it on leave.
- **Privacy notes for the guide**: voice and chat are peer to peer and not stored by any
  server; invite codes reveal network addresses to whoever receives them.
- **Tests**: code encode/decode, schemas and sanitizers, clock offset with simulated
  asymmetric jitter, jitter-buffer scheduling, ownership, relay, mute/ban enforcement, roles,
  local block, voice excluded from bounce, push-to-talk; plus a two-page Playwright run on
  one machine (connect via codes, the host starts the transport, a joiner's note is scheduled
  on the host, loops align within a few ms, a chat message arrives, then a chat mute drops
  the next one).

#### Notes from the first attempt (2.12 cycle, postponed)

**Code so far.** Six pure modules, unfinished and untested (no test files yet), are on branch
`claude/jam-wip` (commit 946f266, based on 2.11.0): `src/jam/codes.js` (deflate-raw plus
base64url, check word, `sdpFingerprint` as the ban key), `protocol.js` (message types,
`sanitizeMessage`/`decodeMessage` with size caps), `framing.js` (chunking for data-channel
message limits), `clock.js` (NTP-style sync keeping the lowest-RTT samples), `jitter.js`
(delay = max(40 ms, transit + 2 x jitter), snap choices) and `ownership.js`.

**Hook points (verified in the code).**
- Store (`src/core/store.js`): `set(path, value, {source})`; `serialize()` omits `ui`;
  `load(state, meta)` replaces everything and emits path `''`; writes to a missing `parts.N` are ignored.
- Undo (`src/core/history.js`): add `'jam'` to the `IGNORE` set. There is no `clear()`/`reset()`;
  add one for join and leave. Undo restores a whole snapshot via `store.load(..., {source:'history'})`,
  so after an undo the jam layer must put back tracks you do not own.
- Version history (`src/core/versions.js`) has its own IGNORE list; pause it while a guest with
  `getVersions().scheduler.pause(true/false)` so the host's session is not saved into your history.
- Autosave (`src/main.js`) serializes the live store on `global`/`parts`/`''` changes. As a guest it
  would overwrite your own saved session with the host's; guard it to keep writing your pre-join snapshot.
- Sanitizers (`src/core/migrate.js`): `migrateState(src)` for a whole session, `sanitizePart(src, i)` for
  one track. Use them on everything received.
- Track ids (`src/core/tracks.js`, `/^[\w-]{1,24}$/`); `watchTracks` only reacts to `''` and `parts`.
- Notes (`src/music/router.js`): the `'sched'` event `{part, note, vel, on, time, source}` fires for every
  engine note (MIDI out and ghost listen to it). Send live playing from `'sched'` (skip seq, preview,
  ghost); on receipt call `engine.noteOn(part, note, vel, time, 'jam')` directly, not the router, or chords
  and the arp are applied twice. `engine.cancelNotes(after, tag)` exists.
- Clock (`src/music/timing.js`): `createTimebase` gives `now()`, `audioToPerf`, `perfToAudio` (heard time).
- Transport (`src/music/transport.js`): `timeAtBeat`, `beatAt`, `nextGridTime(div, from)` (for snap).
  `play()` always starts at now + 0.06 s + the largest lead, so add a small `align({beat, time})` to
  start or re-anchor on the host timeline. Detect local play presses via the transport `'state'` event.
- Fakes: `tests/music/fakes.js` has `createFakeClock`, `createFakeEngine`, `createMemoryStorage`.
- Keeping voice out of recordings (`src/audio/engine.js`): the recorder takes `fx.output`, the looper taps
  `fx.masterTap`, bounces use `bounce.js renderPass`. Play voice only through `<audio>` elements that never
  touch the engine's AudioContext; test it with a source scan (no `src/audio` file imports `src/jam`) and a
  voice sink given an engine whose context throws if touched. (`stems.js` was not read in detail.)
- UI: lazy-load like `topbar.js` does `import('./version-panel.js')`; helpers in `src/ui/lazy.js`.
  `openModal` makes the app inert and `shortcuts.js`/`piano.js` ignore keys while `layers.hasModal()`, so make
  Jam a non-modal side panel. `isTypingTarget` is in `src/ui/dom.js`. Icons (`src/ui/icons.js`) have `mic`
  and `speaker` only. Badges: `BADGES` in `src/core/fun-catalog.js`. Help cards: `CARDS` in `src/ui/help.js`.
- Electron: the CSP in `electron/serve.cjs` has no WebRTC rule (check it); `policy.cjs` grants audio-only capture.

**Push-to-talk key: N (changed from V).** V is taken: `piano.js` uses C and V for keyboard velocity and
`SHORTCUTS` lists them. A search of `src` finds no binding for N (or I), and N is not a piano key, so the
default push-to-talk key is N. Make it rebindable in the Jam settings, skip typing targets, only listen
while voice is on in push-to-talk mode, and add it to `SHORTCUTS` and the help. (`eggs.js` was searched
for N and I; no matches.)

**Still to write.** Pure: `chat` (rate limit, log, @name, unread, filter), `moderation` (roles, mute, ban,
lock, local block), `relay`/`host-room`, `guest-room`, `speaking` (thresholds with hold for a steady ring).
Glue: `rtc.js` (RTCPeerConnection behind a link interface with an in-memory fake for tests), `sync.js`
(store/router/transport bridge), `voice.js`, `jam-ui.js`, `src/ui/jam-panel.js`, `src/styles/jam.css`.
Voice idea (not built): the host offer pre-creates 5 audio transceivers and forwards voices with
`replaceTrack`, avoiding renegotiation. Saved data: none in the session; name, STUN opt-in, PTT key and
the filter list in localStorage; saved chat as a downloaded text file.

**Risks (mostly guesses).** Chrome mDNS host candidates may not resolve in a sandbox (e2e-only fallback
`--disable-features=WebRtcHideLocalIpsWithMdns`); data channels may cap messages around 256 KB (hence
framing); remote audio may need a media element; physics-driven dots move locally and will drift apart
between computers; run e2e host and guest in separate browser contexts so localStorage is not shared.

**Build order.** Tests for the six modules; chat and moderation; host and guest rooms over an in-memory
link; `transport.align`, `'jam'` in history IGNORE, `history.reset`, versions pause, autosave guard;
`sync.js`; `rtc.js`; voice; UI and CSS; `scripts/e2e-jam.mjs`; docs.

### 10.3 Learn: in-depth interactive lessons

- **Accuracy first**: teach only what `docs/RESEARCH.md` (section 3 and its citations),
  `docs/USER-GUIDE.md`, `docs/ARCHITECTURE.md` and the code support. Cite only what
  RESEARCH.md cites; Kac, "Can One Hear the Shape of a Drum?" (American Mathematical Monthly,
  1966) is fine for the Resonator lesson. Standard facts (Nyquist, Fourier series,
  equal-temperament ratios, the 2D wave equation, the CFL condition) may be stated without
  citation but must be correct. Original wording only.
- **Lesson engine**: lessons are data (steps with text, setup actions such as loading a
  terrain or path, setting params, playing a note, opening a tab, highlighting a control with
  a steady outline, and checks that watch the store with tolerances, with Hint and Skip).
  Progress saved per computer; each lesson snapshots the learner's session and restores it on
  exit. Keyboard and screen-reader friendly (live region), phone widths, reduced motion,
  nothing flashing.
- **Curriculum** (8 to 12 lessons, 5 to 12 steps each; skip anything Oro does not do):
  sound basics and harmonics; wave terrain synthesis (orbit frequency is pitch, terrain
  cross-sections are timbre); paths in depth; aliasing, Nyquist and the quality modes;
  filters and envelopes; modulation (LFOs, Links, macros, smart controls, the function
  generator, science sources); the dot's physics (Roll, Drift, Pendulum, Golf); rhythm
  (sequencer, probability, ratchets, parameter locks, song mode, drum kit, slicing); tuning
  (ratios, cents, Scala); the Resonator (2D wave equation, modes, why overtones are
  inharmonic); Imprint and real places.
- **Learn panel**: lessons with level (Beginner, Intermediate, Deep dive), minutes and
  completion; a glossary linked from lesson text. Badges `lesson-complete` and `all-lessons`
  through `src/core/fun.js`.
- **Tests**: schema validation (every action references real params, paths, terrains and
  tabs from the catalogs), check predicates, progress persistence, snapshot and restore
  around a lesson, and a scan that fails on em dashes in lesson text.

#### Notes from the first attempt (2.12 cycle, postponed)

No code was written. These notes come from reading the code and docs; anything marked GUESS was not verified.

**Catalogs and APIs.**
- Params (`src/core/params.js`): `PART_PARAMS`, `PART_PARAM_MAP`, `GLOBAL_PARAM_MAP`, `MOD_PARAM_IDS`, `MOD_FIELDS`,
  `LINK_SOURCES`, `DOT_MODES`, `defaultState(count)`, `stepProb`, `stepRatchet`, `PLOCK_IDS`. Defaults worth knowing:
  `pathOrder` 2 (the Ellipse has a small epicycle; Order 1 gives a plain circle), `size` 0.22, `cutoff` 9000.
- Terrains and paths (`src/dsp/catalog.js`): `TERRAINS`, `PATHS`, `TERRAIN_INDEX`, `PATH_INDEX`; `user` is the
  Imported terrain; the `oro` path is hidden.
- Dock tabs (`src/ui/dock.js` `DOCK_TABS`: sound, mod, seq, mix, loop): open with `store.set('ui.panel', id)`. On
  phones `setMobileTab` in `app.js` only follows `ui.panel` when the mobile tab is not `map` or `keys`, so click
  `.mtab[data-tab=id]` there. `ctx.bus.emit('mod-view', 'links')` switches the Mod tab to Links and Macros.
- Settings tabs (`src/ui/settings.js` `SETTINGS_TABS`): `ctx.openSettings(tab)`. Quality is `ui.audioQuality`
  (saved per computer in `orograph.settings`); modes are `QUALITY_MODES` in `src/dsp/dsp-core.js`.
- Tuning: root-level `tuning`; built-ins `TUNINGS`/`TUNING_MAP` in `src/dsp/tuning.js`; write
  `sanitizeTuning(x) || undefined` as `src/ui/tuning-settings.js` does.
- Store: `serialize()`, `load(state, meta)`; scene loads use `store.load(state, { source: 'scene', [REPLACE_TRACKS]: true })`.
- Notes: `music.router.noteOn(target, note, vel, source)`/`noteOff`. Source `'ui'` counts as a person
  (`isPersonSource` in `src/music/capture.js`) and lands in the Capture buffer. GUESS: a custom `'learn'` source avoids that.
- Undo (`src/core/history.js`): IGNORE set is physics, engine, prefs, transport, theme, history, load, voice, lock,
  version; there is no pause. Version history (`src/core/versions.js`): own IGNORE set,
  `getVersions().scheduler.pause(on)`, `installCloseHooks` (capture-phase pagehide); its preview is a good model for
  snapshot and restore.
- Badges: `found('badge', id)` in `src/core/fun.js`; add `lesson-complete` and `all-lessons` to `BADGES` in
  `src/core/fun-catalog.js`; `onFun` in `src/ui/eggs.js` already shows the toast.
- Lazy loading: add `learn: lazy(() => import('../learn/...'))` to `chunks` in `src/ui/lazy.js`; a lazy module can
  import its own CSS as `src/ui/stems-dialog.js` does.
- Entry point: the phone top bar is full (the theme button hides below 480 px), so put Learn in the Help dialog
  (`src/ui/help.js`, `ctx.openHelp`) and add `ctx.openLearn` in `src/ui/app.js`.
- Highlight targets: `.knob[data-param=id]`, `.mod-row[data-param=id]`, `[data-viewport]`, `.scope-card`,
  `.path-picker`, `button[aria-label="Choose terrain A"]`, `.seg--dot`, `.seq-grid`, `.toggle--seq`,
  `.seq-chain-box`, `.links-list`, `.links-macros`, `.links-science`, `select[aria-label="Filter type"]`,
  `select[aria-label="Resonator mode"]`, `#tuning-preset`, the "Audio quality" radiogroup.
- Modals: `openModal` makes the app inert, so the lesson card must be non-modal, in `layers.host` (modal backdrop
  z 120, popovers z 125). `layers.host` is scaled by `--ui-zoom` on big screens (`uiZoom()` in `src/ui/dom.js`).

**Planned engine.** `src/learn/engine.js` (pure validation, checks, setup, runner), `lessons.js`, `glossary.js`,
`targets.js` (highlight names, each with a selector plus a file and string a test greps for), `progress.js`
(key `oro.learn.v1`, try/catch like `fun.js`), `rescue.js`, `learn-ui.js`, `learn.css`.
- Lesson `{ id, title, level, minutes, summary, setup[], steps[5..12], sources[] }`; step
  `{ id, title, text[] with [[term|label]] glossary links, setup[], highlight, check, hint, play }`.
- Setup actions: terrain, path, param, global, mod, dot, pattern, link, tab, settings, note, quality, tuning, stop.
- Checks: param, global, mod, dot, link, steps (on, prob, ratchet, plocks), drum, chain, ui, tuning, smart,
  userTerrain, all/any; ops eq, gte, lte, near (tolerance, value list, wrap for Dot X and Y), in, moved.
- Each lesson runs on a fresh `defaultState(1)`; on exit restore state plus `ui.selectedPart`, `ui.panel`,
  `ui.audioQuality` and whether the transport was playing. Add a history `pause()` and use
  `versions.scheduler.pause(true)` so lesson edits never become undo steps or versions.

**Proposed lessons (sources in brackets).**
1. Sound and harmonics: Spectra terrain, Scan path (Order 1, Shape 0.5, Size 0.5), move Dot Y. Verified in
   `genSpectra`: Dot Y 0 sine, about 0.167 triangle, 0.25 saw, 0.333 square, 0.5 pulse; rows mirror (v and 1 minus v
   sound the same). Harmonics view: 16 harmonics on a 48 dB scale, Sub bar first (`src/ui/scope.js`). [USER-GUIDE 3, 5]
2. Wave terrain synthesis: size 0 is silent; the map is a torus. [USER-GUIDE 1, 6; RESEARCH 3.1 to 3.3; ARCHITECTURE "Coordinates"]
3. Paths in depth: Laps, Pace, Travel, Ping-pong, Key>Size. [USER-GUIDE 6; `src/dsp/paths.js`]
4. Aliasing, Nyquist and quality: the bandwidth rule is tagged [I] in RESEARCH 3.7, so say "about".
   [USER-GUIDE quality table; `QUALITY` and `mipRaw` in `dsp-core.js`]
5. Filters and envelopes. [USER-GUIDE 7; ranges from params]
6. Modulation: LFOs, Links, macros, smart controls, function generator, science sources. [USER-GUIDE 7, 8;
   `src/ui/mod-panel.js`, `src/ui/links-panel.js`]
7. The dot's physics: Roll, Drift, Explore, Tour, Pendulum, Golf. [USER-GUIDE 4]
8. Rhythm: sequencer, Prob, Ratchet, parameter locks, song mode, drum kit, slicing; step fields `prob`, `ratchet`,
   `plocks`; kit is `parts.N.drum.on`. [USER-GUIDE 9]
9. Tuning: Bohlen-Pierce is 13 equal steps of 3/1. [USER-GUIDE Microtuning; `src/dsp/tuning.js`]
10. The Resonator: leapfrog finite differences on 24, 32 or 36 nodes per side at about 24 kHz; stability bound
    lam2 + 2mu < 0.5 (COURANT 0.49), the 2D CFL limit c dt/dx <= 1/sqrt(2) without damping; LAM2_MAX 0.45 sets the
    pitch ceiling; a uniform square membrane has modes proportional to sqrt(m^2 + n^2), so overtones are inharmonic.
    [header of `src/dsp/resonator.js`; Kac 1966, but do not state the answer to Kac's question]
11. Imprint and real places. [USER-GUIDE Imprint, Real places]

**Citable sources (from RESEARCH.md).** Bischoff, Gold and Horton (CMJ 2(3), 1978); Mitsuhashi (JAES 30(10), 1982);
Borgonovo and Haus (CMJ 10(3), 1986); Roads, Computer Music Tutorial pp. 163 to 167; S. James
(doi 10.26686/wgtn.22123283); the Zabetian thesis (vbn.aau.dk); Wikipedia pages on Jacobi-Anger, Lissajous, Rose,
Hypotrochoid, Superformula and Chebyshev; the CCRMA DC blocker page; plus Kac (1966).

**Skip.** Reflecting edges (Oro wraps as a torus); naming commercial products (RESEARCH section 1 is about one);
exact even-harmonic levels on the Spectra square (rows are interpolated; say "much smaller").

**Risks.** Autosave writes the session on page hide (`src/main.js`), so a phone killing the page mid-lesson could
save the practice state as the user's session: keep a rescue copy that `main.js` restores at boot, plus a
capture-phase pagehide restore. Loading the practice session with `REPLACE_TRACKS` revives frozen tracks. Block
lessons while a version preview is open. Restore Learn's own changes to `ui.audioQuality` and the `mapCollapsed`
pref. Golf's design notes are a good model for a temporary mode that never changes the session.

**Tests.** Schema (every param, path, terrain, tab and link source exists, imported from the real modules;
`settings.js` and `dock.js` import under `tests/ui/fake-dom.js`); every highlight target's string exists in its
file; check predicates incl. near, wrap, moved; progress persistence with fake storage; snapshot and restore
(`serialize()` identical, undo history unchanged, ui keys back); every glossary link resolves; a scan failing on
em or en dashes in lesson and glossary text; badges listed in `BADGES`.

### 10.4 GPU Resonator (merged for 2.12, experimental)

- **Code**: the work-in-progress branch `claude/gpu-resonator-wip` (commit `a6ab926`, based
  on 2.10.0) is merged onto 2.11.0 on the 2.12 branch. Modules: `src/dsp/reso-gpu-kernel.js`
  (WGSL kernels and their f32 JS mirror), `reso-gpu-plan.js` (block planner, `JsMembrane`),
  `reso-gpu-frame.js` (frame format, kept tiny so the worklet bundle stays lean),
  `reso-ring.js`, `reso-gpu-policy.js`, `reso-feed.js` (audio-thread side, `ResoGpuLink`),
  `src/audio/reso-gpu.js`, `reso-gpu-host.js`, `reso-gpu-worker.js` (all loaded only when the
  GPU engine is chosen) and `src/ui/reso-engine-row.js`.
- **Idea**: run the 2.10 Resonator's 2D FDTD membrane on the GPU (WebGPU compute shaders) at
  128, 192 or 256 cells a side instead of the CPU's 24 to 36, from a worker where the browser
  offers WebGPU there (the AudioWorklet thread can't use WebGPU). The GPU advances 256
  internal samples per job, reads back the pickups and streams them to the worklet (SAB rings
  when cross-origin isolated, else MessagePort chunks whose buffers are recycled). The CPU
  Resonator stays the zero-latency default; Oro falls back to it if WebGPU is missing, the
  adapter is lost, or the GPU falls behind real time.
- **Settings**: `ui.resoEngine` ('cpu' or 'gpu') and `ui.resoGpuDetail` (128, 192, 256) live in
  the non-persisted `ui` branch, so nothing new is saved and `migrate.js` needs no change. With
  the CPU engine the output is bit-identical to 2.11 (checked by hashing renders of main and
  this branch at 44.1, 48 and 96 kHz, Resonator Off, Strike and Resonate, Standard and
  Pristine).
- **Done in the merge**: the one conflict (dsp-core message switch) kept 2.11's `stemTap` and
  the `resoGpu` link; stems export (2.11) renders the GPU membranes too; the ScriptProcessor
  fallback forwards GPU status; the host drops stale membranes when a rebuilt DSP attaches;
  clearer fallback status and notice; Engine row spacing. Tests: 19 GPU tests (kernel mirror
  vs CPU membrane within 1e-4, offline capture/render/play through the DSP at 44.1, 48 and
  96 kHz, buffer reuse, CPU default untouched).
- **Measured**: pitch ceiling about 1.4 kHz on flat land and about 800 Hz to 1 kHz on the
  built-in terrains at every GPU detail (CPU: about 340 to 520 Hz on the same terrains);
  added latency 768 internal samples by design, 32 ms at 48 and 96 kHz, 34.8 ms at 44.1 kHz.
- **Checked in a browser, software adapter only**: headless Chromium 141 with SwiftShader
  WebGPU. The WGSL kernel matches the JS mirror within 7.6e-7 absolute (at most about 4e-6
  of the peak) at 128, 192 and 256, for Strike and Resonate, across sub-step changes (pitch
  jumps), and through the worker path; with no
  adapter, choosing GPU falls back cleanly with a notice; with SwiftShader (about 20 s per
  10.7 ms block) live playing falls back as designed. Layout checked at 5120x2160@1,
  1512x982@2 and 390x844@3.
- **Still unverified**: anything on a real GPU (real-time speed and headroom per detail and
  per number of tracks, Apple, NVIDIA, AMD and Intel drivers, device loss in practice), the
  SharedArrayBuffer transport (the app is not cross-origin isolated, so the MessagePort path
  is what runs), WebGPU inside the Electron app on each OS, and a long live session for
  glitches during the ARM crossfade and fallback. Freeze still uses the CPU Resonator.

### 10.5 Listening modes, 3D and surround (2.12)

- **Code**: branch `feat-spatial`. Listening modes in `src/audio/listen.js` (inserted between
  the master analyser and `mainOut`, after the recorder, looper and offline taps; Normal is
  two gain-1 nodes). 3D in `src/dsp/spatial.js` (per-track head model inside the DSP, so
  bounces, freezes and stems include it), params `space`, `spaceAz`, `spaceEl`, `spaceDist`,
  `spaceAir` appended to PART_PARAMS (not modulatable: the stage is per track, not per
  voice), kept by patch loads like the sends. Surround: DSP `{t:'surround'}` mode, a fifth
  worklet output (live) and an N-channel offline pass in `renderPass` (export), mixed down in
  `src/audio/stems.js`; WAVE_FORMAT_EXTENSIBLE writer in `src/audio/wav.js`.
- **Unverified**: live surround on a real 5.1 or 7.1 device (no hardware here; the device
  channel setup, the fifth output and the master-volume follow are untested); how convincing
  the 3D is on real headphones for different listeners; the surround file in a DAW (the
  header reads back in our decoder; not yet opened in a DAW). While live surround is on,
  Record and the looper capture only front left and right, and the master limiter does not
  act on the extra channels.

### 10.6 Small follow-ups found while building 2.12

- **Live mode keys**: the 16 pad keys are fixed (1 to 0 and Q to Y). Let people choose their
  own, with a key-capture setting and conflict checks against the note keys and shortcuts.
- **Freeze and the GPU Resonator**: Freeze still renders the Resonator on the CPU, so a frozen
  track does not sound like its GPU version.
- **Real-hardware checks still owed**: Screen Wake Lock and full screen in the desktop app,
  MIDI Learn (CC and the new note learn) with a physical controller, touch on a real phone or
  tablet, the GPU Resonator on Apple, NVIDIA, AMD and Intel graphics (speed, device loss, the
  Electron app), live 5.1 output, and how convincing the 3D sound is on real headphones.
- **CPU timing test**: `tests/dsp/perf.test.js` (16 voices x unison 2 under 35% of a core)
  fails on a busy machine, on main as well; it passes on CI. Consider a looser bound or a retry
  when the load average is high.
- **Bounces are not bit-repeatable with the master reverb or delay on**: two back-to-back
  bounces of the same session differ in their bytes (found while testing 2.12; it happens on
  2.11 too, in Normal listening mode). Likely the reverb impulse response or render timing.
  Worth finding so bounces are reproducible.

### 10.7 Future versions: features common in other synths that Oro lacks

Checked against the code in October 2026 (2.12). Oro already has MPE, a drawable
multi-segment curve (Function), macros, Links, arpeggiator, chord tools, Scala tuning,
swing, ratchets, Euclidean rhythms and sidechain, so those are not listed.

- **Plugin version (VST3, AU, CLAP)** so Oro runs inside a DAW, with automation and
  multiple outputs. The biggest gap for producers and a project of its own: either a native
  wrapper around the web app (a plugin shell hosting a web view, with audio passed between
  them) or a port of the DSP core to C++. Decide which before starting; check the licence of
  any framework used.
- **Ableton Link** (tempo and phase sync with other apps and devices on the local network).
  Browsers cannot open the UDP sockets Link needs, so this is desktop app only, through a
  native module in Electron. Oro already follows and sends MIDI clock.
- **Vocoder**: shipped in 2.14 as track effect type 31 (see 10.9). Microphone or another track shapes the carrier. Do not add a second one.
- **Piano roll and automation lanes**: free note editing and long knob-movement curves over
  a whole song. Oro has step sequencing, parameter locks, song mode and Capture, but no
  free-form editing. Needs a timeline data model that works with song mode and undo.
- **Make a patch from a sound**: give Oro a sample and have it search terrains, paths,
  filters and envelopes for a patch that imitates the sample's spectrum and envelope.
  Experimental; offline search with a spectral distance score is the likely approach.

2.13 shipped granular mode (with UI) and the tuner (see 10.8). 2.14 is section 10.9.

### 10.8 Oro 2.13.0: Sampler, looper tape controls, granular mode, tuner

**Why:** the owner asked for the ideas of a hardware sampler whose firmware went open source
(MIT licence) in September 2026, in Oro's own layout (the owner dislikes that product's
layout). Everything is clean-room: no code, samples, text or panel design from it, and the
product is not named in Oro. MIT would allow porting code with its notice, but the owner's
rule is clean-room; ask before changing that.

**Code:** shipped on `claude/oro-2.13`. The sampler DSP commits were `30cad6d` and `887cbdb` on `claude/sampler-wip`, cherry-picked as `ab0f7ce` and `8fc9d03`, based on 2.12.0 (`42c1943`). The UI, tape controls, tuner and docs are `cd7cac1`. When that work started, `main` was `11ad758` and did not contain the sampler. 2.13 and 2.14 land on `main` together.

**Done since the pause:** 2.14 later replaced Half / Normal / Double and Reverse with one Speed slider, and added the slice editor (10.9). The list below is the 2.13 commit.
- The 4 sampler expectation bugs and the 2 "appended" parameter tests are fixed.
  `tests/dsp/sampler.test.js`, `tests/audio/surround.test.js` and `tests/dsp/resonator.test.js`
  pass. Expectations now include the default level 0.8, a looser attack window, a freeze
  signature sized to the default drum pads, and relative order (3D, then the four sampler params).
- **Sampler UI:** `src/ui/sampler-panel.js` plus `src/ui/sampler-model.js`, lazy chunk
  `chunks.sampler`, mounted first on the Sound pane. Record 2/4/8/16 s, Import, Grab loop,
  waveform handles for Start and End, modes, direction, grain knobs only in Granular, Slice
  on transients (no slice editor). Turning Sampler on clears the drum kit's `on` flag and
  the reverse. Tests: `tests/ui/sampler-panel.test.js`.
- **Looper tape:** Reverse, Half / Normal / Double (pitch follows speed). Unity forward
  playback still uses the integer playhead. Scrub is a drag on the waveform strip (one-pole
  follow, level falls as the finger moves). Overdub writes each index once. Undo copies
  backward while reversed. Peaks scan in chunks. Tests: `tests/audio/looper-tape.test.js`
  (44 looper tests passed with the older looper files).
- **Tuner:** `src/audio/tuner.js` (cumulative mean normalized difference, clean-room) and
  `src/ui/tuner-panel.js`, lazy-imported at the bottom of Settings > Voice. It taps the
  existing voice input and does not enter the audible graph. Tests: sines at 82.41, 110,
  440 and 1000 Hz within 5 cents, saws stay on the fundamental, silence gives no note.
  Not tested with a real microphone.
- **Docs:** user guide sections, two help cards, README bullets, a 2.13.0 changelog section,
  and this file. `package.json` is 2.13.0.

**Checked:** full Vitest suite, 1879 passed, including `tests/dsp/perf.test.js` on this machine.
Three scenes with the sampler off matched the 2.12.0 engine sample for sample. `npx vite build` succeeded.
Not done: `node dev/dsp/bench.mjs 1` back to back with main, Playwright screenshots, a real microphone.

**Known risks:** `kitSent` in `sync.js` is not permuted on track reorder (pre-existing, not fixed).
Slice editing, missing here, shipped in 2.14 (10.9). Freeze still renders the Resonator on the CPU.
Scrub during an open overdub waits until the undo snapshot finishes.

**After this note:** the website at https://www.hendrickresearch.com/music/oro/ serves 2.14.0.
Desktop downloads update when `main` publishes the GitHub Release.

### 10.9 Oro 2.14.0: slices, tape speed, stereo takes, vocoder

Shipped in 2.14.0 (`package.json` is 2.14.0) on `claude/oro-2.13`.

* Sampler slices are edited on the wave (drag, add, delete, snap to a zero crossing). The
  sequencer Note row becomes Slice and writes `step.slice` only when a step is touched.
  Old patterns keep the key mapping.
* Looper Speed is one bipolar slider. Bend 0 is exactly +1.00× and stays on the integer
  playhead. Left of centre plays backward. Saved sessions that had Half/Normal/Double and
  Reverse are converted once.
* Import, Grab loop and Record output keep stereo. The microphone stays mono.
* Vocoder is track-effect type 31 (appended, so older type numbers are unchanged). The
  modulator is another track's previous block, or microphone audio posted into the engine
  while Voice is on. `mod` is stored only on a vocoder slot.
* Shipped. Plugin, Link and the piano roll are 2.15 (10.10), with the limits written there.
  Do not name the hardware sampler.

### 10.10 Oro 2.15.0: piano roll, jam, learn, sound match, Link, plugin contract

Shipped on `main` as release v2.15.0. `package.json` for that release was 2.15.0. The patch on top is 10.11.

* **Piano roll** (`src/music/roll.js`, `src/ui/piano-roll.js`). Optional `step.q` (1 to 3),
  `step.extras` (at most 8), and `pattern.lane` (one id from `PLOCK_IDS`, curve length
  `pattern.length * 4`). Old sessions omit them. Unity playback with no `q` and no lane
  is the same path as before. The grid is still there.
* **Jam** (`src/jam/`, `src/ui/jam-panel.js`). The six modules from commit 946f266 plus
  chat, moderation, speaking, voice, sync, rtc, relay and the panel. Start calls
  `RTCPeerConnection` when the browser has it. Invite another makes the next
  code, up to five (`p1` to `p5`). Apply reply sets the remote description on
  the invite that is still waiting. Chat arrives on both sides. Notes use the
  `note` message, stamped on the host clock. Guests ping so they can convert.
  Playback goes through the jitter buffer and `engine.noteOn` with source
  `jam`, not the router. Sequencer, preview and ghost are not sent. Voice
  constraints are echo cancellation, noise suppression and AGC. The sink throws
  if handed `{ oroEngine: true }`. Autosave while joined writes the pre-join
  session object. History ignores `jam`.
  Not done: TURN, two real computers, Playwright e2e.
* **Learn** (`src/learn/`). Eleven lessons, five steps each. Highlights are selectors
  whose snippets the test greps in real files. No em dash or en dash in lesson text.
  Badges `lesson-complete` and `all-lessons`. Rescue key `oro.learn.rescue` is restored
  once on boot if a lesson was left open, then cleared.
* **Match a sound** (`src/music/sound-match.js`). The search renders one cycle of
  each candidate: path sample, centre 0.5, size 0.28, bilinear height. That is
  the voice's reading of the land, not the filters, effects or envelopes.
* **Link** (`src/link/link.js`). Status is empty when off, "Not in this build" when on
  and the library is missing. Rows are hidden unless the user agent contains `Electron/`.
  Do not vendor the GPL library into this MIT repo.
* **Plugin** (`src/plugin/host.js`). Output 1 is Mix. Parameters are master volume and,
  for tracks 1 to 4, level, mute, morph, cutoff, resonance, attack, release. Writes use
  source `plugin`, which history ignores. Not a binary, and not extra live outputs.
* **Desktop CSP** allows `stun:stun.l.google.com:19302` on connect-src. No http origin
  was added.
* **Checked:** Vitest, see section 0. Unity looper playback was not re-bench tested.

### 10.11 Oro 2.15.1: lane, jam notes, glossary, tempo lock

Patch on 2.15.0. `package.json` is 2.15.1.

* **Lane.** `shiftLane` in `src/music/roll.js` rotates the curve with Shift (the tail past the pattern length stays). Clear sets `lane` to null. `sanitizePattern` keeps a curve whose length is not `pattern.length * 4`, instead of dropping it. `applyLane` writes the knob back when the lane id changes, when the lane stops, or when a step has no samples. A step lock on that same id still wins the whole step. Drawing a point on a curve that is longer than the current length keeps the existing points.
* **Piano roll notes.** Extras use `stepSlice`. A MIDI pitch the first note already plays is not played again.
* **Jam.** A failed offer calls `host.drop` and closes the peer connection. Apply reply uses `readReply` and the slot map, not only the latest `pending`. Leave calls `releaseSent` (note-offs, then bye) before it closes. A guest bye emits `bye` and frees the slot. `sys` leave silences that person's notes. `playRemote` passes `onAt` into `scheduleNote`, and holds a note-off that arrives before its note-on. The ping interval is set again from `pingInterval(clock.count)` after each pong. Start or Join closes an existing connection first.
* **Learn.** Glossary markup allows a capital id and looks it up in lowercase, so Nyquist, Filter and LFO become buttons.
* **Tempo.** `setReadOnly` blocks drag, wheel, arrows and commit. Live mode disables its tempo buttons while Link is on, a plugin host is set, or external MIDI clock is active.
* **Not claimed:** a compiled plugin, vendored Link, TURN, a jam on two real computers, Playwright jam, live multi-out. Voice still does not enter the engine. Host Mute mic still only sets a moderation flag. It does not stop that person's audio.

### 10.12 Oro 2.17.0: orchestra, drums, ambience, agent API, touch tool, effects

**What the owner asked for in this session**, in order: check Grok's work on the repo;
keep improving the API so bots and agents can use Oro easily; can the marble be dropped
anywhere and follow the land up and down without going in a circle; a mode to click or
drag on the map and have effects; make music like an X post by Ingi Erlingsson possible;
the best DSP and sound possible; improve the orchestra and add missing instruments; more
drum instruments and drum pieces; ambience; what Pigments, Serum 2, Phase Plant, Vital,
Massive X, Arturia and Fullbucket have that Oro lacks; 32-bit output; then "wrap it up,
make a handoff". Effects and features were written from scratch from public descriptions
of what those products do; no code, presets or sounds were copied.

**Grok's work (the commits after 2.16.0 up to PR #32), what was wrong and is now fixed**

* `window.oro` (score desk) was set before `installConsoleEgg()`, which returned early when
  `window.oro` existed, so the console secret disappeared. The egg now adds `secret()` to the
  existing object (not enumerable).
* `Am7` parsed as A minor in octave 7 (the chord regex tried `m` before `m7`). Chord types are
  now matched longest first, sevenths and ninths were added, and `@` gives an explicit octave.
* A pitched `tom` sent its raw MIDI note (for example D3 = 50) to the kit, which has pads 36
  to 43, and the normalised text dropped the pitch, so re-checking changed the hash.
* The desk restored tracks by index: a session load, a reorder or a removed track during a
  score wrote the old track over the wrong one. It now keeps tracks by id, abandons them on a
  session load, stops on a panic and on someone else's track change, and the autosave always
  stores the tracks as they were (`autosave.addFilter` + `desk.cleanState`).
* Tracks were restored the moment the last note-off was scheduled, cutting release tails.
  They now go back 2.5 s later.
* `plugins/oro/.claude-plugin/plugin.json` claimed the plugin renders a WAV. It now says
  where a WAV comes from (the repo's renderer).
* Not fixable in code: renaming the repository `synth` to `Oro` means Macs on 2.11 to 2.16.0
  with **Install updates automatically** on will reject the new asset URLs (their
  `RELEASE_DOWNLOAD_PREFIX` names `/synth/`). Those people need one manual download. Say so in
  the 2.17 release notes.
* The 24-second film was committed and then removed; it is still in git history (5 MB).

**Where the 2.17 code is**

| Area | Files |
|---|---|
| Score grammar, checker, compose | `src/music/score.js` |
| Composer styles (anime-song, opening, epic, symphonic, lullaby, drums with 20 grooves, ambient, lofi, orchestra-type, strings, brass-choir, sparse, atlas) | `src/music/score-styles.js` |
| Voices: 57 pitched (each a factory patch made into an instrument, octave and tune zeroed), the classic kit, 29 drum pieces from the drum library built into kits of eight | `src/music/orchestra.js` |
| Desk: planTracks (add or share tracks), voicedPart, play/stop/status/cleanState/abandon/load, cue events | `src/music/desk.js` |
| Offline render: OroDSP at Pristine, the app's convolution reverb (partitioned FFT with `generateImpulse`), ping-pong delay, chorus, warmth, BS.1770 loudness to -14 LUFS, look-ahead limiter at -1 dBFS | `src/music/score-render.js` |
| MIDI export (General MIDI drums), `#score=` links | `src/music/score-export.js` |
| Agent API, postMessage bridge, opt-in (`?agent=1`) | `src/agent/api.js`, wired in `src/main.js` |
| CLI and MCP server | `scripts/oro-score.mjs`, `scripts/oro-mcp.mjs` |
| Score desk panel (top bar, Score) | `src/ui/score-panel.js`, `src/ui/topbar.js` |
| Touch tool | `src/visual/visuals.js` (press kind `touch`, `visuals.touch()`), `src/music/touch.js`, `src/dsp/touch-sources.js`, `src/ui/viewport-overlay.js`; pref `touchMode` (store-backed) |
| Keep rolling | `src/visual/physics.js` (`cruisePush`), `src/ui/dot-settings.js`, `src/core/migrate.js` (kept only when set) |
| Effects 32 to 40 | `src/dsp/track-effects.js`, `src/dsp/track-fx-config.js` |
| Pitch envelope (`pitchEnv`, appended to PART_PARAMS), remap curves, Touch Link sources (37 to 40) | `src/dsp/dsp-core.js`, `src/core/params.js`, `src/visual/modstate.js` |
| 32-bit float Bounce and Record (pref `wavFormat`) | `src/audio/wav.js`, `src/audio/bounce.js`, `src/audio/recorder.js`, `src/audio/engine.js`, `src/ui/bounce.js`, `src/ui/record.js` |
| Tests | `tests/music/score-217.test.js`, `tests/agent/api.test.js`, `tests/dsp/synth-217.test.js`, `tests/music/touch.test.js`, `tests/visual/cruise.test.js`, `tests/ui/eggs-217.test.js` |

**Contracts kept:** LINK_SOURCES, LINK_CURVES, FX_TYPES and PART_PARAMS were only appended to.
With the new features off, existing sessions render the same (the new DSP paths are
skipped at 0). Two tests that pinned list lengths were updated to the append-only contract.

**How to try it**

* `node scripts/oro-score.mjs render --prompt "anime opening song in D minor" --out a.wav --bits 32`
  (about 44 s of CPU for 52 s of audio here). `compose --prompt "trap beat" --text`, `midi`, `link`, `check`.
* `printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node scripts/oro-mcp.mjs`
* In the app: Score in the top bar; Touch: Move / Strum / FX in the map toolbar; Dot: Roll, then
  the sliders button, Keep rolling. In the console: `oro.help()`, `oro.describe()`.

**Measured, not listened to.** Every voice and drum piece was rendered alone through the
real DSP (master off, no loudness change): all make sound, none are NaN, peaks sit between
about -7 and -23 dBFS. Taiko was about 10 dB hot (lowered); vinyl and city beds are quiet
by design (-42 to -47 dB loudness). A 36-bar anime-song render showed the planned form in a
spectrogram (intro, quieter verse, louder chorus, kime gaps, hotter last chorus, ring-out)
and a roughly flat spectrum per octave from 60 Hz to 4 kHz. None of this says it sounds good.

**The reference post.** The owner linked
https://x.com/ingi_erlingsson/status/2106567435826446624 ("make sure music like this is
possible"). x.com is blocked here, so it was never seen. Grok's `opening` style (cold
flash, name cards, eight hits, title) and the `orchestra-type` default suggest an anime-style
opening with a driving orchestral and rock soundtrack; `anime-song` was built on that
guess. **Ask the owner** what the post sounds like (tempo, instruments, length, vocals or
not) or for an audio file, and tune `fillAnime` in `score-styles.js` to it.

**Not verified / known gaps**

* No listening tests. The orchestral voices are factory patches with envelope, filter and
  vibrato changes; they are not modelled instruments. Voice by voice tuning by ear is the
  biggest open job (`PITCHED` in `orchestra.js`).
* The touch tool and Keep rolling were checked in Node and with a short headless drag; not
  on a phone, a touchscreen or with Rapier (Keep rolling pushes Rapier through world gravity,
  `setPush`; only the built-in integrator is under test).
* The score desk's `voicing patch` loads new lands into tracks, so the first notes wait 0.25 s
  (`PATCH_LEAD`). On a slow machine terrain generation can take longer; notes would then
  play on the old land briefly.
* `oro.render()` in a page runs the offline renderer on the main thread (it yields once per
  second of audio). Moving it into a worker would keep the page smooth.
* The desk uses up to 16 tracks while a score plays. The Mix and Seq panels show them;
  they disappear afterwards. No UI says "borrowed".
* Renders are capped at 5 minutes (memory: about 12 float arrays the length of the piece).
* The MCP server writes only under `--out-dir` (default `./oro-renders`).
* Effects 32 to 40 have unit tests for behaviour and bounds; their sound was not judged by ear.

**Next steps, in order**

1. Ask the owner about the reference post and to listen to `a.wav` renders of
   `anime-song`, `epic`, `symphonic`, `drums` (a few grooves), `ambient` and `lofi`. Fix what they hear.
2. PR [ChaseHendrick/Oro#33](https://github.com/ChaseHendrick/Oro/pull/33) is open from this
   branch. Get CI green, then squash merge only when the owner says so (a merge publishes a
   release). Mention the Mac auto-update rename issue in the notes.
   Two checks were started and stopped before they finished, to save the owner's usage: an
   adversarial code review of the 2.17 diff, and independent judges re-measuring the
   status claims in this section (every voice sounds, no clipping, the level rebalance,
   tests, perf, build, browser). Rerun them before merging.
   The README hero image (`docs/screenshots/orograph-dark.webp`) still shows the old
   OROGRAPH name; recapture it at 1440x900 in the dark theme (the machine was too loaded).
3. The user guide has section 20 for 2.17. In-app Help (`src/ui/help.js`) and the
   shortcuts list do not mention the Score desk or the Touch tool yet.
4. Website: the music page `softwareVersion`, and say `/api/oro` is not served (the skill
   already does).
5. Ideas left from the comparison with other synths: a second oscillator per voice, a
   modulation matrix view of all Links, an envelope follower of the track's own audio as a
   Link source, a slew (lag) per Link, more LFO shapes, wavetable spectral warps (Vital),
   a multiband splitter, and convolution reverb as a track effect.
