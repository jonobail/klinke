# KLINKE roadmap

KLINKE is a pixel-art patchbay studio: drag gear onto the floor, patch it together with cables,
and record what it plays onto a timeline. Design reference: the *KLINKE Pixel Patchbay Studio*
mockup (synth → overdrive → reverb → delay → 4ch mixer → MAIN • REC, 16-bar timeline).

Tick boxes as items land. Milestones are in build order: each one builds on the one before.
Pure logic goes in `src/app/core/` with `node --test` coverage in `tests/`.

**Status:** M0, M2, the MS-20, the Model D, the MF-104, the 12 rack effects and the SP-1200 done, M1 mostly done. Next up: **M3 Record & arrange**.

---

## M0 Foundation ✅

- [x] Angular 22 app (standalone, zoneless, signals), SCSS, prettier
- [x] Pixel theme: colour tokens, Silkscreen + VT323 fonts, dark UI
- [x] Gear catalog with sizes, jacks and params (`core/gear.ts`)
- [x] Patch model: add / move / remove gear, connect / disconnect, one cable per jack, direction and
      feedback-loop checks, signal order, JSON parse with validation (`core/patch.ts`, tested)
- [x] Transport maths: `bar.beat.sixteenth` counter, tempo, song loop (`core/transport.ts`, tested)

## M1 Patch floor (UI) 🟡

- [x] Top bar: logo, FILE / EDIT / PATCH / VIEW menus, transport, position counter, BPM entry, SAVE
- [x] Inventory shelf with ALL / SYNTH / PEDAL / MIXER filters and live gear previews
- [x] Drag gear from the shelf onto the floor, or click a tile to drop it in the first free space
- [x] Drag gear around the floor, snapping to the grid; select it and press Delete (or ×) to remove it
- [x] Click two jacks to patch a cable, with a live dashed cable while patching; click a cable to unplug it
- [x] Hanging-cable rendering; error messages for bad patches
- [x] Working knobs and faders (drag, wheel, arrow keys) and pedal footswitch bypass
- [x] Zoom ×1–×5; the grid extends past the floor
- [x] Timeline: 16-bar ruler (click to seek), playhead, tracks with R / M / S, add track, record regions
- [x] Save to localStorage (Ctrl+S), export / import the patch as JSON, demo rig and empty patch
- [x] Unbounded floor: gear anywhere right / below, the floor grows with it, auto-scroll while
      dragging near an edge, click-to-add always finds room and scrolls the new gear into view
- [x] Hover info: rest the mouse on gear (floor or shelf) for about a second for its name, what it
      is and what it's for (`core/descriptions.ts`)
- [x] The first press of AUDIO, before sound has started, no longer mutes it straight away
- [x] iOS (Safari, Edge, Chrome — all WebKit): audio unlocks on the end of a tap, plays through
      the silent switch (playback audio session / silent media loop), resumes after interruptions;
      the AUDIO button pulses while sound is blocked. Checked in iPhone emulation, not yet on a
      real device
- [ ] Cables are drawn over gear, so a cable crossing a panel can block clicks on the controls
      beneath it (route cables under gear or fade them while pointing at a panel)
- [ ] Hover info on touch screens (long-press is taken by drag / play today)
- [ ] Drag a plugged cable end to move it to another jack
- [ ] Unplug a cable from the keyboard (jack buttons already patch with Enter)
- [ ] Undo / redo for patch edits
- [ ] Stop gear overlapping when it's dropped or dragged (nudge to the nearest free spot)
- [x] Touch / tablet: fit-all zoom on small screens, pinch-zoom and two-finger pan, double-tap
      gear to zoom to it (empty floor to fit), one-finger knob / fader turning, multi-touch keys
      and pads (checked in emulation: iPhone 13, Pixel 7, iPad; not yet on a real device)

## M2 Sound ✅

The patch is the audio graph: every box is a Web Audio unit (`audio/units.ts`) and every cable a
node connection. `AudioEngine` (`audio/audio-engine.ts`) diffs the patch, so moving a knob only
touches that box's params. The maths lives in `core/sound.ts` (tested).

- [x] `AudioEngine` service: an AudioContext started by the first click or key press; AUDIO button
      mutes it (and stays muted until pressed again)
- [x] Patch → node graph sync (gear added / removed, cables changed, params changed)
- [x] ~~MS-1 synth~~, replaced by the MS-20 (see below)
- [x] Play the synth from its on-screen keys (click or slide), the computer keyboard (A–; with
      W E T Y U O P as the black keys, Z / X to change octave), or a **Web MIDI** controller
- [x] The computer keyboard and MIDI play one synth: the selected one, else the last one selected
      or played (marked ⌨ KEYS on its panel)
- [x] Overdrive (oversampled soft clip + tone + level), Delay (filtered feedback loop),
      Reverb (generated stereo impulse, size / damp), Filter (resonant low-pass + mix)
- [x] Footswitch true bypass with a short crossfade, so switching doesn't click
- [x] 4CH mixer: per-channel gain and pan, main level and balance; MAIN • REC volume
- [x] Safety limiter on the main output
- [x] Live meters on the mixer strips and MAIN • REC
- [x] Unpatched gear is silent: you only hear what's cabled through to MAIN • REC
- [ ] Web MIDI needs HTTPS or localhost; over the tailnet that means `tailscale serve`
- [x] MIDI pitch bend (MS-20 ±2 semitones, Model D ±5) and mod wheel (CC 1, Model D)
- [ ] Sustain pedal (CC 64)
- [ ] Tempo-synced delay times

## M2b MS-20 ✅

Replaces the MS-1. Built from the *MS-20 Service Manual* (10 pp: specifications p.2,
block diagram p.9). Maths in `core/ms20.ts` (tested), voice in `audio/ms20-unit.ts`.

- [x] Front panel: VCO 1, VCO 2, VCO MASTER, MIXER, HIGH PASS, LOW PASS, MG, EG 1, EG 2, VCA (31
      controls); 4-position selector knobs click between positions; centre-detented intensity knobs
- [x] VCO1: triangle / sawtooth / PW pulse (1:1 → 1:∞) / white noise; scale 32' 16' 8' 4'
- [x] VCO2: sawtooth / square / narrow pulse / ring modulator (VCO1 × VCO2); scale 16' 8' 4' 2';
      PITCH ±1 octave
- [x] Master tune ±100 cents, portamento, frequency modulation by MG (±) and EG1 (+)
- [x] VCHPF → VCLPF in series, 50 Hz–15 kHz, PEAK from flat to near self-oscillation (with a soft
      saturator after the filters), each with MG (±) and EG2 (±) cutoff modulation
- [x] MG: falling ramp ↔ triangle ↔ rising ramp, 0.1–20 Hz
- [x] EG1 (delay / attack / release, up to 10 s) on pitch; EG2 (hold up to 20 s / attack / decay /
      sustain / release) on the filters and the VCA
- [x] Monophonic, last-note priority, single trigger (legato doesn't re-attack); oscillators run
      free and the VCA gates them, as on the hardware
- [x] 37-key keyboard (3 octaves, C–C)
- [x] EXT SIG IN jack feeds external audio into the filters (patch a pedal or another MS-20 in)
- [x] Saved patches with the old MS-1 load with an MS-20 in its place
- [ ] Control-voltage patching: the MS-20's patch panel (KBD CV / TRIG out, EG1 / EG2 REV out,
      MG triangle / rectangle out, VCO / HPF / LPF CV in, initial gain, total ext), needs a CV
      cable type on the floor
- [ ] Noise generator (pink / white outs), sample & hold, modulation VCA, control wheel and
      momentary switch
- [ ] External signal processor (band-pass, F-V converter, envelope follower, trigger out)
- [ ] Real low-note-priority keyboard option; a closer model of the MS-20's two filter designs
      (AudioWorklet)

## M2c Model D ✅

Built from the *Minimoog Model D Service Manual* (46 pp, scanned): front-panel control diagram
(fig. 7-1, p.7-1), block diagram (dwg. 1429) and left-hand controller schematic (fig. 9-12). The
manual is a repair guide, so ranges it doesn't print use the instrument's published figures
(contour times 1 ms–10 s attack / 4 ms–35 s decay; oscillator 2 / 3 FREQUENCY ±7 semitones).
Maths in `core/modeld.ts` (tested), voice in `audio/modeld-unit.ts`.

- [x] Front panel in the manual's five sections: CONTROLLERS, OSCILLATOR BANK, MIXER, MODIFIERS
      (filter + loudness contour), OUTPUT; orange / blue / white rocker switches as on fig. 7-1
- [x] Three oscillators: RANGE LO, 32'–2'; six waveforms each (osc 3 has reverse sawtooth for
      LFO use); FREQUENCY on 2 and 3; master TUNE
- [x] OSC 3 CONTROL off: oscillator 3 stops following the keyboard (a free-running LFO)
- [x] Mixer: osc 1–3, EXTERNAL INPUT (the `in` jack) and NOISE (white / pink) with ON switches,
      and an OVERLOAD lamp; hotter mixer levels drive the saturator in front of the filter
- [x] Filter: 24 dB low-pass (two cascaded 12 dB stages), CUTOFF, EMPHASIS, AMOUNT OF CONTOUR,
      KEYBOARD CONTROL 1 (1/3) and 2 (2/3), filter contour attack / decay / sustain
- [x] Loudness contour attack / decay / sustain
- [x] MODULATION MIX (osc 3 ↔ noise) through the MOD wheel to the oscillators (OSC MOD) and the
      filter (FILTER MOD)
- [x] Left-hand controller: PITCH wheel (springs back), MOD wheel, GLIDE and DECAY switches (DECAY
      off cuts the release short)
- [x] A-440 reference tone; MAIN output switch and VOLUME
- [x] 44-key keyboard (F–C, 3½ octaves), monophonic with low-note priority, single trigger
- [ ] A true transistor-ladder filter (AudioWorklet) that self-oscillates at full EMPHASIS
- [ ] Oscillator drift / warm-up, and the oscillators' real waveshapes rather than ideal ones
- [ ] Headphone output and its separate VOLUME (R21)

## M2d MF-104 analog delay ✅

Built from the *MF-104 schematics* (BRD-10-011-360 rev E sheets 1–2, daughterboard -365, plus the
spillover-mod notes and the SD / Z part-value sheet in the same PDF). Maths in `core/mf104.ts`
(tested), audio in `audio/mf104-unit.ts`.

- [x] DRIVE preamp (P1) with soft clipping and a red / green level LED (LED1, LB1405 driver)
- [x] Delay line as on the Z board (2 × MN3005, 8192 stages), TIME (P4) with the BBD's pitch slide
      when the time moves; anti-alias and reconstruction low-passes at the corners the part values
      give (≈2.7 kHz short, ≈1.3 kHz long)
- [x] RANGE switch (SW2): doubles the delay (second clock timing cap) and swaps the filter set
- [x] FEEDBACK (P3) past unity into runaway, held by a unity-gain soft clip in the loop; LOOP LED
- [x] INT / EXT LOOP switch (SW1), LOOP OUT and LOOP IN jacks and LOOP GAIN (P2): patch another
      pedal into the repeats (the patch floor allows this loop, since it goes round a delay line)
- [x] MIX (P5) equal-power crossfade, OUTPUT level, bypass footswitch with red / green status LED
- [ ] Delay end points are our interpretation (40–400 ms short, 80–800 ms long); the schematics
      don't print them
- [ ] SA572 compander and BBD clock noise / aliasing character (left out: a DelayNode is clean)
- [ ] Expression-pedal CV inputs for TIME, FEEDBACK and MIX (J2–J4), needs CV patching
- [ ] Spillover mod as an option (repeats ring on after bypass); the SD's longer daughterboard line

## M2e Rack effects ✅

Twelve 19" rack effects, each built from its service manual / schematics by its own module pair
(`core/devices/<name>.ts` + `audio/devices/<name>-unit.ts`) on the shared `rack()` catalog helper,
`RackUnit` base and generic rack panel (display, BYPASS, sections). How to add one:
`docs/DEVICES.md`. Per-device sources, what's modelled and what's interpretation:
`docs/devices/<name>.md`. `tests/devices.test.ts` checks every device against the contract.

| Device | What | Built |
|---|---|---|
| H949 | Harmonizer | 8 pitch functions (two-tap crossfading shifter), delay switches, feedback EQ, REPEAT freeze, DLY ONLY second output |
| DELTA-T | Digital delay | Three taps on the 3 ms grid, gain-ranged 12-bit converter, crystal / VCO clock modes |
| E1010 | Analog (BBD) delay | Five ranges 10–300 ms from the clock and stage counts, 13 kHz filters, bass / treble, triangle modulation |
| MODEL 200 | Digital reverb | Six programs × variations, predelay, RT, size, pre-echo, diffusion, RT low / high, rolloff |
| DPS-R7 | Digital reverb | HLR / RMR / PLR / GTR / ERF algorithms with the manual's parameter ranges |
| REV5 | Digital reverb | Seven direct-recall programs, three-band EQ on the reverb path |
| PCM-70 | Multi-effects | 14 programs: reverbs, delays / chorus (numbers and names from a field bulletin), resonant chords |
| PCM-80 | Multi-effects | 8 algorithms with an ADJUST soft knob and TEMPO / NOTE |
| DPS-D7 | Digital delay | All 7 delay algorithms, loop EQ, auto pan |
| DPS-M7 | Modulation | 20 modulation algorithms, a pre-effect, envelope-controlled effect level |
| DPS-V55 | Multi-effects | Two blocks (parallel / serial), 40 of the 45 effect types from the Effect Parameter Guide |
| DPS-V77 | Multi-effects | Two EQ + effect blocks, four structures, mixer |

Open items:
- [ ] Interpretation to check against owner's manuals (the service documents lacked program lists
      or parameter tables): PCM-70 ranges and placeholder program numbers, PCM-80 algorithm list,
      REV5 / MODEL 200 / DPS-R7 program names and ranges, DPS-V77 effect list (borrowed from the
      V55). The DELTA-T REGEN / MIX and H949 MIX controls are additions.
- [ ] Reverb tails beyond the 8 s impulse cap: a feedback-delay-network tail (MODEL 200, DPS-R7,
      REV5, PCM reverbs), and impulse generation off the main thread (the longest take ~75 ms)
- [ ] Shared: a value readout for every knob (devices supply the text), a momentary button (TAP
      tempo, PCM-80 / DPS-D7 / V55), song tempo available to tempo-based programs
- [ ] Program / preset libraries and register store / recall (MODEL 200, PCM-70 / 80, DPS-*, REV5)
- [ ] H949 keyboard / CV pitch input and LED meter; DELTA-T separate OUT 1–3 jacks and stepped
      gain ranging with its LEDs; E1010 compander breathing, clock noise and FOOT SW
- [ ] DPS-D7 mid EQ band and auto-pan triggers; DPS-M7 second pre-effect, post-effect, envelope
      generators, S&H LFO; DPS-V55 the five unbuilt effects (vocoder, Doppler, pitch roller,
      vocal canceller, freeze); DPS-V77 its own Effect Parameter Guide and per-channel mixer

## M2h SH-101 ✅

From the 1982 service notes; details in `docs/devices/sh101.md`.

- [x] VCO saw + comparator pulse with PWM (LFO / MAN / ENV), sub-oscillator (3 modes), noise
- [x] 4-pole VCF with ENV / MOD / KYBD, VCA ENV or GATE, ADSR with GATE+TRIG / GATE / LFO trigger
- [x] Modulator triangle / square / random / noise, 0.1–30 Hz; portamento OFF / ON / AUTO;
      transpose; bender to VCO / VCF
- [x] Arpeggiator and 100-step sequencer (with rests, transpose by key) clocked by the LFO; HOLD
- [ ] LFO MOD grip, EXT CLK and CV / GATE jacks; sync the clock to the song tempo

## M2f SP-1200 sampler ✅

Sampling drum machine from the owner's manual and the EMU-SP1200 hardware notes; details in
`docs/devices/sp1200.md`. Plus a MULT (one in, three out) so a source can feed SAMPLE IN as well
as its usual chain.

- [x] 32 sounds in four banks, 10 s of 26.04 kHz / 12-bit memory in four 2.5 s zones
- [x] Sampling from SAMPLE IN: preamp +00/+20/+40 dB, GAIN, VU on the display, threshold ARM or
      FORCE, LENGTH 0.1–2.5 s, STOP, "Sample is good" / "Sample Overload"
- [x] Pitch by skipping / repeating samples (± a fifth), decay mode, START / END / LOOP, TRIM, ERASE
- [x] Output channels with dynamic (1–2), fixed (3–6) and no (7–8) filtering, channel ripoff
- [x] Pads from the panel, computer keyboard and MIDI; MIX / TUNE-DECAY sliders
- [ ] Sequencer: segments, songs, swing, auto-correct
- [ ] Multipitch / multilevel, dynamic buttons, stored mixes, copy / swap, dynamic allocation
- [ ] Individual channel output jacks; saving sounds (IndexedDB, WAV import / export)
- [ ] Sampling through an AudioWorklet (ScriptProcessorNode is deprecated)
- [ ] Split the gear panels (gear-view) into one component per instrument; its stylesheet is
      now 9 kB

## M3 Record & arrange

MIDI tracks (done): a per-track AUD / MIDI switch; MIDI tracks play an instrument on the floor
(`sequencer.ts` plays them, timer-dispatched every 5 ms) and record what you play on it while
armed and REC is on, snapping to a per-track grid (OFF, 1/4, 1/8, 1/16, 1/32). A piano-roll drawer
(`piano-roll/`) edits them: add, move, resize, delete. Notes and tracks save with SAVE
(`klinke.song.v1`). Note maths in `core/notes.ts` (tested).

- [x] MIDI tracks: instrument, live record (quantised), playback with mute / solo, piano roll
- [ ] Sample-accurate MIDI playback (schedule on the audio clock instead of a 5 ms timer)
- [ ] Velocity: record it from MIDI and play it into instruments that respond to it
- [ ] Piano roll: box-select, copy / paste, velocity lane, zoom; replace (not only overdub) recording
- [ ] Songs in FILE export / import (today only the patch is exported)

- [ ] Choose each track's source (MAIN = mix bus, other tracks = any OUT jack)
- [ ] Capture audio on armed tracks while REC is on (AudioWorklet → PCM buffers)
- [ ] Real waveforms in take regions; play takes back in sync with the transport
- [ ] Mute / solo affect playback; MAIN bus records the whole mix
- [ ] Metronome and count-in
- [ ] Select, move, trim and delete takes; loop region on the ruler
- [ ] **EXPORT MIX**: offline render (OfflineAudioContext) → WAV download

## M4 Sequencing

- [ ] Note recording from the keyboard onto a track as MIDI-style events
- [ ] Piano roll / step editor for synth parts
- [ ] Quantize and swing
- [ ] MIDI clock in / out

## M5 Projects & persistence

- [ ] Projects in IndexedDB: patch, tracks, takes (audio blobs), tempo
- [ ] Project list: new / open / rename / duplicate / delete; autosave
- [ ] `.klinke` bundle export / import (patch + audio)
- [ ] Undo history that covers the timeline as well as the patch

## M6 More gear & polish

- [ ] More gear: drum machine, sampler, LFO / modulation (CV-style patching to params), chorus,
      compressor, splitter / mult
- [ ] Gear right-click menu: duplicate, reset to defaults, rename tag
- [ ] Accessibility pass: full keyboard patching, screen-reader names for cables
- [x] Responsive layout for small screens (☰ menu, compact bars, GEAR / TRACKS toggles)
- [ ] Playwright end-to-end tests (patch, play, record, export)
- [ ] GitHub Pages deploy workflow (same setup as su700)
