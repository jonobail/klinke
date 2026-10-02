// One-line descriptions of every piece of gear: what it is and what it's for. Shown when you hover
// over gear on the floor or on the shelf. Model names only, as everywhere in the UI.

import type { GearKind } from './gear-types.ts';

export interface GearInfo {
  /** What kind of thing it is, e.g. "Monophonic synthesizer (1978)". */
  what: string;
  /** What you'd use it for, in a sentence. */
  purpose: string;
}

export const DESCRIPTIONS: Record<GearKind, GearInfo> = {
  ms20: {
    what: 'Monophonic analog synthesizer (1978)',
    purpose:
      'Two oscillators into a screaming high-pass and low-pass filter pair; great for aggressive leads and basses. Its EXT SIG IN runs other sounds through those filters.',
  },
  modelD: {
    what: 'Monophonic analog synthesizer (1970)',
    purpose:
      'Three oscillators into the famous 24 dB ladder filter, with pitch and mod wheels; the classic fat bass and lead synth.',
  },
  sh101: {
    what: 'Monophonic analog synthesizer (1982)',
    purpose:
      'One oscillator with a sub-oscillator and noise into a squelchy 4-pole filter, plus an arpeggiator and 100-step sequencer clocked by its LFO; a bass and acid classic.',
  },
  sp1200: {
    what: 'Sampling drum machine (1987)',
    purpose:
      'Record short sounds from SAMPLE IN at a gritty 12-bit / 26 kHz, then play them from eight pads with per-pad pitch, decay and level.',
  },
  deck: {
    what: 'YouTube audio player',
    purpose:
      'Paste a YouTube link and play its sound out of the OUT jack: into the SP-1200 to sample it, through effects, or to the mixer. Nothing is downloaded or kept.',
  },
  mixer: {
    what: '4-channel mixer',
    purpose: 'Combines up to four sources with level and pan for each, then sends one mix out.',
  },
  mult: {
    what: 'Signal splitter',
    purpose:
      'Copies one input to three outputs, so a sound can feed two places at once (e.g. an effect and a sampler).',
  },
  mf104: {
    what: 'Analog delay pedal',
    purpose:
      'Warm bucket-brigade echoes that darken as they repeat; turn FEEDBACK up for runaway oscillation. Its effects loop puts another pedal inside the repeats.',
  },
  overdrive: {
    what: 'Overdrive pedal',
    purpose: 'Adds warm distortion and grit; DRIVE sets how hard it clips, TONE how bright it is.',
  },
  delay: {
    what: 'Delay pedal',
    purpose: 'Simple echo: repeats the sound after TIME, with FEEDBACK for more repeats.',
  },
  reverb: {
    what: 'Reverb pedal',
    purpose: 'Adds a sense of space, from a small room to a long wash.',
  },
  filter: {
    what: 'Filter pedal',
    purpose: 'A resonant low-pass filter for darkening or sweeping a sound.',
  },
  output: {
    what: 'Main output and recorder',
    purpose: 'Everything you want to hear must be patched into here; it sets the master volume.',
  },
  h949: {
    what: 'Harmonizer (1977)',
    purpose:
      'Pitch-shifts the input up or down, plus delay, flanging and reverse effects; classic for doubling and octave effects.',
  },
  deltaT: {
    what: 'Digital delay (1978)',
    purpose:
      'Early studio digital delay with three independently timed outputs, for slapback, doubling and echo.',
  },
  e1010: {
    what: 'Analog delay (1979)',
    purpose:
      'Bucket-brigade delay from short doubling to 300 ms echo, with tone controls and modulation for chorus and vibrato.',
  },
  model200: {
    what: 'Digital reverb (1984)',
    purpose: 'Studio reverb with hall, plate, chamber and room programs, each with variations.',
  },
  dpsR7: {
    what: 'Digital reverb (1990s)',
    purpose:
      'Hall, room, plate, gated and early-reflection reverbs with detailed decay and tone controls.',
  },
  rev5: {
    what: 'Digital reverb (1987)',
    purpose:
      'Studio reverb with hall, room, vocal and plate programs plus a three-band EQ on the reverb.',
  },
  pcm70: {
    what: 'Digital effects processor (1985)',
    purpose: 'Reverbs, multi-tap and tempo delays, chorus and resonant chords, chosen by program.',
  },
  pcm80: {
    what: 'Digital effects processor (1994)',
    purpose: 'Reverb, delay and chorus algorithms with an ADJUST knob and tempo-synced echoes.',
  },
  dpsD7: {
    what: 'Digital delay (1990s)',
    purpose:
      'Seven delay types, from simple echo to multi-tap and ping-pong, with EQ in the feedback loop and auto-pan.',
  },
  dpsM7: {
    what: 'Modulation effects (1990s)',
    purpose: 'Chorus, flanger, phaser, pitch, panning, ring modulation and rotary-speaker effects.',
  },
  dpsV55: {
    what: 'Multi-effects processor (1990s)',
    purpose:
      'Two effect blocks in series or parallel, picked from 40 effect types (reverbs, delays, modulation, more).',
  },
  dpsV77: {
    what: 'Multi-effects processor (1990s)',
    purpose:
      'Two EQ + effect blocks in four routings with a mixer, for layered reverb, delay and modulation chains.',
  },
};

/** "MS-20 — Monophonic analog synthesizer (1978). Two oscillators …" for a tooltip. */
export const describe = (kind: GearKind, label: string): string => {
  const d = DESCRIPTIONS[kind];
  return `${label} — ${d.what}. ${d.purpose}`;
};
