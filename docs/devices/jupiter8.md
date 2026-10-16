# JUPITER-8

8-voice polyphonic synthesizer (1981). Source: _JP-8 Service Notes_, first edition Oct. 1981,
second edition Dec. 1982 (seriescircuits.com): specifications p.1, functional diagram p.6, module
board, module controller, interface and panel board block diagrams p.7, module controller
circuit p.11, adjustment procedures pp.26–29 (each with the panel drawing), the button colours in
the panel parts list p.1.

Code: `core/jupiter8.ts` (settings, arpeggio, key assigner and the voice DSP, tested in
`tests/jupiter8.test.ts`), `audio/jupiter8-unit.ts`, catalog entry `jupiter8` (from
`core/jupiter8.ts`), and its own panel `gear/jupiter8-panel.*`, laid out like the drawing: VOLUME
and ARPEGGIO RATE; LFO, VCO MODULATOR, VCO-1, VCO-2, SOURCE MIX, HPF, VCF, VCA, ENV-1, ENV-2 under
their title bars; the strip of coloured buttons; the bender panel left of the 61 keys.

## Modelled

- **Voices** (module board, p.7; eight, two per board): VCO-1 → VCO-2 → SOURCE MIX → HPF → VCF
  (12 / 24 dB outputs, RES loop) → VCA, with ENV-1 and ENV-2 per voice.
- **VCO-1:** TRIANGLE, SAWTOOTH, PULSE (PWM), SQUARE; RANGE 64'–2'; CROSS MOD: VCO-2 into VCO-1's
  exponential FM, at 5 on the scale ±3 octaves (p.26 §10).
- **VCO-2:** SINE, SAWTOOTH, PULSE (the same PWM), NOISE (the module controller's shared noise
  generator, p.7 / p.11); RANGE 64'–2'; FINE TUNE ±50 cent (spec); SYNC to VCO-1; LOW FREQ drops
  it to sub-audio for cross mod, and its noise becomes slow and wandering (p.29 §24).
- **VCO MODULATOR:** LFO MOD (full scale swings two octaves, p.29 §22) and ENV MOD (ENV-1, full
  scale three octaves, p.26 §8) to VCO-1, BOTH or VCO-2. PULSE WIDTH MOD from LFO, MANUAL or
  ENV-1, from 50 % down to a sliver (p.26 §11).
- **HPF** (non-resonant), **VCF** cutoff, RES to self-oscillation, SLOPE 12 / 24 dB, ENV MOD from
  ENV-1 or ENV-2, LFO MOD, KEY FOLLOW 0–120 % (spec).
- **VCA:** LEVEL and the four-position LFO MOD switch (tremolo). ENV-2 drives the VCA (p.7).
- **ENV-1 / ENV-2:** attack 1 ms–5 s, decay 1 ms–10 s, sustain 0–100 %, release 1 ms–10 s (spec);
  KEY FOLLOW on each (the ENV KF circuit, p.7 / p.11); ENV-1 POLARITY.
- **LFO:** 0.05–40 Hz, DELAY TIME 0–4 s (spec; it fades in after the first key, restarting only
  when every key was up: the total gate, p.11 / p.29 §21); SINE, SAW (falling, p.29 §21),
  SQUARE, RANDOM (a new level each cycle). Its lamp blinks at the rate.
- **ASSIGN MODE:** SOLO, UNISON (all eight voices, a few cents apart), POLY 1, POLY 2; with all
  eight busy the oldest note gives up its voice.
- **ARPEGGIO:** UP, DOWN, U&D, RANDOM over RANGE 1–4 octaves. Clock INT: RATE 1–20 Hz (spec);
  EXT: the song tempo (the EXT CLK jack's job), RATE picking 1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32.
  Steps go through the assign mode, so a UNISON arpeggio is eight voices thick. HOLD latches.
- **HOLD**, **PORTAMENTO** (time knob, ON / OFF; each voice glides from its own last note),
  **MASTER TUNE** ±50 cent.
- **Bender panel:** the lever bends VCO-1 / VCO-2 / VCF through their switches at the BEND VCO /
  VCF depths (±an octave, ±4 octaves at full; our choice). LFO MODULATION (the button, or the
  lever pushed forward) adds the LFO at the LFO MOD VCO / VCF depths.

## Interpretation

- **The voices run as DSP on the audio thread** (`Jupiter8Dsp` in core, sent to an AudioWorklet
  as source text): polyBLEP oscillators, a one-pole HPF, a four-pole ladder solved per sample
  with a soft-clipped input (12 dB from the second pole, 24 dB from the fourth, resonance from
  the fourth either way, as the block diagram's single RES loop does). Native nodes can't
  hard-sync or cross-modulate per sample, and this costs about 5 % of one core for eight voices.
  Modulation (LFO, ENV-1, glide, the filter's coefficients) updates every 8 samples; ENV-2 and
  the audio every sample; silent voices are skipped. Sync resets aren't band-limited.
- **KEY MODE is WHOLE only.** DUAL and SPLIT need a lower and an upper patch; the buttons are
  drawn but disabled, as are PANEL MODE, the patch number / preset buttons and TAPE MEMORY (no
  patch memory: the panel is always MANUAL). BALANCE isn't drawn (it only balances the layers).
  The display shows the arpeggio rate while it runs, else the assign mode.
- **POLY 1 / POLY 2:** the service notes don't describe the assigner. Here POLY 1 hands keys to
  the voices in turn (releases ring on), POLY 2 gives a key back the voice that last played it,
  else the voice free longest. SOLO is last-note priority, legato back to held keys.
- Our choices where the notes print no figure: envelope key follow (times halve every two
  octaves up), LOW FREQ (seven octaves down), HPF 10 Hz–3 kHz, VCF 15 Hz–20 kHz and ENV MOD up to
  six octaves, VCF LFO MOD up to ±2 octaves, VCA LFO MOD depths 0 / 15 / 30 / 50 %, SOURCE MIX
  (each VCO at full in the middle), the unison spread, the pulse's narrowest width.
- The bender panel's LFO MOD rate knob and the PORTAMENTO switch's UPPER ONLY position aren't
  modelled (the latter only matters with layers). The CV / gate jacks, the upper / lower outputs
  and the 7-segment patch display's real contents are not modelled; OUT is mono.
