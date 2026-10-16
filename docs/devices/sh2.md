# SH-2

Monophonic synthesizer (1979): two VCOs and a sub-oscillator into a 4-pole VCF, one ADSR, a
delayed LFO and 37 keys. Source: _SH-2 Service Notes_, first printing Oct. 15, 1979
(seriescircuits.com, `Roland-SH-2-Service-Manual.pdf`): specifications and top / rear views p.1,
block diagram p.2, parts list p.3, VCO / modulator schematic (OPH61 / OPH62) p.4, board layouts
pp.5–6, VCF / VCA / ADSR / ENV FOL'R / KCV & TRIG / bender schematic (OPH63 / OPH64 / OPH65) p.7.

Code: `core/sh2.ts` (catalog entry `SH2_GEAR` and the maths, tested in `tests/sh2.test.ts`),
`audio/sh2-unit.ts`, and its own panel `gear/sh2-panel.*`, laid out like the grey original:
the jack strip along the back (OUTPUT, NOTE OUT for CV / GATE OUT, NOTE IN for CV / GATE IN,
AUDIO IN, in the rear-panel order of p.1); TOTAL TUNE, MODULATOR, VCO, VCO-1, VCO-2, SOURCE
MIXER, VCF, VCA and ENV sliders and slide switches with the four rotary RANGE / WAVEFORM knobs;
VOLUME, POWER, PORTAMENTO, the bender SENSITIVITY VCO / VCF sliders and the lever on the black
cheek left of the keys.

## Modelled

- **VCO-1** (p.1, S7 / S10 on p.4): RANGE 32'–2'; WAVEFORM ∿ / saw / square / pulse. The pulse
  is a comparator on the saw: PULSE WIDTH 50 % → ~5 %, PWM MODE ENV / MAN / LFO (S9, VR121).
  The ∿ is the triangle core rounded by the diode clipper after IC19 (D17 / D18).
- **SUB**: VCO-1's square divided by two (the DN819 divider, IC23, p.4): one octave down.
- **VCO-2** (S4 / S6): RANGE 32'–2'; WAVEFORM NOISE / saw / square / narrow pulse; VCO-2 TUNE
  with a WIDE / NARROW switch (S5).
- **VCO MOD** (LFO into both VCOs), **AUTO BEND** (VR120 with C76 / Q46: a swoop into each new
  note, both VCOs), **TOTAL TUNE**.
- **SOURCE MIXER**: SUB, VCO-1, VCO-2 (VR105–VR107). **AUDIO IN** goes through the EXT SIG AMP
  straight into the VCF (p.2) and feeds the envelope follower.
- **VCF** (IC4–IC7, four OTA stages, p.7): CUTOFF 10 Hz – 20 kHz, RESONANCE to self-oscillation,
  ENV amount with the source switch S3 (ENV FOL'R / ENV + / ENV −), MOD (LFO), KYBD.
- **VCA** (S1): HOLD (open: a drone), ENV, GATE.
- **ENV**: A 1 ms–2.5 s, D 2 ms–10 s, S 0–100 %, R 2 ms–10 s; GATE SELECTOR (S2) GATE+TRIG,
  GATE, LFO (the modulator's square gates the ADSR while a key is held).
- **MODULATOR**: ∿ / square / RANDOM (the noise sampled and held at the LFO rate, S/H on p.2),
  RATE 0.2–25 Hz, DELAY TIME 0–1.5 s (fades the modulation in after each trigger), LED.
- **Keys**: 37, low-note priority (the single-bus resistor keyboard into the KCV S/H, p.7).
  In GATE+TRIG every change of the key voltage retriggers (the KCV & TRIG board differentiates
  it), including falling back to a held key; in GATE a legato line keeps one envelope.
  PORTAMENTO 0–5 s on the KCV S/H, always in circuit.
- **Bender**: SENSITIVITY VCO and VCF (VR114 / VR115, p.7). It always bends VCO-2; VCO-1 (and its
  sub) only with VCO-1's BENDER switch ON (S8), so VCO-2 can be bent against VCO-1.

## Interpretation

- The 4-pole filter is two cascaded 2-pole low-passes, resonance on the second.
- The notes don't print: the VCO-2 TUNE spans (WIDE ±1 octave, NARROW ±1 semitone), TOTAL TUNE
  (±1 semitone), the narrow pulse's width (20 %), the AUTO BEND depth and direction (from an
  octave above, decaying with a time constant up to 0.5 s set by the slider), the bender depths
  (±1 octave VCO, ±4 octaves VCF) and the VCO / VCF MOD curves. Those are our choices.
- The ENV FOL'R is the AUDIO IN rectified and smoothed (12 Hz), scaled to about the ADSR's range.
- The original's CV / GATE jacks are the NOTE IN / NOTE OUT jacks here; PHONES isn't modelled.
- The noise is white (one noise transistor, 2SC828, p.3); there's no pink option on the original.
