// Types and helpers for the gear catalog, kept apart from the catalog itself so device modules
// (`core/devices/*`) can use them without an import cycle.

/** Rack effects, one module each under `core/devices/` (catalog) and `audio/devices/` (sound). */
export type DeviceKind =
  | 'h949'
  | 'deltaT'
  | 'model200'
  | 'pcm70'
  | 'pcm80'
  | 'dpsD7'
  | 'dpsM7'
  | 'dpsR7'
  | 'dpsV55'
  | 'dpsV77'
  | 'e1010'
  | 'rev5';

export type GearKind =
  | 'ms20'
  | 'modelD'
  | 'sh101'
  | 'mf104'
  | 'sp1200'
  | 'mixer'
  | 'mult'
  | 'deck'
  | 'overdrive'
  | 'delay'
  | 'reverb'
  | 'filter'
  | 'output'
  | DeviceKind;
export type GearCategory = 'synth' | 'source' | 'pedal' | 'mixer' | 'rack' | 'output';
export interface JackDef {
  id: string;
  dir: 'in' | 'out';
  /** Position of the jack's centre, as a fraction of the gear's width / height. */
  fx: number;
  fy: number;
  /**
   * An effects-loop return that feeds a delay line. A cable into it may close a loop through
   * other gear (the delay keeps it stable), so it doesn't count when looking for feedback cycles.
   */
  returns?: boolean;
  /** Name printed by the jack, when it isn't just its id (e.g. LOOP OUT). */
  label?: string;
}

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /** A rotary selector with this many positions (stored as 0, 1/(n-1), … 1). */
  steps?: number;
  /** Names of the selector positions, for the tooltip. */
  options?: string[];
  /** Centre-detented intensity knob: 0.5 is "no effect", either side is ±. */
  bipolar?: boolean;
  /** An on / off rocker switch (stored as 0 / 1), in the colour printed on the hardware. */
  rocker?: 'orange' | 'blue' | 'white';
  /** Drawn as a vertical slider (the SH-101's panel) rather than a knob. */
  slider?: boolean;
  /** A momentary button that sends this command to the unit (e.g. the SH-101's REST). */
  action?: string;
}

export interface PanelSection {
  title: string;
  /** A single column of controls, top to bottom… */
  params?: string[];
  /** …or a grid, row by row (`null` leaves a gap). */
  rows?: (string | null)[][];
  /** An indicator lamp in the section, lit from the unit's first meter (the Model D OVERLOAD). */
  lamp?: string;
}

/** The on-screen keyboard: its first key in semitones from the base C, and how many keys. */
export interface KeyboardDef {
  from: number;
  keys: number;
}

export interface GearDef {
  kind: GearKind;
  label: string;
  category: GearCategory;
  /** Footprint in floor cells. */
  w: number;
  h: number;
  jacks: JackDef[];
  params: ParamDef[];
  /** Only one can exist and it can't be removed (the MAIN • REC output). */
  fixed?: boolean;
  /** Front-panel layout, left to right (the MS-20). */
  sections?: PanelSection[];
  keyboard?: KeyboardDef;
  /** Rack units: the line under the model name (e.g. "DIGITAL REVERBERATOR"). */
  subtitle?: string;
  /** Rack units: what the front-panel display shows for the current settings. */
  display?: (params: Record<string, number>) => string;
  /** Rack units: faceplate and legend colours. */
  face?: { panel: string; text: string; display?: string };
}

export const p = (id: string, label: string, def: number, min = 0, max = 1): ParamDef => ({
  id,
  label,
  min,
  max,
  default: def,
});

export const sel = (id: string, label: string, options: string[], def: number): ParamDef => ({
  ...p(id, label, def / (options.length - 1)),
  steps: options.length,
  options,
});

export const rocker = (
  id: string,
  label: string,
  colour: ParamDef['rocker'],
  on: boolean,
): ParamDef => ({
  ...p(id, label, on ? 1 : 0),
  steps: 2,
  options: ['OFF', 'ON'],
  rocker: colour,
});

export const bi = (id: string, label: string, def = 0.5): ParamDef => ({
  ...p(id, label, def),
  bipolar: true,
});

export const pedal = (kind: GearKind, label: string, params: ParamDef[]): GearDef => ({
  kind,
  label,
  category: 'pedal',
  w: 3,
  h: 4,
  jacks: [
    { id: 'in', dir: 'in', fx: 0.08, fy: 0.97 },
    { id: 'out', dir: 'out', fx: 0.92, fy: 0.97 },
  ],
  params: [...params, p('bypass', 'BYPASS', 0)],
});

/**
 * A 19" rack effect: IN and OUT on the bottom corners, a BYPASS switch (added if the device
 * doesn't declare one), a display, and whatever front-panel `sections` the device lays out.
 */
export const rack = (
  def: Omit<GearDef, 'category' | 'jacks'> & { jacks?: JackDef[] },
): GearDef => ({
  jacks: [
    { id: 'in', dir: 'in', fx: 0.02, fy: 0.96 },
    { id: 'out', dir: 'out', fx: 0.98, fy: 0.96 },
  ],
  ...def,
  category: 'rack',
  params: def.params.some((d) => d.id === 'bypass')
    ? def.params
    : [...def.params, p('bypass', 'BYPASS', 0)],
});
