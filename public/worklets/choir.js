// KLINKE CHOIR-16 processor: up to 16 physically modelled singers in one AudioWorklet. Each singer
// is a glottal pulse (tenseness, breath noise that follows the folds' opening, jitter / shimmer /
// period doubling for rasp, vibrato, scoops and drift) driving a Kelly-Lochbaum tube: one section
// of travel per sample, so the section count is the tract's length (15 for a child, ~23 for a man
// at 48 kHz), with a nasal branch joining halfway up through the velum. Silent singers cost
// nothing. The main thread (audio/choir-unit.ts) decides which singer sings which note and sends
// the vowel table and each singer's body; the maths below mirrors src/app/core/choir.ts, which is
// the tested reference (tests/choir.test.ts runs both).

const GLOTTAL_REFLECTION = 0.75;
const LIP_REFLECTION = -0.85;
const TRACT_LOSS = 0.9985;
const NOSE_LOSS = 0.997;
const BLOCK = 128;
/** Longest tract / nose this processor holds (a big man's tract at 96 kHz). */
const MAX_SECTIONS = 72;
/** STEPS walks through a, e, i, o, u: their chart positions. */
const STEP_XY = [
  [0.3, 1],
  [0.1, 0.33],
  [0, 0],
  [1, 0.33],
  [1, 0],
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Glottal flow derivative over one period (core/choir.ts `glottalPulse`). */
function glottalPulse(phase, oq, skew) {
  const tp = oq * skew;
  if (phase < tp) return 0.075 * (Math.PI / tp) * Math.sin((Math.PI * phase) / tp);
  if (phase < oq) {
    const tc = oq - tp;
    return -0.15 * (Math.PI / 2 / tc) * Math.sin(((Math.PI / 2) * (phase - tp)) / tc);
  }
  return 0;
}

/** How open the folds are, 0–1 (core/choir.ts `glottalFlow`). */
function glottalFlow(phase, oq, skew) {
  const tp = oq * skew;
  if (phase < tp) return 0.5 * (1 - Math.cos((Math.PI * phase) / tp));
  if (phase < oq) return Math.cos(((Math.PI / 2) * (phase - tp)) / (oq - tp));
  return 0;
}

/** The tract's diameter profile, glottis to lips (core/choir.ts `tractDiameters`). */
function tractDiameters(n, tongue, height, lips, jaw, sJaw, sLips, sPharynx, out) {
  const lipLen = 0.06 + 0.04 * (sLips - 1);
  const lipStart = 1 - lipLen;
  const lipD = lips * (1.08 - 0.08 * sLips);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    let d;
    if (x < 0.1) {
      d = 0.5 + 9 * x;
    } else if (x < lipStart) {
      const phase = clamp((x - tongue) / 0.36, -1, 1);
      d = 1.5 - height * Math.cos(Math.PI * phase);
      const front = clamp((x - 0.55) / 0.25, 0, 1);
      d *= lerp(1, (0.7 + 0.6 * jaw) * sJaw, front);
      const back = clamp((0.45 - x) / 0.3, 0, 1);
      d *= lerp(1, sPharynx, back);
      if (x < 0.16) d = lerp(1.4, d, (x - 0.1) / 0.06);
    } else {
      d = lipD;
    }
    out[i] = Math.max(0.05, d);
  }
  return out;
}

/** Nasal branch diameters, velum to nostrils (core/choir.ts `noseDiameters`). */
function noseDiameters(m, velum, size, out) {
  for (let j = 0; j < m; j++) {
    const y = j / (m - 1);
    out[j] = size * (y < 0.4 ? 0.5 + 2 * y : 1.3 - 0.9 * (y - 0.4));
  }
  out[0] = velum;
  return out;
}

/** Bilinear lookup in the vowel table → out[0..3] = tongue, height, lips, jaw. */
function gridLookup(g, size, x, y, out) {
  const fx = clamp(x, 0, 1) * (size - 1);
  const fy = clamp(y, 0, 1) * (size - 1);
  const c0 = Math.min(size - 2, Math.floor(fx));
  const r0 = Math.min(size - 2, Math.floor(fy));
  const tx = fx - c0;
  const ty = fy - r0;
  const i00 = (r0 * size + c0) * 4;
  const i01 = i00 + 4;
  const i10 = i00 + size * 4;
  const i11 = i10 + 4;
  for (let k = 0; k < 4; k++)
    out[k] = lerp(lerp(g[i00 + k], g[i01 + k], tx), lerp(g[i10 + k], g[i11 + k], tx), ty);
  return out;
}

/** VOWEL MOTION offset → out[0], out[1] (core/choir.ts `vowelMotion`). */
function vowelMotion(mode, phase, depth, t, tau, rx, ry, bx, by, out) {
  const w = phase - Math.floor(phase);
  let dx = 0;
  let dy = 0;
  if (mode === 1) {
    dx = 0.4 * depth * Math.cos(2 * Math.PI * w);
    dy = 0.5 * depth * Math.sin(2 * Math.PI * w);
  } else if (mode === 2) {
    const tri = (u) => 1 - 4 * Math.abs(u - Math.floor(u + 0.5));
    dx = 0.4 * depth * tri(w + 0.25);
    dy = 0.5 * depth * tri(w);
  } else if (mode === 3) {
    const v = STEP_XY[Math.floor(phase) % STEP_XY.length];
    dx = (v[0] - bx) * depth;
    dy = (v[1] - by) * depth;
  } else if (mode === 4) {
    const e = Math.exp(-t / Math.max(0.01, tau));
    dx = 0.3 * depth * e;
    dy = -0.9 * depth * e;
  } else if (mode === 5) {
    dx = rx * depth;
    dy = ry * depth;
  }
  out[0] = dx;
  out[1] = dy;
  return out;
}

/** Kelly-Lochbaum reflection for pressure waves going from area a1 into a2. */
const reflection = (a1, a2) => (a1 - a2) / (a1 + a2 || 1);

/** One singer: their body, their voice's state, their tract. */
class Singer {
  constructor(seed) {
    this.rand = seed >>> 0 || 1;
    // Body (overwritten by 'singers')
    this.n = 22;
    this.m = 13;
    this.v = 11;
    this.shape = [1, 1, 1];
    this.noseSize = 1;
    this.pan = 0;
    this.detune = 0;
    this.vibRateMul = 1;
    this.vibDepthMul = 1;
    this.breathMul = 1;
    this.jitterMul = 1;
    this.tenseOffset = 0;
    this.lag = 0;
    this.swayRate = 0.1 + 0.15 * this.random();
    this.swayPhase = this.random();
    // Tract waves (double-buffered) and shape
    const f = () => new Float64Array(MAX_SECTIONS);
    this.R = f();
    this.L = f();
    this.Rn = f();
    this.Ln = f();
    this.NR = f();
    this.NL = f();
    this.NRn = f();
    this.NLn = f();
    this.d = f();
    this.A = f();
    this.kOld = f();
    this.kNew = f();
    this.nd = f();
    this.nk = f();
    this.art = new Float64Array(4);
    this.artTarget = new Float64Array(4);
    this.fresh = true;
    this.reset();
  }

  reset() {
    for (const a of [this.R, this.L, this.Rn, this.Ln, this.NR, this.NL, this.NRn, this.NLn])
      a.fill(0);
    this.active = false;
    this.gate = false;
    this.wait = 0;
    this.env = 0;
    this.quiet = 0;
    this.phase = 0;
    this.odd = false;
    this.amp = 1;
    this.jit = 1;
    this.tilt = 0;
    this.asp = 0;
    this.dcIn = 0;
    this.dcOut = 0;
    this.f = 0;
  }

  random() {
    let s = this.rand;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.rand = s >>> 0;
    return this.rand / 4294967296;
  }

  /** A note starts (or, legato, the pitch moves on without a new attack). */
  start(note, vel, pressure, timbre, legato) {
    const sounding = this.active && this.gate;
    this.note = note;
    if (legato && sounding) {
      this.legato = true;
      return;
    }
    this.legato = false;
    this.bendTarget = 0;
    if (!this.active) {
      this.pitch = note;
      this.bend = 0;
      this.bendTarget = 0;
      this.art.set(this.artTarget);
      this.fresh = true;
    }
    this.pitch = sounding ? this.pitch : note;
    this.active = true;
    this.gate = true;
    this.quiet = 0;
    this.wait = sounding ? 0 : Math.round(this.lag * sampleRate);
    this.vel = vel;
    this.pressure = pressure;
    this.timbre = timbre;
    this.age = 0;
    this.scoopAmt = 1;
    this.vibPhase = this.random();
    this.motionPhase = this.random() * 0.15;
    this.rx = this.random() * 2 - 1;
    this.ry = this.random() * 2 - 1;
    this.drift = (this.random() - 0.5) * 0.5;
    this.driftV = 0;
  }
}

class ChoirProcessor extends (globalThis.AudioWorkletProcessor ?? class {}) {
  constructor() {
    super();
    this.fs = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.singers = Array.from({ length: 16 }, (_, i) => new Singer((i + 1) * 2654435761));
    this.grid = null;
    this.gridSize = 0;
    this.p = {
      vowelX: 0.9,
      vowelY: 0.95,
      motion: 0,
      motionRate: 1,
      motionDepth: 0,
      tense: 0.6,
      breath: 0.1,
      rasp: 0,
      vibDepth: 0.4,
      vibRate: 5.5,
      vibDelay: 0.3,
      scoop: 0.2,
      scoopTime: 0.06,
      drift: 0.05,
      attack: 0.08,
      release: 0.3,
      legato: 0.1,
      velum: 0.05,
      width: 0.6,
      wheel: 0,
    };
    this.wheel = 0;
    this.norm = 1;
    this.tmp = new Float64Array(4);
    this.mo = new Float64Array(2);
    this.lastPost = 0;
    this.posted = false;
    this.latest = -1;
    if (this.port) this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    if (m.type === 'grid') {
      this.grid = m.grid;
      this.gridSize = m.size;
    } else if (m.type === 'params') {
      Object.assign(this.p, m.params);
    } else if (m.type === 'singers') {
      m.list.forEach((b, i) => this.body(this.singers[i], b));
    } else if (m.type === 'on') {
      const s = this.singers[m.s];
      s.start(m.note, m.vel, m.pressure, m.timbre, m.legato);
      this.latest = m.s;
    } else if (m.type === 'expr') {
      const s = this.singers[m.s];
      if (m.bend !== undefined) s.bendTarget = m.bend;
      if (m.pressure !== undefined) s.pressure = m.pressure;
      if (m.timbre !== undefined) s.timbre = m.timbre;
    } else if (m.type === 'off') {
      this.singers[m.s].gate = false;
    } else if (m.type === 'allOff') {
      for (const s of this.singers) s.gate = false;
    } else if (m.type === 'stop') {
      this.stopped = true;
    }
  }

  /** A singer's body changed: a new tract length means new waveguides. */
  body(s, b) {
    const n = Math.min(MAX_SECTIONS, b.n);
    const m = Math.min(MAX_SECTIONS, b.m);
    if (n !== s.n || m !== s.m) {
      s.n = n;
      s.m = m;
      s.reset();
      s.fresh = true;
    }
    s.v = Math.min(n - 2, Math.max(2, b.v));
    s.shape = [b.jaw, b.lips, b.pharynx];
    s.noseSize = b.noseSize;
    s.pan = b.pan;
    s.detune = b.detune;
    s.vibRateMul = b.vibRate;
    s.vibDepthMul = b.vibDepth;
    s.breathMul = b.breath;
    s.jitterMul = b.jitter;
    s.tenseOffset = b.tense;
    s.lag = b.lag;
  }

  /** Per-block control: vowel, tract shape, pitch, loudness. Returns false once a singer is silent. */
  control(s, dt) {
    const p = this.p;
    // Loudness: pressure (velocity until MPE says otherwise) through ATTACK / RELEASE.
    if (s.wait > 0) s.wait = Math.max(0, s.wait - BLOCK);
    const level = 0.3 + 0.7 * clamp(s.pressure, 0, 1);
    const target = s.gate && s.wait === 0 ? level : 0;
    const tau = target > s.env ? p.attack / 3 : p.release / 3;
    s.envFrom = s.env;
    s.env += (target - s.env) * (1 - Math.exp(-dt / Math.max(0.002, tau)));
    if (!s.gate && s.env < 2e-4) {
      if (++s.quiet * dt > 0.15) {
        s.reset();
        return false;
      }
    }
    s.age += dt;

    // Vowel: the chart position, VOWEL MOTION, and timbre (brighter = more open and front).
    const tb = (s.timbre ?? 0.5) - 0.5;
    const bx = clamp(p.vowelX - 0.3 * tb, 0, 1);
    const by = clamp(p.vowelY + 0.6 * tb, 0, 1);
    s.motionPhase += p.motionRate * dt;
    const mo = vowelMotion(
      p.motion,
      s.motionPhase,
      p.motionDepth,
      s.age,
      0.5 / p.motionRate,
      s.rx,
      s.ry,
      bx,
      by,
      this.mo,
    );
    s.x = clamp(bx + mo[0], 0, 1);
    s.y = clamp(by + mo[1], 0, 1);
    if (this.grid) gridLookup(this.grid, this.gridSize, s.x, s.y, s.artTarget);
    const k = s.fresh ? 1 : 1 - Math.exp(-dt / (p.motion === 3 ? 0.03 : 0.045));
    for (let i = 0; i < 4; i++) s.art[i] += (s.artTarget[i] - s.art[i]) * k;
    const a = s.art;
    const sh = s.shape;
    tractDiameters(s.n, a[0], a[1], a[2], a[3], sh[0], sh[1], sh[2], s.d);
    for (let i = 0; i < s.n; i++) s.A[i] = s.d[i] * s.d[i];
    const kOld = s.kOld;
    const kNew = s.kNew;
    for (let i = 1; i < s.n; i++) {
      kOld[i] = s.fresh ? reflection(s.A[i - 1], s.A[i]) : kNew[i];
      kNew[i] = reflection(s.A[i - 1], s.A[i]);
    }
    // The velum opens a little more on open vowels, as it does in speech.
    noseDiameters(s.m, p.velum + 0.05 * a[3], s.noseSize, s.nd);
    for (let j = 1; j < s.m; j++) s.nk[j] = reflection(s.nd[j - 1] ** 2, s.nd[j] ** 2);
    s.noseA = s.nd[0] * s.nd[0];
    s.fresh = false;

    // Pitch: legato glide, bend (smoothed ~7 ms), scoop, vibrato after its delay, drift.
    const glideTau = s.legato ? Math.max(0.005, p.legato / 3) : 0.004;
    s.pitch += (s.note - s.pitch) * (1 - Math.exp(-dt / glideTau));
    s.bend += (s.bendTarget + this.wheel - s.bend) * (1 - Math.exp(-dt / 0.007));
    s.scoopAmt *= Math.exp(-dt / Math.max(0.01, p.scoopTime));
    s.vibPhase += p.vibRate * s.vibRateMul * dt;
    const vibOn = clamp((s.age - p.vibDelay) / 0.4, 0, 1);
    const vib = p.vibDepth * s.vibDepthMul * vibOn * Math.sin(2 * Math.PI * s.vibPhase);
    s.driftV += (s.random() - 0.5) * dt * 4 - s.driftV * dt * 2;
    s.drift = clamp(s.drift + s.driftV * dt, -1, 1) * (1 - dt * 0.2);
    const semis = s.pitch + s.bend + s.detune - p.scoop * s.scoopAmt + vib + s.drift * p.drift;
    s.fFrom = s.f || 440 * Math.pow(2, (semis - 69) / 12);
    s.f = clamp(440 * Math.pow(2, (semis - 69) / 12), 25, 2500);

    // Voice: tenseness rises with pressure; breath and rasp from the style and the singer.
    const tense = clamp(p.tense + s.tenseOffset + 0.3 * (level - 0.65) + 0.2 * tb, 0, 1);
    s.oq = 0.82 - 0.42 * tense;
    s.skew = 0.6 + 0.2 * tense;
    const fc = 1000 + 7000 * tense * tense;
    s.tiltK = 1 - Math.exp((-2 * Math.PI * fc) / this.fs);
    s.breath = clamp(p.breath * s.breathMul + 0.12 * (1 - tense) * p.breath, 0, 1.2);
    s.jitter = (0.003 + 0.035 * p.rasp) * s.jitterMul;
    s.shimmer = 0.05 + 0.45 * p.rasp;
    s.sub = p.rasp > 0.4 ? (p.rasp - 0.4) * 0.9 : 0;
    // Sway: a slow swell and a drift across the stage.
    s.swayPhase += s.swayRate * dt;
    const sway = Math.sin(2 * Math.PI * s.swayPhase);
    s.gain = 1 + 0.06 * sway;
    const pos = clamp(s.pan * p.width + 0.03 * sway, -1, 1);
    s.gl = Math.cos(((pos + 1) * Math.PI) / 4);
    s.gr = Math.sin(((pos + 1) * Math.PI) / 4);
    return true;
  }

  /** Runs one singer for a block, adding into the output channels. */
  sing(s, outL, outR, frames) {
    const fs = this.fs;
    const n = s.n;
    const m = s.m;
    const v = s.v;
    const kOld = s.kOld;
    const kNew = s.kNew;
    const A = s.A;
    const nk = s.nk;
    const Al = A[v - 1];
    const Ar = A[v];
    const An = s.noseA;
    const jSum = 2 / (Al + Ar + An);
    const oq = s.oq;
    const skew = s.skew;
    const tiltK = s.tiltK;
    const breath = s.breath * 0.6;
    const inv = 1 / frames;
    const df = (s.f - s.fFrom) * inv;
    const de = (s.env - s.envFrom) * inv;
    let R = s.R;
    let L = s.L;
    let Rn = s.Rn;
    let Ln = s.Ln;
    let NR = s.NR;
    let NL = s.NL;
    let NRn = s.NRn;
    let NLn = s.NLn;
    let phase = s.phase;
    let tilt = s.tilt;
    let asp = s.asp;
    let dcIn = s.dcIn;
    let dcOut = s.dcOut;
    let rnd = s.rand;
    let jit = s.jit;
    let amp = s.amp;
    let odd = s.odd;
    const jitter = s.jitter;
    const shimmer = s.shimmer;
    const sub = s.sub;
    const f0 = s.fFrom;
    const e0 = s.envFrom;
    const gl = s.gl * s.gain;
    const gr = s.gr * s.gain;
    for (let t = 0; t < frames; t++) {
      const f = f0 + df * t;
      const env = e0 + de * t;
      phase += (f * jit) / fs;
      if (phase >= 1) {
        phase -= 1;
        // A new period: rasp jitters its length and amplitude, and heavy rasp alternates
        // strong and weak pulses (period doubling).
        rnd ^= rnd << 13;
        rnd ^= rnd >>> 17;
        rnd ^= rnd << 5;
        const r1 = (rnd >>> 0) / 4294967296 - 0.5;
        rnd ^= rnd << 13;
        rnd ^= rnd >>> 17;
        rnd ^= rnd << 5;
        const r2 = (rnd >>> 0) / 4294967296 - 0.5;
        jit = 1 + 2 * jitter * r1;
        odd = !odd;
        amp = (1 + shimmer * r2) * (odd ? 1 - sub : 1);
      }
      const g = glottalPulse(phase, oq, skew) * amp;
      const flow = breath > 0 ? glottalFlow(phase, oq, skew) : 0;
      // Aspiration: white noise, brightened, louder while the folds are open.
      rnd ^= rnd << 13;
      rnd ^= rnd >>> 17;
      rnd ^= rnd << 5;
      const white = (rnd >>> 0) / 2147483648 - 1;
      asp += 0.35 * (white - asp);
      const noise = (white - 0.7 * asp) * breath * (0.12 + 0.88 * flow);
      tilt += tiltK * (g + noise - tilt);
      const src = tilt * env;

      // Kelly-Lochbaum scattering, glottis to lips, reflections eased across the block.
      const u = t * inv;
      Rn[0] = (GLOTTAL_REFLECTION * L[0] + src) * TRACT_LOSS;
      Ln[n - 1] = LIP_REFLECTION * R[n - 1] * TRACT_LOSS;
      for (let i = 1; i < n; i++) {
        if (i === v) continue;
        const ko = kOld[i];
        const a = R[i - 1];
        const b = L[i];
        const w = (ko + (kNew[i] - ko) * u) * (a - b);
        Rn[i] = (a + w) * TRACT_LOSS;
        Ln[i - 1] = (b + w) * TRACT_LOSS;
      }
      // The velum: a three-way junction between the throat, the mouth and the nose.
      const a = R[v - 1];
      const b = L[v];
      const c = NL[0];
      const pj = (Al * a + Ar * b + An * c) * jSum;
      Rn[v] = (pj - b) * TRACT_LOSS;
      Ln[v - 1] = (pj - a) * TRACT_LOSS;
      NRn[0] = (pj - c) * NOSE_LOSS;
      for (let j = 1; j < m; j++) {
        const w = nk[j] * (NR[j - 1] - NL[j]);
        NRn[j] = (NR[j - 1] + w) * NOSE_LOSS;
        NLn[j - 1] = (NL[j] + w) * NOSE_LOSS;
      }
      NLn[m - 1] = LIP_REFLECTION * NR[m - 1] * NOSE_LOSS;
      const out = (R[n - 1] + NR[m - 1]) * (1 + LIP_REFLECTION);
      let tmp = R;
      R = Rn;
      Rn = tmp;
      tmp = L;
      L = Ln;
      Ln = tmp;
      tmp = NR;
      NR = NRn;
      NRn = tmp;
      tmp = NL;
      NL = NLn;
      NLn = tmp;
      // DC blocker (~20 Hz), then onto the stage.
      dcOut = out - dcIn + 0.997 * dcOut;
      dcIn = out;
      outL[t] += dcOut * gl;
      outR[t] += dcOut * gr;
    }
    s.R = R;
    s.L = L;
    s.Rn = Rn;
    s.Ln = Ln;
    s.NR = NR;
    s.NL = NL;
    s.NRn = NRn;
    s.NLn = NLn;
    s.phase = phase;
    s.jit = jit;
    s.amp = amp;
    s.odd = odd;
    s.tilt = tilt;
    s.asp = asp;
    s.dcIn = dcIn;
    s.dcOut = dcOut;
    s.rand = rnd >>> 0 || 1;
  }

  process(_inputs, outputs) {
    if (this.stopped) return false;
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    outL.fill(0);
    if (outR !== outL) outR.fill(0);
    const frames = outL.length;
    const dt = frames / this.fs;
    this.wheel += (this.p.wheel - this.wheel) * (1 - Math.exp(-dt / 0.007));
    let mask = 0;
    let level = 0;
    let voices = 0;
    for (let i = 0; i < this.singers.length; i++) {
      const s = this.singers[i];
      if (!s.active || !this.control(s, dt)) continue;
      mask |= 1 << i;
      voices++;
      this.sing(s, outL, outR, frames);
    }
    // A full choir is louder than one singer, but not sixteen times: ease the level as they join.
    const norm = this.norm;
    this.norm += (1 / (1 + 0.12 * Math.max(0, voices - 1)) - norm) * (1 - Math.exp(-dt / 0.08));
    if (voices) {
      const dn = (this.norm - norm) / frames;
      for (let t = 0; t < frames; t++) {
        const g = norm + dn * t;
        outL[t] *= g;
        if (outR !== outL) outR[t] *= g;
      }
    }
    // Live state for the panel's face and singer lamps, ~25 times a second.
    this.lastPost += frames;
    if (this.port && this.lastPost >= this.fs / 25 && (mask || this.posted)) {
      this.lastPost = 0;
      const s = this.singers[this.latest];
      if (s && s.active) level = s.env;
      this.port.postMessage({
        mask,
        x: s && s.active ? s.x : this.p.vowelX,
        y: s && s.active ? s.y : this.p.vowelY,
        level,
      });
      this.posted = mask !== 0;
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') registerProcessor('klinke-choir', ChoirProcessor);
