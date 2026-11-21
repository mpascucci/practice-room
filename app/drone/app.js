// Drone — additive drone: one sine partial per harmonic, bellows-like breathing.

const SOLFEGE = ['DO', 'DO♯', 'RE', 'RE♯', 'MI', 'FA', 'FA♯', 'SOL', 'SOL♯', 'LA', 'SI♭', 'SI'];
const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
// Note-name notation, app-wide (set in the tuner, also used by the metronome): 'both' ("DO - C4"), 'solfege' ("DO4")
// or 'letters' ("C4"). Stored under its own key, shared by all panes; a change in one pane reaches the others as a
// `storage` event.
const NOTATION_KEY = 'practice-room:notation';
const NOTATIONS = ['both', 'solfege', 'letters'];
const readNotation = () => { try { const v = localStorage.getItem(NOTATION_KEY); return NOTATIONS.includes(v) ? v : 'both'; } catch { return 'both'; } };
let notation = readNotation();
const noteName = (sol, letter, oct = '') => (notation === 'solfege' ? `${sol}${oct}`
  : notation === 'letters' ? `${letter}${oct}` : `${sol} - ${letter}${oct}`);
const HARMONICS = 13;
const STORAGE_KEY = 'shrutibox:v1';
const ATTACK = 0.6, RELEASE = 0.9, GLIDE = 0.08; // seconds

// Sweep: harmonics from H(state.mod.from − 1) up get a sinusoidal gain modulation,
// phase-staggered so the emphasis travels upward through the spectrum.
const MOD_FROM_MIN = 2, MOD_FROM_MAX = 12;         // selectable starting harmonic
const modStart = () => state.mod.from - 1;         // index of the first swept harmonic
const RATE_MIN = 0.02, RATE_MAX = 2;               // Hz, log-mapped slider
const rateFromPos = (p) => RATE_MIN * Math.pow(RATE_MAX / RATE_MIN, p / 100);
const posFromRate = (r) => 100 * Math.log(r / RATE_MIN) / Math.log(RATE_MAX / RATE_MIN);
// Reflected travelling wave: a sine pattern across the swept harmonics whose position
// swings up by one wavelength and back (smooth turnaround) once per sweep cycle.
// u = LFO phase (radians); returns the modulation signal in [-1, 1] for harmonic i.
function sweepSignal(i, u) {
  const s = modStart();
  const x = Math.max(0, i - s) / (HARMONICS - s);   // position of harmonic in the swept range
  const shift = Math.PI * (1 - Math.cos(u));        // 0 → 2π → 0 over one cycle
  return Math.sin(shift - 2 * Math.PI * x);
}

// Tuner temperaments: cents above the anchor (reference) note of the 12 chromatic degrees. The anchor is chosen per
// temperament in the tuner (state.refs), `ref` being the usual one used as default:
// - just, Pythagorean, meantone: the scale is built on the anchor (default C, the usual layout of these scales);
// - `fixed` well-temperaments, listed from C: keep their historical layout, the anchor only picks which note is exact
//   (default A, as tuners and baroque players set them);
// - Turkish/Arabic (`sys`): the anchor is the pitch sounded by Rast (default G = bolahenk, C for Arabic).
// The anchor itself is at its equal-tempered pitch at the current A4.
const COMMA_CENTS = 1200 / 53;   // Turkish/Ottoman koma: 1/53 octave (about 22.64 ¢), 9 commas = one whole tone
const REF_A_MIN = 400, REF_A_MAX = 480;
const TEMPERAMENTS = [
  { id: 'equal', name: 'Equal temperament', cents: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100] },
  { id: 'just', name: 'Just intonation (5-limit)', ref: 0, cents: [0, 111.73, 203.91, 315.64, 386.31, 498.04, 590.22, 701.96, 813.69, 884.36, 1017.6, 1088.27] },
  { id: 'pythagorean', name: 'Pythagorean', ref: 0, cents: [0, 113.69, 203.91, 294.13, 407.82, 498.04, 611.73, 701.96, 815.64, 905.87, 996.09, 1109.78] },
  { id: 'meantone', name: 'Quarter-comma meantone', ref: 0, cents: [0, 76.05, 193.16, 310.26, 386.31, 503.42, 579.47, 696.58, 772.63, 889.74, 1006.84, 1082.89] },
  { id: 'werckmeister', name: 'Werckmeister III', fixed: true, ref: 9, cents: [0, 90.22, 192.18, 294.13, 390.22, 498.04, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18] },
  { id: 'kirnberger', name: 'Kirnberger III', fixed: true, ref: 9, cents: [0, 90.22, 193.16, 294.13, 386.31, 498.04, 590.22, 696.58, 792.18, 889.74, 996.09, 1088.27] },
  { id: 'vallotti', name: 'Vallotti', fixed: true, ref: 9, cents: [0, 94.13, 196.09, 298.04, 392.18, 501.96, 592.18, 698.04, 796.09, 894.13, 998.04, 1090.22] },
  { id: 'turkish', name: 'Turkish (53 koma)', sys: 'turkish', ref: 7 },
  { id: 'arabic', name: 'Arabic (24 quarter tones)', sys: 'arabic', ref: 0 },
];

// Turkish (Arel-Ezgi-Uzdilek) system: the octave is 53 commas (koma) on a Pythagorean grid, C = 0:
// whole tone = 9, limma (E-F, B-C) = 4. Each natural note takes ±1 (koma) and ±4 (bakiye) accidentals, which reaches
// the 5- and 8-comma positions from the neighbouring note. Rast (SOL) sits at 31 and anchors the grid on the Rast note chosen below.
const TR_RAST_POS = 31;   // Rast = SOL on the grid below
const TR_NATURALS = [[0, 'DO'], [9, 'RE'], [18, 'MI'], [22, 'FA'], [31, 'SOL'], [40, 'LA'], [49, 'SI']];
// Accidentals drawn as small inline SVGs (no font dependency): koma ♯ (half sharp), bakiye ♯, bakiye ♭, koma ♭ (reversed flat).
const accSvg = (w, body) => `<svg class="acc" viewBox="0 0 ${w} 20" aria-hidden="true">${body}</svg>`;
const TR_ACC = {
  1: accSvg(8, '<path d="M4 1.5v17M0.8 8.2l6.4-2M0.8 13.6l6.4-2"/>'),
  4: accSvg(12, '<path d="M4.2 2v16M8.2 1.4v16M1 8.2l10-2.6M1 13.8l10-2.6"/>'),
  '-4': accSvg(9, '<path d="M2.5 1v17M2.5 11.5C9 7 10 15.5 2.5 18"/>'),
  '-1': accSvg(9, '<path d="M6.5 1v17M6.5 11.5C0 7 -1 15.5 6.5 18"/>'),
};
// Traditional makam names, by grid position. Only the ones that are unambiguous are listed.
const TR_NAME_RANGE = 50;   // cents: the tuner keeps a traditional name while the pitch is this close to it
const TR_NAMES = { 0: 'Çârgâh', 9: 'Nevâ', 18: 'Hüseynî', 22: 'Acem', 31: 'Rast', 40: 'Dügâh', 44: 'Kürdî', 48: 'Segâh', 49: 'Buselik' };
const TR_NOTES = (() => {
  const out = [];
  TR_NATURALS.forEach(([pos, name], i) => {
    const next = TR_NATURALS[(i + 1) % 7][0] + (i === 6 ? 53 : 0), gap = next - pos;
    const accs = gap === 9 ? [0, 1, 4, -4, -1] : [0, 1, -1];
    const offs = gap === 9 ? [0, 1, 4, 5, 8] : [0, 1, 3];
    accs.forEach((a, j) => {
      const p = (pos + offs[j]) % 53;
      out.push({ pos: p, label: (a < 0 ? TR_NATURALS[(i + 1) % 7][1] : name) + (a ? TR_ACC[a] : ''), trad: TR_NAMES[p] || '' });
    });
  });
  return out;
})();

// Arabic system: 24 equal quarter tones (50 ¢) per octave, Rast = DO = 0 on the grid. Naturals sit at 0 4 8 10 14 18 22;
// each gets a half-sharp (sori) and, before the next whole tone, a sharp and a half-flat (koron, reversed flat).
const AR_NATURALS = [[0, 'DO'], [4, 'RE'], [8, 'MI'], [10, 'FA'], [14, 'SOL'], [18, 'LA'], [22, 'SI']];
const AR_NAMES = { 0: 'Rast', 4: 'Dukah', 7: 'Sikah', 10: 'Jaharkah', 14: 'Nawa', 18: 'Husayni', 21: 'Iraq' };
const AR_NOTES = (() => {
  const out = [];
  AR_NATURALS.forEach(([pos, name], i) => {
    const [nPos, nName] = AR_NATURALS[(i + 1) % 7];
    const gap = (i === 6 ? 24 : nPos) - pos;
    const steps = gap === 4 ? [[0, 0], [1, 1], [2, i === 5 ? -2 : 2], [3, -1]] : [[0, 0], [1, 1]];   // [quarter tones above, accidental]
    steps.forEach(([o, a]) => {
      const flat = a < 0;
      out.push({ pos: (pos + o) % 24, label: (flat ? nName : name) + (a ? TR_ACC[a === 1 ? 1 : a === -1 ? -1 : a > 0 ? 4 : -4] : ''), trad: AR_NAMES[(pos + o) % 24] || '' });
    });
  });
  return out;
})();
// Systems anchored on a chosen Rast note: pitch of each note in cents above Rast.
const SYSTEMS = {
  turkish: { notes: TR_NOTES, off: (n) => ((n.pos - TR_RAST_POS + 53) % 53) * 1200 / 53 },
  arabic: { notes: AR_NOTES, off: (n) => n.pos * 50 },
};

// Anchor note (pitch class) and note offsets (cents above the anchor) of a temperament.
const refOf = (temp) => state.refs[temp.id] ?? temp.ref ?? 0;   // chosen reference note (pitch class; C for equal temperament)
// A reference recorded from the microphone (state.caps, Hz) overrides the selector: its nearest note is the anchor and
// anchorCents its offset from equal temperament, so the whole scale follows the exact pitch that was played.
const capMidi = (temp) => (state.caps[temp.id] ? 69 + 12 * Math.log2(state.caps[temp.id] / state.refA) : null);
const anchorOf = (temp) => {
  const m = capMidi(temp);
  if (m !== null) return ((Math.round(m) % 12) + 12) % 12;
  return refOf(temp);
};
const anchorCents = (temp) => { const m = capMidi(temp); return m === null ? 0 : 100 * (m - Math.round(m)); };
function temperScale(temp) {
  const sys = SYSTEMS[temp.sys];
  if (sys) return sys.notes.map(sys.off);
  const a = anchorOf(temp);
  if (temp.fixed) return temp.cents.map((_, k) => (temp.cents[(a + k) % 12] - temp.cents[a] + 1200) % 1200);
  return temp.cents;
}
const tunerOpen = () => !$('tuner').classList.contains('collapsed');
// The drone's base note follows the tuner's temperament (also once the tuner is folded, until the X of the temperament
// tag restores equal temperament): cents by which the tempered note differs from its equal-tempered pitch (0 for equal
// temperament). The harmonics stay the natural multiples.
function temperDelta() {
  const temp = TEMPERAMENTS.find((t) => t.id === state.temper);
  if (temp.id === 'equal') return 0;
  const et = (((state.note - anchorOf(temp)) % 12) + 12) % 12 * 100;
  const scale = temperScale(temp);
  const diff = (off) => ((off - et + 1800) % 1200) - 600;
  if (temp.sys) return scale.reduce((best, off) => (Math.abs(diff(off)) < Math.abs(best) ? diff(off) : best), 600) + anchorCents(temp);
  return diff(scale[et / 100]) + anchorCents(temp);
}

const defaults = () => ({
  note: 0,          // pitch class, 0 = C
  octave: 3,
  refA: 440,        // reference pitch of A4 (Hz), shared by the drone and the tuner
  temper: 'equal',  // tuner temperament (see TEMPERAMENTS)
  refs: {},         // tuner reference note per temperament id (pitch class); missing = the temperament's `ref`
  caps: {},         // tuner reference recorded from the mic per temperament id (Hz); overrides `refs`
  mod: { on: false, rate: 0.2, depth: 70, from: 2 },
  swell: { on: false, rate: 0.1, depth: 70 },
  harmonics: Array.from({ length: HARMONICS }, (_, i) => ({
    on: i < 4,
    vol: Math.round(100 / Math.pow(i + 1, 0.8)),   // gently falling spectrum
  })),
});

const $ = (id) => document.getElementById(id);
const playBtn = $('play');
const noteSel = $('note');
const octaveSel = $('octave');
const freqEl = $('freq');
const rowsEl = $('rows');
const sweepEl = document.querySelector('.sweep');
const modOn = $('modOn');
const modRate = $('modRate');
const modRateOut = $('modRateOut');
const modDepth = $('modDepth');
const modDepthOut = $('modDepthOut');
const modFrom = $('modFrom');
const swellSection = $('swellSection');
const swellOn = $('swellOn');
const swellRate = $('swellRate');
const swellRateOut = $('swellRateOut');
const swellDepth = $('swellDepth');
const swellDepthOut = $('swellDepthOut');
const modRange = $('modRange');

let state = defaults();
load();

// ---------- Persistence ----------
// Reference notes per temperament; older versions stored the Rast notes as `rast` / `rastAr`.
function loadRefs(s) {
  const src = { turkish: s.rast, arabic: s.rastAr, ...(s.refs && typeof s.refs === 'object' ? s.refs : {}) };
  const refs = {};
  TEMPERAMENTS.forEach((t) => {
    const v = src[t.id];
    if (t.ref !== undefined && Number.isInteger(v) && v >= 0 && v < 12) refs[t.id] = v;
  });
  return refs;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s || !Array.isArray(s.harmonics)) return;
    const d = defaults();
    state = {
      note: Number.isInteger(s.note) && s.note >= 0 && s.note < 12 ? s.note : d.note,
      octave: [2, 3, 4].includes(s.octave) ? s.octave : d.octave,
      refA: Number.isFinite(s.refA) && s.refA >= REF_A_MIN && s.refA <= REF_A_MAX ? Math.round(s.refA) : d.refA,
      temper: TEMPERAMENTS.some((t) => t.id === s.temper) ? s.temper : d.temper,
      refs: loadRefs(s),
      caps: Object.fromEntries(Object.entries(s.caps && typeof s.caps === 'object' ? s.caps : {})
        .filter(([id, hz]) => TEMPERAMENTS.some((t) => t.id === id && t.ref !== undefined) && Number.isFinite(hz) && hz >= 20 && hz <= 5000)),
      mod: {
        on: false,   // sweep always starts off; rate, depth and range are remembered
        rate: Number.isFinite(s.mod?.rate) ? Math.min(RATE_MAX, Math.max(RATE_MIN, s.mod.rate)) : d.mod.rate,
        depth: Number.isFinite(s.mod?.depth) ? Math.min(100, Math.max(0, s.mod.depth)) : d.mod.depth,
        from: Number.isInteger(s.mod?.from) && s.mod.from >= MOD_FROM_MIN && s.mod.from <= MOD_FROM_MAX ? s.mod.from : d.mod.from,
      },
      swell: {
        on: false,   // swell always starts off; rate and depth are remembered
        rate: Number.isFinite(s.swell?.rate) ? Math.min(RATE_MAX, Math.max(RATE_MIN, s.swell.rate)) : d.swell.rate,
        depth: Number.isFinite(s.swell?.depth) ? Math.min(100, Math.max(0, s.swell.depth)) : d.swell.depth,
      },
      harmonics: d.harmonics.map((h, i) => ({
        on: typeof s.harmonics[i]?.on === 'boolean' ? s.harmonics[i].on : h.on,
        vol: Number.isFinite(s.harmonics[i]?.vol) ? s.harmonics[i].vol : h.vol,
      })),
    };
  } catch { /* storage unavailable — use defaults */ }
}
let harmHold = null;   // on/off flags of the harmonics saved while the tuner mutes H2 and above
function save() {
  // The tuner's temporary muting is never persisted: store the flags the user had before opening it.
  const out = harmHold ? { ...state, harmonics: state.harmonics.map((h, i) => ({ ...h, on: harmHold[i] })) } : state;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch {}
  report();
}

// ---------- Pitch helpers ----------
const midiOf = () => 12 * (state.octave + 1) + state.note;          // C4 = 60
const freqOfMidi = (m) => state.refA * Math.pow(2, (m - 69) / 12);
const fundamental = () => freqOfMidi(midiOf()) * Math.pow(2, temperDelta() / 1200);

// Nearest equal-tempered note of a harmonic, with cents deviation.
function harmonicPitch(k) {
  const exact = midiOf() + temperDelta() / 100 + 12 * Math.log2(k);
  const nearest = Math.round(exact);
  const cents = Math.round((exact - nearest) * 100);
  const pc = ((nearest % 12) + 12) % 12;
  return { name: noteName(SOLFEGE[pc], LETTERS[pc]), cents };
}

// Perceptual slider → gain.
const volToGain = (v) => Math.pow(v / 100, 2);
const MASTER_VOL = 70;   // fixed output level (there is no volume slider here: the home page sets the level per app)

// ---------- Audio graph ----------
// partials[k] → partialGain[k] → mix → breath (bellows LFO) → master → limiter → out
let ctx = null;
let nodes = null;
let trim = null;        // output gain set by the home page
let shellVol = 1;
let swellClock = null; // same, for the swell LFO
let lfoClock = null;   // {t, phase, rate}: sweep LFO phase at audio time t
let animId = 0;
let playing = false;
let wakeLock = null;

function buildGraph() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.005;
  limiter.release.value = 0.25;
  trim = ctx.createGain();
  trim.gain.value = shellVol;
  limiter.connect(trim).connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(limiter);

  // Bellows: slow, slightly irregular swell of the whole sound.
  const breath = ctx.createGain();
  breath.gain.value = 0.92;
  breath.connect(master);
  const lfo1 = ctx.createOscillator(), lfo2 = ctx.createOscillator();
  const lfoDepth = ctx.createGain();
  lfo1.frequency.value = 0.17;
  lfo2.frequency.value = 0.071;
  lfoDepth.gain.value = 0.05;
  lfo1.connect(lfoDepth);
  lfo2.connect(lfoDepth);
  lfoDepth.connect(breath.gain);
  lfo1.start();
  lfo2.start();

  // Soft reed colour: gentle low-pass on the upper partials.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 4500;
  tone.Q.value = 0.5;
  tone.connect(breath);

  const mix = ctx.createGain();
  mix.gain.value = 0.22;   // headroom for 13 partials
  mix.connect(tone);

  // One shared rate signal drives every sweep LFO's frequency, so they stay phase-locked
  // when the rate changes.
  const t0 = ctx.currentTime + 0.05;
  const rate = ctx.createConstantSource();
  rate.offset.value = state.mod.rate;
  rate.start(t0);
  lfoClock = { t: t0, phase: 0, rate: state.mod.rate };

  // Swell: one LFO (−cos u) shared by all partials, each scaled by its own depth.
  const swellLfo = ctx.createOscillator();
  swellLfo.setPeriodicWave(ctx.createPeriodicWave(
    new Float32Array([0, -1]), new Float32Array([0, 0]), { disableNormalization: true }));
  swellLfo.frequency.value = state.swell.rate;
  swellLfo.start(t0);
  swellClock = { t: t0, phase: 0, rate: state.swell.rate };

  const f0 = fundamental();
  const partials = [];
  for (let i = 0; i < HARMONICS; i++) {
    const k = i + 1;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f0 * k;
    // A few cents of random detune per reed keeps the drone alive.
    osc.detune.value = (Math.random() - 0.5) * 4;
    const g = ctx.createGain();
    g.gain.value = partialTarget(i);
    osc.connect(g);
    osc.start();
    const p = { osc, gain: g };

    // Every partial gets a sweep stage, so the starting harmonic can change live:
    // g → mod → mix, with mod.gain = offset + depth · sin(ωt + φᵢ)
    const mod = ctx.createGain();
    const depth = ctx.createGain();
    depth.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0;
    rate.connect(lfo.frequency);
    const sw = sweepWave(i);
    lfo.setPeriodicWave(sw.wave);
    p.dc = sw.dc;
    lfo.connect(depth).connect(mod.gain);
    lfo.start(t0);
    // g → mod (sweep) → swell → mix
    const swell = ctx.createGain();
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 0;
    swellLfo.connect(swellDepth).connect(swell.gain);
    g.connect(mod).connect(swell).connect(mix);
    Object.assign(p, { mod, depth, lfo, swell, swellDepth });
    partials.push(p);
  }
  nodes = { master, partials, rate, swellLfo };
  applyMod(true);
  applySwell(true);
}

// Brass swell: a slow crescendo/decrescendo e(u) = (1 − cos u)/2 ∈ [0, 1] that mostly
// brightens — upper harmonics drop back when soft and bloom when loud (brass behaviour).
// Multiplier: mᵢ = 1 − D·wᵢ·(1 − e), with weight wᵢ rising from 0.25 (H1) to 1 (H13).
// At the loud peak every harmonic is at its slider level — the swell never exceeds it.
const swellWeight = (i) => 0.25 + 0.75 * (i / (HARMONICS - 1));
function swellShape(i) {
  const k = state.swell.on ? (state.swell.depth / 100) * swellWeight(i) : 0;
  return { offset: 1 - k / 2, amp: k / 2 };   // m = offset − amp·cos u
}

// The audio LFO for harmonic i plays sweepSignal(i, ·) as a PeriodicWave (Fourier series).
// Web Audio drops the DC term, so it is returned separately and added to the gain offset.
const SWEEP_N = 256, SWEEP_K = 32;
function sweepWave(i) {
  const vals = Array.from({ length: SWEEP_N }, (_, j) => sweepSignal(i, (2 * Math.PI * j) / SWEEP_N));
  const dc = vals.reduce((a, v) => a + v, 0) / SWEEP_N;
  const re = new Float32Array(SWEEP_K + 1), im = new Float32Array(SWEEP_K + 1);
  for (let k = 1; k <= SWEEP_K; k++) {
    let a = 0, b = 0;
    for (let j = 0; j < SWEEP_N; j++) {
      const u = (2 * Math.PI * j) / SWEEP_N;
      a += vals[j] * Math.cos(k * u);
      b += vals[j] * Math.sin(k * u);
    }
    re[k] = (2 * a) / SWEEP_N;
    im[k] = (2 * b) / SWEEP_N;
  }
  return { wave: ctx.createPeriodicWave(re, im, { disableNormalization: true }), dc };
}

// Starting harmonic changed: rebuild the waveforms for the new swept range.
function applyModFrom() {
  if (!nodes) return;
  nodes.partials.forEach((p, i) => {
    const sw = sweepWave(i);
    p.lfo.setPeriodicWave(sw.wave);
    p.dc = sw.dc;
  });
  applyMod();
}

// Modulation multiplier range: [1 − depth, 1] — never louder than the slider setting.
function modShape() {
  const d = state.mod.depth / 100;
  return state.mod.on ? { offset: 1 - d / 2, amp: d / 2 } : { offset: 1, amp: 0 };
}

function applyMod(immediate = false) {
  if (!nodes) return;
  const { offset, amp } = modShape();
  const now = ctx.currentTime;
  nodes.partials.forEach((p, i) => {
    const swept = i >= modStart();
    const off = swept ? offset + amp * p.dc : 1, a = swept ? amp : 0;
    if (immediate) { p.mod.gain.value = off; p.depth.gain.value = a; }
    else {
      p.mod.gain.setTargetAtTime(off, now, 0.15);
      p.depth.gain.setTargetAtTime(a, now, 0.15);
    }
  });
}

function applySwell(immediate = false) {
  if (!nodes) return;
  const now = ctx.currentTime;
  nodes.partials.forEach((p, i) => {
    const { offset, amp } = swellShape(i);
    if (immediate) { p.swell.gain.value = offset; p.swellDepth.gain.value = amp; }
    else {
      p.swell.gain.setTargetAtTime(offset, now, 0.15);
      p.swellDepth.gain.setTargetAtTime(amp, now, 0.15);
    }
  });
}

// Advance a clock {t, phase, rate} to now and switch it to a new rate; returns the switch time.
function retime(clock, rate) {
  const now = ctx.currentTime;
  clock.phase += 2 * Math.PI * clock.rate * Math.max(0, now - clock.t);
  clock.t = Math.max(now, clock.t);
  clock.rate = rate;
  return clock.t;
}
const clockPhase = (clock) => clock.phase + 2 * Math.PI * clock.rate * Math.max(0, ctx.currentTime - clock.t);

function applySwellRate() {
  if (!nodes) return;
  nodes.swellLfo.frequency.setValueAtTime(state.swell.rate, retime(swellClock, state.swell.rate));
}

function applyRate() {
  if (!nodes) return;
  // Fold elapsed phase into the clock so the visual stays in step with the audio.
  nodes.rate.offset.setValueAtTime(state.mod.rate, retime(lfoClock, state.mod.rate));
}

// Current modulation multiplier of harmonic i, mirrored from the audio LFOs.
// Combined live multiplier of harmonic i (sweep × swell), mirrored from the audio LFOs.
function modFactor(i) {
  let m = 1;
  if (state.mod.on && lfoClock && i >= modStart()) {
    const { offset, amp } = modShape();
    m *= offset + amp * sweepSignal(i, clockPhase(lfoClock));
  }
  if (state.swell.on && swellClock) {
    const { offset, amp } = swellShape(i);
    m *= offset - amp * Math.cos(clockPhase(swellClock));
  }
  return m;
}

function partialTarget(i) {
  const h = state.harmonics[i];
  return h.on ? volToGain(h.vol) : 0;
}

function applyPartial(i) {
  if (!nodes) return;
  nodes.partials[i].gain.gain.setTargetAtTime(partialTarget(i), ctx.currentTime, 0.03);
}

function applyPitch() {
  if (!nodes) return;
  const f0 = fundamental();
  nodes.partials.forEach((p, i) => p.osc.frequency.setTargetAtTime(f0 * (i + 1), ctx.currentTime, GLIDE));
}

function applyMaster(target = playing ? volToGain(MASTER_VOL) : 0, tc = 0.05) {
  if (!nodes) return;
  const g = nodes.master.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.setTargetAtTime(target, ctx.currentTime, tc);
}

// ---------- Transport ----------
function start() {
  recStop();   // starting or stopping the drone ends a recording
  recBtn.disabled = true;   // and the drone would be heard by the microphone: no recording while it plays
  if (!ctx) buildGraph();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  playing = true;
  applyMaster(volToGain(MASTER_VOL), ATTACK / 3);   // bellows fill up
  playBtn.setAttribute('aria-pressed', 'true');
  playBtn.setAttribute('aria-label', 'Stop');
  syncAnimation();
  requestWakeLock();
  report();
  checkBlocked();
}

function stop() {
  recStop();
  recBtn.disabled = false;
  playing = false;
  applyMaster(0, RELEASE / 3);
  playBtn.setAttribute('aria-pressed', 'false');
  playBtn.setAttribute('aria-label', 'Play');
  syncAnimation();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  report();
  // Suspend the context once the release has faded, to save battery.
  setTimeout(() => { if (!playing && ctx?.state === 'running') ctx.suspend(); }, RELEASE * 1000 + 300);
}

const toggle = () => (playing ? stop() : start());

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing) requestWakeLock();
});

// ---------- UI ----------
function buildSelectors() {
  for (let h = MOD_FROM_MIN; h <= MOD_FROM_MAX; h++) modFrom.add(new Option(`H${h}`, h));
  noteSel.innerHTML = SOLFEGE.map((s, i) => `<option value="${i}">${noteName(s, LETTERS[i])}</option>`).join('');
}

const rowEls = [];
function buildRows() {
  const tpl = $('rowTpl');
  for (let i = 0; i < HARMONICS; i++) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    const el = {
      li,
      on: li.querySelector('.on'),
      h: li.querySelector('.h'),
      pitch: li.querySelector('.pitch'),
      hz: li.querySelector('.hz'),
      vol: li.querySelector('.vol'),
      pct: li.querySelector('.pct'),
    };
    el.h.textContent = `H${i + 1}`;
    el.on.setAttribute('aria-label', `Harmonic ${i + 1} on/off`);
    el.vol.setAttribute('aria-label', `Harmonic ${i + 1} volume`);

    el.on.addEventListener('change', () => {
      state.harmonics[i].on = el.on.checked;
      clearInstrument();
      renderRow(i); applyPartial(i); save();
    });
    el.vol.addEventListener('input', () => {
      state.harmonics[i].vol = el.vol.valueAsNumber;
      // Raising a muted harmonic's volume switches it on.
      if (!state.harmonics[i].on && el.vol.valueAsNumber > 0) state.harmonics[i].on = true;
      clearInstrument();
      renderRow(i); applyPartial(i); save();
    });

    rowsEl.append(li);
    rowEls.push(el);
  }
}

// Slider visuals: --p = thumb position (set value), --lp = live level fill (0..1).
function setRangeFill(input, live) {
  const min = +input.min, max = +input.max;
  input.style.setProperty('--p', ((input.valueAsNumber - min) / (max - min)).toFixed(4));
  if (live === undefined) input.style.removeProperty('--lp');
  else input.style.setProperty('--lp', live.toFixed(4));
}

function renderRow(i) {
  const h = state.harmonics[i];
  const el = rowEls[i];
  el.on.checked = h.on;
  if (el.vol.valueAsNumber !== h.vol) el.vol.value = h.vol;
  el.pct.textContent = h.vol;
  el.li.classList.toggle('off', !h.on);
  const m = modFactor(i);
  const level = playing && h.on ? (0.25 + 0.75 * h.vol / 100) * m : 0;
  el.li.style.setProperty('--level', level.toFixed(3));
  // Live amplitude in slider units: gain = (vol/100)² · m  →  position = vol · √m
  const sweeping = playing && h.on && m !== 1;
  setRangeFill(el.vol, sweeping ? (h.vol / 100) * Math.sqrt(m) : undefined);
}

// Animate the row glows of swept harmonics while the sweep is audible.
const animatedFrom = () => (state.swell.on ? 0 : modStart());
function animate() {
  for (let i = animatedFrom(); i < HARMONICS; i++) renderRow(i);
  animId = requestAnimationFrame(animate);
}
function syncAnimation() {
  const run = playing && (state.mod.on || state.swell.on);
  rowsEl.classList.toggle('sweeping', run);
  rowEls.forEach((el, i) => el.li.classList.toggle('swept', i >= animatedFrom()));
  cancelAnimationFrame(animId);
  if (run) animId = requestAnimationFrame(animate);
  else updateLevels();
}

function renderMod() {
  sweepEl.classList.toggle('active', state.mod.on);
  modOn.checked = state.mod.on;
  modRate.value = posFromRate(state.mod.rate);
  const r = state.mod.rate;
  modRateOut.textContent = `${r < 0.1 ? r.toFixed(3) : r.toFixed(2)} Hz · ${(1 / r).toFixed(1)} s`;
  modDepth.value = state.mod.depth;
  modDepthOut.textContent = `${state.mod.depth}%`;
  setRangeFill(modRate);
  setRangeFill(modDepth);
  modFrom.value = state.mod.from;
  modRange.textContent = `H${state.mod.from}–H${HARMONICS}`;
}

function renderSwell() {
  swellSection.classList.toggle('active', state.swell.on);
  swellOn.checked = state.swell.on;
  swellRate.value = posFromRate(state.swell.rate);
  const r = state.swell.rate;
  swellRateOut.textContent = `${r < 0.1 ? r.toFixed(3) : r.toFixed(2)} Hz · ${(1 / r).toFixed(1)} s`;
  swellDepth.value = state.swell.depth;
  swellDepthOut.textContent = `${state.swell.depth}%`;
  setRangeFill(swellRate);
  setRangeFill(swellDepth);
}

// Turkish system: solfège name of pitch class pc counted from the Rast note `a`, which is always SOL (as when playing
// in another ahenk), followed by the sounding western letter, e.g. "SOL - C4" when Rast is on C.
const trSolfege = (pc, a, oct = '') => noteName(SOLFEGE[(pc - a + 19) % 12], LETTERS[pc], oct);   // +7 (SOL) +12
// Name of each drone note ("DO - C"). On the Turkish system the solfège is relative to Rast (see
// trSolfege), and a note tuned to a named makam degree (the grid note temperDelta tunes it to) gets that name first,
// e.g. "Rast (SOL - C)".
function droneNames(oct = '') {
  const temp = TEMPERAMENTS.find((t) => t.id === state.temper);
  if (temp.sys !== 'turkish') return LETTERS.map((l, i) => noteName(SOLFEGE[i], l, oct));
  const sys = SYSTEMS[temp.sys], scale = temperScale(temp), a = anchorOf(temp);
  return LETTERS.map((_, i) => {
    const p = trSolfege(i, a, oct);
    const et = ((i - a + 12) % 12) * 100;
    const dist = (off) => Math.abs(((off - et + 1800) % 1200) - 600);
    const k = scale.reduce((best, off, j) => (dist(off) < dist(scale[best]) ? j : best), 0);
    return sys.notes[k].trad ? `${sys.notes[k].trad} (${p})` : p;
  });
}

function renderPitch() {
  const f0 = fundamental();
  const names = droneNames();
  [...noteSel.options].forEach((o, i) => { if (o.text !== names[i]) o.text = names[i]; });
  rowEls.forEach((el, i) => {
    const { name, cents } = harmonicPitch(i + 1);
    const c = cents === 0 ? '' : `<span class="cents">${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢</span>`;
    el.pitch.innerHTML = `${name}${c}`;
    el.hz.textContent = `${(f0 * (i + 1)).toFixed(1)} Hz`;
  });
  freqEl.textContent = `${droneNames(state.octave)[state.note]} · ${f0.toFixed(2)} Hz (A4 = ${state.refA} Hz)`;
}

const updateLevels = () => state.harmonics.forEach((_, i) => renderRow(i));

function renderAll() {
  noteSel.value = state.note;
  octaveSel.value = state.octave;
  renderMod();
  renderSwell();
  renderPitch();
  updateLevels();
}

function setAll(fn) {
  clearInstrument();
  state.harmonics.forEach((h, i) => { fn(h, i); applyPartial(i); });
  updateLevels();
  save();
}

// ---------- Events ----------
playBtn.addEventListener('click', toggle);

noteSel.addEventListener('change', () => {
  state.note = +noteSel.value;
  renderPitch(); applyPitch(); save();
});
octaveSel.addEventListener('change', () => {
  state.octave = +octaveSel.value;
  renderPitch(); applyPitch(); save();
});

modOn.addEventListener('change', () => {
  clearInstrument();
  state.mod.on = modOn.checked;
  renderMod(); applyMod(); syncAnimation(); save();
});
modRate.addEventListener('input', () => {
  clearInstrument();
  state.mod.rate = rateFromPos(modRate.valueAsNumber);
  renderMod(); applyRate(); save();
});
modFrom.addEventListener('change', () => {
  clearInstrument();
  state.mod.from = +modFrom.value;
  renderMod(); applyModFrom(); updateLevels(); save();
});
modDepth.addEventListener('input', () => {
  clearInstrument();
  state.mod.depth = modDepth.valueAsNumber;
  renderMod(); applyMod(); save();
});

swellOn.addEventListener('change', () => {
  clearInstrument();
  state.swell.on = swellOn.checked;
  renderSwell(); applySwell(); syncAnimation(); save();
});
swellRate.addEventListener('input', () => {
  clearInstrument();
  state.swell.rate = rateFromPos(swellRate.valueAsNumber);
  renderSwell(); applySwellRate(); save();
});
swellDepth.addEventListener('input', () => {
  clearInstrument();
  state.swell.depth = swellDepth.valueAsNumber;
  renderSwell(); applySwell(); save();
});

$('allOn').addEventListener('click', () => setAll((h) => { h.on = true; }));
$('allOff').addEventListener('click', () => setAll((h) => { h.on = false; }));
// Spectrum presets
const FLAT_VOL = 60;
const linearVol = (i) => Math.round((100 * (HARMONICS - i)) / HARMONICS);   // H1 100 → H13 8
const FLAT_ON = 10;   // flat: H1–H10 on, H11–H13 off (still set to the flat volume, so they sound right if switched on)
$('presetFlat').addEventListener('click', () => setAll((h, i) => { h.on = i < FLAT_ON; h.vol = FLAT_VOL; }));
$('presetLinear').addEventListener('click', () => setAll((h, i) => { h.on = true; h.vol = linearVol(i); }));

// ---------- Collapsible harmonics panel ----------
// The header's chevron button folds the preset buttons and the harmonic rows away (open by default, remembered).
const harmSection = document.querySelector('.harmonics');
const harmToggle = $('harmToggle');
const HARM_OPEN_KEY = 'shrutibox:harmonicsOpen';
function setHarmonicsOpen(open, remember = true) {
  harmSection.classList.toggle('collapsed', !open);
  harmToggle.setAttribute('aria-expanded', open);
  if (remember) { try { localStorage.setItem(HARM_OPEN_KEY, open ? '1' : '0'); } catch {} }
}
harmToggle.addEventListener('click', () => setHarmonicsOpen(harmToggle.getAttribute('aria-expanded') !== 'true'));
try { if (localStorage.getItem(HARM_OPEN_KEY) === '0') setHarmonicsOpen(false, false); } catch {}

// ---------- Tuner ----------
// Microphone → AnalyserNode (not routed to the output, so no feedback) → YIN pitch detection →
// nearest equal-tempered note + cents deviation. Uses its own AudioContext, independent of the drone's.
const tunerSection = $('tuner');
const tunerToggle = $('tunerToggle');
const TUNER_MIN_HZ = 50, TUNER_MAX_HZ = 2000;
const TUNER_RMS_GATE = 0.01;       // below this the input is treated as silence
const TUNER_YIN_THRESHOLD = 0.12;
const TUNER_SMOOTH_S = 0.45;       // integration time constant of the pitch display (higher = steadier, slower)
const TUNER_HOLD_MS = 600;          // keep showing the last note briefly after the signal drops
let tunerCtx = null, tunerStream = null, tunerAnalyser = null, tunerBuf = null, tunerRaf = 0;
let tunerMidi = null, tunerLastAt = 0;

// Reference capture (rec button beside the reference note): while `capturing`, the tuner's raw pitch readings feed a run
// that must stay within CAP_TOL_CENTS of its median for CAP_STEADY_MS; a few stray readings (CAP_MISSES in a row) are
// ignored, a longer miss or a gap in the signal restarts the run. The median of the run becomes the reference.
const CAP_STEADY_MS = 2000, CAP_TOL_CENTS = 10, CAP_MISSES = 3, CAP_GAP_MS = 250;
let capturing = false, capRun = [], capMiss = 0;
const median = (a) => { const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
function capFeed(midi, now) {
  if (!capturing) return;
  if (capRun.length && now - capRun[capRun.length - 1].t > CAP_GAP_MS) { capRun = []; capMiss = 0; }
  if (midi === null) return;
  if (capRun.length && Math.abs(midi - median(capRun.map((x) => x.midi))) * 100 > CAP_TOL_CENTS) {
    if (++capMiss <= CAP_MISSES) return;
    capRun = [];
  }
  capMiss = 0;
  capRun.push({ t: now, midi });
  if (now - capRun[0].t >= CAP_STEADY_MS) {
    state.caps[state.temper] = freqOfMidi(median(capRun.map((x) => x.midi)));
    capStop();
    retune(); save();
  }
}
function capStop() { capturing = false; capRun = []; capMiss = 0; syncRefRow(); }

function tunerMsg(text = '') {   // error text only; hidden when empty
  $('tunerMsg').textContent = text;
  $('tunerMsg').hidden = !text;
  $('tunerMsg').classList.add('warn');
}

const tunerDisks = [...document.querySelectorAll('#tunerDisks .disk')];
function tunerReadout(f) {
  const note = $('tunerNote');
  if (!f) {
    note.textContent = 'listening...';
    note.classList.add('idle');
    $('tunerHz').innerHTML = '&nbsp;';
    tunerDisks.forEach((d) => { d.style.setProperty('--i', 0); d.classList.remove('top'); });
    return;
  }
  // Cents above the anchor note (see anchorOf), folded into one octave, then the nearest degree of the temperament.
  // While a reference is being recorded the display is in equal temperament, independent of the current reference.
  const temp = capturing ? TEMPERAMENTS[0] : TEMPERAMENTS.find((t) => t.id === state.temper);
  const sys = SYSTEMS[temp.sys];
  const anchor = anchorOf(temp);
  const tonic = freqOfMidi(60 + anchor + anchorCents(temp) / 100);
  const c = ((1200 * Math.log2(f / tonic)) % 1200 + 1200) % 1200;
  const scale = temperScale(temp);
  let deg = 0, dev = Infinity;
  scale.forEach((off, k) => {
    const dd = ((c - off + 1800) % 1200) - 600;
    if (Math.abs(dd) < Math.abs(dev)) { deg = k; dev = dd; }
  });
  if (temp.sys === 'turkish') {
    // Keep the traditional name while the pitch is within TR_NAME_RANGE of a named note, even when it is nearer to
    // an unnamed koma neighbour: the deviation is then measured from the named note.
    let nk = -1, nd = Infinity;
    scale.forEach((off, k) => {
      if (!sys.notes[k].trad) return;
      const dd = ((c - off + 1800) % 1200) - 600;
      if (Math.abs(dd) < Math.abs(nd)) { nk = k; nd = dd; }
    });
    if (Math.abs(nd) <= TR_NAME_RANGE) { deg = nk; dev = nd; }
  }
  const pc = sys ? 0 : (anchor + deg) % 12;
  const target = f * Math.pow(2, -dev / 1200);
  const n = Math.round(69 + 12 * Math.log2(target / state.refA));   // equal-tempered neighbour, for the octave number only
  note.classList.remove('idle');
  if (temp.sys === 'turkish') {
    // Named relative to Rast: the traditional name in big and the nearest equal-tempered note to the target in small,
    // its solfège counted from Rast = SOL (trSolfege), e.g. "Rast (SOL - C4)" when Rast is on C; just that when there
    // is no traditional name.
    const tn = sys.notes[deg], spc = ((n % 12) + 12) % 12, western = trSolfege(spc, anchor, Math.floor(n / 12) - 1);
    note.innerHTML = tn.trad ? `${tn.trad} <small>(${western})</small>` : western;
  } else if (sys) {
    // The note is named from its absolute place on the grid (tonic position + offset), as makam names are absolute.
    const tn = sys.notes[deg];
    note.innerHTML = `${tn.label}${Math.floor(n / 12) - 1}${tn.trad ? ` <small>${tn.trad}</small>` : ''}`;
  } else note.textContent = noteName(SOLFEGE[pc], LETTERS[pc], Math.floor(n / 12) - 1);
  const cents = Math.round(dev);
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
  const commas = Math.round(dev / COMMA_CENTS * 10) / 10;
  $('tunerHz').innerHTML = `<b>${f.toFixed(1)}</b> Hz &nbsp;<b>${sgn(cents)}${Math.abs(cents)}</b>¢ &nbsp;<b>${sgn(commas)}${Math.abs(commas).toFixed(1)}</b> koma`;
  // Disk k (k = -4…4) is the bin centred on k·10 cents; lit by how close the pitch is to that centre.
  const dc = Math.max(-40, Math.min(40, dev));
  const top = Math.round(dc / 10) + 4;   // nearest bin = most intense disk, outlined in white
  tunerDisks.forEach((d, k) => {
    d.style.setProperty('--i', Math.max(0, 1 - Math.abs(dc - (k - 4) * 10) / 10).toFixed(2));
    d.classList.toggle('top', k === top);
  });
}

// YIN (de Cheveigné & Kawahara 2002): difference function → cumulative mean normalisation →
// first dip under the threshold → parabolic interpolation. Returns Hz or 0.
function yinPitch(buf, sampleRate) {
  const half = buf.length >> 1;
  const minTau = Math.max(2, Math.floor(sampleRate / TUNER_MAX_HZ));
  const maxTau = Math.min(half - 1, Math.floor(sampleRate / TUNER_MIN_HZ));
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) { const x = buf[i] - buf[i + tau]; sum += x * x; }
    d[tau] = sum;
  }
  let run = 0;
  for (let tau = 1; tau <= maxTau; tau++) { run += d[tau]; d[tau] = run ? (d[tau] * tau) / run : 1; }
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (d[t] < TUNER_YIN_THRESHOLD) {
      while (t + 1 <= maxTau && d[t + 1] < d[t]) t++;
      tau = t; break;
    }
  }
  if (tau < 0) return 0;
  let better = tau;
  if (tau > 1 && tau < maxTau) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const den = a - 2 * b + c;
    if (den) better = tau + (a - c) / (2 * den);
  }
  return sampleRate / better;
}

function tunerLoop() {
  tunerRaf = requestAnimationFrame(tunerLoop);
  tunerAnalyser.getFloatTimeDomainData(tunerBuf);
  let sq = 0;
  for (let i = 0; i < tunerBuf.length; i++) sq += tunerBuf[i] * tunerBuf[i];
  const now = performance.now();
  const f = Math.sqrt(sq / tunerBuf.length) >= TUNER_RMS_GATE ? yinPitch(tunerBuf, tunerCtx.sampleRate) : 0;
  if (f) {
    const midi = 69 + 12 * Math.log2(f / state.refA);
    // Light smoothing, but jump straight to a new note instead of gliding through the semitones in between.
    const dt = Math.min(0.1, (now - tunerLastAt) / 1000);   // frame-rate independent exponential smoothing
    tunerMidi = tunerMidi !== null && Math.abs(midi - tunerMidi) < 0.6 ? tunerMidi + (1 - Math.exp(-dt / TUNER_SMOOTH_S)) * (midi - tunerMidi) : midi;
    tunerLastAt = now;
    tunerReadout(freqOfMidi(tunerMidi));
    capFeed(tunerMidi, now);   // the smoothed pitch, so vibrato averages out
  } else if (now - tunerLastAt > TUNER_HOLD_MS) {
    tunerMidi = null;
    tunerReadout(0);
  }
  if (!f) capFeed(null, now);
  if (capturing) capLabel(tunerMidi);
}

async function tunerMicError(err) {
  if (err.name === 'NotFoundError') return 'No microphone found.';
  if (err.name === 'NotReadableError') return 'The microphone is in use by another app or can\'t be opened.';
  if (err.name !== 'NotAllowedError' && err.name !== 'SecurityError') return `Can't open the microphone (${err.name}).`;
  if (!window.isSecureContext) return 'Microphone access needs a secure page: open the app over https or on localhost.';
  return 'Microphone access is blocked. Allow it in the browser\'s site settings for this page, then reload and press Listen again.';
}

// Raw microphone stream (no echo-cancel/noise-suppression/AGC). Resolves to {stream} or {error: text}; shared by the tuner and the harmonics recorder.
async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) return { error: 'This browser can\'t access the microphone.' };
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }) };
  } catch (err) {
    return { error: await tunerMicError(err) };
  }
}

async function tunerStart() {
  if (tunerStream) return;
  const { stream, error } = await openMic();
  if (error) { tunerMsg(error); return; }
  if (tunerSection.classList.contains('collapsed') || tunerStream) { stream.getTracks().forEach((t) => t.stop()); return; }   // folded while the permission prompt was open
  tunerStream = stream;
  tunerCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await tunerCtx.resume(); } catch {}
  tunerAnalyser = tunerCtx.createAnalyser();
  tunerAnalyser.fftSize = 4096;
  tunerBuf = new Float32Array(tunerAnalyser.fftSize);
  tunerCtx.createMediaStreamSource(tunerStream).connect(tunerAnalyser);
  tunerMsg();
  tunerMidi = null; tunerLastAt = 0;
  tunerLoop();
}

function tunerStop() {
  if (capturing) capStop();
  cancelAnimationFrame(tunerRaf);
  tunerStream?.getTracks().forEach((t) => t.stop());
  tunerCtx?.close().catch(() => {});
  tunerStream = tunerCtx = tunerAnalyser = tunerBuf = null;
  tunerReadout(0);
  tunerMsg();
}

// With the tuner open only the fundamental sounds (H2 and above are switched off); closing it restores them.
function holdHarmonics(mute) {
  if (mute === !!harmHold) return;
  if (mute) harmHold = state.harmonics.map((h) => h.on);
  state.harmonics.forEach((h, i) => { h.on = mute ? i === 0 && h.on : harmHold[i]; renderRow(i); applyPartial(i); });
  if (!mute) harmHold = null;
  save();
}

function setTunerOpen(open) {
  tunerSection.classList.toggle('collapsed', !open);
  holdHarmonics(open);
  retune();
  tunerToggle.setAttribute('aria-expanded', open);
  if (open) tunerStart(); else tunerStop();   // listen while the curtain is down, release the mic when it is folded
}
tunerToggle.addEventListener('click', () => setTunerOpen(tunerToggle.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') tunerStop(); });

const refASel = $('refA'), temperSel = $('temper');
temperSel.innerHTML = TEMPERAMENTS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
temperSel.value = state.temper;
refASel.value = state.refA;
// Temperament tag left of the base note: shown while the tuner is open or the drone is not in equal temperament,
// with an X (after the name) that restores equal temperament.
const temperTag = $('temperTag'), temperName = $('temperName'), temperClear = $('temperClear');
function retune() {   // the drone's base note depends on the temperament
  const equal = state.temper === 'equal';
  temperTag.hidden = equal && !tunerOpen();
  temperClear.hidden = equal;
  temperName.textContent = TEMPERAMENTS.find((t) => t.id === state.temper).name;
  renderPitch(); applyPitch();
}
temperClear.addEventListener('click', () => {
  state.temper = 'equal'; temperSel.value = 'equal'; capStop(); retune(); save();
});
// Reference note selector (hidden for equal temperament), with an (i) dialog explaining it for the current temperament.
const refRow = $('refRow'), refSel = $('refSel'), refDialog = $('refDialog');
const noteOptions = (def = -1) => SOLFEGE.map((s, i) => `<option value="${i}">${noteName(s, LETTERS[i])}${i === def ? ' (default)' : ''}</option>`).join('');
const REF_HINTS = {
  movable: 'The scale is built on this note, which is tuned as in equal temperament at the A4 pitch. '
    + 'C (the default) is the usual layout of this scale; set it to the tonic of the piece you play.',
  fixed: 'The temperament keeps its historical layout from C. This note is tuned as in equal temperament at the A4 pitch '
    + 'and the others follow it. A (the default) is how tuners and baroque players set it.',
  turkish: 'The pitch that sounds as Rast. Notes stay named with Rast = SOL, as when playing in another ahenk. '
    + 'G (the default) is bolahenk, concert pitch.',
  arabic: 'The pitch that sounds as Rast. Notes stay named with Rast = DO. C is the default.',
};
const refCap = $('refCap'), refRec = $('refRec');
// Note name and cents (from equal temperament at A4) of a pitch given as a fractional MIDI number.
function capText(m) {
  const n = Math.round(m), pc = ((n % 12) + 12) % 12, c = Math.round(100 * (m - n));
  return `${noteName(SOLFEGE[pc], LETTERS[pc], Math.floor(n / 12) - 1)} ${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(c)}¢`;
}
function capLabel(m) { refCap.textContent = m === null ? 'play a steady note...' : capText(m); }
const REC_LABELS = {
  idle: 'Record the reference: play a steady note',
  listening: 'Stop listening',
  captured: 'Discard the recorded reference',
};
const syncRefRow = () => {
  const t = TEMPERAMENTS.find((x) => x.id === state.temper);
  refRow.hidden = t.ref === undefined;
  if (refRow.hidden) return;
  const label = t.sys ? 'Rast note' : 'Reference note';
  $('refLabel').textContent = $('refDlgTitle').textContent = label;
  $('refInfoBtn').setAttribute('aria-label', `About the ${label.toLowerCase()}`);
  refSel.innerHTML = noteOptions(t.ref);
  refSel.value = refOf(t);
  $('refInfo').textContent = `${REF_HINTS[t.sys || (t.fixed ? 'fixed' : 'movable')]} `
    + 'Or press the red button and play a steady note for 2 seconds: its exact pitch becomes the reference, until you discard it.';
  // Selector, or a label showing the note being recorded (yellow) / the recorded reference (blue).
  const captured = capMidi(t) !== null;
  const mode = capturing ? 'listening' : captured ? 'captured' : 'idle';
  refSel.hidden = mode !== 'idle';
  refCap.hidden = mode === 'idle';
  refCap.classList.toggle('done', mode === 'captured');
  if (mode === 'listening') capLabel(tunerMidi);
  if (mode === 'captured') refCap.textContent = capText(capMidi(t));
  refRec.dataset.state = mode;
  refRec.setAttribute('aria-label', REC_LABELS[mode]);
  refRec.title = REC_LABELS[mode];
};
refRec.addEventListener('click', () => {
  if (capturing) { capStop(); return; }
  if (state.caps[state.temper]) { delete state.caps[state.temper]; syncRefRow(); retune(); save(); return; }
  capturing = true; capRun = []; capMiss = 0;
  syncRefRow();
});
syncRefRow();
$('refInfoBtn').addEventListener('click', () => refDialog.showModal());
refDialog.addEventListener('click', (e) => { if (e.target === refDialog) refDialog.close(); });   // tap outside closes
refSel.addEventListener('change', () => { state.refs[state.temper] = +refSel.value; retune(); save(); });
// Notation radio: redraw every note name (drone selector, harmonics, reference selector, tuner, top-bar status).
const notationRadios = document.querySelectorAll('input[name="notation"]');
function applyNotation(v) {
  notation = v;
  notationRadios.forEach((r) => { r.checked = r.value === v; });
  syncRefRow(); renderPitch(); report();
}
notationRadios.forEach((r) => {
  r.checked = r.value === notation;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    try { localStorage.setItem(NOTATION_KEY, r.value); } catch {}
    applyNotation(r.value);
  });
});
window.addEventListener('storage', (e) => { if (e.key === NOTATION_KEY) applyNotation(readNotation()); });
temperSel.addEventListener('change', () => { state.temper = temperSel.value; capturing = false; syncRefRow(); retune(); save(); });
refASel.addEventListener('change', () => {
  const v = Math.round(+refASel.value);
  state.refA = Number.isFinite(v) ? Math.min(REF_A_MAX, Math.max(REF_A_MIN, v)) : 440;
  refASel.value = state.refA;
  tunerMidi = null;
  syncRefRow();   // a recorded reference keeps its pitch, so its cents from the new A4 change
  renderPitch(); applyPitch(); save();   // the drone follows the reference pitch too
});

// ---------- Harmonics recorder ----------
// The rec button listens to the microphone and sets the harmonic sliders to the heard spectrum: YIN (shared with
// the tuner) finds the fundamental, then the FFT peak near each multiple k·f0 gives that harmonic's amplitude.
// Amplitudes are smoothed over time, normalised to the strongest harmonic and mapped to the perceptual sliders (v = 100·√a).
const recBtn = $('harmRec');
const REC_FFT = 8192;
const REC_YIN_LEN = 4096;          // YIN only needs the latest samples; keeps its cost like the tuner's
const REC_SMOOTH_S = 0.5;          // time constant of the per-harmonic amplitude average
const REC_OFF_BELOW = 0.02;        // relative amplitude (−34 dB) under which a harmonic is switched off
const REC_WINDOW_CENTS = 45;       // search window around each multiple of f0
let recCtx = null, recStream = null, recAnalyser = null, recTime = null, recSpec = null, recRaf = 0;
let recAmps = null, recLastAt = 0, recSavedAt = 0;

// Spectrogram strip right of the harmonics panel (visible while listening). Time runs right → left (newest column at the
// right edge); the vertical axis is frequency in units of f0, laid out so harmonic k sits at the vertical centre of its row.
const spectro = $('spectro'), spectroCtx = spectro.getContext('2d');
const harmWrap = $('harmWrap');
const SPECTRO_RANGE_DB = 60;
let spY0 = 0, spPitch = 1;   // device px: centre of the H1 row and distance between row centres
function spectroLayout() {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(spectro.clientWidth * dpr), h = Math.round(spectro.clientHeight * dpr);
  if (!w || !h) return;
  if (spectro.width !== w || spectro.height !== h) { spectro.width = w; spectro.height = h; }   // resizing clears it
  const top = spectro.getBoundingClientRect().top;
  const r0 = rowEls[0].li.getBoundingClientRect(), r1 = rowEls[1].li.getBoundingClientRect();
  spY0 = (r0.top + r0.height / 2 - top) * dpr;
  spPitch = (r1.top - r0.top) * dpr;
}
new ResizeObserver(spectroLayout).observe(spectro);
// Colour table: t 0..1 → dark brown → amber → pale yellow.
const SPECTRO_LUT = new Uint8ClampedArray(256 * 3);
for (let k = 0; k < 256; k++) {
  const t = k / 255, lo = t < 0.6;
  const A = lo ? [20, 18, 16] : [224, 164, 58], B = lo ? [224, 164, 58] : [255, 240, 200], u = lo ? t / 0.6 : (t - 0.6) / 0.4;
  for (let c = 0; c < 3; c++) SPECTRO_LUT[k * 3 + c] = A[c] + (B[c] - A[c]) * u;
}
// History of absolute spectra, newest last (null = silence). Every frame the whole strip is redrawn against the
// *current* fundamental (`spRef`, lightly smoothed): the newest column has its harmonics on the rows, older columns keep
// their real frequencies and so appear shifted by how far the pitch has moved since (a glide shows up as a ramp).
let spHist = [], spRef = 0, spRefAt = 0, spImg = null;
const spBin = () => recCtx.sampleRate / REC_FFT;

function spectroPush(f0) {   // f0 = 0 for silence
  const W = spectro.width, step = Math.max(1, Math.round(devicePixelRatio || 1));
  const max = Math.max(1, Math.floor(W / step));
  let entry = null;
  if (f0) {
    const bin = spBin();
    const lo = Math.max(1, Math.floor(0.5 * f0 / bin)), hi = Math.min(recSpec.length - 1, Math.ceil(13.5 * f0 / bin));
    let ref = -Infinity;
    for (let i = lo; i <= hi; i++) if (recSpec[i] > ref) ref = recSpec[i];
    const reuse = spHist.length >= max ? spHist.shift() : null;
    const spec = reuse?.spec ?? new Float32Array(recSpec.length);
    spec.set(recSpec);
    entry = { spec, ref, f0 };
    // Reference fundamental: short exponential smoothing in log-frequency, snapping on jumps over 0.6 semitone.
    const now = performance.now(), dt = Math.min(0.1, (now - spRefAt) / 1000);
    spRefAt = now;
    const d = 12 * Math.log2(f0 / (spRef || f0));
    spRef = spRef && Math.abs(d) < 0.6 ? spRef * Math.pow(2, (d / 12) * (1 - Math.exp(-dt / 0.08))) : f0;
  }
  if (!entry) { if (spHist.length >= max) spHist.shift(); }
  spHist.push(entry);
  while (spHist.length > max) spHist.shift();
}

function spectroDraw() {
  const W = spectro.width, H = spectro.height;
  if (!W || !H) return;
  if (!spImg || spImg.width !== W || spImg.height !== H) spImg = spectroCtx.createImageData(W, H);
  const step = Math.max(1, Math.round(devicePixelRatio || 1));
  const d = spImg.data, bin = recCtx ? spBin() : 1;
  // Per-row harmonic position h (1 = the H1 row's centre) and guide rows.
  const hRow = new Float32Array(H), guide = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    const h = 1 + (y - spY0) / spPitch;
    hRow[y] = h;
    guide[y] = Math.abs(h - Math.round(h)) * spPitch < 0.5 ? 1 : 0;
  }
  const n = spHist.length;
  for (let x = 0; x < W; x++) {
    const j = n - 1 - Math.floor((W - 1 - x) / step);     // history index of this pixel column (newest at the right edge)
    const e = j >= 0 && spRef ? spHist[j] : null;
    const floor = e ? e.ref - SPECTRO_RANGE_DB : 0;
    // Inverted translation: an older column whose pitch was r = f0/spRef times the current one is stretched by 1/r
    // (its harmonic k is drawn at row k/r), so a descending pitch slopes down on screen (the rows run H1 at the top).
    const c = e ? (e.f0 * e.f0) / spRef / bin : 0;
    for (let y = 0; y < H; y++) {
      let t = 0;
      if (e && hRow[y] >= 0.5) {
        const b = hRow[y] * c;
        if (b >= 1 && b < e.spec.length - 1) {
          const i = b | 0, fr = b - i;
          t = Math.min(1, Math.max(0, ((e.spec[i] * (1 - fr) + e.spec[i + 1] * fr) - floor) / SPECTRO_RANGE_DB));
        }
      }
      if (guide[y] && t < 0.12) t = 0.12;
      const k = ((t * 255) | 0) * 3, o = (y * W + x) * 4;
      d[o] = SPECTRO_LUT[k]; d[o + 1] = SPECTRO_LUT[k + 1]; d[o + 2] = SPECTRO_LUT[k + 2]; d[o + 3] = 255;
    }
  }
  spectroCtx.putImageData(spImg, 0, 0);
}

function recMsg(text = '') {
  const el = $('harmMsg');
  el.textContent = text;
  el.hidden = !text;
}

function recFrame() {
  recRaf = requestAnimationFrame(recFrame);
  recAnalyser.getFloatTimeDomainData(recTime);
  const win = recTime.subarray(recTime.length - REC_YIN_LEN);
  let sq = 0;
  for (let i = 0; i < win.length; i++) sq += win[i] * win[i];
  if (Math.sqrt(sq / win.length) < TUNER_RMS_GATE) { spectroPush(0); spectroDraw(); return; }      // silence: keep the current sliders
  const sr = recCtx.sampleRate;
  const f0 = yinPitch(win, sr);
  recAnalyser.getFloatFrequencyData(recSpec);
  if (!f0) { spectroPush(0); spectroDraw(); return; }
  const bin = sr / REC_FFT, ratio = Math.pow(2, REC_WINDOW_CENTS / 1200);
  const now = performance.now();
  const dt = Math.min(0.1, (now - recLastAt) / 1000);
  const k = recLastAt ? 1 - Math.exp(-dt / REC_SMOOTH_S) : 1;
  recLastAt = now;
  const raw = [];
  for (let i = 0; i < HARMONICS; i++) {
    const f = f0 * (i + 1);
    if (f * ratio >= sr / 2 * 0.95) { raw.push(0); continue; }
    const lo = Math.max(1, Math.floor((f / ratio) / bin)), hi = Math.min(recSpec.length - 1, Math.ceil((f * ratio) / bin));
    let peak = -Infinity;
    for (let b = lo; b <= hi; b++) if (recSpec[b] > peak) peak = recSpec[b];
    raw.push(Math.pow(10, peak / 20));                          // dB → linear amplitude
  }
  spectroPush(f0); spectroDraw();
  recAmps = recAmps ? recAmps.map((a, i) => a + k * (raw[i] - a)) : raw;
  const top = Math.max(...recAmps);
  if (!(top > 0)) return;
  clearInstrument();
  recAmps.forEach((a, i) => {
    const rel = a / top;
    const h = state.harmonics[i];
    h.on = rel >= REC_OFF_BELOW;
    if (h.on) h.vol = Math.round(100 * Math.sqrt(rel));
    renderRow(i); applyPartial(i);
  });
  if (now - recSavedAt > 500) { recSavedAt = now; save(); }
}

async function recStart() {
  if (recStream) return;
  recBtn.classList.add('on'); recBtn.setAttribute('aria-pressed', 'true');
  setHarmonicsOpen(true, false);   // show the sliders and the spectrogram; the remembered open/closed preference is left alone
  recMsg();
  const { stream, error } = await openMic();
  if (error || !recBtn.classList.contains('on') || recStream) {   // failed, or stopped while the permission prompt was open
    stream?.getTracks().forEach((t) => t.stop());
    if (error) { recMsg(error); recStop(); }
    return;
  }
  recStream = stream;
  recCtx = new (window.AudioContext || window.webkitAudioContext)();
  try { await recCtx.resume(); } catch {}
  recAnalyser = recCtx.createAnalyser();
  recAnalyser.fftSize = REC_FFT;
  recAnalyser.smoothingTimeConstant = 0;
  recTime = new Float32Array(REC_FFT);
  recSpec = new Float32Array(recAnalyser.frequencyBinCount);
  recCtx.createMediaStreamSource(recStream).connect(recAnalyser);   // not routed to the output: no feedback
  recAmps = null; recLastAt = 0;
  harmWrap.classList.add('listening');
  spectroLayout();
  spHist = []; spRef = 0;
  recFrame();
}

function recStop() {
  cancelAnimationFrame(recRaf);
  recStream?.getTracks().forEach((t) => t.stop());
  recCtx?.close().catch(() => {});
  harmWrap.classList.remove('listening');
  const wasOn = !!recStream;
  recStream = recCtx = recAnalyser = recTime = recSpec = recAmps = null;
  recBtn.classList.remove('on'); recBtn.setAttribute('aria-pressed', 'false');
  if (wasOn) save();
}

recBtn.addEventListener('click', () => (recBtn.classList.contains('on') ? recStop() : recStart()));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') recStop(); });

// ---------- Instrument presets ----------
// Amplitudes are relative linear levels (0 = off). Sliders are perceptual (gain = (v/100)²),
// so a level a becomes slider value 100·√a. `mod` sets the sweep; static instruments turn it off.
const hn = (k) => k + 1;   // harmonic number of index k
const INSTRUMENTS = [
  { id: 'clarinet', name: 'Clarinet', group: 'Steady',
    amps: Array.from({ length: HARMONICS }, (_, k) => (hn(k) % 2 ? 1 / Math.pow(hn(k), 1.3) : 0)) },
  { id: 'flute', name: 'Flute', group: 'Steady',
    amps: [1, 0.5, 0.25, 0.12, 0.06, 0.03, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'organ', name: 'Organ', group: 'Steady',      // drawbar-style: H1 H2 H3 H4 H6 H8
    amps: [1, 0.8, 0.7, 0.6, 0, 0.5, 0, 0.45, 0, 0, 0, 0, 0] },
  { id: 'strings', name: 'Strings', group: 'Steady',  // sawtooth-like 1/n
    amps: Array.from({ length: HARMONICS }, (_, k) => 1 / hn(k)) },
  { id: 'oboe', name: 'Oboe', group: 'Steady',        // weak fundamental, formant around H3
    amps: [0.5, 0.9, 1, 0.9, 0.7, 0.45, 0.3, 0.2, 0.15, 0.1, 0.08, 0.06, 0.05] },
  { id: 'bagpipe', name: 'Bagpipe', group: 'Steady',
    amps: [1, 0.9, 0.9, 0.85, 0.8, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45] },
  { id: 'harmonium', name: 'Harmonium', group: 'Steady',  // reed, slight H3–H6 boost
    amps: [1, 0.57, 0.58, 0.46, 0.39, 0.33, 0.21, 0.19, 0.17, 0.16, 0.15, 0.14, 0.13] },
  { id: 'brass', name: 'Brass', group: 'With swell',    // trombone-like: peak at H2, slow fall
    amps: [0.8, 1, 0.9, 0.75, 0.6, 0.5, 0.4, 0.3, 0.22, 0.16, 0.12, 0.09, 0.07],
    swell: { on: true, rate: 0.1, depth: 70 } },
  { id: 'tanpura', name: 'Tanpura', group: 'With sweep',   // shimmering upper band
    amps: [1, 0.5, 0.35, 0.3, 0.5, 0.55, 0.55, 0.5, 0.45, 0.4, 0.25, 0.15, 0.1],
    mod: { on: true, rate: 0.12, depth: 80, from: 4 } },
  { id: 'overtone', name: 'Overtone', group: 'With sweep',
    amps: [1, 0.25, 0.1, 0.1, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6],
    mod: { on: true, rate: 0.06, depth: 100, from: 5 } },
  { id: 'didgeridoo', name: 'Didgeridoo', group: 'With sweep',
    amps: [1, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.2, 0.15, 0.1, 0.08, 0.06],
    mod: { on: true, rate: 0.3, depth: 75, from: 3 } },
];

const instrumentSel = $('instrument');
function buildInstruments() {
  instrumentSel.add(new Option('instrument…', ''));
  const groups = {};
  for (const inst of INSTRUMENTS) {
    if (!groups[inst.group]) {
      groups[inst.group] = document.createElement('optgroup');
      groups[inst.group].label = inst.group;
      instrumentSel.append(groups[inst.group]);
    }
    groups[inst.group].append(new Option(inst.name, inst.id));
  }
}

// Any manual change to harmonics or sweep means the sound is no longer the preset.
function clearInstrument() {
  instrumentSel.value = '';
  instrumentSel.classList.remove('chosen');
  presetSel.value = ''; presetSel.classList.remove('chosen');
}

function applyInstrument(id) {
  const inst = INSTRUMENTS.find((x) => x.id === id);
  if (!inst) return;
  const peak = Math.max(...inst.amps);
  setAll((h, i) => {
    const a = inst.amps[i] / peak;
    h.on = a > 0;
    if (a > 0) h.vol = Math.round(100 * Math.sqrt(a));
  });
  Object.assign(state.mod, inst.mod ?? { on: false });
  Object.assign(state.swell, inst.swell ?? { on: false });
  renderMod(); renderSwell();
  applyRate(); applyModFrom(); applySwellRate(); applySwell();
  syncAnimation(); updateLevels(); save();
  instrumentSel.value = id;
  instrumentSel.classList.add('chosen');
}

instrumentSel.addEventListener('change', () => applyInstrument(instrumentSel.value));

// ---------- User presets ----------
// A preset stores the sound: every harmonic's on/volume plus the sweep and swell settings (not the base note).
// The dropdown lists the saved presets; its last entry opens the dialog to save, overwrite or delete.
const PRESETS_KEY = 'shrutibox:presets:v1';
const MAX_PRESETS = 50, MAX_LABEL = 20;
const presetSel = $('presetSel');
const presetsDialog = $('presetsDialog');
const presetName = $('presetName');
const presetList = $('presetList');
const presetEmpty = $('presetEmpty');
const PRESETS_EMPTY_TEXT = presetEmpty.textContent;
const clampNum = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
let presets = loadPresets();

function loadPresets() {
  try {
    const list = JSON.parse(localStorage.getItem(PRESETS_KEY));
    if (!Array.isArray(list)) return [];
    const d = defaults();
    return list.flatMap((p) => {
      if (!p || typeof p.name !== 'string' || !Array.isArray(p.harmonics)) return [];
      return [{
        name: p.name.slice(0, MAX_LABEL),
        harmonics: d.harmonics.map((h, i) => ({
          on: typeof p.harmonics[i]?.on === 'boolean' ? p.harmonics[i].on : false,
          vol: clampNum(p.harmonics[i]?.vol, 0, 100, h.vol),
        })),
        mod: {
          on: p.mod?.on === true,
          rate: clampNum(p.mod?.rate, RATE_MIN, RATE_MAX, d.mod.rate),
          depth: clampNum(p.mod?.depth, 0, 100, d.mod.depth),
          from: Number.isInteger(p.mod?.from) && p.mod.from >= MOD_FROM_MIN && p.mod.from <= MOD_FROM_MAX ? p.mod.from : d.mod.from,
        },
        swell: {
          on: p.swell?.on === true,
          rate: clampNum(p.swell?.rate, RATE_MIN, RATE_MAX, d.swell.rate),
          depth: clampNum(p.swell?.depth, 0, 100, d.swell.depth),
        },
      }];
    }).slice(0, MAX_PRESETS);
  } catch { return []; }
}
function storePresets() {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

// Default label: Preset 01, Preset 02, … the smallest number not used yet.
function nextPresetName() {
  const used = new Set(presets.map((p) => p.name.toLowerCase()));
  let k = 1;
  while (used.has(`preset ${String(k).padStart(2, '0')}`)) k++;
  return `Preset ${String(k).padStart(2, '0')}`;
}

// Dropdown: "presets…" placeholder, the saved presets, then "Save / edit…" last.
const PRESET_EDIT = 'edit';
function renderPresetSelect() {
  presetSel.replaceChildren(new Option('presets…', ''));
  presets.forEach((p, i) => presetSel.add(new Option(p.name, i)));
  presetSel.add(new Option('Save / edit…', PRESET_EDIT));
  presetSel.value = '';
  presetSel.classList.remove('chosen');
}

// Small bar graph of the harmonics (bar height = slider position, off = dim).
function presetBars(p) {
  const wrap = document.createElement('span');
  wrap.className = 'preset-bars';
  wrap.setAttribute('aria-hidden', 'true');
  for (const h of p.harmonics) {
    const b = document.createElement('i');
    b.style.height = `${h.on ? Math.max(8, h.vol) : 8}%`;
    b.className = h.on ? 'on' : '';
    wrap.append(b);
  }
  return wrap;
}

function presetSummary(p) {
  const n = p.harmonics.filter((h) => h.on).length;
  return `${n} harmonic${n === 1 ? '' : 's'}${p.mod.on ? ' · sweep' : ''}${p.swell.on ? ' · swell' : ''}`;
}

function renderPresets() {
  presetEmpty.hidden = presets.length > 0;
  presetList.hidden = presets.length === 0;
  presetList.replaceChildren(...presets.map((p, i) => {
    const li = document.createElement('li');
    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'preset-load';
    load.dataset.load = i;
    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = p.name;
    const info = document.createElement('small');
    info.textContent = presetSummary(p);
    const head = document.createElement('span');
    head.className = 'preset-head';
    head.append(name, info);
    load.append(head, presetBars(p));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'preset-del';
    del.dataset.del = i;
    del.setAttribute('aria-label', `Delete preset ${p.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
    li.append(load, del);
    return li;
  }));
  presetName.value = nextPresetName();
  renderPresetSelect();
}

function savePreset() {
  const name = presetName.value.trim().slice(0, MAX_LABEL) || nextPresetName();
  const p = {
    name,
    harmonics: state.harmonics.map((h) => ({ on: h.on, vol: h.vol })),
    mod: { ...state.mod }, swell: { ...state.swell },
  };
  const at = presets.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
  if (at >= 0) presets[at] = p;                       // same label: overwrite
  else if (presets.length < MAX_PRESETS) presets.push(p);
  else { presetEmpty.textContent = `Too many presets (max ${MAX_PRESETS}): delete one first.`; presetEmpty.hidden = false; return; }
  storePresets();
  renderPresets();
}

function applyPreset(p) {
  clearInstrument();
  state.harmonics.forEach((h, i) => { Object.assign(h, p.harmonics[i]); applyPartial(i); });
  Object.assign(state.mod, p.mod);
  Object.assign(state.swell, p.swell);
  renderMod(); renderSwell();
  applyRate(); applyModFrom(); applySwellRate(); applySwell();
  syncAnimation(); updateLevels(); save();
}

presetSel.addEventListener('change', () => {
  const v = presetSel.value;
  if (v === PRESET_EDIT) {
    presetEmpty.textContent = PRESETS_EMPTY_TEXT;
    renderPresets();
    presetsDialog.showModal();
    $('presetSave').focus();   // not the text field: no virtual keyboard on touch devices
  } else if (v !== '' && presets[+v]) {
    applyPreset(presets[+v]);
    presetSel.value = v;
    presetSel.classList.add('chosen');   // stays shown until any manual change (clearInstrument)
  }
});
$('presetSave').addEventListener('click', savePreset);
presetName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); savePreset(); } });
presetList.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { presets.splice(+del.dataset.del, 1); storePresets(); renderPresets(); return; }
  const load = e.target.closest('[data-load]');
  if (load) { applyPreset(presets[+load.dataset.load]); presetsDialog.close(); }
});
presetsDialog.addEventListener('click', (e) => { if (e.target === presetsDialog) presetsDialog.close(); });
renderPresetSelect();

$('reset').addEventListener('click', () => {
  const d = defaults().harmonics;
  setAll((h, i) => { h.on = d[i].on; h.vol = d[i].vol; });
});

// Space = play/stop (unless a control has focus and uses Space itself).
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat) return;
  const t = e.target;
  if (presetsDialog.open || (t instanceof HTMLInputElement && t.type === 'text')) return;
  if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement ||
      (t instanceof HTMLInputElement && t.type === 'checkbox')) return;
  e.preventDefault();
  toggle();
});

// ---------- Touch: scroll-safe controls ----------
// On touch screens a swipe that starts on a slider would move it, and a tap that stops a
// momentum scroll would flip a switch. Sliders here only respond to a deliberate horizontal
// drag (relative, no jump-to-touch); vertical swipes scroll the page. Switch taps right after
// a scroll are ignored.
let lastScroll = 0;
addEventListener('scroll', () => { lastScroll = performance.now(); }, { passive: true, capture: true });

document.addEventListener('click', (e) => {
  if (performance.now() - lastScroll < 350 && e.target.closest('.switch')) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

const DRAG_SLOP = 8;   // px of movement before deciding scroll vs. drag

function touchSafeRange(input) {
  const host = input.parentElement;
  input.classList.add('touch-range');   // native input ignores touches (CSS)
  host.classList.add('touch-host');     // host lets the browser handle vertical pans only
  let g = null;

  host.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const r = input.getBoundingClientRect();
    if (e.clientX < r.left - 6 || e.clientX > r.right + 6 || e.clientY < r.top - 12 || e.clientY > r.bottom + 12) return;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, v: input.valueAsNumber, w: r.width, drag: false };
  });

  host.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.drag) {
      if (Math.abs(dy) > DRAG_SLOP && Math.abs(dy) >= Math.abs(dx)) { g = null; return; }  // a scroll
      if (Math.abs(dx) < DRAG_SLOP) return;
      g.drag = true;
      g.x = e.clientX;                     // start from here: no jump when the drag kicks in
      host.setPointerCapture(e.pointerId);
      input.classList.add('dragging');
      return;
    }
    const min = +input.min, max = +input.max, step = +input.step || 1;
    let v = g.v + ((e.clientX - g.x) / g.w) * (max - min);
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (v !== input.valueAsNumber) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  const end = (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (g.drag) input.dispatchEvent(new Event('change', { bubbles: true }));
    input.classList.remove('dragging');
    g = null;
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
}

// ---------- Embedding (home page) ----------
// Inside the home page: accept play/stop commands and report status to the parent.
const EMBEDDED = window.parent !== window;
if (EMBEDDED) document.documentElement.classList.add('embedded');

function report() {
  if (!EMBEDDED) return;
  parent.postMessage({ type: 'status', app: 'drone', playing: playing, info: `${noteName(SOLFEGE[state.note], LETTERS[state.note], state.octave)}${state.mod.on ? ' · sweep' : ''}${state.swell.on ? ' · swell' : ''}` }, '*');
}

// If the browser refused to start audio (autoplay policy), tell the home page.
function checkBlocked() {
  setTimeout(() => {
    if (EMBEDDED && playing && ctx?.state !== 'running') parent.postMessage({ type: 'blocked', app: 'drone' }, '*');
  }, 400);
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.type !== 'cmd') return;
  const a = e.data.action;
  if (a === 'toggle') toggle();
  else if (a === 'play' && !playing) start();
  else if (a === 'stop' && playing) stop();
  else if (a === 'ping') report();
  else if (a === 'leave') { setTunerOpen(false); recStop(); }   // the user switched to another tab: close the tuner, stop the recorder, release the mic
  else if (a === 'volume' && Number.isFinite(e.data.value)) {
    shellVol = Math.min(1, Math.max(0, e.data.value));
    if (trim) trim.gain.setTargetAtTime(shellVol, ctx.currentTime, 0.02);
  }
});

// ---------- Init ----------
buildSelectors();
buildInstruments();
buildRows();
if (matchMedia('(pointer: coarse)').matches) {
  document.querySelectorAll('input[type="range"]').forEach(touchSafeRange);
}
renderAll();
report();
