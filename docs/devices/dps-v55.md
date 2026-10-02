# DPS-V55 multi-effect processor

Files: `src/app/core/devices/dps-v55.ts` (catalog, settings, display),
`src/app/audio/devices/dps-v55-unit.ts` (sound), and the effect types it shares with the V77:
`src/app/core/devices/dps-fx.ts` (effect list, knob ranges, unit conversions),
`src/app/audio/devices/dps-engines.ts` (engines + the effect block),
`dps-blocks.ts` / `dps-dsp.ts` / `dps-taps.ts`. Tests: `tests/dps-v55.test.ts`,
`tests/dps-dsp.test.ts`.

## Sources

- Operating Instructions: https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-V55-User-Manual.pdf
- Effect Parameter Guide: https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-V55-Effect-Parameter-Guide.pdf
- Service Manual: https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-V55-Service-Manual.pdf (not needed for the model)

| Page           | What it gave us                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual p.4     | 45 effect algorithms in three types (4ch, 2ch, Mono-Pair); 200 presets; serial / parallel structures; TAP.                                                    |
| Manual p.5     | Functional hierarchy: Master Level 0–100, FxA / FxB on-off and parameters, structure.                                                                         |
| Manual p.6     | Front panel: effect list printed beside the display, INPUT LEVEL ×4, rotary encoder, EDIT PARAMETER buttons, Fx TYPE, BYPASS, SAVE, SYSTEM.                   |
| Manual p.8     | 4ch effects (01–09) use the whole unit; 2ch (10–36) and Mono-Pair (37–45) go two to a program; parallel "/" = FxA and FxB independent, serial = FxA into FxB. |
| Manual p.10–11 | Preset 001 "Super Reverb", FxA:11 / FxB:12; the display shows FxA number, structure symbol, FxB number.                                                       |
| Guide p.2      | List of effects 01–45 with codes, type and TAP marks.                                                                                                         |
| Guide pp.5–48  | One page per effect: its parameters in order with ranges (used as the knob ranges).                                                                           |

## What's modelled

`send → FxA → (serial) FxB → ret`, or in parallel `send → FxA` and `send → FxB`, each at 0.7,
summed. A 4ch FxA (or FxB OFF) leaves FxA alone. Each block is an engine in a crossfading slot
with a direct / effect balance (BAL; the guide's Direct Level / Effect Level or Mono-Pair BAL);
dynamics, EQ, drive, amp, exciter, gate, tremolo, vibrato and wah are inserts (all effect).
INPUT and LEVEL (master) are the base levels.

Knobs P1–P3 are each effect's first parameters in guide order, with the guide's ranges (Rev Time
0.3–50 s, PreDelay 0–150/300/400 ms, delay 0–1360 ms, feedback ±99, pitch ±2400 c…).
Built: 01–07, 10–33, 37–45 (40 of 45).

| Effects                                                  | Engine                                                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01–03, 10–12 reverbs                                     | `reverbIR` convolution (seeded noise, HF damping over time, early reflections for halls / rooms), rebuilt debounced only when RT / PreDelay / HiDamp change, crossfaded |
| 04, 13 3 Dimension                                       | panners at sin(angle), darker behind (                                                                                                                                  | angle | > 90°) |
| 05 Deca Chorus, 06 Ensemble, 19 Stereo Chorus            | `Voices` (5 / 3 + fast LFO / 2 per channel)                                                                                                                             |
| 07 Rotary                                                | `Rotary` (Speed slow / fast, Depth, Drive)                                                                                                                              |
| 14 Early Reflection                                      | 12 taps per side; Type 1–4 = 30 / 55 / 90 / 140 ms rooms; Level Mode Dec / Fix / Inc tilt                                                                               |
| 15 Stereo Delay, 16 Ping Pong                            | `StereoDelay`; ping-pong feeds the left line and cross-feeds                                                                                                            |
| 17 Stereo Pitch, 18 Reverse Shifter                      | two-tap `PitchShift` per channel; reverse runs the window backwards (Length 20–650 ms)                                                                                  |
| 20 Flanger, 21 Phaser                                    | flanger voice with feedback; 8-stage all-pass phaser                                                                                                                    |
| 22 Stereo Panner, 23 Haas Panner, 31 Tremolo, 32 Vibrato | StereoPanner LFO; ±0.9 ms inter-channel delay; gain LFO; delay LFO                                                                                                      |
| 24 Driver, 26 Amp                                        | waveshaper + tone (Color 1–6 = 1.5–10 kHz; Amp F / B / M / J voicings, Mic as cabinet low-pass)                                                                         |
| 25 EQ, 44 EQ+EQ                                          | low shelf 200 Hz / peak 1 kHz / high shelf 5 kHz, −24…+12 dB                                                                                                            |
| 27 Limiter, 28 Compressor, 45 Comp+Comp                  | DynamicsCompressorNode with make-up                                                                                                                                     |
| 29 Exciter                                               | high-passed saturation added to the dry signal                                                                                                                          |
| 30 Gate                                                  | envelope follower keying a smooth step                                                                                                                                  |
| 33 Auto Wah                                              | envelope sweeping a resonant band-pass (Sens ± = up / down)                                                                                                             |
| 37–43 Mono-Pairs                                         | two engines, one per output channel                                                                                                                                     |

Display: `11/12 Hall2` / `RevT 3.0s` — FxA number, structure symbol (`/` parallel, `>` serial),
FxB number (`--` none), FxA code, then FxA's P1.

## Interpretation

- One knob per parameter isn't possible for 45 effects, so P1–P3 are the first parameters (for
  EQ the three gains; Gate Threshold / GateTime / Release; Limiter Threshold / Ratio / Release);
  the rest are fixed (Size / Spread 1.0, phaser resonance +50, delay LPF 6–8 kHz…).
- Rate 0–100 → 0.05–12 Hz exponential (the guide prints no Hz); chorus Depth 100 % = ±10 ms.
- Reverb RT above 6 s is truncated to a 6 s impulse with a faded end.
- The four channels collapse to our mono-in / stereo-out patch: 4ch effects take the mono input
  on all channels; the parallel structure sums FxA and FxB.
- Exciter Frequency 1–32 → 1–10 kHz; Amp model voicings are guesses from the names.

## Open items

- Not built: 08 Vocoder, 09 Doppler, 34 Pitch Roller, 35 Vocal Canceler, 36 Freeze.
- TAP tempo, MIDI, preset programs (the 200 presets' parameter values aren't in the sources).
