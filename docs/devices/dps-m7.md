# DPS-M7 digital sonic modulator

Files: `src/app/core/devices/dps-m7.ts` (catalog, algorithm list, knob maths, display),
`src/app/audio/devices/dps-m7-unit.ts` (sound). Shared blocks: `dps-dsp.ts`,
`dps-blocks.ts` (see the DPS-D7 doc). Tests: `tests/dps-m7.test.ts`, `tests/dps-dsp.test.ts`.

## Source

Operating Instructions (scanned, English pp.1–~45):
https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-M7-User-Manual.pdf

| Page | What it gave us                                                                                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p.4  | Table of contents = the algorithm lists: pre-effect 0 OFF, 1 SEQ, 2 SXE, 3 DEX, 4 GTE, 5 CMP; modulation 0 OFF, 1 SCH … 20 RTY; post-effect; envelope EVF / EG1 / EG2.                                                                                                |
| p.11 | Block chain INPUT → PRE-EFFECT 1 → PRE-EFFECT 2 → MODULATION → POST-EFFECT → OUTPUT, with ENVELOPE from the input into the modulation block; every block has an "Algorithm 0" pass-through.                                                                           |
| p.23 | Stereo Chorus: two chorus units per channel (LFO and inverted LFO), LFO 0.01–40 Hz, depth "modulates the delay time for approximately 20 msec" at 100 %, waves sin / triangle / special 1 / special 2, predelay 0–300 ms, panpots, direct / effect levels and phases. |
| p.24 | Deca Chorus: five chorus units per channel, LFO phases 0–359°, predelays 0–1000 ms.                                                                                                                                                                                   |
| p.35 | Multi Phaser: two phase shifters per channel, up to 8 stages each (180° per stage), manual, resonance 0–99.9 %, S/H.                                                                                                                                                  |
| p.36 | Stereo Flanger: manual (centre delay; ~63 ms max with both depths), depth ~20 ms, feedback.                                                                                                                                                                           |
| p.40 | Modulation Delay: main delay 0–500 ms, feedback 0–99.9 % with bass / treble in the loop, three sub taps with pans.                                                                                                                                                    |
| p.42 | Stereo Panner: modes off / LFO / ENV, limit min / max, LFO 0.01–40 Hz, triggers.                                                                                                                                                                                      |
| p.45 | Vibrato + Tremolo: vibrato and tremolo units sharing the LFO frequency, tremolo LFO phase for panning-like effects, predelay 0–500 ms.                                                                                                                                |
| p.47 | Ring Modulator: OSC 0.05–3000 Hz (osc / noise / ch1 carrier), feedback delay 0–1000 ms with three panned taps, loop EQ.                                                                                                                                               |
| p.48 | Rotary Speaker: speed fast / slow, horn 1–20 Hz fast / 0.05–5 Hz slow, rotor likewise, rising / falling times 0.01–10 s, drive, horn : rotor balance.                                                                                                                 |

## What's modelled

`send → pre-effect (slot) ─┬→ direct ──────────────────────┬→ ret`
`                          └→ modulation (slot) → effect ──┘`
plus an envelope follower on the input whose ENV amount modulates the effect level (the
"effect modulation" every algorithm's LEVEL section has, p.18 "dynamic modulation"): + brings
the effect in with playing, − ducks it. MIX sets direct / effect (equal power) after the
pre-effect, so the pre-effect is heard on the direct sound too. BYPASS passes the input.

| #   | Algo | Build                                                                               |
| --- | ---- | ----------------------------------------------------------------------------------- |
| 0   | OFF  | pass-through                                                                        |
| 1   | SCH  | `Voices` 2 per channel, LFO phases 0° / 180°, panned                                |
| 2   | DCH  | `Voices` 5 per channel, phases 72° apart, staggered predelays                       |
| 3   | MCH  | 3 per channel, ch2 LFO ×1.33                                                        |
| 4   | BCH  | chorus on the band above 300 Hz                                                     |
| 5   | SPS  | two-tap pitch shifters, ±2400 cents, predelay, feedback                             |
| 6   | BPS  | pitch shift above 400 Hz                                                            |
| 7   | PSM  | pitch shift then a vibrato voice                                                    |
| 8   | RVS  | the pitch shifter run backwards (window = DELAY, 20–650 ms)                         |
| 9   | ENS  | 3 voices per channel, each with a slow and a fast (×6.3) LFO                        |
| 10  | MPH  | 8 all-pass stages per channel swept on `detune`, resonance feedback                 |
| 11  | SFL  | one flanger voice per channel with feedback                                         |
| 12  | MFL  | two flanger voices per channel, ch2 LFO ×1.5                                        |
| 13  | MDL  | modulated delay 0–500 ms with feedback                                              |
| 14  | SPM  | chorus into an auto-panner on the same rate                                         |
| 15  | SPA  | auto-panner, WIDTH = DEPTH                                                          |
| 16  | HPA  | Haas panner: ±0.9 ms between channels                                               |
| 17  | DOP  | wide delay sweep (pitch) with the image moving                                      |
| 18  | VIB  | vibrato voice into tremolo; FDBK = tremolo depth, PHASE = tremolo ch2 phase         |
| 19  | RNG  | ring modulator (sine OSC) into a feedback delay                                     |
| 20  | RTY  | overdrive → 800 Hz crossover; horn: Doppler delay, AM, pan; rotor: pan; speed ramps |

Knobs: RATE (0.01–40 Hz exp.; RNG: OSC 0.05–3000 Hz; RTY: below half SLOW, above FAST), DEPTH
(100 % = ±10 ms, the manual's ~20 ms), DELAY (per algorithm, square law: predelay, manual, main
delay, reverse window, Doppler distance), FDBK (−/+ = inverse / normal; resonance for MPH; RTY:
drive), PITCH (±2400 c), WAVE, PHASE (ch2 LFO 0–359°), ENV. Pre-effect AMOUNT: SEQ tilt
(±12 dB at 250 Hz / 4 kHz), SXE / DEX exciter amount (3 kHz / 1.8 kHz), GTE threshold, CMP depth.

The LFO waves are Fourier series (`waveHarmonics`) in PeriodicWaves, so the ch2 LFO is the same
oscillator wave started PHASE degrees later and stays locked. Algorithm and pre-effect changes
crossfade.

## Interpretation

- Only one pre-effect slot (the M7 has two) and no post-effect block; the envelope block's
  EG1 / EG2 generators and the MIDI / key triggers aren't modelled — the envelope follower
  (EVF) drives effect level only, not LFO depth or rate.
- Pages for MCH (p.25), BCH (p.26), PSM (p.32), SPM (p.41), DOP (p.44) weren't read closely; those
  builds follow the names and the neighbouring algorithms.
- Phaser S/H and per-unit stage counts are fixed at 8 stages; the special 1 / 2 waves are our
  reading of the icons (∩∩ humps / ∪∪ dips).
- Rotor / horn speeds fixed inside the documented ranges (horn 0.8 / 6.8 Hz, rotor 0.6 / 5.6 Hz),
  rise ≈ 1.5 s horn / 3 s rotor.
- The MDL / RNG sub taps and loop EQ are left out.

## Open items

- Second pre-effect, post-effect block, EG1 / EG2, triggers, S/H LFO.
- Noise and ch1 carriers for the ring modulator.
