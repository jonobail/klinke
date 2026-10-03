// The gear catalog: what each piece of kit looks like on the floor, its jacks and its controls.
// Sizes are in floor cells; jack positions are fractions of the gear's width and height so the
// cable layer can find them at any zoom. Types and helpers live in `gear-types.ts`; the rack
// effects each have their own module under `devices/`.

import { DEVICES } from './devices/index.ts';
import {
  type DeviceKind,
  type GearDef,
  type GearKind,
  type JackDef,
  bi,
  p,
  pedal,
  rocker,
  sel,
} from './gear-types.ts';

import { KIT_CHANNELS, PADS, PREAMPS, SOUND_IDS } from './sp1200.ts';

export * from './gear-types.ts';

const RANGES = ['LO', "32'", "16'", "8'", "4'", "2'"];
const OSC_WAVES = ['TRIANGLE', 'TRI-SAW', 'SAWTOOTH', 'SQUARE', 'WIDE PULSE', 'NARROW PULSE'];
const OSC3_WAVES = ['TRIANGLE', 'REV SAW', 'SAWTOOTH', 'SQUARE', 'WIDE PULSE', 'NARROW PULSE'];

/** Everything except the rack effects, which come from `devices/`. */
const BUILT_IN: Record<Exclude<GearKind, DeviceKind>, GearDef> = {
  // MS-20 (1978): monophonic, 2 VCOs → mixer → VCHPF → VCLPF → VCA, after the service
  // manual's specifications and block diagram. The audio patch-panel jack is EXT SIG IN, which
  // feeds the filters just as on the hardware.
  ms20: {
    kind: 'ms20',
    label: 'MS-20',
    category: 'synth',
    w: 15,
    h: 6,
    jacks: [
      { id: 'in', dir: 'in', fx: 0.025, fy: 0.98 },
      { id: 'out', dir: 'out', fx: 0.975, fy: 0.98 },
    ],
    params: [
      sel('vco1Wave', 'WAVE FORM', ['TRIANGLE', 'SAWTOOTH', 'PULSE (PW)', 'WHITE NOISE'], 1),
      p('vco1Pw', 'PW', 0.3),
      sel('vco1Scale', 'SCALE', ["32'", "16'", "8'", "4'"], 2),
      sel('vco2Wave', 'WAVE FORM', ['SAWTOOTH', 'SQUARE', 'NARROW PULSE', 'RING MOD'], 1),
      bi('vco2Pitch', 'PITCH', 0.52),
      sel('vco2Scale', 'SCALE', ["16'", "8'", "4'", "2'"], 1),
      bi('tune', 'MASTER TUNE'),
      p('portamento', 'PORTAMENTO', 0),
      bi('fmMg', 'MG/T.EXT'),
      p('fmEg1', 'EG1/EXT', 0),
      p('vco1Level', 'VCO 1', 0.8),
      p('vco2Level', 'VCO 2', 0.45),
      p('hpfCutoff', 'CUTOFF', 0),
      p('hpfPeak', 'PEAK', 0.1),
      bi('hpfMg', 'MG/T.EXT'),
      bi('hpfEg2', 'EG2/EXT'),
      p('lpfCutoff', 'CUTOFF', 0.5),
      p('lpfPeak', 'PEAK', 0.35),
      bi('lpfMg', 'MG/T.EXT'),
      bi('lpfEg2', 'EG2/EXT', 0.78),
      p('mgWave', 'WAVE FORM', 0.5),
      p('mgFreq', 'FREQ', 0.45),
      p('eg1Delay', 'DELAY', 0),
      p('eg1Attack', 'ATTACK', 0.2),
      p('eg1Release', 'RELEASE', 0.3),
      p('eg2Hold', 'HOLD', 0),
      p('eg2Attack', 'ATTACK', 0.05),
      p('eg2Decay', 'DECAY', 0.4),
      p('eg2Sustain', 'SUSTAIN', 0.6),
      p('eg2Release', 'RELEASE', 0.3),
      p('volume', 'VOLUME', 0.7),
    ],
    sections: [
      { title: 'VCO 1', params: ['vco1Wave', 'vco1Pw', 'vco1Scale'] },
      { title: 'VCO 2', params: ['vco2Wave', 'vco2Pitch', 'vco2Scale'] },
      { title: 'VCO MASTER', params: ['tune', 'portamento', 'fmMg', 'fmEg1'] },
      { title: 'MIXER', params: ['vco1Level', 'vco2Level'] },
      { title: 'HIGH PASS', params: ['hpfCutoff', 'hpfPeak', 'hpfMg', 'hpfEg2'] },
      { title: 'LOW PASS', params: ['lpfCutoff', 'lpfPeak', 'lpfMg', 'lpfEg2'] },
      { title: 'MG', params: ['mgWave', 'mgFreq'] },
      { title: 'EG 1', params: ['eg1Delay', 'eg1Attack', 'eg1Release'] },
      { title: 'EG 2', params: ['eg2Hold', 'eg2Attack', 'eg2Decay', 'eg2Sustain', 'eg2Release'] },
      { title: 'VCA', params: ['volume'] },
    ],
    keyboard: { from: 0, keys: 37 }, // C–C, 3 octaves
  },
  // Model D (1970): monophonic, 3 VCOs + noise + external in → mixer → 24 dB ladder filter →
  // VCA, after the service manual's front-panel diagram (fig. 7-1), block diagram (dwg. 1429)
  // and left-hand controller schematic (fig. 9-12).
  modelD: {
    kind: 'modelD',
    label: 'MODEL D',
    category: 'synth',
    w: 20,
    h: 6,
    jacks: [
      { id: 'in', dir: 'in', fx: 0.02, fy: 0.98 },
      { id: 'out', dir: 'out', fx: 0.98, fy: 0.98 },
    ],
    params: [
      // Controllers
      bi('tune', 'TUNE'),
      p('glide', 'GLIDE', 0.3),
      p('modMix', 'MOD MIX', 0),
      rocker('oscMod', 'OSC MOD', 'orange', false),
      rocker('osc3Kbd', 'OSC 3', 'orange', true),
      // Oscillator bank
      sel('osc1Range', 'RANGE', RANGES, 3),
      sel('osc1Wave', 'WAVE', OSC_WAVES, 2),
      sel('osc2Range', 'RANGE', RANGES, 3),
      bi('osc2Freq', 'FREQ', 0.515),
      sel('osc2Wave', 'WAVE', OSC_WAVES, 2),
      sel('osc3Range', 'RANGE', RANGES, 2),
      bi('osc3Freq', 'FREQ', 0.49),
      sel('osc3Wave', 'WAVE', OSC3_WAVES, 0),
      // Mixer
      p('osc1Vol', 'OSC 1', 0.8),
      rocker('osc1On', 'ON', 'blue', true),
      p('extVol', 'EXT IN', 0.7),
      rocker('extOn', 'ON', 'blue', false),
      p('osc2Vol', 'OSC 2', 0.65),
      rocker('osc2On', 'ON', 'blue', true),
      p('noiseVol', 'NOISE', 0.5),
      rocker('noiseOn', 'ON', 'blue', false),
      rocker('noisePink', 'PINK', 'white', false),
      p('osc3Vol', 'OSC 3', 0.5),
      rocker('osc3On', 'ON', 'blue', false),
      // Modifiers: filter
      rocker('filterMod', 'MOD', 'orange', false),
      rocker('kbd1', 'KBD 1', 'orange', true),
      rocker('kbd2', 'KBD 2', 'orange', false),
      p('cutoff', 'CUTOFF', 0.4),
      p('emphasis', 'EMPHASIS', 0.35),
      p('contour', 'CONTOUR', 0.55),
      p('fAttack', 'ATTACK', 0.08),
      p('fDecay', 'DECAY', 0.45),
      p('fSustain', 'SUSTAIN', 0.35),
      // Modifiers: loudness contour
      p('lAttack', 'ATTACK', 0.03),
      p('lDecay', 'DECAY', 0.45),
      p('lSustain', 'SUSTAIN', 0.85),
      // Output
      p('volume', 'VOLUME', 0.7),
      rocker('mainOn', 'MAIN', 'blue', true),
      rocker('a440', 'A-440', 'blue', false),
      // Left-hand controller (the pitch wheel springs back, so it isn't stored)
      rocker('glideOn', 'GLIDE', 'white', false),
      rocker('decayOn', 'DECAY', 'white', true),
      p('modWheel', 'MOD', 0),
    ],
    sections: [
      { title: 'CONTROLLERS', rows: [['tune'], ['glide', 'modMix'], ['oscMod', 'osc3Kbd']] },
      {
        title: 'OSCILLATOR BANK',
        rows: [
          ['osc1Range', null, 'osc1Wave'],
          ['osc2Range', 'osc2Freq', 'osc2Wave'],
          ['osc3Range', 'osc3Freq', 'osc3Wave'],
        ],
      },
      {
        title: 'MIXER',
        lamp: 'OVERLOAD',
        rows: [
          ['osc1Vol', 'osc1On', null],
          ['extVol', 'extOn', null],
          ['osc2Vol', 'osc2On', null],
          ['noiseVol', 'noiseOn', 'noisePink'],
          ['osc3Vol', 'osc3On', null],
        ],
      },
      {
        title: 'FILTER',
        rows: [
          ['filterMod', 'kbd1', 'kbd2'],
          ['cutoff', 'emphasis', 'contour'],
          ['fAttack', 'fDecay', 'fSustain'],
        ],
      },
      { title: 'LOUDNESS', rows: [['lAttack', 'lDecay', 'lSustain']] },
      { title: 'OUTPUT', rows: [['volume'], ['mainOn'], ['a440']] },
    ],
    keyboard: { from: -7, keys: 44 }, // F–C, 3½ octaves
  },
  mixer: {
    kind: 'mixer',
    label: '4CH MIXER',
    category: 'mixer',
    w: 6,
    h: 5,
    jacks: [
      { id: 'in1', dir: 'in', fx: 0.09, fy: 0.97 },
      { id: 'in2', dir: 'in', fx: 0.23, fy: 0.97 },
      { id: 'in3', dir: 'in', fx: 0.37, fy: 0.97 },
      { id: 'in4', dir: 'in', fx: 0.51, fy: 0.97 },
      { id: 'out', dir: 'out', fx: 0.91, fy: 0.97 },
    ],
    params: [1, 2, 3, 4]
      .flatMap((n) => [p(`pan${n}`, `PAN ${n}`, 0.5), p(`level${n}`, `CH ${n}`, 0.75)])
      .concat(p('pan5', 'BAL', 0.5), p('master', 'MAIN', 0.8)),
  },
  overdrive: pedal('overdrive', 'OVERDRIVE', [
    p('drive', 'DRIVE', 0.5),
    p('tone', 'TONE', 0.5),
    p('level', 'LEVEL', 0.6),
  ]),
  delay: pedal('delay', 'DELAY', [
    p('time', 'TIME', 0.35),
    p('feedback', 'FDBK', 0.4),
    p('mix', 'MIX', 0.35),
  ]),
  reverb: pedal('reverb', 'REVERB', [
    p('size', 'SIZE', 0.6),
    p('damp', 'DAMP', 0.4),
    p('mix', 'MIX', 0.3),
  ]),
  filter: pedal('filter', 'FILTER', [
    p('cutoff', 'CUTOFF', 0.5),
    p('reso', 'RESO', 0.3),
    p('mix', 'MIX', 1),
  ]),
  // MF-104 analog delay, after the schematics (BRD-10-011-360 rev E, daughterboard -365): DRIVE,
  // TIME, FEEDBACK, MIX, OUTPUT and LOOP GAIN pots, RANGE and INT/EXT LOOP switches, a bypass
  // footswitch, and the LOOP OUT / LOOP IN effects-loop jacks.
  mf104: {
    kind: 'mf104',
    label: 'MF-104',
    category: 'pedal',
    w: 6,
    h: 4,
    jacks: [
      { id: 'in', dir: 'in', fx: 0.04, fy: 0.97 },
      { id: 'loopOut', dir: 'out', fx: 0.4, fy: 0.97, label: 'LOOP OUT' },
      { id: 'loopIn', dir: 'in', fx: 0.6, fy: 0.97, returns: true, label: 'LOOP IN' },
      { id: 'out', dir: 'out', fx: 0.96, fy: 0.97 },
    ],
    params: [
      p('drive', 'DRIVE', 0.35),
      p('time', 'TIME', 0.5),
      p('feedback', 'FEEDBACK', 0.4),
      p('mix', 'MIX', 0.4),
      p('output', 'OUTPUT', 0.7),
      p('loopGain', 'LOOP GAIN', 0.5),
      sel('range', 'RANGE', ['SHORT', 'LONG'], 0),
      { ...sel('loop', 'LOOP', ['INT', 'EXT'], 0), rocker: 'white' },
      p('bypass', 'BYPASS', 0),
    ],
  },
  // SH-101 (1982): monophonic, VCO + sub-oscillator + noise → 4-pole VCF → VCA, with an LFO that
  // also clocks the arpeggiator and the 100-step sequencer. After the service notes: specs and
  // top view p.1, block diagram p.2, CPU program pp.3–4.
  sh101: {
    kind: 'sh101',
    label: 'SH-101',
    category: 'synth',
    w: 18,
    h: 10,
    // OUTPUT sits in the jack strip along the back, top right, as on the hardware.
    jacks: [{ id: 'out', dir: 'out', fx: 0.975, fy: 0.03, label: 'OUTPUT' }],
    params: [
      p('volume', 'VOLUME', 0.7),
      p('portaTime', 'PORTA', 0.2),
      sel('portaMode', 'PORTA', ['OFF', 'ON', 'AUTO'], 0),
      sel('transpose', 'TRANSPOSE', ['L', 'M', 'H'], 1),
      { ...p('bendVco', 'B.VCO', 0.2), slider: true },
      { ...p('bendVcf', 'B.VCF', 0), slider: true },
      { ...p('lfoMod', 'LFO MOD', 0.3), slider: true },
      sel('arp', 'ARP', ['OFF', 'UP', 'U&D', 'DOWN'], 0),
      sel('seq', 'SEQ', ['OFF', 'LOAD', 'PLAY'], 0),
      rocker('hold', 'HOLD', 'white', false),
      { ...p('rest', 'REST', 0), action: 'rest' },
      { ...p('lfoRate', 'RATE', 0.45), slider: true },
      sel('lfoWave', 'WAVE', ['TRIANGLE', 'SQUARE', 'RANDOM', 'NOISE'], 0),
      { ...p('vcoMod', 'MOD', 0), slider: true },
      sel('range', 'RANGE', ["16'", "8'", "4'", "2'"], 1),
      { ...p('pulseWidth', 'PW', 0.3), slider: true },
      sel('pwmSource', 'PWM', ['LFO', 'MAN', 'ENV'], 1),
      bi('tune', 'TUNE'),
      { ...p('pulse', 'PULSE', 0.6), slider: true },
      { ...p('saw', 'SAW', 0.7), slider: true },
      { ...p('sub', 'SUB', 0), slider: true },
      { ...p('noise', 'NOISE', 0), slider: true },
      sel('subMode', 'SUB', ['1 OCT', '2 OCT', '2 OCT PW'], 0),
      { ...p('cutoff', 'FREQ', 0.55), slider: true },
      { ...p('resonance', 'RES', 0.25), slider: true },
      { ...p('vcfEnv', 'ENV', 0.45), slider: true },
      { ...p('vcfMod', 'MOD', 0), slider: true },
      { ...p('vcfKybd', 'KYBD', 0.5), slider: true },
      sel('vcaMode', 'VCA', ['ENV', 'GATE'], 0),
      { ...p('attack', 'A', 0.05), slider: true },
      { ...p('decay', 'D', 0.45), slider: true },
      { ...p('sustain', 'S', 0.55), slider: true },
      { ...p('release', 'R', 0.25), slider: true },
      sel('envTrigger', 'TRIG', ['GATE+TRIG', 'GATE', 'LFO'], 0),
    ],
    // The panel is its own component (gear/sh101-panel), laid out like the hardware.
    keyboard: { from: -7, keys: 32 }, // F–C, 32 keys (spec)
  },
  // SP-1200 sampling drum machine, after the owner's manual. Global controls, then per sound
  // location (A1–D8): level, slider (tune or decay), decay mode, output channel, truncation and loop.
  sp1200: {
    kind: 'sp1200',
    label: 'SP-1200',
    category: 'synth',
    // About 1.2 : 1 like the tabletop original; the jacks sit in the bottom band's corners.
    w: 15,
    h: 12,
    jacks: [
      { id: 'in', dir: 'in', fx: 0.035, fy: 0.975, label: 'SAMPLE IN' },
      { id: 'out', dir: 'out', fx: 0.965, fy: 0.975, label: 'MIX OUT' },
    ],
    params: [
      sel('bank', 'BANK', ['A', 'B', 'C', 'D'], 0),
      sel(
        'pad',
        'SOUND',
        Array.from({ length: PADS }, (_, i) => String(i + 1)),
        0,
      ),
      // The Performance mode button: 0 = MIX, 1 = TUNE/DECAY (as saved before MULTI existed).
      sel('sliders', 'SLIDERS', ['MIX', 'MULTI MODE', 'TUNE/DECAY'], 0),
      p('volume', 'MIX VOLUME', 0.7),
      p('metronome', 'METRONOME VOLUME', 0.5),
      p('gain', 'GAIN', 0.75),
      sel('preamp', 'PREAMP', PREAMPS, 0),
      p('threshold', 'THRESHOLD', 0.3),
      p('length', 'LENGTH', 0.375), // 1.0 s
      ...SOUND_IDS.flatMap((id, n) => {
        const kit = n < PADS; // bank A: the stand-in drum kit
        return [
          p(`lvl${id}`, `LEVEL ${id}`, 0.75),
          p(`tune${id}`, `TUNE ${id}`, 0.5),
          rocker(`dmode${id}`, `DECAY MODE ${id}`, 'white', kit && (n === 2 || n === 3)),
          sel(
            `ch${id}`,
            `CHANNEL ${id}`,
            ['1', '2', '3', '4', '5', '6', '7', '8'],
            kit ? KIT_CHANNELS[n] - 1 : 6,
          ),
          p(`start${id}`, `START ${id}`, 0),
          p(`end${id}`, `END ${id}`, 1),
          p(`loop${id}`, `LOOP ${id}`, 0),
        ];
      }),
    ],
  },
  // A passive mult: one input copied to three outputs, for sending a signal two places at once
  // (e.g. a synth to both its effects chain and the SP-1200's SAMPLE IN).
  mult: {
    kind: 'mult',
    label: 'MULT',
    category: 'mixer',
    w: 2,
    h: 3,
    jacks: [
      { id: 'in', dir: 'in', fx: 0.5, fy: 0.12 },
      { id: 'out', dir: 'out', fx: 0.2, fy: 0.95 },
      { id: 'out2', dir: 'out', fx: 0.5, fy: 0.95, label: 'OUT 2' },
      { id: 'out3', dir: 'out', fx: 0.8, fy: 0.95, label: 'OUT 3' },
    ],
    params: [],
  },
  output: {
    kind: 'output',
    label: 'MAIN • REC',
    category: 'output',
    w: 5,
    h: 5,
    jacks: [{ id: 'in', dir: 'in', fx: 0.04, fy: 0.95 }],
    params: [p('volume', 'VOL', 0.8)],
    fixed: true,
  },
};

export const GEAR = {
  ...BUILT_IN,
  ...Object.fromEntries(DEVICES.map((d) => [d.kind, d])),
} as Record<GearKind, GearDef>;

/** What the inventory shelf offers, in shelf order. */
export const INVENTORY: GearKind[] = [
  'ms20',
  'modelD',
  'sh101',
  'mixer',
  'sp1200',
  'mult',
  'mf104',
  'overdrive',
  'delay',
  'reverb',
  'filter',
  ...DEVICES.map((d) => d.kind),
];

export const jackDef = (kind: GearKind, jack: string): JackDef | undefined =>
  GEAR[kind].jacks.find((j) => j.id === jack);

export const defaultParams = (kind: GearKind): Record<string, number> =>
  Object.fromEntries(GEAR[kind].params.map((d) => [d.id, d.default]));
