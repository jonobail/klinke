# MOTION-15

Expression engine: a note effect with no sound of its own. Plain notes in, up to 15 voices out,
each with its own pitch bend (±48 semitones), pressure and timbre, MPE-style, on a NOTE cable.
When the chord changes, the voices already sounding glide to the new notes along the shortest
way, so chords morph instead of restarting. Held voices swell, wander, drift and pick up vibrato,
and the autopilot can keep them moving by itself. KLINKE's own design, not a copy of any
hardware; it sits between CHORD-8 and CHOIR-16 (CHORD-8 → MOTION-15 → CHOIR-16).

Code: `core/motion.ts` (catalog entry `MOTION_GEAR` and all the maths, tested in
`tests/motion.test.ts`), `audio/motion-unit.ts` (`MotionUnit`: the voice pool and the
control-rate engine) and its own panel `gear/motion-panel.*`: a header with the preset display,
◀ ▶ and DICE; the voice-line display, the AUTOPILOT with its 8-step pattern and the GLOBAL BEND;
then VOICES, GLIDE, START · RELEASE, EXPRESSION and MODULATORS. NOTE IN on the left edge, NOTE OUT
on the right. 14 × 7 cells.

## How it plays

- **Input:** NOTE IN (any upstream expression is kept: incoming bend is part of the note's pitch,
  incoming pressure and timbre are the base the motion works on), or the keys / Web MIDI / a
  timeline track playing it directly (velocity 0.8, the pitch wheel ±2 semitones on every voice).
- **Chords:** notes within 30 ms are one chord. A released voice waits LEGATO (0–400 ms) for a
  new note before it lets go, so an off followed by new ons is a chord change, not a restart.
- **Voice leading:** the waiting voices are paired with the new notes. SMART keeps the voices in
  order (they never cross), choosing which ones take part so the total movement is smallest.
  CLASSIC takes the smallest total movement, crossing if that's shorter. Spare new notes start
  new voices; spare old voices let go. A move further than ±48 semitones retriggers.
- **VOICES 1–15** caps the pool: over the limit, the oldest held note hands its voice to the
  newest (VOICES 1 is a legato mono line that glides back to a still-held note).
- **A voice's note is fixed at its 'on';** every move after that is bend from it.

## Controls

- **GLIDE:** MODE TIME (0–4 s) or RATE (2–96 semitones a second); CURVE LINEAR / EASE IN /
  EASE OUT / S-CURVE / OVERSHOOT; SPREAD (each voice's time ±75 %, the same each time for a voice
  slot); STAGGER NONE / LOW→HIGH / HIGH→LOW / OUTSIDE IN / INSIDE OUT / RANDOM over TIME (0–2 s);
  PATH DIRECT / ARC UP / ARC DOWN / ZIGZAG / SWIRL with DEPTH (0–12 semitones at mid-glide;
  zigzag and swirl turn opposite ways on neighbouring voices, swirl also circles the timbre).
- **START · RELEASE:** new voices bend in from BELOW / ABOVE / ALTERNATE / RANDOM by up to 12
  semitones (at the glide's speed); released voices FALL or RISE by up to 24 semitones over
  RELEASE TIME (20 ms–2 s), fading their pressure, before their 'off'.
- **EXPRESSION:** SWELL (pressure from 25 % to full over up to 4 s); TIMBRE WANDER (slow smooth
  noise, ±0.4); DRIFT (slow per-voice pitch noise, up to 40 cent); delayed vibrato: VIB DLY
  (0–3 s after the voice arrives, then a 0.6 s fade in; it fades out while the voice glides),
  VIB RATE (1.5–9 Hz), VIB DEP (up to 1.5 semitones).
- **AUTOPILOT:** held voices keep moving, one pattern step at a time, gliding with the GLIDE
  settings. MODE OFF / OCTAVES (each voice leaps an octave up or down by the sign of its own step)
  / WALK (all voices by the step in major-scale degrees) / ARP-GLIDE (one voice at a time, bottom
  to top, steps out and comes home) / BREATHE (outer voices spread apart or close in by the step)
  / WANDER (each voice a random scale move up to its step) / MIRROR (positive steps flip the chord
  upside down about its middle). RATE: SYNC on, 2 BARS…1/16 at the song tempo; off, 0.1–12
  steps a second. LOOP SEQUENCE repeats the pattern, EVOLVE nudges one step after each pass.
  AMOUNT scales the size (WALK, BREATHE, WANDER) or how many voices take part, from the top down
  (OCTAVES, ARP-GLIDE, MIRROR). The 8 steps (−7…+7) are edited on the panel (click or drag a
  column, the wheel nudges) and stored in the patch; the playing step is lit.
- **GLOBAL BEND:** a shape over every voice, timed from the start of the phrase (the first note
  after silence): RISE / FALL / ARCH / DIP (one-shot, or LOOP) and SAW / WOBBLE (always cyclic),
  over 1/4…4 BARS at the song tempo, DEPTH ±12 semitones.
- **MODULATORS:** two per-voice sines (0.05–8 Hz) into PITCH (±2 semitones) / PRESSURE / TIMBRE
  (±0.5) / VIBRATO (its depth), each voice's phase offset by SPREAD.
- **Presets** (◀ ▶: INIT, SLOW MORPH, CASCADE, SWIRLY, OCTAVE JUMPS, SCALE WALK, GLIDE ARP,
  BREATHING, WANDERER, MIRRORS, FALLING, TAPE SICK) set everything but VOICES and LEADING, and
  the pattern. **DICE** rolls a fresh, playable set and pattern.
- **Display:** each voice's pitch over the last 4 seconds, one colour per voice, brighter with
  more pressure, octave lines on each C; the header shows sounding / available voices.

## Events

- **'on'** when a voice starts, with velocity, its start bend, the swell's first pressure and the
  incoming timbre.
- **'expr'** at control rate (every 12 ms) only for what changed: bend by more than 0.003
  semitone, pressure or timbre by more than 0.004.
- **'off'** when a released voice's release bend ends (straight away with RELEASE NONE), when a
  voice must retrigger, and for every open voice on all-notes-off.

## Interpretation

- Times, depths and ranges are chosen to feel right in KLINKE rather than taken from anything.
- The control rate runs off a 12 ms timer, so motion is as smooth as the receiver's own
  smoothing of the bend (CHOIR-16 glides it lightly).
- The 30 ms chord window delays every note by up to about 30 ms.
