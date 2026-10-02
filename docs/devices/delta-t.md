# DELTA-T — digital delay system (102-S)

Source: _Delta-T Service Manual_ (photos of 19 schematic sheets, no text pages). Page numbers are
the PDF's.

| PDF page | Sheet                | What we used                                                                                                                                                                                             |
| -------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | INP-01 input card    | 15 kHz input filter (12 kHz on A / ALTEC versions), gain-ranging stage 0 / +10 / +20 / +30 dB (G00A–G11A), Hybrid Systems 5678 ADC (FR0–FR10 + MSB = 12 bits).                                           |
| 2        | OM-102 output module | Coarse switches CS0–2 select memory output M01–M08, fine switches FS0–2 the tap slot; DAC-80 12-bit DAC + 2-bit gain (G00D–G11D) undo the ranging; 15 kHz reconstruction filter; word length 12–14 bits. |
| 5        | CTL-01 control       | Gain-ranging logic (step gain up / down one-shots), DOWN 10 / 20 / 30 and LIMIT LEDs.                                                                                                                    |
| 7        | DM-102-S memory      | Taps every 3 ms: D1 3 ms … D15 45 ms; "data out A, 3–24 ms", "data out B, 27–48 ms".                                                                                                                     |
| 8        | VCO-102 option       | 8038 generator, CLOCK MODE EXT / square / triangle / sine / MANUAL / XTAL, FREQ 0.2–20 Hz (×100 range), AMPLITUDE, DELAY OFFSET; calibration 2.21 MHz (DELAY CCW) – 4.43 MHz (CW).                       |
| 9        | BPO option           | Output module "1 of 5".                                                                                                                                                                                  |
| 11       | TIM-01 timing        | Crystal per model; 102-S: 4.437 MHz.                                                                                                                                                                     |

## Signal flow (as built)

`send → 15 kHz 4-pole LPF → (+ REGEN) → gain-ranged 12-bit converter (WaveShaper) → three DelayNode
taps → 15 kHz 4-pole LPF each → LEVEL 1–3 → ret`. REGEN feeds output 1 back to the converter input.

- **Tap delay** = (8 × coarse + fine + 1) × 3 ms: 3–192 ms in 64 steps (eight memory outputs × eight
  3 ms slots). Each output's DELAY knob walks through the 64 switch positions.
- **Clock**: XTAL = 4.437 MHz. MANUAL / SINE / TRI / SQUARE use the VCO: OFFSET sets 2.21–4.43 MHz
  (higher = shorter delay, as in the calibration notes), and every tap scales with the clock period, so
  delays reach up to 2× at 2.21 MHz. The VCO swings the clock by AMPLITUDE around OFFSET, kept inside
  2.21–4.43 MHz.
- **Converters**: samples are amplified by 0 / 10 / 20 / 30 dB when small enough, quantised to 12 bits,
  hard-limited at full scale (LIMIT), and divided back down — quantisation noise rides with the level.

## Interpretation

- The gain ranger is syllabic in hardware (one-shot timed steps); here it's instantaneous per sample
  (a floating-point staircase in a WaveShaper), which is what can be done without a worklet.
- No front-panel document: output modules are shown as DELAY + LEVEL knobs; three of the five output
  modules are modelled, summed to the one OUT jack.
- **REGEN and MIX are additions** (the schematics show no internal recirculation; studios patched it
  through the console).
- Delay ∝ 1 / clock is linearised for the modulation (small-signal); modulation depth is capped so a
  tap never runs backwards (slope < 0.9). A square-wave clock slides each delay over about one delay
  time (the samples already in memory keep their spacing), so SQUARE is smoothed by a low-pass at
  1 / (2 × longest delay) and its depth is limited to ±25 %.
- The ×100 FREQ range (to 2 kHz) and EXT clock input are not modelled.
- Sample rate / bandwidth don't track the VCO clock (a DelayNode runs at the context rate).

## Roadmap

- Separate OUT 1–3 jacks (each output module had its own XLR) — needs extra jacks on the rack face.
- Syllabic gain ranging (attack / release of the step logic) and LED indicators for DOWN 10/20/30 / LIMIT.
