# Real guitar pedals with Orograph (v1.1 design)

Design notes for running Orograph through the owner's pedalboard, mostly via an Akai MPC XL over
USB-C. Facts come from manufacturer manuals, Akai's MPC Live III / MPC XL User Guide v3.9 and the
Chromium source; anything unconfirmed is marked. Nothing here has been tested on the real hardware.

## What is wired in v1.1

Status of the code on this branch. **None of it has been tested with real pedals, a real MPC XL or
a real multichannel interface.** Only unit tests (fake AudioContext, offline DSP renders, fake MIDI)
and a production build have been run; everything below needs checking on the hardware.

| Feature | Where | State |
|---|---|---|
| Pedal send per part (`pedalSend` 0..1, `pedalPre`, `pedalInsert` in `src/core/params.js`) | DSP fourth output (`src/dsp/dsp-core.js`, `worklet.js`); Mix strips | Wired. Pre-fader follows mute/solo but not the level fader. Insert mutes the dry sound and its delay/reverb sends. Both only act while the host reports the send as running (`{t:'pedal', active}`), so a part can never fall silent with nowhere to go. |
| Send limiter, about -18 dBFS by default (-30, -24, -18, -12 in Settings) | `src/audio/pedal-host.js` using `createSendLimiter` | Wired. |
| Output map: main mix on one pair, pedal send on another (default 1/2 and 3/4), discrete 4+ channel destination, device picker via `setSinkId` | `pedal-host.js` using `buildOutputRouting` / `planRouting`; Settings > Pedals | Wired. On a 2-channel device, or without `setSinkId`, the send stays off with a reason and the app plays as before. |
| Return via `getUserMedia` (echo cancellation, noise suppression, auto gain off), into the master and the delay/reverb sends, never into the send | `pedal-host.js` using `openReturn` | Wired. Return level, return to delay, return to reverb. |
| Runaway-feedback guard | `attachFeedbackGuard` on the return | Wired. Mutes the return; Settings shows why, with an Unmute button. |
| Ping (round-trip latency) | `measureRoundTrip`; Settings > Pedals > Latency | Wired. Mutes the music on the send and the return monitor while it runs; the last result is kept per computer. |
| Guitar Level Links source (index 15 in `LINK_SOURCES`) | "Mono return + guitar" layout: channel 2 feeds `createGuitarInput`; its envelope goes to the DSP as `{t:'guitar', v}` | Wired. |
| Pedal MIDI profiles (Purr-ting, Lost + Found, Nucleo, Xero) | `src/ui/pedal-rig.js` + `createPedalMidi`; Settings > Pedals | Wired: on/off per pedal, channel, conflict warnings, Effect on / Bypass (with the Purr-ting's inverted encoding), Tap tempo (4 taps at the song tempo), Program Change, and one "Follow" mapping per pedal (Macro 1-4 or Guitar Level to one control). Sent through `midi.sendRaw` to the MIDI & MPC output or a chosen port. |
| Electron | `electron/policy.cjs`, `package.json` | Audio-only `media` requests are granted to `app://orograph` (video still refused); `NSMicrophoneUsageDescription` is in the mac build. |
| Saved state | `STATE_VERSION` 2, `migrateState` | 0.1.0 sessions load with the pedal params at 0. Patches never store the pedal routing and loading one keeps the part's routing (like Mute and Solo). Rig settings are per computer in `localStorage['orograph.pedals']`. |
| Offline bounce | `engine.bounce` | Renders every part dry: Insert is ignored and there is no pedal send (the pedals are hardware). |

Not wired yet: latency compensation (scheduling Insert parts early or delaying the dry signal by the
ping result), guitar pitch tracking to notes, Capture to a wavetable terrain, pedal LFOs, scenes and
patches recalling pedal presets, and switching the context to 44.1 kHz for the MPC (the browser
resamples instead).

## The rig (from the owner's notes in ChaseHendrick/music-field-manual, checked against manuals)

| Pedal | MIDI | Notes for Orograph |
|---|---|---|
| Origin Effects Cali76 Stacked | none | audio loop only |
| DigiTech HammerOn | none | audio loop only; max input +5 dBu |
| Lichtlaerm Medusa | none | audio loop only (has its own parallel FX loop) |
| Lichtlaerm Nostalgia | none (tap footswitch) | audio loop only |
| OBNE Purr-ting (Parting firmware, assumed) | 3.5 mm TRS Type A in/out (out = thru), default ch 1 | CC 11 expression, 14 rate, 15 depth, 16 shape, 17 dissolve, 18 chance, 19 smear, 20 glitch, 21 time, 22 filter, 23 mix, 27 volume, 85 on/off (**inverted**: 0-63 on), 86 tap; PC 1-127 presets |
| Chase Bliss Lost + Found | 1/4" TRS MIDI (5-pin needs the Chase Bliss MIDIBox), default ch 2 | CC 14 L time, 15 mix, 16 R time, 17 L modify, 18 blend, 19 R modify, 20 ramp, 57 dry kill, 93 tap, 100 expression, 102/103 footswitches; PC 0 = live. EXP/CV jack accepts 0-5 V CV on a floating-ring cable (the only pedal here that documents CV) |
| Cornerstone Nucleo | 3.5 mm TRS Type A (+ MIDI over USB-C) | CC 0 bypass, CC 5 channel (full chart unverified); 128 presets |
| Walrus Xero Polylooper | 1/8" TRS Type A in/thru | CC 2/3 volume 1/2, 4/5 speed, 6/7 direction, 20 play, 21 stop, 22 record, 23 stop rec, 24 undo; follows MIDI clock; max +7.5 dBu |

Guitar: Jackson American Series Soloist SL2 DX (passive JB / '59, Floyd Rose). Amp: Boss Katana Artist Gen 3.

## MPC XL audio routing (Standalone mode)

USB-C carries 24 audio channels each way (8/8 option since MPC 3.7); install the MPC XL driver
from the inMusic Software Center if the computer does not list "MPC XL" as an audio device.

1. **Pedal send:** Audio track, Audio Input = **USB Input 3,4**, Monitor = **In**, Audio Output = **Out 3,4** → cable Out 3/4 to the board.
2. **Pedal return:** board → **Input 3/4** (Phono/Line switch on Line) → Audio track, Audio Input = Input 3,4, Monitor = In, Audio Output = **USB Out 1,2** (must be 1,2: Chrome only captures two input channels).
3. **Orograph's main mix:** Audio track, Input = USB Input 1,2 → Out 1,2, Monitor = In.
4. Set Dir/Main and the headphone Mix knob to **Main** so you do not hear dry, unaligned copies.
5. Outputs 3/4 can reach +20.4 dBu with no hardware volume, far above pedal headroom: Orograph's send bus is limited to about −18 dBFS by default.

Guitar at the same time as the return: guitar into **Inst 1** (front) → its own track → USB Out 2, and the pedal return as mono on USB Out 1 ("mono return + guitar" mode).

## Orograph features

* **Pedal send per part** (a fourth send next to Delay and Reverb), Pre/Post, and an **Insert** mode that mutes the part's dry sound so only the pedal return is heard.
* **Output map:** Settings > Pedals picks the device (`setSinkId`), would set the context to 44.1 kHz for the MPC (not wired yet), and sends main mix to outputs 1/2 and the pedal bus to outputs 3/4 (a 4+ channel destination with discrete channel interpretation). Chromium exposes up to 32 output channels; the Windows driver may expose stereo pairs instead (unverified).
* **Return:** `getUserMedia` with echo cancellation, noise suppression and auto gain all off, mixed back into the master and FX, never into the send (with a runaway-feedback mute).
* **Ping:** plays a click/chirp on the send with the music muted, cross-correlates the return, shows the round trip (expect roughly 25-70 ms) and compensates: sequenced Insert parts are scheduled earlier by that amount; Send mode can delay the dry signal instead.
* **MIDI to pedals:** pedal profiles (channel, CC map, value encodings such as the Purr-ting's inverted on/off, PC meaning) for the four MIDI pedals; Macros and LFOs can drive pedal CCs (sent on change, at most about 100 Hz per pedal); scenes and patches can recall pedal presets with Program Change. Route: Web MIDI → MPC (USB MIDI Port 1) → a MIDI track with output MPC A → TRS Type A chain (Purr-ting → Xero → Nucleo), and MPC B → MIDIBox → Lost + Found. The MPC may consume Program Change ("Program Change" preference selects Sequence/Track), so a class-compliant USB MIDI interface is the fallback.
* **Guitar as modulation:** an envelope follower on the input (attack, release, gate) becomes a Links source.
* **Guitar as notes:** monophonic pitch tracking (McLeod pitch method, 2048-sample window, 256 hop; first stable pitch about 30-60 ms after the pick), note-on on onset with hysteresis, pitch bend for bends. Track the clean DI before distortion.
* **Guitar as terrain:** Capture records a held note, finds its period and turns the evolving waveform into a wavetable terrain (attack to decay along one axis).
* **Desktop app:** allow audio-only capture for the app origin and add `NSMicrophoneUsageDescription` on macOS.

Only CV-capable pedal: Lost + Found (0-5 V). Do not drive other pedals' expression jacks with MPC CV.

## Needs hardware confirmation

Host-side MPC device and port names; whether Chrome reports more than 2 output channels for the MPC;
which input channels Chrome captures; MPC monitor latency and the real round trip; whether MIDI tracks
forward CC/PC unchanged; the full Nucleo CC chart; pitch-tracking latency on this guitar.

## Sources

Akai MPC Live III / MPC XL User Guide v3.9 and MPC 3.7 release notes; Akai MPC XL FAQ and "Understanding
the MIDI ports on your MPC"; OBNE Parting manual; Chase Bliss Lost + Found manual and MIDI manual; Walrus
Xero manual; DigiTech HammerOn manual; Cornerstone Nucleo manual (partial); Chromium
`media/audio/mac/audio_manager_mac.cc`, `media/audio/win/core_audio_util_win.cc`, issue 40403559;
de Cheveigné and Kawahara 2002 (YIN); McLeod and Wyvill 2005 (MPM); the owner's music-field-manual notes (facts only).
