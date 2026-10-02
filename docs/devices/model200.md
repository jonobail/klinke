# MODEL 200 — digital reverberator

Files: `src/app/core/devices/model200.ts` (catalog + maths), `src/app/audio/devices/model200-unit.ts`
(sound), `tests/model200.test.ts`. Shared impulse builder: `src/app/core/devices/reverb-ir.ts`
and `src/app/audio/devices/impulse-convolver.ts`.

## Sources

- _Model 200 Service Packet_ (seriescircuits.com, scanned):
  - §1.2 Specifications (p. 1-2): four programs in software V1.2; predelay maximum 39–999 ms
    (program- and size-dependent); size maximum 40–99 m (program-dependent); reverb time about
    0.6–70 s (program- and size-dependent); frequency contouring "full bandwidth (10 kHz), 7 kHz
    or 3 kHz"; displays: 7-segment PROGRAM / REGISTER, PREDELAY, REVERB TIME, SIZE; LEDs for
    pre-echoes on/off, diffusion high/med/low, RT contour low and high (3 positions each),
    rolloff low/med/high; reverberant response 20 Hz–10 kHz, direct 20 Hz–20 kHz.
  - §1.3 Block diagram (p. 1-4): input level (+20 dB gain switch) → INPUT MIX → INPUT MUTE →
    input filters → A/D → digital reverberation processor (with memory, timing & control logic) →
    D/A → output filters → OUTPUT MIX with the direct signal → OUT LEVEL.
  - Table 3.1 (p. 3-2): the front-panel controls (keypad, PGM, REG, STO, CLR, PRE-ECHOES,
    DIFFUSION, RT CONTOUR LOW / HIGH, ROLLOFF) and the three rotary pots PREDELAY, REVERB TIME,
    SIZE.
  - Fig. 4.1 (p. 4-2): the front panel, including the RT CONTOUR legends (low ×1.5 / ×1 / ×.5
    around 100 Hz, high ×1 / ×.5 / ×.25 towards 10 kHz).
  - _M200 Test Report Addendum_ 010-04139 (pp. 4–6, the last pages of the packet): six programs
    with up to ten variations each and the variation keypad grid; "How the controls affect the
    sound": ROLLOFF (HIGH = only the sharp 10 kHz anti-alias filters; MED / LOW a 6 dB/octave
    filter at 7 kHz / 3 kHz), Program 1 (Halls) has a 23 ms minimum predelay, pre-echoes are
    independent of and may come before the predelay, diffusion (high = smoother, more coloured;
    low = clearer), REVERB TIME is the 1 kHz RT60 and is affected by SIZE except in the Inverse
    Room program, variation 0 = variation 1 "more metallic" for when modulation noise is heard.
- The schematics PDF was looked at but not used for the algorithm (the DSP is microcoded).

## What's modelled

- **Programs:** six, as in the Addendum. Signal: send → impulse (pre-echoes + tail, ROLLOFF) →
  slow random-modulation delay → two 10 kHz low-passes (the "very sharp" anti-alias) → MIX.
- **Variation 0–9** follows the keypad grid: rows = size (1–3 and 0 large, 4–6 medium, 7–9
  small) and columns = RT / pre-echoes (1/4/7 medium RT no pre-echoes, 2/5/8 medium RT medium
  pre-echoes, 3/6/9 short RT high pre-echoes). Here the row sets the pre-echo spacing, the column
  the pre-echo level and a ×0.6 RT for the "short" column; variation 0 turns the modulation off.
- **PREDELAY / RVB TIME / SIZE** knobs and readouts with the specified ranges; RT grows with SIZE
  (×0.4…×1) except in the Inverse Room; the predelay ceiling grows with SIZE from 39 to 999 ms;
  Halls never go below 23 ms.
- **PRE-ECHO** switch, **DIFFUSION** (echo build-up time ×2.5 / ×1 / ×0.45), **RT LOW** and
  **RT HIGH** contour (low / high band RT multipliers, crossovers 250 Hz and 3 kHz), **ROLLOFF**
  (6 dB/oct at 3 k / 7 k, or off), **MIX** (the block diagram's OUTPUT MIX).
- The impulse is a three-band exponentially decaying noise tail that starts as sparse echoes and
  fills in; it is rebuilt (debounced 150 ms) only when something that shapes it changes.
- Display: `program.variation NAME` and `predelay ms  RT s  size m`.

## Interpretation

- Program names other than "Halls" and "Inverse Room" aren't in the documents: we use HALL,
  PLATE, CHAMBER, RICH PLATE, INVERSE ROOM, ROOM. Their sizes, densities and build-up times are
  ours.
- On the hardware a variation loads PREDELAY / RT / SIZE values and the knobs only take over once
  turned through them; here the knobs are absolute and the variation sets pre-echoes / RT column.
- Minimum SIZE 8 m; RT knob 0.6–70 s exponential; the Inverse Room's RVB TIME is the length of
  its swell (0.1–1.5 s).
- Pre-echo tap times / levels, crossover frequencies, modulation rate (0.67 Hz, ±0.4 ms).
- Impulses are capped at 8 s, so very long RTs fade out over the last 15 % of that.

## Harness (MS-20 → MODEL 200 → out, MIX full wet)

- Default (1.1 HALL, 34 ms, 2.3 s, 53 m): output 0.62 while held; after release the level falls
  0.7 → 0.3 over ~1 s and below the meter floor (-60 dB) at ~1.6 s.
- RT 12 s: still 0.40 (-36 dB) 4 s after release. RT 0.7 s: gone by 0.5 s.
- 5.1 INVRS (0.3 s swell): stops dead ~0.25 s after release.
- BYPASS: dry 0.8 while held, effect meters 0, silent 50 ms after release. No page errors.

## Open items

- REGISTER store / recall, REVERB STOP and INPUT MUTE (rear-panel jacks), the input +20 dB switch.
- A true recirculating (FDN) tail would allow RT beyond the 8 s impulse cap and modulation inside
  the loop rather than on the output.
