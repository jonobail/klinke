# CHOIR-16

A physically modelled choir of up to 16 singers. Nothing is sampled: every singer is a model of
vocal folds, throat, mouth, nose and lips computed as they sing, so breath, rasp and vibrato come
out of the model and no two notes are the same. The last link in the note chain CHORD-8 →
MOTION-15 → CHOIR-16 (NOTE cables into **NOTE IN**), and playable directly from the keys, MIDI
and MIDI tracks like any synth.

Code: `core/choir.ts` (catalog entry `CHOIR_GEAR` and all the maths, tested in
`tests/choir.test.ts`), `audio/choir-unit.ts` (allocation, stage and room), the audio-thread
processor `public/worklets/choir.js`, and the panel `gear/choir-panel.*`.

## Modelled

- **Glottal source:** a Rosenberg-style flow pulse (opening, a sharp closure, a closed phase); its
  derivative drives the tract. TENSENESS (from the style, louder singing and timbre) shortens the
  open phase and brightens the spectral tilt; lax voices are softer and breathier.
- **Breath:** aspiration noise, louder while the folds are open (it follows the glottal flow).
- **Rasp:** jitter (period length) and shimmer (pulse height) per cycle; heavy rasp alternates
  strong and weak pulses (period doubling, the growl).
- **Vibrato** with its own rate, depth and onset delay per style; **scoops** (notes start below
  pitch and slide up); slow **drift** and a gentle **sway** of level and stage position, so
  singers move on their own.
- **Vocal tract:** a Kelly-Lochbaum tube, glottis to lips, with glottal and lip reflections and
  wall loss. A cosine tongue body narrows the tract at one place and widens it half a bump away
  (the tongue keeps its volume); the jaw opens the front cavity; the last sections are the lips.
  A **nasal branch** joins halfway up through a three-way junction at the velum.
- **Vowel chart:** ten anchors (i y e ɛ a ɑ ɔ o u ə) at their IPA chart positions, each an
  articulation (tongue place and height, lip opening, jaw); points between are interpolated. The
  anchors were tuned against the model's own resonances (man, 17 cm: /i/ ≈ 230 / 2450 Hz, /ɑ/ ≈
  770 / 1180, /u/ ≈ 250 / 880).
- **Singer bodies:** SINGER CHILD / WOMAN / MAN / MIXED (women and men alternating) sets tract
  length (≈ 11, 14.5, 17 cm) and range; AGE lengthens the tract a little and, for adults, adds
  jitter, breath and a slower, wider vibrato; NECK ±12 % length; JAW oral width; LIPS fullness
  (longer, narrower lip section); NOSE velum opening and nasal size. Each seat also has its own
  seeded quirks (length, shape, detune of a few cents, vibrato rate, breath, entry lag), so a
  choir is never uniform.
- **Styles:** CLASSICAL (tense, dark: lowered larynx and wide throat, strong delayed vibrato), POP
  (breathy, bright, light vibrato), GOSPEL (gritty, big scoops), FOLK (plain, almost straight),
  ROUGH (a strained storyteller's voice: heavy rasp and pressure, slow wide vibrato). BREATH, RASP
  and VIBRATO at half are the style as it is; 0 removes it, full doubles it.
- **Modes:** CHOIR (each note to the next free singer, preferring one whose range suits it; the
  longest-sounding is taken when all are busy), TUTTI (the newest key sings in every singer, each
  in their own octave within their range), SOLO (the first singer alone). LEGATO glides between
  tied notes in TUTTI and SOLO, and letting go of a note returns to the one still held.
- **Vowel motion:** OFF, SINE and TRIANGLE (an ellipse around the set vowel), STEPS (a → e → i →
  o → u), ENVELOPE (each note opens from a closer, rounder vowel), RANDOM (a fresh vowel each
  note); RATE and DEPTH.
- **Expression (MPE on NOTE IN, in every mode):** per-note bend → pitch (smoothed ~7 ms), pressure
  → loudness and tenseness, timbre → a brighter, more open vowel; velocity is the starting
  pressure. Voices are followed by their `voice` id, so MOTION-15 can bend held notes into new
  chords.
- **Stage and room:** singers stand across the stage (WIDTH); ROOM moves the microphone pair back:
  less direct sound, more side-wall reflections (13 / 19 ms, crossed) and more hall tail.
- **The face** mouths the vowel being sung (lips, jaw, tongue); the tract view shows its shape.

## Interpretation

- **One section per sample.** The tract runs at the sample rate with one section of travel per
  sample, so the section count is the tract's length (child ≈ 15, man ≈ 23 at 48 kHz) and lengths
  step in ~7 mm. Such a tube's response mirrors above a quarter of the sample rate, so two
  low-passes at 0.2 × the sample rate follow the processor. Running the tract twice per sample
  would double the cost for detail above ~10 kHz.
- **Cost:** one AudioWorklet holds all 16 singers; silent ones are skipped. Measured in Node
  (V8, 48 kHz): about 1 % of one core per sounding singer, under 20 % with all 16.
- Vowels only: no consonants or words.
- The choir's level eases as more singers join (a full choir is louder than one singer, not
  sixteen times as loud).
