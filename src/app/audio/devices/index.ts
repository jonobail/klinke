// Web Audio units for the rack effects, by kind (see docs/DEVICES.md).

import type { DeviceKind } from '../../core/gear';
import type { Unit } from '../unit';
import { H949Unit } from './h949-unit';
import { DeltaTUnit } from './delta-t-unit';
import { Model200Unit } from './model200-unit';
import { Pcm70Unit } from './pcm70-unit';
import { Pcm80Unit } from './pcm80-unit';
import { DpsD7Unit } from './dps-d7-unit';
import { DpsM7Unit } from './dps-m7-unit';
import { DpsR7Unit } from './dps-r7-unit';
import { DpsV55Unit } from './dps-v55-unit';
import { DpsV77Unit } from './dps-v77-unit';
import { E1010Unit } from './e1010-unit';
import { Rev5Unit } from './rev5-unit';

export const DEVICE_UNITS: Record<DeviceKind, (ctx: AudioContext) => Unit> = {
  h949: (ctx) => new H949Unit(ctx),
  deltaT: (ctx) => new DeltaTUnit(ctx),
  model200: (ctx) => new Model200Unit(ctx),
  pcm70: (ctx) => new Pcm70Unit(ctx),
  pcm80: (ctx) => new Pcm80Unit(ctx),
  dpsD7: (ctx) => new DpsD7Unit(ctx),
  dpsM7: (ctx) => new DpsM7Unit(ctx),
  dpsR7: (ctx) => new DpsR7Unit(ctx),
  dpsV55: (ctx) => new DpsV55Unit(ctx),
  dpsV77: (ctx) => new DpsV77Unit(ctx),
  e1010: (ctx) => new E1010Unit(ctx),
  rev5: (ctx) => new Rev5Unit(ctx),
};
