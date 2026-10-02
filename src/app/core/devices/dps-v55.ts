// DPS-V55 multi-effect processor, after its Operating Instructions and Effect Parameter Guide.
//
// A program holds two effect blocks, FxA and FxB (manual p.8, "Understanding the Effect Types
// and Program Structures"). FxA takes any of the 45 effects; FxB only the 2ch (10–36) and
// Mono-Pair (37–45) ones, and a 4ch effect (01–09) in FxA switches FxB off. The structure is
// parallel ("/", FxA and FxB independent) or serial (FxA feeds FxB). The display shows the
// program's FxA / FxB numbers and structure symbol (p.11), e.g. "FxA:11 / FxB:12".
//
// The front panel edits one parameter at a time (EDIT PARAMETER buttons + rotary encoder, p.6);
// here each block has knobs for its first three parameters (P1–P3, which ones per effect in
// dps-fx.ts) and its direct / effect balance. INPUT LEVEL (p.6) and the master Level (p.5).

import { type FxDef, V55_FX, knobLine } from './dps-fx.ts';
import { choice, pad } from './dps-dsp.ts';
import { type GearDef, p, rack, sel } from '../gear-types.ts';

type Params = Record<string, number>;

/** FxB can't take a 4ch effect (Effect Parameter Guide p.2, note 1). */
export const V55_FXB: FxDef[] = V55_FX.filter((d) => d.ch !== '4ch');
const label = (d: FxDef) => `${pad(d.no)} ${d.code}`;

export function v55Settings(p: Params) {
  const a = V55_FX[choice(p['fxA'], V55_FX.length)];
  const bIndex = choice(p['fxB'], V55_FXB.length + 1);
  // A 4ch effect in FxA takes the whole processor: no FxB (manual p.8).
  const b = a.ch === '4ch' || bIndex === 0 ? undefined : V55_FXB[bIndex - 1];
  return {
    a,
    b,
    aKnobs: [p['a1'], p['a2'], p['a3']],
    bKnobs: [p['b1'], p['b2'], p['b3']],
    aBal: p['aBal'],
    bBal: p['bBal'],
    /** Serial (FxA → FxB); parallel otherwise. Without an FxB it makes no difference. */
    serial: p['struct'] >= 0.5,
  };
}

export const dpsV55: GearDef = rack({
  kind: 'dpsV55',
  label: 'DPS-V55',
  subtitle: 'MULTI-EFFECT PROCESSOR',
  w: 16,
  h: 3,
  params: [
    p('input', 'INPUT', 0.75),
    // Preset 001 "Super Reverb" is FxA:11 / FxB:12 in parallel (manual p.10).
    sel(
      'fxA',
      'FX A',
      V55_FX.map(label),
      V55_FX.findIndex((d) => d.no === 11),
    ),
    p('a1', 'P1', 0.45),
    p('a2', 'P2', 0.3),
    p('a3', 'P3', 0.6),
    p('aBal', 'BAL', 0.4),
    sel('fxB', 'FX B', ['OFF', ...V55_FXB.map(label)], 1 + V55_FXB.findIndex((d) => d.no === 12)),
    p('b1', 'P1', 0.35),
    p('b2', 'P2', 0.2),
    p('b3', 'P3', 0.5),
    p('bBal', 'BAL', 0.3),
    sel('struct', 'STRUCT', ['PARALLEL', 'SERIAL'], 0),
    p('output', 'LEVEL', 0.75),
  ],
  sections: [
    { title: 'INPUT', rows: [['input']] },
    { title: 'FX A', rows: [['fxA', 'a1', 'a2', 'a3', 'aBal']] },
    { title: 'FX B', rows: [['fxB', 'b1', 'b2', 'b3', 'bBal']] },
    { title: 'MASTER', rows: [['struct', 'output']] },
  ],
  display: (params) => {
    const s = v55Settings(params);
    const sym = s.serial && s.b ? '>' : '/';
    return `${pad(s.a.no)}${sym}${s.b ? pad(s.b.no) : '--'} ${s.a.code}\n${knobLine(s.a, 0, s.aKnobs[0])}`;
  },
  face: { panel: '#2a2b2e', text: '#e8e6df', display: '#9fe0ff' },
});
