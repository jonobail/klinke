# DPS-V77 multi-effect processor

Files: `src/app/core/devices/dps-v77.ts` (catalog, FX list, settings, display),
`src/app/audio/devices/dps-v77-unit.ts` (sound); effect types shared with the V55
(`dps-fx.ts`, `dps-engines.ts`, see that doc). Tests: `tests/dps-v77.test.ts`.

## Sources

- Operating Instructions: https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-V77-User-Manual.pdf
- Service Manual: https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-V77-Service-Manual.pdf
  (contains an OCR copy of the manual; no effect list).

| Page | What it gave us                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p.4  | Full stereo; effects "chosen from the DPS-R7 / D7 / M7 / F7 sound series" plus new ones; two multi-type FX blocks and two EQ blocks; morphing between programs.              |
| p.5  | Hierarchy: EQ A, FX A, EQ B, FX B, Mixer (STRCT, FX A level, FX B level, Dry level), active parameters.                                                                      |
| p.6  | Front panel: INPUT (concentric ch1 / ch2), OUTPUT, meter, display, number keys, shuttle ring, FUNCTION A–F, BYPASS / MUTE.                                                   |
| p.8  | Each block = EQ block + FX block, EQ [Mode] Pre or Post; structures SERI 1 (A → B) and SERI 2 (B → A); the example "block A an intense flanger, block B the largest reverb". |
| p.9  | PARA (separate effects mixed: "no undulation from the flanger in the reverb"), DUAL (ch1 and ch2 isolated), MORPH.                                                           |
| p.16 | Morphing crossfades the old and new effects.                                                                                                                                 |
| p.17 | EQ A example: Shelving EQ (SEQ) with low frequency 0.125 kHz.                                                                                                                |
| p.19 | Structure symbols in the title bar; MIX block levels FX A, FX B, Dry, per channel.                                                                                           |

The V77's own Effect Parameter Guide is not among the sources, so the FX types and their
parameters are the DPS family's (see Interpretation).

## What's modelled

Each block: pre EQ → FX → post EQ, where the EQ block is a low shelf at 125 Hz and a high shelf
at 8 kHz, ±12 dB, applied before (PRE) or after (POST) the effect, or not at all (OFF). The FX
block is a crossfading slot, 100 % effect. Structure:

- SERI 1: send → A → B; SERI 2: send → B → A; PARA: send → A and send → B.
- DUAL: send up-mixed to stereo and split: ch1 → A → left, ch2 → B → right.
- MIX: `FX A level × A + FX B level × B + Dry level × send` (¾ = unity). In the serial structures
  both block outputs reach the mixer.

Changing structure re-patches behind a 40 ms mute (the two serial orders can't both be wired:
the loop would have no delay). Changing an FX type crossfades (MORPH-like). INPUT / OUTPUT are
the base levels; the base dry path is off (the mixer's Dry replaces it), BYPASS passes dry.

FX types (28): Hall, Room, Plate, E/R, Delay, Ping-pong, Tap delay (D7 TPD style), Mod delay
(M7 MDL), Pitch, Reverse shift, Chorus, Deca chorus, Ensemble, Flanger, Phaser, Pan, Haas,
Tremolo, Vibrato, Rotary, Wah, Ring mod (M7 RNG), Drive, Amp, Comp, Limit, Gate, Exciter, each
with three parameter knobs P1–P3 (ranges as on the V55 guide / M7 / D7 pages).

Display: `Flang>Hall` / `Rate 30` — block A type, structure symbol (`>` SERI 1, `<` SERI 2,
`/` PARA, `:` DUAL), block B type, then A's P1.

## Interpretation

- The effect list is the DPS family's (the V55 guide's effects, the M7 ring modulator and
  modulation delay, the D7 tap delay), not the V77's own list; names are short V77-display style.
- SEQ frequencies 125 Hz / 8 kHz and ±12 dB are our choice (the manual shows 0.125 kHz);
  no other EQ types (the "CEQ" on p.19 isn't explained in the manual).
- Serial structures send both block outputs to the mixer; per-channel mixer levels, active
  parameters, RTC, pedals and MIDI aren't modelled; MORPH is the default crossfade on type change.

## Open items

- The V77 Effect Parameter Guide (true effect list and ranges).
- More EQ types (CEQ / parametric), per-channel mixer levels.
