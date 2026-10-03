# KLINKE · Pixel Patchbay Studio

A browser music studio in pixel art, built with Angular: drag gear (an MS-20, a Model D, an SH-101, an MF-104 delay, pedals, a
4-channel mixer) onto the floor, patch it together with cables, and record onto a 16-bar timeline.

Progress and plans are tracked in **[docs/ROADMAP.md](docs/ROADMAP.md)**. The patch floor and
the sound engine work now; recording audio onto the timeline is the next milestone.

## Running locally

```bash
npm install
npm start      # http://localhost:4200
npm run start:tailnet   # same, reachable from other devices on the tailnet
npm test       # unit tests for src/app/core (node --test)
npm run build
```

## Using it

- **Add gear:** drag a tile from INVENTORY onto the floor, or click it.
- **Patch:** click an OUT jack (red ring), then an IN jack (white ring). Click a cable to unplug it.
  Each jack takes one cable, and feedback loops are refused.
- **Move / remove:** drag a box by its body; select it and press Delete (or the ×).
- **Play:** click or slide across a synth's keys, or use the computer keyboard: A S D F G H J K
  L ; ' are the white keys, W E T Y U O P the black keys, and Z / X change octave. A MIDI
  controller works too (Chrome / Edge, over HTTPS or localhost), including pitch bend and the mod
  wheel. The keyboard plays one synth at a time, the one marked ⌨ KEYS: click a synth to hand it
  the keyboard. You hear only what's patched through to MAIN • REC.
- **MS-20:** like the original it's monophonic (last note wins; legato glides without
  re-triggering). The WAVE FORM and SCALE knobs click between four positions; knobs with a tick at
  12 o'clock are ± intensities that do nothing at centre. Its EXT SIG IN jack runs other audio
  through its filters.
- **Model D:** monophonic with low-note priority, like the original. Rocker switches turn mixer
  sources and features on; the PITCH wheel springs back, the MOD wheel stays. Turn OSC 3 off (and
  its RANGE to LO) to use oscillator 3 as an LFO through OSC MOD / FILTER MOD. The OVERLOAD lamp
  lights when the mixer is driving the filter hard.
- **MF-104:** an analog delay. RANGE doubles every delay time; FEEDBACK at the top runs away into
  self-oscillation (turn it down to calm it). Flip LOOP to EXT and patch LOOP OUT → another pedal →
  LOOP IN to put that pedal inside the repeats; LOOP GAIN sets how much comes back.
- **MIDI tracks:** a track's AUD / MIDI button makes it a MIDI track; pick its instrument (any
  synth or the SP-1200) in the lane. Click the lane to open the piano roll underneath: click to add
  a note, drag to move, drag the right edge to resize, double-click or Delete to remove; GRID sets
  the snap (default 1/16). To record, arm the track (R) and press REC, then play the computer
  keys, a MIDI keyboard or the on-screen keys; notes snap to the grid. Tracks save with SAVE.
- **SH-101:** monophonic with a sub-oscillator; the LFO also clocks the arpeggiator (ARP: UP / U&D
  / DOWN, hold keys) and the sequencer: set SEQ to LOAD, play notes (REST for a gap), then PLAY;
  holding a key while it plays transposes the line. HOLD latches. The sequence is saved with the
  patch.
- **SP-1200:** a sampling drum machine laid out like the original. Click it (or a pad) to give it
  the keyboard: A–K play pads 1–8; the bank button cycles A–D, the Performance button switches
  the sliders between Tune/Decay and Mix. To sample, patch a source into SAMPLE IN (use a MULT to
  keep it in its chain too), press a pad to choose the location, press the red SAMPLE button, key
  5 and set the length with slider 1, then key 9 to sample now or 7 to arm (sampling starts when
  the input passes the threshold set with SAMPLE 4). SET-UP 19 truncates and loops, SET-UP 20
  deletes. The LCD prompts you through each step.
- **Rack effects:** under RACK in the inventory, twelve rack processors (harmonizer, delays,
  reverbs, multi-effects). Patch them like pedals; the display shows the program and setting,
  and BYPASS passes the signal dry. Each is documented in `docs/devices/`.
- **AUDIO:** sound starts with your first click or key press; the AUDIO button mutes it.
- **Controls:** drag knobs and faders up and down, scroll them, or focus them and use the arrow
  keys. Click a pedal's footswitch to bypass it.
- **Transport:** Space plays and stops; pressing STOP twice returns to the top. REC records on
  tracks armed with R. Click the ruler to move the playhead.
- **Save:** SAVE or Ctrl+S keeps the patch in this browser; FILE exports and imports it as JSON.

## Layout

| Path | What |
|---|---|
| `src/app/core/` | Pure logic with no Angular: gear catalog, patch graph, transport and sound maths |
| `src/app/patch-store.ts` | Patch state (signals), selection, cable patching, persistence |
| `src/app/transport.ts` | Song clock, tracks and record regions |
| `src/app/audio/` | Web Audio engine: one unit per gear kind, graph sync, keyboard / MIDI notes, meters |
| `src/app/top-bar/`, `inventory/`, `floor/`, `timeline/` | The four screen areas |
| `src/app/gear/` | Gear artwork and the knob / fader controls |
| `tests/` | `node --test` suites for `core/` |
