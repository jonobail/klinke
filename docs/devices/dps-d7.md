# DPS-D7 digital delay

Files: `src/app/core/devices/dps-d7.ts` (catalog, algorithms, knob maths, display),
`src/app/audio/devices/dps-d7-unit.ts` (sound). Shared with the DPS-M7 / V55 / V77:
`src/app/core/devices/dps-dsp.ts` (knob scaling, LFO waves, impulses, saturation),
`src/app/core/devices/dps-taps.ts` (tap patterns), `src/app/audio/devices/dps-blocks.ts`
(Web Audio blocks). Tests: `tests/dps-d7.test.ts`, `tests/dps-dsp.test.ts`.

## Sources

Operating Instructions (scanned, English pp.1–42):
https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-D7-User-Manual.pdf
Service Manual (scanned): https://seriescircuits.com/wp-content/uploads/2026/04/Sony-DPS-D7-Service-Manual.pdf
(skimmed only; the user manual's block chapter was enough for the signal flow).

| Page | What it gave us                                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p.8  | Front panel: POWER, INPUT (two concentric knobs), DRY and EFFECT output knobs, input meter, 40×2 display, LOAD / HELP / EDIT / SAVE / BYPASS / ENTER, operating dial.                                                 |
| p.12 | Block chain INPUT → EQ → DELAY → AUTOPAN → OUTPUT; 12 dB of internal headroom.                                                                                                                                        |
| p.14 | EQ block: bass / PEQ / treble per channel, ±12 dB, bass 16 Hz–6.3 kHz, treble 400 Hz–20 kHz.                                                                                                                          |
| p.15 | Algorithm 1 STD (time only, 0–1365.31 ms); Algorithm 2 FBD (0.021–1365.21 ms, feedback 0–100 % normal / inverse, bass / treble in the loop; "when the gain exceeds 100 % (including feedback EQ)" it keeps sounding). |
| p.16 | Algorithm 3 DBD: pre delay (≤ 682.63 ms) and main delay (≤ 682.44 ms) in series, each with its own feedback and loop EQ.                                                                                              |
| p.17 | Algorithm 4 TPD: 38 taps per channel after a ≤ 99.98 ms pre delay, taps 0–1265.31 ms, each with level and phase; "available as a reflection simulator".                                                               |
| p.18 | Algorithm 5 LGD: one 2730.44 ms line, ch1 + ch2 mixed in, 3-band EQ in the feedback, 29 taps per channel.                                                                                                             |
| p.19 | Algorithm 6 PTD: pre delay with feedback, main delay with feedback, five taps with panpots.                                                                                                                           |
| p.20 | Algorithm 7 MTD: early reflections and pre delays per channel, main lines with taps, cross pre delay, cross taps and cross feedback between channels, loop EQ.                                                        |
| p.21 | Auto panner: wave sin / triangle / special 1 / special 2, 0.1–20 Hz, limit min / max, triggers.                                                                                                                       |
| p.22 | Output block: level, phase, round.                                                                                                                                                                                    |

## What's modelled

`send → EQ (bass / treble) → algorithm (crossfading slot) → auto panner or straight → ret`, with
the base class's dry path at DRY and the return at EFFECT (`faderGain`, ¾ = unity). INPUT is
the base input level. BYPASS passes the dry signal.

| Algo  | TIME          | TIME 2      | FDBK                  | Build                                                          |
| ----- | ------------- | ----------- | --------------------- | -------------------------------------------------------------- |
| 1 STD | ch1 time      | ch2 time    | —                     | two DelayNodes, no feedback; BASS / TREBLE act on the EQ block |
| 2 FBD | ch1 time      | ch2 time    | level / phase         | `StereoDelay`, bass / treble shelves in the loop               |
| 3 DBD | delay 1       | delay 2     | both loops            | two `StereoDelay`s in series                                   |
| 4 TPD | last tap      | pre delay   | level tilt            | 38 + 38 taps as a sparse impulse (ConvolverNode)               |
| 5 LGD | feedback time | tap spacing | level / phase         | `TapLine`: a 2.73 s line with loop EQ, read through 29 taps    |
| 6 PTD | main delay    | pre delay   | both loops            | pre `StereoDelay` → `TapLine` with five panned taps            |
| 7 MTD | ch1 main      | ch2 main    | 35 % self, 65 % cross | 3 + 3 early reflections + cross-coupled `StereoDelay`          |

FDBK is centre-detented: right is "normal", left "inverse" phase (one knob for the manual's level
and phase). Every loop has a unity-gain tanh clip on the way back, so +12 dB of loop EQ at 100 %
feedback self-oscillates (as p.15 warns) but stays bounded; at the defaults repeats die away.
Changing TIME glides the delay (a short pitch slide), changing algorithm crossfades.

Auto panner (PAN, RATE, WIDTH): OFF or one of the four waves, 0.1–20 Hz, sweeping
`±WIDTH` around the centre on a StereoPanner. The special waves are rounded humps (special 1)
and their mirror (special 2), our reading of the M7's wave icons.

Display (2 lines): `2 FBD 413ms` / `R167 FB+40` — algorithm number, code, TIME, then TIME 2
(R = ch2, D2 = delay 2, PD = pre delay, SP = tap spacing) and FDBK (SL = TPD's tap slope).

## Interpretation

- The dial-and-page editor becomes fixed knobs; each algorithm's other parameters are fixed:
  loop shelves at 200 Hz / 4 kHz (the manual's are adjustable), no PEQ band, both channels
  of DBD / LGD / PTD share their settings.
- TPD has no feedback, so FDBK tilts the 38 tap levels (+ dies away, − builds up); tap times are a
  seeded reflection pattern, denser early, ~¼ phase-inverted, ch1 left / ch2 right.
- LGD taps sit on a TIME 2 grid alternating left / right, dying away, plus the feedback tap.
- PTD's five taps are evenly spaced and pan left → right; the pre delay's own feedback is half
  the main one.
- MTD's tap structure is reduced to early reflections + two lines with self / cross feedback.
- Auto-pan triggers (ch1 / ch2 / MIDI, LFO step, start point) are not modelled.
- The input EQ block is used only by the algorithms without a feedback loop (STD, TPD).

## Open items

- PEQ band and adjustable shelf frequencies; per-channel parameters.
- Tap-tempo ("delay time tap in") from a button.
- Auto-panner trigger modes and the output block's phase / round.
