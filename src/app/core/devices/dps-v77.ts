// DPS-V77 multi-effect processor, after its Operating Instructions ("Understanding the Signal
// Flow", pp.8–9; "Changing the Structure", p.19).
//
// Two blocks, A and B, each an EQ block and an FX block. The EQ sits before or after the effect
// ([Mode] Pre / Post, p.8). The structure joins the blocks: SERI 1 (A → B), SERI 2 (B → A),
// PARA (side by side, mixed) or DUAL (ch 1 through A, ch 2 through B). The MIX block sets the
// FX A, FX B and Dry output levels (p.19). INPUT and OUTPUT are the front-panel knobs (p.6).
//
// The V77's own Effect Parameter Guide isn't among our sources; the manual (p.4) says its FX
// blocks carry effects from the DPS-R7 / D7 / M7 / F7 series plus new ones. So the FX types here
// are the DPS family's (dps-fx.ts: the V55 guide's effects, plus the M7 ring modulator and
// modulation delay and the D7 tap delay), each with three parameter knobs. MORPH (p.16), which
// crossfades between programs, is how every type change behaves here.

import { DPS_EXTRA_FX, type FxDef, V55_FX, knobLine } from './dps-fx.ts';
import { bipolar, choice } from './dps-dsp.ts';
import { type GearDef, bi, p, rack, sel } from '../gear-types.ts';

type Params = Record<string, number>;

/** FX types and the short names the V77 display uses ("CEQ – Hall", p.19). */
const TYPES: [string, string][] = [
  ['Hall2', 'Hall'],
  ['Room2', 'Room'],
  ['Plat2', 'Plate'],
  ['E/R', 'E/R'],
  ['StDLY', 'Delay'],
  ['PpDLY', 'PngPg'],
  ['TapDL', 'TapDl'],
  ['MDly', 'ModDl'],
  ['StPCH', 'Pitch'],
  ['RvSFT', 'RvSft'],
  ['StCHO', 'Chors'],
  ['DcCHO', 'Deca'],
  ['ENS', 'Ensmb'],
  ['StFLN', 'Flang'],
  ['StPHS', 'Phasr'],
  ['StPAN', 'Pan'],
  ['HsPAN', 'Haas'],
  ['Treml', 'Treml'],
  ['Vibrt', 'Vibrt'],
  ['Rotry', 'Rotry'],
  ['Wah', 'Wah'],
  ['Ring', 'Ring'],
  ['Drivr', 'Drive'],
  ['Amp', 'Amp'],
  ['Comp', 'Comp'],
  ['Limit', 'Limit'],
  ['Gate', 'Gate'],
  ['Excit', 'Excit'],
];

const ALL = [...V55_FX, ...DPS_EXTRA_FX];
export const V77_FX: (FxDef & { short: string })[] = TYPES.map(([code, short]) => ({
  ...ALL.find((d) => d.code === code)!,
  short,
}));

export const V77_STRUCTS = ['SERI 1', 'SERI 2', 'PARA', 'DUAL'] as const;
/** The structure symbol in the PLAY title bar (p.19). */
export const V77_SYMBOLS = ['>', '<', '/', ':'];
export const EQ_MODES = ['OFF', 'PRE', 'POST'] as const;

/** The shelving EQ (SEQ, p.17): low shelf at 125 Hz, high shelf at 8 kHz, ±12 dB. */
export const SEQ = { lowHz: 125, highHz: 8000, rangeDb: 12 };

function block(p: Params, x: 'a' | 'b') {
  return {
    fx: V77_FX[choice(p[`${x}Type`], V77_FX.length)],
    knobs: [p[`${x}1`], p[`${x}2`], p[`${x}3`]],
    eq: EQ_MODES[choice(p[`${x}Eq`], 3)],
    lowDb: bipolar(p[`${x}Low`]) * SEQ.rangeDb,
    highDb: bipolar(p[`${x}High`]) * SEQ.rangeDb,
  };
}

export function v77Settings(p: Params) {
  const lvl = (v: number) => Math.pow(v / 0.75, 2);
  return {
    a: block(p, 'a'),
    b: block(p, 'b'),
    structure: choice(p['struct'], 4),
    fxA: lvl(p['lvlA']),
    fxB: lvl(p['lvlB']),
    dry: lvl(p['dry']),
  };
}

export const dpsV77: GearDef = rack({
  kind: 'dpsV77',
  label: 'DPS-V77',
  subtitle: 'MULTI-EFFECT PROCESSOR',
  w: 18,
  h: 3,
  params: [
    p('input', 'INPUT', 0.75),
    // "Block A an intense flanger, block B the largest available reverb" (p.8).
    sel(
      'aType',
      'FX A',
      V77_FX.map((d) => d.short),
      V77_FX.findIndex((d) => d.code === 'StFLN'),
    ),
    p('a1', 'P1', 0.3),
    p('a2', 'P2', 0.7),
    p('a3', 'P3', 0.75),
    sel('aEq', 'EQ A', [...EQ_MODES], 0),
    bi('aLow', 'LOW'),
    bi('aHigh', 'HIGH'),
    sel(
      'bType',
      'FX B',
      V77_FX.map((d) => d.short),
      V77_FX.findIndex((d) => d.code === 'Hall2'),
    ),
    p('b1', 'P1', 0.5),
    p('b2', 'P2', 0.3),
    p('b3', 'P3', 0.6),
    sel('bEq', 'EQ B', [...EQ_MODES], 0),
    bi('bLow', 'LOW'),
    bi('bHigh', 'HIGH'),
    sel('struct', 'STRUCT', [...V77_STRUCTS], 0),
    p('lvlA', 'FX A', 0.75),
    p('lvlB', 'FX B', 0.6),
    p('dry', 'DRY', 0.75),
    p('output', 'OUTPUT', 0.75),
  ],
  sections: [
    { title: 'INPUT', rows: [['input']] },
    {
      title: 'BLOCK A',
      rows: [
        ['aType', 'a1', 'a2', 'a3'],
        ['aEq', 'aLow', 'aHigh'],
      ],
    },
    {
      title: 'BLOCK B',
      rows: [
        ['bType', 'b1', 'b2', 'b3'],
        ['bEq', 'bLow', 'bHigh'],
      ],
    },
    {
      title: 'MIX',
      rows: [
        ['struct', 'lvlA', 'lvlB'],
        ['dry', 'output'],
      ],
    },
  ],
  display: (params) => {
    const s = v77Settings(params);
    return `${s.a.fx.short}${V77_SYMBOLS[s.structure]}${s.b.fx.short}\n${knobLine(s.a.fx, 0, s.a.knobs[0])}`;
  },
  face: { panel: '#1d1e22', text: '#dcdad3', display: '#a8f0c8' },
});
