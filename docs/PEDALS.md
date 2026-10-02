# Real guitar pedals with Orograph (v1.1 design)

Design notes for running Orograph through the owner's pedalboard, mostly via an Akai MPC XL over
USB-C. Facts come from manufacturer manuals, Akai's MPC Live III / MPC XL User Guide v3.9 and the
Chromium source; anything unconfirmed is marked. Nothing here has been tested on the real hardware.

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
* **Output map:** Settings > Audio picks the device (`setSinkId`), sets the context to 44.1 kHz for the MPC, and sends main mix to outputs 1/2 and the pedal bus to outputs 3/4 (a 4+ channel destination with discrete channel interpretation). Chromium exposes up to 32 output channels; the Windows driver may expose stereo pairs instead (unverified).
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
