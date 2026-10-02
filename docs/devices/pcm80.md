# PCM-80 digital effects processor

Files: `src/app/core/devices/pcm80.ts` (catalog, algorithms, knob maths, display),
`src/app/audio/devices/pcm80-unit.ts` (sound), and the pieces shared with the PCM-70
(`core/devices/pcm-dsp.ts`, `core/devices/pcm-display.ts`, `audio/devices/pcm-engines.ts`).
Tests: `tests/pcm80.test.ts`.

## Source

Service manual (scanned):
https://seriescircuits.com/wp-content/uploads/2023/12/Lexicon-PCM-80-Service-Manual.pdf

| Page (PDF)                | What it gave us                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p. 1-1 (7), block diagram | Stereo analog (or S/PDIF) in → INPUT level → A/D → EFFECTS → MIX with the dry signal → D/A → L / R out; CPU with soft knob, keys, footswitch, foot controller, MIDI, PCMCIA card.                                                                                                                                                                                                                               |
| p. 1-2 (8), front panel   | INPUT; display of two rows of 20 characters (effect names, IDs, parameter names and values); ADJUST, which "with Program Banks or Register Banks selected, behaves as a soft knob for patched parameters"; SELECT; four internal preset banks of 50 programs; TEMPO ("LED flashes in time with current tempo rate") and TAP ("press twice in rhythm to establish tempo rate. Press once to reset LFO"); BYPASS. |
| p. 2-1 / 2-2 (15–16)      | 10 Hz–20 kHz ±0.5 dB A/A, 18-bit conversion, 18–24-bit DSP, two 256k × 18 DRAMs of audio memory (expandable by SIMM), 44.1 / 48 kHz.                                                                                                                                                                                                                                                                            |
| p. 3-7 (23)               | A Concert Hall program: the display reads `ConcertHall P0 1.9` / `*ADJ UpMyEchos` — the ADJUST knob patched to bring up echoes.                                                                                                                                                                                                                                                                                 |
| p. 3-9 (25)               | `P0 0.0 Prime Blue`; edit-matrix row `S.0 Controls Mix`; MIDI matrix rows.                                                                                                                                                                                                                                                                                                                                      |
| p. 5-1 (53)               | Architecture: V40 host, Lexichip-2, Tacochip and DSP56002.                                                                                                                                                                                                                                                                                                                                                      |

The service manual names only one algorithm (Concert Hall) and has no parameter tables, so the
other algorithm families and every range below are interpretation.

## What's modelled

Signal flow (fig. p. 1-1): `L/R in → INPUT → algorithm → wet`, mixed with the dry signal by MIX
(the `S.0 Controls Mix` row), then OUTPUT. Stereo throughout. BYPASS passes the dry signal.

Eight algorithms on the ALGO selector, five engine types:

| Algorithm        | Engine                                                                | ADJUST (soft knob) patched to                |
| ---------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| CONCERT HALL     | hall impulse + two tempo echoes (L, R, regenerating) feeding the hall | ECHOES: echo level ("UpMyEchos")             |
| PLATE            | bright plate impulse                                                  | BLOOM: decay ×0.6–1.8 and treble together    |
| CHORUS-VERB      | 2-voice chorus into a chamber impulse                                 | VERB: chorus vs room balance                 |
| INVERSE          | rising impulse that stops dead                                        | SLOPE: 6–36 dB climb                         |
| DUAL CHORUS      | 6 modulated voices, 3 per side                                        | SWIRL: depth and rate together               |
| MULTI-BAND DELAY | 6 taps on the tempo grid, each in its own band                        | BANDS: band-pass Q 0.7–7.7                   |
| DUAL DELAY       | L on the tempo step, R later by SIZE, ping-ponging                    | WIDTH: stereo spread                         |
| RES-CHORD        | 6 combs tuned to a chord                                              | CHORD: maj, min, sus4, maj7, min7, 9, fifths |

Panel: INPUT · ALGO, ADJUST · TEMPO, NOTE · DECAY, SIZE, TONE · DEPTH, RATE (LFO) · MIX, OUTPUT.

- TEMPO 40–240 BPM × NOTE (1/16, 1/8T, 1/8, 1/8., 1/4, 1/4., 1/2) is the delay step for the
  Concert Hall echoes, Multi-band and Dual Delay — the TEMPO / TAP keys' job on the hardware.
- DECAY: RT60 (hall 0.3–20 s, plate 0.3–10 s, chamber 0.3–6 s), inverse length 0.1–1 s, delay
  feedback up to 0.95, ring time for the chords.
- SIZE: room 4–40 m (and a pre-delay of half a crossing), chorus base delay, tap spread, chord root.
- TONE: treble decay / loop low-pass 1–20 kHz. DEPTH / RATE: LFO sweep and rate (tail "spin" on
  the reverbs, detune / strum on the chords).

The display shows the algorithm as the PCM-80 spells it (`ConcertHall`) and, below, the control
being changed: `*ECHOES 64%` when ADJUST moves (the `*` marks the soft-knob patch, as on p. 3-7),
`120BPM 1/4`, `RT 2.45S`, `FBK 57%`…

## Interpretation

- **The algorithm list** apart from Concert Hall is ours, chosen to cover the PCM-80's reverb,
  chorus, delay and resonator families; it needs checking against the owner's manual.
- **Program banks** (P0–P3, 50 programs each) aren't modelled: ALGO + ADJUST stand in for loading a
  program and turning its soft knob. "Prime Blue" and "UpMyEchos" aren't reproduced.
- **ADJUST patches** are one fixed patch per algorithm; the hardware lets each program patch it to
  several parameters with its own scaling.
- The engines are the same as the PCM-70's (see `docs/devices/pcm70.md` for how the rooms, combs and
  tap networks are built), but full-bandwidth (20 kHz, p. 2-1) and stereo in.
- Algorithm changes mute briefly (old engine fades out, new one fades in 60 ms later).
- Not modelled: TAP (no momentary key in the rack panel), the tempo LED, LFO reset, footswitch /
  foot controller, MIDI, S/PDIF, the PCMCIA card, the -10 / +4 output switch.

## Open items

- Owner's manual for the real algorithms, parameter matrix and ranges.
- TAP tempo and a tempo LED (needs a momentary button in the shared rack panel), or tempo from the
  transport.
- Several ADJUST patches per program, and the program banks.
