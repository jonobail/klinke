# Rack devices: how a device is built

Each rack effect lives in its own files, so devices can be built (and changed) independently:

| File | What |
|---|---|
| `src/app/core/devices/<name>.ts` | Catalog entry: `export const <kind>: GearDef = rack({...})`. Pure TypeScript, no Angular or Web Audio, so `node --test` can load it. Put the device's knob → unit maths here too. |
| `src/app/audio/devices/<name>-unit.ts` | The sound: `export class <Name>Unit extends RackUnit`. |
| `tests/<name>.test.ts` | `node --test` tests for the maths. |
| `docs/devices/<name>.md` | Sources (document, page / figure), what was modelled, what's interpretation. |

Shared pieces (change these only deliberately, they affect every device): `core/gear-types.ts`
(`rack()`, `p()`, `sel()`, `bi()`, `rocker()`), `core/devices/index.ts` and
`audio/devices/index.ts` (the registries), `audio/devices/rack-unit.ts`, and the generic rack panel
in `gear/gear-view.*`. `tests/devices.test.ts` checks every device against the contract below.

## Contract

- **Names:** model names only (`PCM-70`, `REV5`), never the manufacturer.
- **Catalog entry** (`rack({...})`):
  - `kind` is the device's `DeviceKind`; `label` the model name; `subtitle` one short line.
  - `w` 6–18 cells, `h` 3–5 (one cell is 40 px at ×3 zoom; a 1U face at h 3 is 120 px).
  - `params`: every control is a 0–1 value. `p(id, label, default)` for knobs,
    `sel(id, label, options, defaultIndex)` for selectors (programs, algorithms, ranges),
    `bi(id, label)` for centre-detented ±, `rocker(id, label, colour, on)` for switches.
    `rack()` adds `bypass` (the panel has a BYPASS button) unless you declare it.
    If there's a `mix` param the base class does an equal-power dry / wet; `input` / `output`
    params set levels (0.75 = unity, see `faderGain`).
  - `sections`: the front panel, left to right, each `{ title, rows: [[id, …], …] }`. Every
    param except `bypass` must appear exactly once. Keep it readable: ≤ 4 rows, short labels.
  - `display(params)`: what the unit's display shows (≤ 24 chars, may contain `\n`), e.g. the
    program number and name.
  - `face`: `{ panel, text, display }` colours to suggest the real faceplate.
  - Extra jacks are fine (e.g. a second output), but `in` and `out` must exist.
- **Unit** (`extends RackUnit`): build the effect between `this.send` and `this.ret` in the
  constructor; `apply(params)` updates it and is called on every knob move, so it must be cheap
  (glide `AudioParam`s with `glide()`; only rebuild buffers / waves when a value really changes).
  - Native Web Audio nodes only (no AudioWorklet): units are built synchronously.
  - Feedback loops must contain a `DelayNode` (Web Audio requires it) and must stay bounded.
  - Meters: channel 0 is the effect input, channel 1 the effect return (free from the base).
  - Clean up anything with timers in `dispose()`.
- **Fidelity:** follow the device's service manual / schematics for the signal flow, controls,
  ranges and algorithms. Where the document doesn't say, choose something sensible and write it
  down as interpretation in `docs/devices/<name>.md`.
