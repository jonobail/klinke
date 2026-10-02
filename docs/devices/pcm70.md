# PCM-70 digital effects processor

Files: `src/app/core/devices/pcm70.ts` (catalog, programs, knob maths, display),
`src/app/audio/devices/pcm70-unit.ts` (sound), shared with the PCM-80:
`src/app/core/devices/pcm-dsp.ts` (impulses, combs, tap networks, tempo),
`src/app/core/devices/pcm-display.ts` (which control is being edited),
`src/app/audio/devices/pcm-engines.ts` (the Web Audio engines). Tests: `tests/pcm70.test.ts`.

## Source

Service packet (scanned; includes field bulletins):
https://seriescircuits.com/wp-content/uploads/2024/11/Lexicon-PCM-70-Service-Manual.pdf

| Page (PDF)                     | What it gave us                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p. 2-1 (6), §2.1               | "More than 40 digital effects and reverb programs, including Chorus and Echo, Resonant Chords, Multiband Delays, Rich Chamber, Rich Plate, and Concert Hall"; over 70 parameter types. Fig. 2.1 front panel: headroom LEDs, INPUT, display, SOFT KNOB, up/down and 0–9 keys, PGM / REG / LOAD / BYP.                                                |
| p. 2-2 (7)                     | The display shows the program or register number and name, or the selected parameter; the soft knob edits that parameter; programs are addressed as row.column.                                                                                                                                                                                     |
| p. 2-3 (8)                     | BYP: "the main input is directly connected to both outputs". Fig. 2.2 rear panel: one MAIN INPUT, LEFT / RIGHT outputs.                                                                                                                                                                                                                             |
| p. 2-5 (10), §2.2              | Processed signal 20 Hz–15 kHz ±1 dB; direct 20 Hz–20 kHz.                                                                                                                                                                                                                                                                                           |
| p. 2-7 (12)                    | Display: 10-digit, 14-segment alphanumeric.                                                                                                                                                                                                                                                                                                         |
| p. 4-2 / 4-3 (24–25)           | Sampling at 33.85 kHz; 16-bit converters; the master processor asserts MUTE "whenever a program is changed, in order to prevent glitches at the output".                                                                                                                                                                                            |
| Field bulletin 070-04662 (102) | Program numbers / names: 0.0 CHORUS, 0.3 STEREO FLANGE, 0.7 PSYCHO ECHOES, 0.8 ECHOES BPM, 0.9 CHORUS AND ECHO BPM, 1.1 DOUBLE DELAY, 1.3 CIRCULAR DELAYS, 1.8 BOUNCING BPM, 6.0 MIDI ECHO BPM, 6.1 CASCADE BPM. The DIFFUSION parameter of the Chorus and Echo and Multiband Delay families "adds between 4 and 20 ms to the selected delay time". |

The service packet has no algorithm block diagrams or parameter tables (those are in the owner's
manual, 070-04337, which we don't have), so the algorithm internals and every parameter range below
are interpretation.

## What's modelled

Signal flow: `in → INPUT → mono → program's engine → 15 kHz low-pass → wet`, mixed with the dry
signal by MIX, then OUTPUT. BYPASS sends the input straight to the outputs.

Fourteen programs, seven different engines:

| #   | Program             | Engine                                                              |
| --- | ------------------- | ------------------------------------------------------------------- |
| 0.0 | CHORUS              | 3 modulated taps (5–40 ms), quadrature LFO phases, light feedback   |
| 0.3 | STEREO FLANGE       | 2 taps 0.6–12 ms, negative feedback, LFOs 90° apart                 |
| 0.7 | PSYCHO ECHOES       | 4 taps at irregular ratios (1, 1.37, 1.93, 2.71), each regenerating |
| 0.8 | ECHOES BPM          | 2 tempo taps (1 and 1.5 note values)                                |
| 0.9 | CHORUS AND ECHO BPM | 3 tempo taps with chorus-depth modulation                           |
| 1.1 | DOUBLE DELAY        | 2 band-split taps                                                   |
| 1.3 | CIRCULAR DELAYS     | 4 band-split taps in a ring, panned round the field                 |
| 1.8 | BOUNCING BPM        | ping-pong: L → R → L on the tempo                                   |
| 2.0 | RESONANT CHORDS     | 6 combs tuned to a chord, rung by the input                         |
| 3.0 | CONCERT HALL        | generated hall impulse (convolution)                                |
| 4.0 | RICH CHAMBER        | denser, faster-building room impulse                                |
| 5.0 | RICH PLATE          | bright plate impulse, no early reflections                          |
| 6.1 | CASCADE BPM         | 4 taps in series, the last feeding back to the first                |
| 7.0 | INVERSE ROOM        | reverse-envelope impulse that stops dead                            |

Panel: INPUT · PROGRAM, SOFT · DECAY, DELAY, SIZE, TREBLE · DEPTH, RATE · MIX, OUTPUT. The knobs
are the main rows of each program's parameter matrix; what they mean depends on the family:

| Knob         | Reverbs                       | Inverse         | Chorus & Echo / Multiband          | BPM programs          | Resonant Chords                               |
| ------------ | ----------------------------- | --------------- | ---------------------------------- | --------------------- | --------------------------------------------- |
| DECAY        | RT60 0.3–20 s (hall), 0.3–8 s | length 0.12–1 s | feedback (0.6–0.95 max by program) | feedback              | ring time 0.2–8 s                             |
| DELAY        | pre-delay 0–500 ms            | pre-delay       | delay time (program range)         | tempo 40–240 BPM      | root C1–C4                                    |
| SIZE         | 4–40 m                        | 4–40 m          | tap spread                         | note value 1/16 … 1/2 | stereo width                                  |
| TREBLE       | treble decay 1–15 kHz         | same            | loop low-pass 1–15 kHz             | same                  | brightness 0.8–12 kHz                         |
| DEPTH / RATE | tail "spin" 0–2 ms, 0.05–4 Hz | same            | LFO sweep, 0.05–8 Hz               | same                  | detune ±25 cents / strum 0–80 ms              |
| SOFT         | BASS ×0.5–2.5                 | SLOPE 6–36 dB   | DIFFUSION 0–100 %                  | DIFFUSION             | CHORD (maj, min, sus4, maj7, min7, 9, fifths) |

The display shows the program (`3.0 CONCERT`) and, on the second line, the control being changed
in that program's terms (`RT 2.45S`, `DLY 340MS`, `120 BPM`, `ROOT C2`); after a program change it
shows what SOFT is patched to. Two lines of ≤ 12 characters suggest the 10-digit display.

## Interpretation

- **Program numbers 2.0, 3.0, 4.0, 5.0, 7.0** are placeholders: the bulletin only numbers the
  delay / chorus programs. INVERSE ROOM is not in the service packet's list; it's included because
  the brief asked for it and it's a well-known PCM-70 program.
- **Algorithms**: rooms are generated impulses (three-band decaying noise: bass below 250 Hz at
  RT × BASS, treble above TREBLE at RT × 0.35, plus size-spaced early reflections for hall and
  chamber) in a pair of ConvolverNodes, crossfaded when a shape-defining knob settles (150 ms
  debounce). Delays are DelayNode networks (self / ring / cascade) whose every loop passes a
  FEEDBACK link < 1 and a Butterworth low-pass. Resonant chords are 6 feedback combs; Web Audio can't
  loop faster than one 128-sample block, so chord tones above ≈ 340 Hz drop by octaves; the comb
  delay is shortened by the loop filter's phase delay so the notes stay in tune.
- **DIFFUSION** is a 4–20 ms noise burst convolved with the input, blended in by SOFT (at 0 the delay
  times are exact, as the bulletin says of v1.2).
- **The 15 kHz low-pass** on the wet path stands in for the 33.85 kHz sampling; the dry path stays
  full range (§2.2). Converter noise and 16-bit quantisation aren't modelled.
- **Program change**: the old engine fades out over ~30 ms and the new one fades in 60 ms later,
  for the hardware's MUTE.
- MIDI (Dynamic MIDI, 6.0 MIDI ECHO BPM), registers, the headroom LED ladder and the rear-panel
  output level switch are not modelled. INPUT / OUTPUT are this app's usual level knobs.

## Open items

- Get the owner's manual (070-04337) for the real program list (rows 2–9), the parameter matrix
  and its ranges, and replace the interpretations above.
- Tempo from the transport clock (a shared change: devices don't see the tempo today).
- Registers: saving edited programs per unit.
