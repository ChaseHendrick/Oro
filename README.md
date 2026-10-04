# Oro

<img src="build/icon.svg" alt="Oro icon: a contour-line mountain circled by an orbit and a glowing dot" width="128" align="right">

Oro is a synthesizer you play by exploring a landscape. You put a glowing dot
somewhere on a 3D map, the dot's orbit sweeps across the hills and valleys, and the
shape of the land under that orbit becomes the sound. Move the dot and the tone moves
with it.

It runs as a desktop app on Mac, Windows and Linux, or in a web browser (even offline,
from a single file). It plays from your computer keyboard, the on-screen keys, its own
step sequencer, or a MIDI controller such as an Akai MPC.

**[Download](#download)** · **[User guide](docs/USER-GUIDE.md)** ·
**[Play in the browser](#play-in-the-browser)** · **[Claude plugin](plugins/oro)** · **[What's new](CHANGELOG.md)**

![Oro in the dark theme: a 3D landscape with a glowing dot and its orbit, the Map panel on the right and the Sound controls below](docs/screenshots/orograph-dark.webp)

## How it makes sound

Oro uses a technique called **wave terrain synthesis**.

* **The terrain** is a height map: every point on the map has a height between a deep
  valley and a high peak. Oro has a collection of landscapes (rolling hills,
  ridges, craters, terraces, spirals and more), and you can blend two of them.
* **The path** is a closed loop, such as a circle, a star or a flower shape, drawn
  around the dot.
* **Playing a note** sends a point around that loop over and over, once per cycle of
  the sound. At the note A above middle C that is 440 laps every second. The height
  of the ground under the moving point, read tens of thousands of times per second,
  *is* the audio waveform.

So **pitch** is how fast the point goes around, and **timbre** (the character of the
sound) is the shape of the land it crosses. Gentle hills give soft, round tones; sharp
ridges and cliffs add bright, buzzy harmonics. A bigger loop crosses more of the
landscape and usually sounds brighter. Because the dot can sit anywhere and the loop
can grow, squash, rotate and spin, small moves give smooth, continuous changes in tone,
something like moving through a wavetable but in two dimensions instead of one.

The idea comes from computer music research of the late 1970s and early 1980s (Rich
Gold; Yasuhiro Mitsuhashi; Alberto Borgonovo and Goffredo Haus). Oro adds a 3D
view you can play directly, and a modern synthesizer around it. The
[user guide](docs/USER-GUIDE.md#1-what-wave-terrain-synthesis-is) has the maths in a
few lines.

## A quick tour

* **Nineteen mathematical terrains and 320 original images.** Browse the built-in
  image library or import your own image, 16-bit elevation map, wavetable or complete
  audio recording. Image imports retain red, green, blue and brightness for live channel
  morphing. Cartesian and polar mapping work at 512 by 512 resolution.
* **Twenty paths.** Line, Square and Raster join Ellipse, Lissajous, Rose and the other
  curves. Window, Mangle and axis mirroring reshape the path; Laps and Pace retain
  hard-sync sweeps and phase distortion.
* **A dot with a mind of its own.** Pin it, let it **Roll** downhill as a marble you can
  flick, **Drift**, **Explore** the land playing in-key notes at peaks and valleys, or
  **Tour** through waypoints in time with the music. A minimap and keyboard control make
  precise placement easy.
* **Sound shaping.** Up to eight unison copies, two sub oscillators with seven waves
  each, four noise colours, synthesized vinyl/waves/city loops and imported recordings,
  eleven morphable partial profiles, phase modulation, ring modulation and a tuned
  Karplus-Strong pluck. Three ladder colours, SEM and diode-inspired digital filters
  join the state-variable, comb and vowel filters.
* **Modulation everywhere.** Forty targets each have an LFO, an independent six-stage
  envelope and four controller slots. LFO timing, skew, offset, finite loop counts and
  a drawable 32-step shape with glide and smoothing support detailed movement. Links
  and four global Macros provide additional routing.
* **Music.** Up to sixteen tracks, a 16-step sequencer per track that stores scale degrees so it
  follows the key, accents, slides, **dot locks** that move the dot per step, an
  arpeggiator with 40 scales and 28 rhythm patterns, swing, and a one-key **preview** phrase for every patch.
* **Patches and scenes.** More than fifty factory patches in ten categories, seven
  factory scenes, searchable categories, authors and folders, 36 MIDI Program Change
  favourites, your own patches and scenes, random patches, and JSON export and import.
* **Mix and record.** A four-slot effects rack on each track with 27 effects and ten
  routing layouts, plus vector mixing for banks of four tracks. Shimmer, granular pitch
  shifting, EQ and multiband compression join the master effects and limiter with an
  adjustable ceiling. Record what you play to a 24-bit WAV, or **bounce** the sequencers
  offline, with optional stems per part.
* **3D sound and listening modes (2.12).** Place any track around your head for
  headphones (by hand, or let it follow the dot on the map), export a 5.1 or 7.1 surround
  file with the stems, and check your mix with a headphone crossfeed, a mono check, a rough
  small-speaker preview or swapped channels without changing what gets exported. The 3D
  model is generic, so it works better for some listeners than others.
* **Looper and resampling.** A tempo-locked looper with overdub, undo and WAV export, and
  **Resample**, which turns the loop (or a few bars of the output) into a new wavetable
  terrain you can play, loop and resample again.
* **Guitar chords (1.5, experimental).** Single-note tracking with bends or
  several notes at once from a clean guitar input. Chords respond more slowly and
  can miss octave-doubled strings. Tested with generated signals, not real hardware.
* **Sampler (2.14).** One sample per track. The microphone is mono. A file, the loop
  or the output can be stereo. Play it from the keyboard (chromatic, one-shot, held,
  slices or granular). Slice marks can be dragged, and the sequencer can pick a slice
  per step. The drum kit and the sampler turn each other off.
* **Looper tape (2.14).** One Speed slider: normal in the middle, faster to the right,
  backward to the left, with pitch following the speed. Drag the waveform to scrub.
  Normal forward playback is unchanged.
* **Vocoder (2.14).** A track effect. The microphone or another track shapes this one.
* **Piano roll (2.15).** Extra notes between the 16 steps, plus one automation lane. The grid stays. A step lock still wins on its step. Shift moves the lane with the steps. Clear removes it.
* **Jam (2.15).** A direct connection for chat and the notes you play, with up to five friends. Notes wait on a shared clock. Voice is optional and stays out of the recording. The invite contains a network address.
* **Learn (2.15).** Eleven short lessons, opened from Help. Your session is put back when you leave.
* **Match a sound (2.15).** Compares a file with one cycle of each land and path. Experimental, and not a copy of the sound.
* **Link and plugin (2.15).** Desktop Link switches are visible, but the GPL Link library is not included. `?plugin=1` exposes a host parameter list. There is no VST, AU or CLAP file.
* **Tuner (2.13).** Settings > Voice, and Tune on the Sampler card, show the note and cents from the
  microphone. It only listens, and it follows the reference pitch.
* **Voice input (1.4).** Sing into any microphone, a laptop's own included:
  hear it with the synth, loop and resample vocals, play a part by singing or humming,
  capture a sung note as a terrain, and let your voice move the terrain through Links.
* **MIDI and the Akai MPC XL.** Omni or one channel per part, MPC pad scale mode, a
  Q-Link learn wizard, MIDI Learn on sound and master knobs, clock in or out, MPE, and a step by step
  MPC guide inside the app.
* **Desktop updates.** Optional release checks and background downloads on Windows
  installer/Linux AppImage builds, followed by your choice to restart and install.
  Macs offer release notices by default, and from 2.11 an opt-in **Install updates
  automatically** that downloads the release, checks its checksum and replaces the app
  when you quit (new in 2.11, not yet tested on every macOS version). Portable/archive
  copies offer release notices and manual downloads. Older copies need one manual
  upgrade to gain the updater.
* **Live mode (2.12).** A full-screen stage view: 16 big pads that switch scenes and
  patterns on the next bar or beat, mute and solo tracks, hit drums, play chords or recall
  macro and smart control presets; a setlist with Now and Next, notes and cues; large
  faders, tap tempo and Panic; a lock that ignores stray taps; keyboard and MIDI mapping.
* **Dark and light themes**, 24 palettes, six cameras and six render styles, saved
  camera views, keyboard shortcuts for the main actions, and a layout that
  works on a phone.

## Download

Get the newest version from the
**[Releases page](https://github.com/ChaseHendrick/Oro/releases/latest)**,
or use these direct links:

| Your computer | Download |
|---|---|
| Mac with Apple silicon (M1 or newer) | [Oro-mac-arm64.dmg](https://github.com/ChaseHendrick/Oro/releases/latest/download/Oro-mac-arm64.dmg) |
| Mac with an Intel processor | [Oro-mac-x64.dmg](https://github.com/ChaseHendrick/Oro/releases/latest/download/Oro-mac-x64.dmg) |
| Windows 10 or 11, installer | [Oro-windows-setup.exe](https://github.com/ChaseHendrick/Oro/releases/latest/download/Oro-windows-setup.exe) |
| Windows, no installation needed | [Oro-windows-portable.exe](https://github.com/ChaseHendrick/Oro/releases/latest/download/Oro-windows-portable.exe) |
| Linux (64-bit PC) | [Oro-linux-x86_64.AppImage](https://github.com/ChaseHendrick/Oro/releases/latest/download/Oro-linux-x86_64.AppImage) |
| Any computer, in Chrome or Edge | [Oro.html](https://github.com/ChaseHendrick/Oro/releases/latest/download/Oro.html) (see [Play in the browser](#play-in-the-browser)) |

Releases are built and published automatically by GitHub Actions from the `main`
branch. Open the Releases page for the current assets and build status. You can also
[build it yourself](#build-it-yourself).

Not sure which Mac you have? Open the Apple menu and choose **About This Mac**. If it
says **Chip: Apple M1** (or M2, M3 and so on), take the Apple silicon version. If it says
**Processor: Intel**, take the Intel one.

Oro is free and is not signed with a paid Apple or Microsoft developer
certificate, so your computer will ask you to confirm the first time you open it. This
is normal for small independent apps. Here is what to do.

### Mac: the first launch

1. Open the `.dmg` file and drag **Oro** onto the **Applications** folder.
2. Open Oro from Applications. macOS will say it cannot verify the app. Click
   **Done** (not "Move to Trash").
3. Open **System Settings**, go to **Privacy & Security**, and scroll down to the
   Security section. You will see a note that Oro was blocked. Click
   **Open Anyway**, enter your password, then click **Open Anyway** once more.

From then on Oro opens normally. You may need to repeat step 3 after installing
a new version.

**Updates on a Mac.** By default Oro shows a notice when a new release is out, and you
download and replace the app yourself. From 2.11 you can instead turn on
**Settings > Updates > Install updates automatically** (off by default). Oro then
downloads the new version in the background, checks it against the checksum published
with the release, and replaces the app when you quit (or when you choose **Restart now**),
keeping the old one if anything goes wrong. Oro must be in your Applications folder for
this. It is new in 2.11 and not yet tested on every macOS version.

On macOS 14 Sonoma or older there is a shortcut: in Applications, hold **Control** and
click Oro, choose **Open**, then click **Open** again.

If macOS ever says **"Oro is damaged and can't be opened"**, the app is fine; macOS
is being strict about unsigned downloads. Open the **Terminal** app and paste this line,
then press Return:

```sh
xattr -dr com.apple.quarantine /Applications/Oro.app
```

That removes the "downloaded from the internet" flag from Oro only.

### Windows: the first launch

When you run the installer (or the portable version), Windows may show a blue box
titled **"Windows protected your PC"**. Click **More info**, then **Run anyway**.

The installer lets you choose where Oro goes and adds it to the Start menu and
the desktop. The portable version needs no installation: keep the `.exe` anywhere,
for example on a USB stick, and double-click it to play. It starts a little slower
because it unpacks itself each time.

### Linux: the first launch

The AppImage is a single file that runs without installing. Make it executable once,
then start it:

```sh
chmod +x Oro-linux-x86_64.AppImage
./Oro-linux-x86_64.AppImage
```

You can also right-click the file, open **Properties**, and turn on **Allow executing
file as program**. If nothing happens, your system may need FUSE 2 (on Ubuntu 22.04:
`sudo apt install libfuse2`; on Ubuntu 24.04 and newer: `sudo apt install libfuse2t64`).
If it still closes right away on Ubuntu 24.04 or newer, start it from a terminal with
`./Oro-linux-x86_64.AppImage --no-sandbox`. A plain `.tar.gz` folder version is on
the Releases page too.

## Play in the browser

No installation at all:

* **Online:** <https://www.hendrickresearch.com/music/oro/> (this page goes live
  when the matching update to the Hendrick Research website is merged).
* **Offline:** download **Oro.html** from the
  [Releases page](https://github.com/ChaseHendrick/Oro/releases/latest) and
  double-click it. The whole synthesizer is inside that one file, so it works on a
  plane, in a practice room, or anywhere without internet.
* **On your own website:** each release also has **Oro-web.zip**, the normal web
  build. It works from any folder of a site, for example `/music/oro/`.

Use a recent **Chrome** or **Edge** for the best results, especially for MIDI. Other
browsers can play sound, but some cannot talk to MIDI devices. The first time you
connect a MIDI device the browser asks for permission; click **Allow**.

## Quick start

1. **Open Oro.** If you see a Start button, click it to switch the sound on
   (browsers need one click before any web page may make noise).
2. **Place the dot.** Click anywhere on the 3D map, or drag the dot. Its orbit is the
   bright loop around it. Drag empty space to turn the view, and scroll to zoom.
3. **Twist knobs.** Try **Size** (how big the orbit is: bigger is brighter), **Morph**
   (blend from one landscape to the other), **Warp** (makes the land itself ripple) and
   **Fold** (adds sparkle).
4. **Play keys.** Use the on-screen keyboard, your computer keyboard, or a MIDI
   controller.
5. **Press Play.** The step sequencer plays a pattern so you can keep both hands on the
   knobs. Change the landscape, the path shape and the dot's behaviour (pinned, rolling
   like a marble, or drifting) and listen to how the sound follows.

Your last session is saved automatically, so Oro opens where you left off.

The **[user guide](docs/USER-GUIDE.md)** goes through every control: the map and the
dot, all the terrains and paths, the sound and modulation, the sequencer and dot locks,
mixing, recording, settings and MIDI.

## Connect an Akai MPC (or any MIDI controller)

Oro works with class-compliant USB MIDI devices, including Akai MPCs in
Standalone mode.

1. Connect the MPC's **USB-C** port to your computer with a USB cable that carries
   data (some charging-only cables do not).
2. In Oro, open **Settings**, go to **MIDI & MPC**, press **Connect MIDI**, and
   make sure the MPC input is on (its name contains "MPC").
3. On the MPC, set a MIDI track's output to the USB MIDI port and play the pads.

The in-app guide (Settings, MIDI & MPC) walks through the MPC menus step by step,
including Q-Link knobs (with MIDI Learn), sending notes from Oro back to the MPC,
and keeping tempo in sync. If no MIDI device shows up, close other music software that
might be using the port, try another cable, and on Windows install the MPC driver from
Akai's software center.

MIDI works in the desktop app and in Chrome or Edge.

The full MPC XL notes, with sources, are in [docs/MPC-XL.md](docs/MPC-XL.md). None of
the MPC steps have been tried on a physical MPC XL yet, so treat the menu names as
guidance.

## Guitar pedals (1.1, untested on hardware)

Version 1.1 adds a pedal send per part, an output map for four-channel devices such as the
MPC XL, a pedal return with a feedback guard, a latency ping, MIDI profiles for four
pedals and a Guitar Level modulation source (**Settings > Pedals**). It follows the
manuals but has not been tried with real pedals or a real MPC XL yet. Details are in the
[user guide](docs/USER-GUIDE.md#15-guitar-pedals) and [docs/PEDALS.md](docs/PEDALS.md).

## Keyboard shortcuts

Press **?** in the app to see every shortcut. They are also listed in the
[user guide](docs/USER-GUIDE.md#16-keyboard-shortcuts).

## Build it yourself

You only need this if you want to change Oro. Install
[Node.js](https://nodejs.org) version 22 or newer, download this project, then run
these commands in a terminal inside the project folder:

| Command | What it does |
|---|---|
| `npm ci` | Installs the exact tools and libraries the project uses (run once). |
| `npm run dev` | Starts Oro at http://127.0.0.1:5173 and reloads as you edit. |
| `npm test` | Runs the automated tests. |
| `npm run build` | Builds the web app into `dist/`. |
| `npm run build:single` | Builds the one-file offline version into `dist-single/index.html`. |
| `npm run electron` | Builds, then opens the desktop app from the source code. |
| `npm run dist` | Builds the desktop app for your computer into `release/`. |
| `npm run dist:mac`, `dist:win`, `dist:linux` | Builds the desktop app for one system. Each is best run on that system. |

Every change pushed to the `main` branch is built automatically for Mac, Windows and
Linux by GitHub Actions and published on the
[Releases page](https://github.com/ChaseHendrick/Oro/releases/latest).

## Project layout

| Folder | Contents |
|---|---|
| `src/core/` | Parameters, the shared state store, loading of saved sessions |
| `src/dsp/` | The sound engine: terrains, paths and the synthesizer voice |
| `src/audio/` | Audio setup, effects, recording, importing images and WAV files |
| `src/visual/` | The 3D landscape, the orbit and the dot (three.js, Rapier physics) |
| `src/ui/`, `src/styles/` | Knobs, panels, keyboard, sequencer grid, themes |
| `src/music/`, `src/midi/`, `src/presets/` | Sequencer, arpeggiator, MIDI, factory sounds |
| `electron/` | The desktop app shell |
| `public/`, `build/` | Icons and the web app manifest |
| `tests/` | Automated tests |
| `docs/` | The user guide, architecture notes, the research brief, MPC and pedal notes, screenshots |
| `dev/` | Developer test pages and tools (icon and notice generators) |

## Documentation

| Document | What it covers |
|---|---|
| [User guide](docs/USER-GUIDE.md) | How to play Oro, every control explained, troubleshooting |
| [Changelog](CHANGELOG.md) | What is in each version |
| [Akai MPC XL](docs/MPC-XL.md) | Connecting and syncing an MPC XL, with sources |
| [Guitar pedals](docs/PEDALS.md) | The design of version 1.1's pedalboard integration and what is wired |
| [Research brief](docs/RESEARCH.md) | Wave terrain synthesis: history, maths, prior art and the build stack |
| [Architecture](docs/ARCHITECTURE.md) | How the code fits together, for developers |

## Independent work

Oro is an independent, clean-room implementation of wave terrain synthesis,
written from first principles and published mathematics. No code, graphics, sounds
or presets from any other product were used. It was inspired by the idea behind the
Conductive Labs Terrain Synth. Terrain Synth is a trademark of Conductive Labs.
Oro is not affiliated with, endorsed by, or connected to Conductive Labs.

## License

Oro is free and open source under the [MIT License](LICENSE). The libraries it
includes, and their licenses, are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<!--
Twice to the peaks, twice to the valleys,
then wander west and east, and west and east again.
Sign with the second letter, then the first,
and the cabinet opens on the map.
-->

## Credits

Made by Chase ([Hendrick Research](https://www.hendrickresearch.com)), written with
the help of Claude Code. 3D graphics by [three.js](https://threejs.org), marble physics
by [Rapier](https://rapier.rs), desktop app by [Electron](https://www.electronjs.org).
