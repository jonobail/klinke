# CHORD-8

Chord and progression generator: a note effect that makes no sound of its own. Keys come in (the
computer keyboard, MIDI, a timeline MIDI track, the pads or a NOTE IN cable), chords go out of
NOTE OUT, through a small set of player effects. Patch it into MOTION-15 or CHOIR-16 (or any
NOTE IN). Not a copy of any one product: a KLINKE-sized take on the usual chord-generator
feature set (scale chords, generated progressions, strum / arp / rhythm / bounce, per-note bend,
chord recording).

Code: `core/chords.ts` (catalog entry `CHORDS_GEAR` and all the maths: scales, chord building,
voicings, voice leading, the progression and rhythm generators, arp orders, strum, bounce and
slide timings, chord names; tested in `tests/chords.test.ts`), `audio/chords-unit.ts` (the
timing), and its own panel `gear/chords-panel.*`.

## Playing it

- **MODE PADS** (default): the white keys from the keyboard's base C are pads 1–8 (C D E F G A B
  C), wrapping every eight white keys, so the next D is pad 1 again; black keys play nothing.
  Z / X octave shifts move the pads with the keyboard. Holding a pad on the panel does the same.
- **MODE SCALE**: every key plays the diatonic chord built on it. Keys outside the scale snap to
  the nearest scale note (a tie goes down), so any key gives a chord that fits.
- Every held key is its own chord: hold two pads and both sound, each stopping on its own release.
- **NOTE IN** keys count from C3 (MIDI 48) as the pads' base C; their velocity scales VELOCITY.
- The pitch wheel bends every chord note ±2 semitones (as per-note 'expr' bends).

## Controls

- **LCD:** the chord playing (or the last one), with a slash for an inverted bass; key, scale
  and style below, and REC n while recording.
- **STYLE / DICE / REC:** DICE rolls eight new pads in the STYLE, plus a rhythm for PATTERN GEN,
  and saves both with the patch. REC arms chord recording: the next chords you play (built on the
  keys, as in SCALE mode, whatever MODE says) are written onto pads 1–8 in turn; it stops after
  pad 8 or on a second press.
- **Pads:** each shows its numeral and chord in the current key. Hold to play; the mouse wheel over
  a pad steps its chord through the scale's degrees. Lit amber while playing; the pad REC writes
  next has a red rim.
- **HARMONY:** MODE; KEY (12); SCALE (major, minor, dorian, phrygian, lydian, mixolydian,
  harmonic minor, melodic minor); SIZE (AUTO = each pad's own size, triad in SCALE mode; or
  forced TRIAD / 7TH / 9TH / 11TH); VOICING (CLOSE, OPEN = every other note up an octave, DROP 2,
  SPREAD = root an octave down, the rest open); INV (root, 1st, 2nd, 3rd); OCTAVE (±2); LEAD
  (voice leading: each chord takes whichever inversion, an octave either way, moves least from
  the one before, gently pulled back toward the middle so it doesn't drift; INV is ignored while
  it's on).
- **PLAY:** VEL (velocity), STRUM (0–120 ms between notes), DIR (UP, DOWN, ALT = alternating).
- **ARP:** MODE (OFF, UP, DOWN, UP-DN, RANDOM, CHORD = the whole chord on every step), RATE
  (1/4, 1/8, 1/8T, 1/16, 1/16T, 1/32, from the song tempo), OCT (1–3), GATE (also used by
  PATTERN). An arp replaces PATTERN and BOUNCE while it's on.
- **RHYTHM:** PATTERN retriggers the chord on a bar of sixteenths: 4THS, 8THS, OFFBEAT,
  CHARLSTN, BOSSA, SYNCO, or GEN (the rhythm DICE rolled), accents louder, each hit lasting GATE
  of the gap to the next. BOUNCE (0–12 repeats) and TIME (the first gap, 60–800 ms): with ARP
  and PATTERN off, the chord repeats like a dropped ball, each gap 0.7 of the last and each hit
  softer, until the gaps get too short to hear; the last one holds.
- **BEND:** FROM (centre = off, ±12 semitones in quarter steps) and TIME (20 ms–2 s): every
  note starts that far off and slides in, easing out, as per-note bend 'expr' events, so a
  downstream MOTION-15 or CHOIR-16 gets expressive input.

## Progression styles

A weighted Markov walk over the seven degrees, a per-style mix of chord sizes, and the last pad
swapped if it can't lead back into the first (so the eight loop).

- **POP:** I, IV, V and vi around each other; mostly triads.
- **JAZZ:** chains of ii–V–I (every second pad takes the strongest pull most of the time); 7ths
  and 9ths.
- **BOSSA:** Imaj7 to ii9–V7 and back, IV and vi for colour; 9ths; its rhythm leans on the
  syncopated 3-3-4-3-3 comp.
- **MODAL:** hovers on the tonic and the mode's colour chords (ii, IV, vii); open 9ths. Pick
  DORIAN, LYDIAN or MIXOLYDIAN for the colour.
- **CINEMA:** slow tonic, VI, III, VII and iv moves (best in a minor scale); triads and 9ths.

## Interpretation

- The patch stores the progression as text (`prog`: `degree:size` per pad) and the GEN rhythm
  (`gen`), so the dice results and recorded chords travel with the patch; changing KEY or SCALE
  re-spells the pads instead of replacing them.
- The unit emits every event at the moment it should sound (one timer per event; the arp and
  pattern clocks count from their start so they don't drift), so timing is as tight as the
  browser's timers, a few ms. Patterns and arps start on the key press rather than on the bar.
