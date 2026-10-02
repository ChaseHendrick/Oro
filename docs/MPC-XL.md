# Connecting an Akai MPC XL to Orograph

Reference notes behind the in-app guide (Settings > MIDI & MPC). Sources are listed at the end.
Nothing here has been validated on a physical MPC XL by the Orograph authors yet, so treat the
menu paths as guidance and use the MPC's on-screen MIDI monitor to confirm what is being sent.

## What the hardware offers

* The MPC XL (announced at NAMM, January 2026) has 16 pressure and velocity sensitive pads, 16 Q-Link
  knobs with OLED labels, a touch strip, 2 x 5-pin MIDI in, 4 x 5-pin MIDI out, 3 x USB-A host ports and
  one USB-C port for a computer.
* In **Standalone mode** the XL supports Akai's **Direct USB-MIDI**: over USB-C it appears to the computer
  as two MIDI ports in each direction (Akai: "should appear as MPC MIDI 1 & 2"; select "MPC MIDI In 1").
  On the MPC these are called **USB MIDI Port 1** and **USB MIDI Port 2**. Exact names reported by each
  OS and browser are not verified, so Orograph matches any port whose name contains "MPC".
* Akai lists its driver as required for audio interface use, Controller Mode and internal drive access.
  MIDI is not on that list, so driverless USB MIDI is likely, but not stated by Akai. If no port appears
  (especially on Windows), install the MPC XL driver from the inMusic Software Center.
* Controller Mode is a different workflow (MPC desktop software). Keep the XL in Standalone mode.

## Play Orograph from the MPC pads

1. Connect the XL's USB-C port to the computer with a data cable.
2. On the MPC: Menu > Preferences > MIDI / Sync. Enable **USB MIDI Port 1** (output side: Track on).
3. Create a **MIDI track**, set its **MIDI Output Port** to USB MIDI Port 1 and pick a channel.
4. The pads send notes from Pad Perform (Chromatic, Notes, Chords, Progressions, Custom). In a drum
   program the default note map is chromatic from C1, so pad A01 = note 36 (Akai 2.11 release notes;
   not restated for 3.x).
5. In Orograph: Settings > MIDI & MPC > Connect MIDI, enable the MPC input. Choose **Notes** (pads play
   their own pitches) or **Scale** (pads always land in Orograph's key, starting at the base note).

Alternative: **MIDI Control Mode** on the MPC lets you set, per pad, channel, note, velocity and
aftertouch, and per Q-Link, channel, CC number, Absolute/Relative mode and range, with the output port
chosen under "MIDI Control Mode Output". Use Absolute mode for Orograph.

## Twist Q-Links to control Orograph

Q-Link CC numbers are not fixed in Akai's documentation, so Orograph uses **MIDI Learn**: run the Q-Link
wizard (Settings > MIDI & MPC) and twist each Q-Link when asked, or right-click any knob > MIDI Learn.
The default wizard order puts the dot (X, Y), path size and rotation, terrain morph, warp, fold and lift,
filter cutoff and resonance on the 16 Q-Links.

## Play the MPC from Orograph

1. On the MPC: Menu > Preferences > MIDI / Sync, find **USB MIDI Port 1** under Input Ports and enable
   **Track** (Global sends incoming MIDI to whichever track is selected; turn it off for per-track routing).
2. On a plugin, keygroup or MIDI track, set **MIDI Input** to USB MIDI Port 1, a specific channel (not
   All), and Monitor to **In** (or **Merge**).
3. In Orograph: choose the MPC output and turn on **Send notes**, with one channel per part.

## Sync tempo (only one clock master)

* **Orograph leads:** turn on Send clock in Orograph; on the MPC set Sync Receive to **MIDI Clock**.
  Akai: audio recording on the MPC is disabled while it receives MIDI Clock.
* **MPC leads:** on the MPC set Send to **MIDI Clock** and tick **Sync** for the USB MIDI Port 1 output;
  in Orograph turn on **Follow MPC clock**.
* Never enable both directions at once.

## Troubleshooting

* No ports: use a data-capable USB-C cable, keep the XL in Standalone mode, close the MPC desktop
  software or any DAW that might hold the port (older Windows MIDI is single-client), install the XL
  driver if Windows still shows nothing.
* Browser: Web MIDI needs Chrome, Edge or the Orograph desktop app, and a secure page (https or local
  file). Chrome asks for MIDI permission the first time.
* Silent MPC pads in the MPC itself usually mean MIDI/Sync > Track on "MPC Pads" was unticked.
* Stuck notes: Orograph's Panic sends note-offs, then CC64 = 0, CC123 = 0 and CC120 = 0. Leave the MPC's
  "Filter 'All Notes Off' CC" disabled so it accepts them.

## Sources

* Akai, MPC Live III / MPC XL User Guide v3.9; MPC Standalone OS User Guide v3.9; MPC 3.9, 3.7 and 2.11 release notes (cdn.inmusicbrands.com).
* Akai support: MPC XL FAQ; Understanding the MIDI ports on your MPC; How to use 3rd-party VSTs with your MPC (Direct USB-MIDI); Using the MPC Key 37 as a MIDI controller.
* KVR and Gearnews MPC XL announcements (January 2026); Sound On Sound MPC XL review.
* Chrome Web MIDI permission prompt (developer.chrome.com); Windows MIDI Services (microsoft.github.io/MIDI).
* The owner's own MPC notes (ChaseHendrick/music-field-manual), facts only.
