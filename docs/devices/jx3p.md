# JX-3P

Six-voice polyphonic synthesizer (1983) with its PG-200 programmer. Source: _JX-3P (PG-200)
Service Notes_, first edition, 27 July 1983 (seriescircuits.com). Pages are the PDF's (each is a
two-page spread): specifications, top view and front panel p.1, PG-200 panel p.2, block diagram
p.4, waveforms switching chart p.5, circuit descriptions pp.6–7 (CPU program, assigner, DCO,
SYNC / METAL, VCF, VCA, chorus, sequencer clock), MIDI implementation p.20.

Code: `core/jx3p.ts` (catalog entry, settings, sequencer and the voices, tested in
`tests/jx3p.test.ts`), `audio/jx3p-unit.ts`, and its own panel `gear/jx3p-panel.*`: the PG-200's
DCO-1, DCO-2, FREQ MOD, VCF, VCA, LFO, ENVELOPE and CHORUS across the top (on the hardware they
edit the EDIT MAP's parameters); the JX-3P's black face below with LFO TRIG, BRILLIANCE, VOLUME
and the membrane buttons CHORUS, MUTE, HOLD, KEY TRANSPOSE and the SEQUENCER's WRITE, TIE, REST,
RATE, START / STOP; the bender with its range switch beside the 61 keys.

## Modelled

- **Six voices (12 DCOs), one CPU** (p.6). The assigner as described: a key goes back to the voice
  it last had; otherwise to the voice released longest ago; with all six held, the voice keyed
  longest ago is stolen. Poly only (the JX-3P has no unison mode).
- **DCOs** (pp.4–6): a counter's rectangle, or that rectangle integrated into a sawtooth whose
  capacitor is discharged each cycle. Waveforms SAW / PULSE / SQUARE, DCO-2 also NOISE. PULSE is
  the "pulse-like sawtooth": the CPU drives DCO CV to the top (5 V on the switching chart, p.5), so
  the ramp clips after a fixed time and the pulse narrows as the pitch drops. RANGE 16' / 8' / 4';
  DCO-2 TUNE ±12 semitones and FINE TUNE.
- **CROSS MOD** (p.6, chart p.5): SYNC resets DCO-2's counter at DCO-1's rate; METAL leaves the
  counter free, blocks DCO-2's rectangle, and discharges its ramp on every falling edge of both
  rectangles. Edges are band-limited (PolyBLEP).
- **FREQ MOD**: LFO and ENV depth knobs shared by the two DCOs, each DCO switching them in; the ENV
  polarity switch. Pitch changes are applied once per audio block (2.7 ms), like the CPU's
  periodic DCO update.
- **Mixer**: SOURCE MIX balances DCO-1 and DCO-2 (BAL, p.4).
- **VCF** (p.6–7): 4-pole low-pass with resonance (IR3109), self-oscillating at the top as the
  adjustment procedure implies (p.7, §5); CUTOFF, RESONANCE, LFO MOD, ENV MOD with polarity,
  PITCH FOLLOW 0–100 %, and the face's BRILLIANCE as an offset.
- **VCA** (p.7): ENV or GATE, LEVEL, MUTE.
- **Software ADSR and LFO** (p.6: "ADSR and LFO are software-generated"): one ADSR per voice;
  one LFO (sine, square, random) with DELAY TIME, which fades it in from the first key down after
  all were up, or from LFO TRIG.
- **HPF** after the six voices are mixed, not per voice (block diagram p.4); non-resonant.
- **Stereo chorus** (p.7): two BBDs swept by one triangle 180° apart, 10 kHz filters before and
  after; dry plus one BBD on each side. Delay range from the MN3009 (256 stages at 40–200 kHz,
  0.64–3.2 ms).
- **Bender**: NARROW / MIDDLE / WIDE = ±2 / ±4 / ±7 semitones (p.20), on the DCOs only.
- **HOLD**: keys keep sounding after release until HOLD goes off.
- **Sequencer** (128 steps): WRITE clears the memory and records; each note or chord keyed
  together (up to six) is one step, stored when every key is up; REST adds a silent step, TIE
  lengthens the step before. START / STOP plays it in a loop; KEY TRANSPOSE on, a key moves the
  playing line by its distance from C4 (and doesn't sound); off, keys play along. The sequence is
  saved with the patch (the hardware keeps it in battery-backed RAM).

## Interpretation

- **Clock**: the hardware's sequencer runs on its own oscillator (RATE slider, SEQ TRIG input);
  here it follows the song tempo, RATE choosing 1/32, 1/16, 1/8 or 1/4 steps. Notes sound for
  half a step (plus any ties).
- **Not modelled**: the 32 tone memories, banks and the EDIT / SENS / GROUP A / B parameter
  editing (the PG-200 controls do the editing), tape memory, MIDI, the PG-200's MANUAL / WRITE.
- **Ranges the notes don't print** are chosen to sound and behave like the instrument: CUTOFF
  15 Hz–18 kHz, ENV MOD up to 7 octaves, LFO MOD up to 3 octaves, BRILLIANCE ±1½ octaves, HPF
  40 Hz–1.5 kHz (off fully left), ATTACK 1 ms–5 s, DECAY / RELEASE 2 ms–10 s, LFO 0.1–20 Hz,
  DELAY up to 5 s, FREQ MOD LFO up to ±1 octave and ENV up to 3 octaves, the pulse's 0.5 ms
  width, the chorus sweep (0.65 Hz, 0.8–3 ms) and the SOURCE MIX law (linear).
- Tuning is A4 = 440 Hz like the rest of the studio (the notes tune to 442 Hz, p.7).
- **Where it runs**: the voices, envelopes and LFO run in an AudioWorklet built from
  `Jx3pVoices`'s own source text (loaded as a Blob URL), so the class in `core/jx3p.ts` is both the
  tested reference and the code that plays. The HPF, chorus and volume are Web Audio nodes.
  Cost: idle voices are skipped; six sounding voices are a few percent of one core.
