# JUNO-60

6-voice polyphonic synthesizer (1982). Source: _JUNO-60 Service Notes_, first edition, 10 Apr.
1983 (seriescircuits.com): specifications and top view p.1, block diagram p.3, panel board A / B
schematics pp.5 / 7 (LFO, PWM, the chorus LFO), CPU board p.9 (DCO, IR3109 VCF, IR3R01 ENV),
chorus board p.11 (HPF, VCA LEVEL, two MN3009 BBDs), bender board p.13, circuit descriptions
pp.14–16 (key assignment, master oscillator ranges, PWM, VCF control voltages), adjustment
procedures pp.22–25.

Code: `core/juno60.ts` (maths, catalog entry `JUNO60_GEAR`, tested in `tests/juno60.test.ts`),
`audio/juno60-unit.ts`, and its own panel `gear/juno60-panel.*`, laid out like the hardware: the
rear jack strip; ARPEGGIO, LFO, DCO, HPF, VCF, VCA, ENV, CHORUS and MEMORY across the long black
panel with coloured slider caps, lever switches and lit buttons; the bender panel (VOLUME, TUNE,
DCO / VCF bender depths, OCTAVE TRANSPOSE, LFO TRIG, the lever) left of the 61 keys, between
walnut cheeks.

## Modelled

- **Six fixed voice channels**, built once. **Key assignment** as on p.14: channels go out in the
  cyclic order CH1–CH6, carrying on after the last one used (so releases ring on); a 7th key
  while six are held steals the channel of the first key.
- **DCO** per voice: sawtooth, pulse made by a comparator on the saw (p.14 fig. 2) with PWM
  50 % → 95 % (adjustments 9-1 / 9-2) from LFO, MAN or ENV (each voice its own envelope), and
  the −1 octave square sub-oscillator (p.15 fig. 3) with its level; PULSE / SAW / SUB on-off
  buttons; one shared noise generator into every voice (TR5, panel board A). The master
  oscillator's modulation ranges (p.14): DCO LFO ±300 cent, bender ±700 cent, TUNE ±50 cent.
- **VCF** per voice, 24 dB: FREQ calibrated so FREQ 3 with C4 held gives 248 Hz (8-2), ten
  octaves of travel; RES to the edge of oscillation; ENV with its ± polarity switch, up to ≈30 kHz
  from FREQ 0 (8-9); LFO ±3.3 octaves (45 Hz – 4.5 kHz at FREQ 3.5, 8-7); KYBD 0–100 % around
  C4 (8-3 / 8-4).
- **VCA** per voice: ENV or GATE. **ENV**: A 1 ms–3 s, D 2 ms–12 s, S, R 2 ms–12 s (spec).
- **LFO**: triangle, 0.3–20 Hz, DELAY TIME 0–1.5 s (spec) then a fade-in (fig. 31); TRIG MODE
  AUTO restarts the delay with the first key after all were let go, MAN brings the LFO in only
  while the bender panel's LFO TRIG is held.
- **HPF** after the voice sum (chorus board): position 0 flat, 1–3 one pole each from the
  0.022 / 0.01 / 0.0047 µF selected by the 4051 into 33 kΩ ‖ 470 kΩ: ≈235 Hz, 516 Hz, 1.1 kHz.
- **VCA LEVEL** (IC6), then the **chorus**: the direct signal to both outputs; the signal through
  the two Sallen–Key anti-alias filters (≈9.7 and 10.4 kHz from their 22 kΩ / capacitor values)
  into two BBDs, one swept by the chorus LFO's triangle and one by its inverse (panel board B
  pins 40 / 39), each mixed back into its own side at 39 : 47 (IC8). I, II, or both together
  for I+II. The OUT jack is stereo.
- **Arpeggio**: UP / U&D / DOWN, RANGE 1–3 octaves, RATE 1.5–50 Hz (spec); ARP CLOCK EXT
  stands in for the ARPEGGIO CLOCK jack (one step per pulse, spec): the song tempo, RATE picking
  1/4 … 1/32. Notes go through the key assigner like played keys, gate half a step.
- **HOLD** keeps keys sounding (latches the arpeggio chord); **KEY TRANSPOSE**: press, then a
  key (C4 = none) transposes everything; press again to clear. The amount is kept in the patch.
- **OCTAVE TRANSPOSE** DOWN / NORMAL / UP; **bender** lever with DCO and VCF depth knobs.
- **MEMORY**: PATCH 1–8 load eight preset sounds; the display shows the bank/patch number.

## Interpretation

- The chorus LFO rates and BBD delay sweeps aren't printed in the notes; we use the hardware's
  commonly published measurements: I 0.513 Hz and II 0.863 Hz sweeping 1.66–5.35 ms, I+II
  9.75 Hz sweeping 3.3–3.7 ms. BBD clock noise and hiss aren't modelled.
- The IR3109 is two cascaded 2-pole low-passes, resonance on the second (no self-oscillation).
- PWM in LFO mode swings the width from 50 % toward the slider's setting (unipolar); the VCF
  bender range (±2 octaves at full) and the LFO delay's fade-in time are our choices.
- U&D doesn't repeat its turning notes. The patch memory holds presets, not user patches;
  the factory sounds aren't reproduced. DCB, tape SAVE / LOAD, VCF CONTROL and the output level
  switch aren't modelled.
- The DCO's sub-oscillator is a separate oscillator at half the frequency, started with the saw
  so the two stay locked, rather than a divider on the counter output.
