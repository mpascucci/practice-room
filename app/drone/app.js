// Drone — additive drone: one sine partial per harmonic, bellows-like breathing.

const SOLFEGE = ['DO', 'DO♯', 'RE', 'RE♯', 'MI', 'FA', 'FA♯', 'SOL', 'SOL♯', 'LA', 'SI♭', 'SI'];
const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
const HARMONICS = 13;
const STORAGE_KEY = 'shrutibox:v1';
const ATTACK = 0.6, RELEASE = 0.9, GLIDE = 0.08; // seconds

// Sweep: harmonics from H<state.mod.from> up get a sinusoidal gain modulation,
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

const defaults = () => ({
  note: 0,          // pitch class, 0 = C
  octave: 3,
  master: 70,
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
const masterRange = $('master');
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
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s || !Array.isArray(s.harmonics)) return;
    const d = defaults();
    state = {
      note: Number.isInteger(s.note) && s.note >= 0 && s.note < 12 ? s.note : d.note,
      octave: [2, 3, 4].includes(s.octave) ? s.octave : d.octave,
      master: Number.isFinite(s.master) ? Math.min(100, Math.max(0, s.master)) : d.master,
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
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  report();
}

// ---------- Pitch helpers ----------
const midiOf = () => 12 * (state.octave + 1) + state.note;          // C4 = 60
const freqOfMidi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const fundamental = () => freqOfMidi(midiOf());

// Nearest equal-tempered note of a harmonic, with cents deviation.
function harmonicPitch(k) {
  const exact = midiOf() + 12 * Math.log2(k);
  const nearest = Math.round(exact);
  const cents = Math.round((exact - nearest) * 100);
  const pc = ((nearest % 12) + 12) % 12;
  return { name: `${SOLFEGE[pc]} · ${LETTERS[pc]}`, cents };
}

// Perceptual slider → gain.
const volToGain = (v) => Math.pow(v / 100, 2);

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

function applyMaster(target = playing ? volToGain(state.master) : 0, tc = 0.05) {
  if (!nodes) return;
  const g = nodes.master.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.setTargetAtTime(target, ctx.currentTime, tc);
}

// ---------- Transport ----------
function start() {
  if (!ctx) buildGraph();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  playing = true;
  applyMaster(volToGain(state.master), ATTACK / 3);   // bellows fill up
  playBtn.setAttribute('aria-pressed', 'true');
  playBtn.setAttribute('aria-label', 'Stop');
  syncAnimation();
  requestWakeLock();
  report();
  checkBlocked();
}

function stop() {
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
  noteSel.innerHTML = SOLFEGE.map((s, i) => `<option value="${i}">${s} - ${LETTERS[i]}</option>`).join('');
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

function renderPitch() {
  const f0 = fundamental();
  rowEls.forEach((el, i) => {
    const { name, cents } = harmonicPitch(i + 1);
    const c = cents === 0 ? '' : `<span class="cents">${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢</span>`;
    el.pitch.innerHTML = `${name}${c}`;
    el.hz.textContent = `${(f0 * (i + 1)).toFixed(1)} Hz`;
  });
  freqEl.textContent = `${SOLFEGE[state.note]} - ${LETTERS[state.note]}${state.octave} · ${f0.toFixed(2)} Hz (A4 = 440 Hz)`;
}

const updateLevels = () => state.harmonics.forEach((_, i) => renderRow(i));

function renderAll() {
  noteSel.value = state.note;
  octaveSel.value = state.octave;
  masterRange.value = state.master;
  setRangeFill(masterRange);
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
masterRange.addEventListener('input', () => {
  setRangeFill(masterRange);
  state.master = masterRange.valueAsNumber;
  if (playing) applyMaster();
  save();
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
$('presetFlat').addEventListener('click', () => setAll((h) => { h.on = true; h.vol = FLAT_VOL; }));
$('presetLinear').addEventListener('click', () => setAll((h, i) => { h.on = true; h.vol = linearVol(i); }));

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

$('reset').addEventListener('click', () => {
  const d = defaults().harmonics;
  setAll((h, i) => { h.on = d[i].on; h.vol = d[i].vol; });
});

// Space = play/stop (unless a control has focus and uses Space itself).
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat) return;
  const t = e.target;
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
  parent.postMessage({ type: 'status', app: 'drone', playing: playing, info: `${SOLFEGE[state.note]} - ${LETTERS[state.note]}${state.octave}${state.mod.on ? ' · sweep' : ''}${state.swell.on ? ' · swell' : ''}` }, '*');
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
