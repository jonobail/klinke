# REV5 — digital reverberator

Files: `src/app/core/devices/rev5.ts`, `src/app/audio/devices/rev5-unit.ts`, `tests/rev5.test.ts`;
shared impulse builder `core/devices/reverb-ir.ts`, `audio/devices/impulse-convolver.ts`.

## Sources

_REV5 Service Manual_ (seriescircuits.com; pages are upside down in the scan):

- p. 2 Specifications: presets 1–30 (ROM) and user memory 31–90; analog equalizer LOW ±15 dB
  50–700 Hz, MID ±15 dB 350 Hz–5 kHz, HIGH ±15 dB 2–20 kHz; A/D 1 channel, 16 bit, 44.1 kHz;
  D/A 2 channels; effect response 20 Hz–20 kHz; 16 × 2 LCD and 2-digit LED; front-panel keys
  including direct recall REV1 -31-, REV2 -32-, REV3 -33-, REV4 -34-, ER1 -35-, ER2 -36-,
  OTHERS -37-, INITIAL DELAY, 1ST REF, LEVEL, EQ, EQ ON.
- p. 3 Panel layout: POWER, MONO / STEREO, INPUT LEVEL, EQ ON / OFF, LO FREQ / LEVEL, MID FREQ /
  LEVEL, HI FREQ / LEVEL, MIXING (DIRECT ↔ REV), the key matrix and remote unit.
- p. 4 Block diagram: L (MONO) / R inputs → INPUT LEVEL → MONO / STEREO → summed → EQ (EQ ON
  switch) → LPF → A/D → 3 × DSP (YM3804) with DRAM, DEQ (YM3608), MOD → D/A → LPF → MIXING
  pots (DIRECT / REV) → MUTE / BYPASS → OUTPUT LEVEL (+4 / -20) → outputs.
- pp. 5–7 LSI data (YM3804 DSP, YM3608 DEQ, YM3807 modulation generator) confirm the DSP split.

## What's modelled

- send → mono sum (one A/D channel) → analog EQ (LO shelf, MID peak, HI shelf, ±15 dB, only
  with EQ ON) → impulse → MIXING. The direct sound is untouched by the EQ, as on the diagram.
- **PROGRAM**: the seven direct-recall keys, shown as memory 01–07: REV1 HALL, REV2 ROOM,
  REV3 VOCAL, REV4 PLATE, E/R1 HALL (regular early-reflection pattern, no tail), E/R2 RANDOM
  (scattered reflections), OTHERS GATE (reverb & gate).
- **RT** 0.3–99 s (30–500 ms gate time on OTHERS), **HIGH** 0.1–1.0 (high-band RT ratio),
  **DIFFUSION** 0–10 (echo build-up time and stereo width), **INIT DLY** 0.1–400 ms (to the
  first reflection), **1ST REF** (first-reflection level).
- **INPUT**, **EQ ON**, the EQ knobs and **MIXING** as on the front panel.
- Display: the 2-digit memory number with the key and program name, then RT (or gate time /
  initial delay).

## Interpretation

- The service manual has no program or parameter list: program names / characters behind the
  keys, the RT / HIGH / DIFFUSION / INITIAL DELAY ranges and the reading of "1ST REF" as the
  first-reflection level are ours (in the style of the REV-series parameters).
- LO and HI are drawn as shelving bands, MID as a peak (Q 0.9); the manual only says ±15 dB over
  the listed ranges.
- MONO / STEREO only affects the direct path on the hardware (both channels are summed for the
  A/D either way), so it is left out. The 30 presets, delay / echo / modulation / pitch programs
  under OTHERS, user memories and MIDI aren't modelled.

## Harness (MS-20 → REV5 → out, MIXING full)

- REV1 HALL RT 1.7 s: 0.60 held; 0.42 at 0.4 s, 0.21 at 0.8 s, below -60 dB by ~1 s.
- REV1 RT 9.7 s: still 0.31–0.46 after 3 s. REV4 PLATE 1.7 s: 0.65 → 0 at ~1.2 s.
- E/R1 and OTHERS (70 ms gate): silent 200 ms after release. EQ on (LO +15, HI -15) audibly
  darker (0.72 held). BYPASS: 0.78 held, silent after release. No page errors.

## Open items

- The preset list (1–30), the other OTHERS programs (delay, echo, flange, chorus, phasing,
  tremolo, symphonic, pitch change), user memories, MIDI program change.
