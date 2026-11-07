<p align="center"><img src="docs/klinke-logo.svg" alt="KLINKE" width="560"></p>

<p align="center"><img src="docs/klinke-studio.png" alt="KLINKE patch floor with a chord generator, synths, a drum machine, a mixer and the timeline" width="720"></p>

<p align="center">
  A patch bay studio in the browser · Built with Angular and the Web Audio API
</p>

KLINKE is a modular music studio laid out like a floor of hardware. Drag synths, a sampler,
pedals and rack effects onto the floor, patch them together with cables, play them from the
computer keyboard or a MIDI controller, and record the result onto a 16-bar timeline. Every
sound is generated live in the browser; there is no server.

**Live demo:** https://jonobail.github.io/klinke/

## Features

- **Patch anything into anything.** Each piece of gear has real IN and OUT jacks; signal flows
  only where cables go, and feedback loops are refused.
- **Synths modelled on their service manuals and schematics,** monophonic and polyphonic, each
  with its original voice architecture, panel layout and quirks.
- **NOTE cables** carry notes between gear: chord generators, per-note expression and a
  physically modelled choir.
- **SP-1200 sampling drum machine** that samples whatever you patch into it, driven from its
  front-panel keys and LCD like the original.
- **Effects:** overdrive, delay, reverb and filter pedals, the MF-104 analog delay, and twelve
  rack processors (H949, Delta-T, Model 200, PCM-70, PCM-80, DPS-D7 / M7 / R7 / V55 / V77,
  E1010, REV5).
- **MIDI tracks** with live quantised recording (overdub or replace, with velocity), a piano roll
  with step entry, selection, copy / paste and a velocity lane, plus quantize and swing.
- **MIDI clock** out to other gear, or follow an external clock (start, stop, song position, tempo).
- **Loop braces** for the whole song (any window of bars) and for each track, dragged like a
  DAW's, so a one-bar beat can repeat under a longer part.
- **Audio tracks** that record the main mix or any single piece of gear, with waveforms and
  playback scheduled on the audio clock.
- **EXPORT MIX** bounces the song to a WAV file.
- **Works on phones and tablets:** pinch and double-tap zoom, touch-playable keys, iOS audio
  unlock.
- **Projects** that save themselves: each keeps its patch, song and recorded audio in the
  browser (IndexedDB), and travels as one `.klinke` file. Songs and patches also export / import
  as JSON.
- **Undo / redo** across the patch floor and the timeline.

## Quick start

1. Open the [live demo](https://jonobail.github.io/klinke/). The demo rig is already patched:
   a chord generator plays a polysynth over a NOTE cable, and a drum machine joins it in the
   mixer feeding **MAIN • REC**.
2. Click anywhere to start audio, then play **A S D F G H J K L** (white keys) and
   **W E T Y U O P** (black keys); **Z / X** change octave.
3. Click a synth to give it the keyboard (marked **⌨ KEYS**); press **RUN/STOP** on the drum
   machine to start its beat.
4. Arm a track with **R**, press **REC**, play, then press **EXPORT MIX** to save a WAV.

## Using KLINKE

### Patching

| Action | How |
|---|---|
| Add gear | Drag a tile from **INVENTORY** onto the floor, or click it |
| Connect | Click an OUT jack (red ring), then an IN jack (white ring) |
| Disconnect | Click the cable, or focus a plugged jack and press **Delete** |
| Move a cable | Drag a plugged cable end to another jack (drop it on empty floor to pull it out) |
| Move / remove | Drag a box by its body (dropped on other gear, it slides to the nearest free spot); select it and press **Delete** (or **×**) |
| What's this? | Rest the mouse on gear, or click / tap its name tag |
| Adjust controls | Drag knobs and faders vertically, scroll over them, or focus and use the arrow keys |
| Bypass a pedal | Click its footswitch |

Only what reaches **MAIN • REC** is heard. A **MULT** splits one signal to several inputs.

Blue DIN-style jacks carry notes, not sound: patch note gear into an instrument's NOTE IN with NOTE
cables and play it from the keys. Every instrument has a NOTE IN (play it from a cable) and a NOTE OUT (passes on whatever it plays),
so one keyboard or chord can drive several synths at once.

### Playing

The computer keyboard plays one instrument at a time. A MIDI controller works in Chrome and Edge
over HTTPS or localhost, including pitch bend and the mod wheel. You can also click or slide
across any on-screen keyboard.

### Recording

- **Transport:** **Space** plays and stops, and is the kill switch: stopping also stops every
  drum machine and sequencer and every sounding note (with the song stopped, it stops any
  sequencer still running). **STOP** twice returns to the top; click the ruler to move the
  playhead, or drag along it to draw a new song loop. The arrow on the gear shelf folds it away and back; **HIDE ▾** (then **SHOW ▴**),
  beside the zoom and **FIT**, does the same for the tracks.
- **MIDI tracks:** switch a track to **MIDI** and pick its instrument. Arm it (**R**) and press
  **REC** to record notes, quantised to the track's grid (default 1/16). Click the lane to open
  the piano roll: click to add a note, drag to move, drag the right edge to resize,
  double-click or **Delete** to remove. Shift-click or shift-drag selects; the arrows transpose
  and nudge; **Ctrl+C / V / D** copy, paste and duplicate; drag the VEL bars for velocity.
  On a touch screen, **COPY / PASTE / DUP / DEL** in the piano roll's bar do the same.
  **QUANTIZE** snaps the selection (or the track), **SWING** delays the off-beats (notes you
  record against a swung track are taken off the swing, so they quantise onto the grid and play
  back where you played them), and
  **OVERDUB / REPLACE** sets how recording treats notes already there. **STEP** writes each note
  or chord you play at the cursor and moves on a step (REST, TIE, BACK).
- **MIDI clock:** click the **MIDI** badge to send clock to your other gear (**CLOCK OUT**) or to
  follow theirs (**SYNC EXT**: their start, stop, song position and tempo). With both on, clock
  isn't sent back to the device it comes from (that would loop); the panel says when it leaves
  one out.
- **Audio tracks:** choose what the track records: **MAIN MIX** or one piece of gear's OUT. Arm
  it and press **REC**; the take appears with its waveform and plays back in time with the song.
  Mute (**M**) and solo (**S**) apply. Click a take to pick it: drag it to move it (snaps to
  sixteenths; hold **Shift** to move freely), drag either edge to trim it (pull the edge back
  out to bring the audio back), nudge it with the arrows, and press **Delete** (or its **✕**) to
  remove it. The lane's **✕** deletes all of a track's takes. Wrapping round the loop or moving
  the playhead while recording starts a new take.
- **Metronome, count-in and latency:** the **♩** button beside LOOP opens the recording
  settings. **CLICK** ticks every beat (higher on the downbeat) while the song plays; it goes
  straight to your speakers, so it's never recorded or exported. **COUNT-IN** clicks one or two
  bars in when you press **REC** on a stopped song (REC blinks; press it or STOP to cancel).
  **LATENCY AUTO** moves the notes you record earlier by the delay between the audio clock and
  your ears that the browser reports, and **OFFSET** adds (or takes off) more, in ms, for your
  MIDI gear or Bluetooth headphones. Audio takes need no shift: they're captured inside the
  audio graph, in step with the song.
- **Timing:** MIDI tracks are booked a little ahead on the audio clock, so their notes land on
  the sample on the synths and the SP-1200. The CHORD-8, MOTION-15 and CHOIR-16, and any
  instrument whose NOTE OUT is patched, are played from a timer at the right moment instead.
- **Loops:** the red bar above the ruler is the song loop. Drag its ends to set where it starts
  and ends, or drag the middle to move it. The song plays round it: bars past its end are
  shaded, and a song started before it plays on into it. Each track has its own loop bar along the top of its lane: drag its end to make the track
  repeat its first bars (dimmed copies show the repeats); drag it out to the song loop's end, or
  double-click it, to follow the song again. A looping MIDI track records each pass into its
  loop; a looping audio track starts a new take each time round.
- **EXPORT MIX** (or **FILE → Export mix**) plays the song once from the top in real time,
  through the last note or take plus a bar for tails (exactly the loop when a song loop is set),
  and downloads `klinke-mix.wav`. Click
  again to cancel.
- **SAVE** (or **Ctrl+S**) keeps the patch and song in this browser. Recorded audio is saved
  as soon as each take ends.

### Projects and undo

- **Projects:** the patch, the song and its recorded takes together. The open project's name
  sits beside the logo; click it (or **FILE → Projects…**) for the list: open one, **+ NEW**,
  **REN**ame, **DUP**licate or **DEL**ete it (DEL asks once more). Changes save themselves a
  moment after you make them, and KLINKE opens the last project you had open. Everything stays in
  this browser.
- **FILE → Export project (.klinke)** saves the open project with all its audio in one file;
  **Import project** opens one as a new project (in this or another browser).
- **FILE → Export song / Import song (.json)** move just the song: tempo, loop, tracks and their
  MIDI notes (no audio). **Export / Import patch (.json)** do the same for the patch floor.
- **Undo / redo:** **Ctrl+Z** and **Ctrl+Shift+Z** (or **Ctrl+Y**), also in the **EDIT** menu.
  They cover the patch floor (gear, cables, knobs) and the timeline (tracks, notes, takes, tempo,
  loops). A knob turn, a note drag, a gear drag or one pass of recording is one step; arming,
  muting and soloing aren't steps. Opening another project starts its history afresh. A track's
  cleared takes can be undone until the project is next opened.

### Instrument notes

Each piece of gear is documented in [docs/devices/](docs/devices/).

## Run locally

**Requirements:** Node.js 24 or newer.

```sh
git clone https://github.com/jonobail/klinke.git
cd klinke
npm install
npm start               # http://localhost:4200
npm test                # unit tests for src/app/core (node --test)
npm run build           # production build in dist/klinke
```

`npm run start:tailnet` serves on `0.0.0.0:4200` so other devices on a Tailscale network can
connect. Web MIDI needs HTTPS or localhost, so MIDI controllers only work locally or on the
hosted version.

## Deployment

Every push to `master` runs `.github/workflows/pages.yml`, which runs the unit tests, builds with
`--base-href /klinke/` and publishes to GitHub Pages. The app is fully static.

## Project layout

| Path | Contents |
|---|---|
| `src/app/core/` | Framework-free logic: gear catalogue, patch graph, transport, notes, WAV encoding |
| `src/app/audio/` | Web Audio engine: one unit per gear kind, graph sync, notes, meters, takes storage |
| `src/app/patch-store.ts` | Patch state, selection, cable patching, persistence |
| `src/app/projects.ts` | Projects in IndexedDB, autosave, `.klinke` bundles, song files |
| `src/app/history.ts` | Undo / redo over the patch and the song (`core/history.ts`) |
| `src/app/transport.ts` | Song clock and tracks |
| `src/app/sequencer.ts` | MIDI track playback and recording |
| `src/app/recorder.ts` | Audio takes, playback and EXPORT MIX |
| `src/app/gear/` | Gear panels and the knob / fader / keyboard controls |
| `src/app/top-bar/`, `inventory/`, `floor/`, `timeline/`, `piano-roll/` | Screen areas |
| `public/worklets/` | AudioWorklets: recording capture and synth voices |
| `tests/` | `node --test` suites for `core/` |
| `docs/` | [Roadmap](docs/ROADMAP.md) and per-device design notes |

## Roadmap

Progress and plans are tracked in [docs/ROADMAP.md](docs/ROADMAP.md).
