# DPS-R7 — digital reverberator

Files: `src/app/core/devices/dps-r7.ts`, `src/app/audio/devices/dps-r7-unit.ts`,
`tests/dps-r7.test.ts`; shared impulse builder `core/devices/reverb-ir.ts`,
`audio/devices/impulse-convolver.ts`.

## Sources

_DPS-R7 Operating Instructions_ (seriescircuits.com, scanned, pages printed sideways):

- p. 4 table of contents: the Reverberation block's sub-blocks REVC / REVS / REV1 / REV2; ST-ST
  algorithms 1 HLR, 2 RMR, 3 PLR, 4 GTR, 5 ERF; MONO-ST algorithms 6 PLR, 7 GTR, 8 ERF, 9 DL1,
  10 DL2.
- p. 7 front panel: POWER, INPUT (dual concentric, per channel), DRY, EFFECT, input level meter,
  2 × 40-character display, LOAD / HELP / EDIT / SAVE / BYPASS / ENTER, operating dial.
- pp. 21–22 reverberation parameters: predelay, 2nd predelay, cross predelay, early reflection,
  2nd / cross early reflection, rotate high / bass / treble ("filters used to change the
  reverberation time specific to the frequency band"), spread ("normally the same as size"),
  size (time scale of the box); gate time, envelope form / direction (normal / reverse) /
  time, release form, with the gate envelope figure.
- p. 23 REVC block (reverb / direct level and phase).
- pp. 24–28 parameter tables and block diagrams:
  - HLR Hall: reverb time 0.3–99.0 s; predelays and reflections 1–32767 words, 0–100 %,
    normal / inverse; presence 0.003–1.000; rotate high 0.003–1.000; rotate bass freq
    25 Hz–6.3 kHz, level -12…+6 dB; spread and size 0.5–1.5.
  - RMR Room: reverb time 0.12–39.60 s; spread 0.5–2.5; size 0.5–1.5; otherwise as HLR.
  - PLR Plate: 0.3–99.0 s; 1–22527 words; early ref. 1–3; rotate high only.
  - GTR Gate: gate time 1–16383 words; envelope form linear1 / linear2 / exponential1 /
    exponential2; direction normal / reverse; envelope time 0.01–99.99 s; release form 5–100;
    predelay 1–30719 words; spread and size 0.5–2.5.
  - ERF Early reflection: 48 taps per channel, 1–32767 words each, off a predelayed line.
- p. 62 specifications: 18-bit A/D, 40 kHz sampling, 10 Hz–18 kHz response.

## What's modelled

- **ALGORITHM**: the five ST-ST REVS algorithms. send → impulse → 18 kHz low-pass → EFFECT.
- **TIME**: reverb time with each algorithm's range; gate time on GTR (2000–16383 words,
  50–410 ms); pattern scale ×0.5–2 on ERF. **PREDELAY** 1 word to the algorithm's maximum
  (square-law knob; 32767 words = 819 ms). **SIZE** and **SPREAD** with each algorithm's ranges;
  size scales the reflections and the echo build-up, spread decorrelates the channels.
- **E.REF**: level of the predelay box's early, cross and 2nd early reflections (alternating
  phase); **ROT HIGH** 0.003–1: the high band's RT as a fraction of TIME; **BASS FREQ** 25 Hz–
  6.3 kHz and **BASS LVL** (HLR / RMR) set the low band crossover and its RT.
- **ENVELOPE** and **REVERSE** for GTR: hold for the gate time with a linear or exponential
  envelope (forward = decaying, reverse = swelling), then cut.
- **INPUT**, **DRY**, **EFFECT** as on the front panel (separate levels instead of a MIX).
- Display: algorithm code and name, then time and predelay.

## Interpretation

- Factory tap times / levels aren't printed, so the early-reflection patterns are ours; the
  ERF's 48 taps per channel are a seeded pattern over ~120 ms × scale.
- BASS LVL (-12…+6 dB, 0 dB at the centre detent) is read as an RT change of 2^(dB/6), not a
  loop gain; the high band crossover is fixed at 5 kHz.
- Envelope time = gate time × 4 (LIN1 / EXP1) or × 1.5 (LIN2 / EXP2); release form is a fixed
  4 ms cut. Gate time is also limited by SIZE when SIZE < 1 ("the smaller the size, the smaller
  the maximum effective gate time").
- SPREAD above 1.5 just means fully decorrelated.
- The 100 presets, presence control, the phase switches, the MONO-ST algorithms and the pre- /
  post-effect blocks (phaser, flanger, EQ, exciter, auto-panner, delays) are not modelled.

## Harness (MS-20 → DPS-R7 → out, DRY 0, EFFECT 0.75)

- HLR 3.05 s: 0.65 held; 0.42 at 0.4 s, 0.24 at 1 s, below -60 dB at ~2 s.
- HLR 17 s: still 0.45 after 3 s. PLR 3.05 s: 0.65 → 0 at ~2.1 s (denser onset, no ERs).
- GTR 116 ms gate + 48 ms predelay: 0.45 → 0.24 at 150 ms, then cut (0 at 200 ms); reverse
  (EXP2) holds 0.40–0.42 up to the cut instead of falling. ERF: silent 200 ms after release.
- DRY 0.75 + BYPASS: 0.73 held, silent after release. No page errors.

## Open items

- Preset memory list (P1–P100) with names, the 2nd / cross predelays as separate controls,
  presence, MONO-ST algorithms (REV1 + REV2 in parallel), DL1 / DL2 and the pre- / post-effects.
