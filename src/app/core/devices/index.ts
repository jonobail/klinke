// The rack effects, in shelf order. Each module exports its catalog entry (see docs/DEVICES.md).

import type { GearDef } from '../gear-types.ts';
import { h949 } from './h949.ts';
import { deltaT } from './delta-t.ts';
import { model200 } from './model200.ts';
import { pcm70 } from './pcm70.ts';
import { pcm80 } from './pcm80.ts';
import { dpsD7 } from './dps-d7.ts';
import { dpsM7 } from './dps-m7.ts';
import { dpsR7 } from './dps-r7.ts';
import { dpsV55 } from './dps-v55.ts';
import { dpsV77 } from './dps-v77.ts';
import { e1010 } from './e1010.ts';
import { rev5 } from './rev5.ts';

export const DEVICES: GearDef[] = [
  h949,
  deltaT,
  model200,
  pcm70,
  pcm80,
  dpsD7,
  dpsM7,
  dpsR7,
  dpsV55,
  dpsV77,
  e1010,
  rev5,
];
