// Metronome — Web Audio lookahead scheduler, Worker-driven timer, rAF-synced visuals.

const STATES = ['silent', 'normal', 'accent'];
const MIN_BEATS = 1, MAX_BEATS = 24;
const MIN_MEASURES = 1, MAX_MEASURES = 8;
const MIN_BPM = 20, MAX_BPM = 300;
const LOOKAHEAD = 0.12;      // seconds of audio scheduled ahead
const TICK_MS = 25;          // scheduler wake-up interval
const TAP_RESET_MS = 2000;   // a pause longer than this starts a new tap series
const TAP_MAX = 9;           // taps kept for the running average (8 intervals)
const STORAGE_KEY = 'metronome:v2';
const TIMBRES = ['string', 'brass'];
const MIN_DENOM = 1, MAX_DENOM = 16;
const LETTERS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
const SOLFEGE = ['DO', 'DO♯', 'RE', 'RE♯', 'MI', 'FA', 'FA♯', 'SOL', 'SOL♯', 'LA', 'SI♭', 'SI'];
const MIN_OCT = 1, MAX_OCT = 6;
const MIN_MIDI = 12 * (MIN_OCT + 1), MAX_MIDI = 12 * (MAX_OCT + 1) + 11;
const freqOfMidi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Brass spectrum (same harmonic amplitudes as the drone's "Brass" preset).
const BRASS = [0.8, 1, 0.9, 0.75, 0.6, 0.5, 0.4, 0.3, 0.22, 0.16, 0.12, 0.09, 0.07];
const ATTACK = 0.003;        // s — near-instant, precise onset
const MIN_NOTE = 0.04;       // s — shortest sounding length

const $ = (id) => document.getElementById(id);
const measuresEl = $('measures');
const stageEl = $('stage');
const playBtn = $('play');
const beatInput = $('beatCount');
const measureInput = $('measureCount');
const tempoInput = $('tempo');
const tempoRange = $('tempoRange');
const tapBtn = $('tap');
const tapInfo = $('tapInfo');
const multSelect = $('tempoMult');
const tempoEff = $('tempoEff');
const denomInput = $('denom');

const defaultMeasure = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 'accent' : 'normal'));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const effBpm = () => state.bpm * state.mult;
// Effective tempo in the label; highlighted (blue) only when the multiplier is not 1.
function showEff() {
  tempoEff.textContent = effBpm();
  tempoEff.classList.toggle('multiplied', state.mult !== 1);
  multSelect.classList.toggle('multiplied', state.mult !== 1);
}

// ---------- State ----------
// measures: array of measures, each an array of beat states; all share the same beat count.
const state = {
  bpm: 120,
  mult: 1,          // tempo multiplier 1–4; the effective tempo is bpm × mult
  measures: [defaultMeasure(4)],
  playing: false,
  normalMidi: 50,   // D3
  accentMidi: 38,   // D2
  mode: 'click',      // 'click' (plain sine tick) | 'instrument' (see settings dialog) | 'percussion' (WAV samples, see `perc`)
  timbre: 'brass',  // 'brass' = labelled "sustain" in the UI (sustained) | 'string' = labelled "pluck" (plucked); the stored values keep their old names
  denom: 3,         // note length = 1/denom of a beat
  perc: 'bass-snare', // percussion set: a folder in sounds/ (see PERC_SETS)
};
const MODES = ['click', 'instrument', 'percussion'];
const PERC_SETS = ['machine', 'bass-snare', 'darabuka', 'tapan', 'pier'];
const PERC_FILES = { pier: { low: 'pier_PAN.flac', high: 'pier_TA.flac' } };   // sets not using low.flac / high.flac
const beatCount = () => state.measures[0].length;
load();

let ctx = null;          // AudioContext (created on first user gesture)
let out = null;          // output gain: every sound goes through it (volume set by the home page)
let shellVol = 1;
let worker = null;       // timer worker (not throttled in background tabs like setInterval)
let nextTime = 0;        // audio time of the next beat to schedule
let nextMeasure = 0;     // measure index of the next beat to schedule
let nextBeat = 0;        // beat index of the next beat to schedule
let queue = [];          // scheduled beats awaiting display: {m, i, t}
let litEl = null;
let rafId = 0;
let wakeLock = null;

// ---------- Persistence ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!s || !Number.isInteger(s.bpm) || !Array.isArray(s.measures) || !s.measures.length) return;
    const n = clamp(s.measures[0].length || 4, MIN_BEATS, MAX_BEATS);
    state.bpm = clamp(s.bpm, MIN_BPM, MAX_BPM);
    if (Number.isInteger(s.mult)) state.mult = clamp(s.mult, 1, 4);
    state.measures = s.measures.slice(0, MAX_MEASURES).map((m) =>
      Array.from({ length: n }, (_, i) => (STATES.includes(m?.[i]) ? m[i] : 'normal')));
    if (Number.isInteger(s.normalMidi)) state.normalMidi = clamp(s.normalMidi, MIN_MIDI, MAX_MIDI);
    if (Number.isInteger(s.accentMidi)) state.accentMidi = clamp(s.accentMidi, MIN_MIDI, MAX_MIDI);
    if (MODES.includes(s.mode)) state.mode = s.mode;
    if (s.mode === 'drum') state.mode = 'percussion';   // legacy name
    if (s.perc === 'darabouka') s.perc = 'darabuka';   // old spelling in saved settings
    if (PERC_SETS.includes(s.perc)) state.perc = s.perc;
    if (TIMBRES.includes(s.timbre)) state.timbre = s.timbre;
    if (Number.isInteger(s.denom)) state.denom = clamp(s.denom, MIN_DENOM, MAX_DENOM);
  } catch { /* storage unavailable — use defaults */ }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ bpm: state.bpm, mult: state.mult, measures: state.measures, normalMidi: state.normalMidi, accentMidi: state.accentMidi, denom: state.denom, timbre: state.timbre, mode: state.mode, perc: state.perc })); } catch {}
  report();
}

// ---------- Rendering ----------
function diskLabel(m, i) {
  return `Measure ${m + 1}, beat ${i + 1}: ${state.measures[m][i]}`;
}

function renderBeats() {
  const n = beatCount();
  const mCount = state.measures.length;
  stageEl.style.setProperty('--n', n);
  stageEl.style.setProperty('--m', mCount);

  // Reuse existing rows/disks, add/remove the difference.
  while (measuresEl.children.length > mCount) measuresEl.lastElementChild.remove();
  while (measuresEl.children.length < mCount) {
    const row = document.createElement('div');
    row.className = 'beats';
    row.setAttribute('role', 'group');
    measuresEl.append(row);
  }
  [...measuresEl.children].forEach((row, m) => {
    row.setAttribute('aria-label', `Measure ${m + 1} (click a beat to change: silent, normal, accent)`);
    while (row.children.length > n) row.lastElementChild.remove();
    while (row.children.length < n) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'disk';
      row.append(b);
    }
    [...row.children].forEach((el, i) => {
      el.dataset.measure = m;
      el.dataset.index = i;
      el.dataset.state = state.measures[m][i];
      el.textContent = n <= 16 ? i + 1 : '';
      el.setAttribute('aria-label', diskLabel(m, i));
    });
  });
  if (litEl && !litEl.isConnected) litEl = null;
}

function diskAt(m, i) {
  return measuresEl.children[m]?.children[i] ?? null;
}

function setLit(el) {
  if (el && el === litEl) {
    // Same disk again (single beat, single measure): retrigger the flash.
    el.classList.remove('lit'); void el.offsetWidth; el.classList.add('lit');
    return;
  }
  litEl?.classList.remove('lit');
  litEl = el;
  el?.classList.add('lit');
}

function syncInputs() {
  beatInput.value = beatCount();
  measureInput.value = state.measures.length;
  tempoInput.value = state.bpm;
  tempoRange.value = state.bpm;
  multSelect.value = state.mult;
  showEff();
  denomInput.value = state.denom === 1 ? '1' : `1/${state.denom}`;
}

// ---------- Audio ----------
function ensureAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    out = ctx.createGain();
    out.gain.value = shellVol;
    out.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  if (state.mode === 'percussion') loadPerc();
  if (!worker) {
    const src = `let id=null;onmessage=e=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage(0),${TICK_MS});}else{clearInterval(id);id=null;}};`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = scheduler;
  }
}

// Plain click: short sine tick.
function sineClick(time, accent) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(accent ? 1760 : 1100, time);
  const peak = accent ? 0.9 : 0.6;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + (accent ? 0.08 : 0.05));
  osc.connect(gain).connect(out);
  osc.start(time);
  osc.stop(time + 0.1);
}

// Percussion mode: each set is a folder sounds/<set>/ with low.flac (accent beats) and high.flac
// (normal beats). To change a set's sounds, replace its two files (and bump VERSION in sw.js).
const percBuffers = {};   // set -> {low, high}
const percLoading = {};   // set -> Promise
function loadPerc(set = state.perc) {
  percLoading[set] ??= Promise.all(['low', 'high'].map(async (kind) => {
    try {
      const res = await fetch(`sounds/${set}/${PERC_FILES[set]?.[kind] ?? kind + '.flac'}`);
      (percBuffers[set] ??= {})[kind] = await ctx.decodeAudioData(await res.arrayBuffer());
    } catch { /* missing or undecodable: that drum stays silent */ }
  }));
  return percLoading[set];
}
function percHit(time, accent) {
  const buf = percBuffers[state.perc]?.[accent ? 'low' : 'high'];
  if (!buf) return;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = buf;
  gain.gain.value = accent ? 1 : 0.85;
  src.connect(gain).connect(out);
  src.start(time);
}

let brassWave = null;
function click(time, accent, dur = (60 / effBpm()) / state.denom) {
  if (state.mode === 'click') return sineClick(time, accent);
  if (state.mode === 'percussion') return percHit(time, accent);
  if (!brassWave) {
    const re = new Float32Array(BRASS.length + 1), im = new Float32Array(BRASS.length + 1);
    BRASS.forEach((v, k) => { im[k + 1] = v; });
    brassWave = ctx.createPeriodicWave(re, im);
  }
  dur = Math.max(MIN_NOTE, dur);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.setPeriodicWave(brassWave);
  osc.frequency.setValueAtTime(freqOfMidi(accent ? state.accentMidi : state.normalMidi), time);
  const peak = accent ? 0.5 : 0.35;   // spectrum sums to ~6.3, so scale down
  const end = time + dur;
  gain.gain.setValueAtTime(0.0001, time);
  if (state.timbre === 'brass') {
    // Sustained note: short attack, flat body, quick release; the filter opens during the
    // attack so the upper harmonics bloom just after the onset.
    const att = Math.min(0.012, dur * 0.3);
    const rel = Math.min(0.035, dur * 0.4);
    gain.gain.linearRampToValueAtTime(peak, time + att);
    gain.gain.setValueAtTime(peak, end - rel);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    const f = freqOfMidi(accent ? state.accentMidi : state.normalMidi);
    lp.frequency.setValueAtTime(f * 2, time);
    lp.frequency.exponentialRampToValueAtTime(Math.min(f * 14, 18000), time + att * 2.5);
    osc.connect(lp).connect(gain);
  } else {
    // Plucked: instant attack, then a continuous exponential decay.
    gain.gain.linearRampToValueAtTime(peak, time + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
  }
  gain.connect(out);
  osc.start(time);
  osc.stop(time + dur + 0.02);
}

function scheduler() {
  const horizon = ctx.currentTime + LOOKAHEAD;
  while (nextTime < horizon) {
    // Counts may have changed since the last tick.
    if (nextMeasure >= state.measures.length) nextMeasure = 0;
    if (nextBeat >= beatCount()) nextBeat = 0;

    const s = state.measures[nextMeasure][nextBeat];
    if (s !== 'silent') click(nextTime, s === 'accent');
    queue.push({ m: nextMeasure, i: nextBeat, t: nextTime });

    nextTime += 60 / effBpm();
    if (++nextBeat >= beatCount()) {
      nextBeat = 0;
      nextMeasure = (nextMeasure + 1) % state.measures.length;
    }
  }
}

function draw() {
  // Compensate for output latency so the light matches what's heard.
  const now = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  let due = null;
  while (queue.length && queue[0].t <= now) due = queue.shift();
  if (due) setLit(diskAt(due.m, due.i));
  rafId = requestAnimationFrame(draw);
}

// ---------- Transport ----------
function start() {
  ensureAudio();
  state.playing = true;
  nextMeasure = 0;
  nextBeat = 0;
  queue = [];
  nextTime = ctx.currentTime + 0.06;
  scheduler();
  worker.postMessage('start');
  rafId = requestAnimationFrame(draw);
  playBtn.setAttribute('aria-pressed', 'true');
  playBtn.setAttribute('aria-label', 'Stop');
  requestWakeLock();
  report();
  checkBlocked();
}

function stop() {
  state.playing = false;
  worker?.postMessage('stop');
  cancelAnimationFrame(rafId);
  queue = [];
  setLit(null);
  playBtn.setAttribute('aria-pressed', 'false');
  playBtn.setAttribute('aria-label', 'Play');
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  report();
}

const toggle = () => (state.playing ? stop() : start());

// Keep the screen on while playing (Screen Wake Lock API).
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.playing) requestWakeLock();
});

// ---------- Setters ----------
function setBeatCount(n) {
  n = clamp(Math.round(n), MIN_BEATS, MAX_BEATS);
  if (!Number.isFinite(n)) return;
  for (const m of state.measures) {
    if (n > m.length) m.push(...Array(n - m.length).fill('normal'));
    else m.length = n;
  }
  renderBeats();
  save();
}

function setMeasureCount(count) {
  count = clamp(Math.round(count), MIN_MEASURES, MAX_MEASURES);
  if (!Number.isFinite(count)) return;
  // New measures copy the pattern of the last one.
  while (state.measures.length < count) state.measures.push([...state.measures.at(-1)]);
  state.measures.length = count;
  renderBeats();
  save();
}

function setTempo(bpm) {
  bpm = clamp(Math.round(bpm), MIN_BPM, MAX_BPM);
  if (!Number.isFinite(bpm)) return;
  state.bpm = bpm;
  tempoRange.value = bpm;
  showEff();
  save();
}

function setMult(m) {
  m = clamp(Math.round(m), 1, 4);
  if (!Number.isFinite(m)) return;
  state.mult = m;
  multSelect.value = m;
  showEff();
  save();
}
multSelect.addEventListener('change', () => setMult(Number(multSelect.value)));

function setDenom(d) {
  d = clamp(Math.round(d), MIN_DENOM, MAX_DENOM);
  if (!Number.isFinite(d)) return;
  state.denom = d;
  save();
}

// ---------- Tap tempo ----------
let taps = [];
let tapResetTimer = 0;
let tapFlashTimer = 0;

function tap() {
  const now = performance.now();
  if (taps.length && now - taps.at(-1) > TAP_RESET_MS) taps = [];
  taps.push(now);
  if (taps.length > TAP_MAX) taps.shift();

  if (taps.length >= 2) {
    const avgMs = (taps.at(-1) - taps[0]) / (taps.length - 1);
    setMult(1);
    setTempo(60000 / avgMs);
    syncInputs();
  }
  tapInfo.textContent = 'tap again';

  tapBtn.classList.add('hit');
  clearTimeout(tapFlashTimer);
  tapFlashTimer = setTimeout(() => tapBtn.classList.remove('hit'), 90);

  clearTimeout(tapResetTimer);
  tapResetTimer = setTimeout(() => { taps = []; tapInfo.textContent = ''; }, TAP_RESET_MS);
}

// pointerdown (not click) so the timestamp is taken at the moment of the tap.
tapBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
tapBtn.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); tap(); }
});

// ---------- Events ----------
playBtn.addEventListener('click', toggle);

measuresEl.addEventListener('click', (e) => {
  const disk = e.target.closest('.disk');
  if (!disk) return;
  const m = +disk.dataset.measure, i = +disk.dataset.index;
  const row = state.measures[m];
  row[i] = STATES[(STATES.indexOf(row[i]) + 1) % STATES.length];
  disk.dataset.state = row[i];
  disk.setAttribute('aria-label', diskLabel(m, i));
  save();
});

// Number inputs: apply while typing if valid; normalize on commit.
function bindNumber(input, min, max, setter) {
  input.addEventListener('input', () => {
    const v = input.valueAsNumber;
    if (Number.isInteger(v) && v >= min && v <= max) setter(v);
  });
  input.addEventListener('change', () => {
    if (Number.isFinite(input.valueAsNumber)) setter(input.valueAsNumber);
    syncInputs();
  });
}
bindNumber(beatInput, MIN_BEATS, MAX_BEATS, setBeatCount);
bindNumber(measureInput, MIN_MEASURES, MAX_MEASURES, setMeasureCount);
bindNumber(tempoInput, MIN_BPM, MAX_BPM, setTempo);

tempoRange.addEventListener('input', () => {
  setTempo(tempoRange.valueAsNumber);
  tempoInput.value = state.bpm;
});

// Stepper buttons, with press-and-hold auto-repeat.
const stepActions = {
  tempo: (d) => setTempo(state.bpm + d),
  beatCount: (d) => setBeatCount(beatCount() + d),
  measureCount: (d) => setMeasureCount(state.measures.length + d),
  denom: (d) => setDenom(state.denom - d),   // + = longer note = smaller denominator
};
document.querySelectorAll('[data-step]').forEach((btn) => {
  let holdTimer = 0;
  const step = () => { stepActions[btn.dataset.step](+btn.dataset.dir); syncInputs(); };
  const release = () => clearTimeout(holdTimer);
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    step();
    const repeat = (delay) => { holdTimer = setTimeout(() => { step(); repeat(Math.max(40, delay * 0.85)); }, delay); };
    repeat(400);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, release));
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); step(); } });
});

// Keyboard: Space = play/stop, T = tap, ←/→ = tempo ∓1 (Shift: ∓10), ↑/↓ = beats.
document.addEventListener('keydown', (e) => {
  if (seqDialog.open || settingsDialog.open || presetsDialog.open) return;          // dialog handles its own keys
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.target instanceof HTMLInputElement && e.key !== ' ' && e.key.toLowerCase() !== 't') return;
  const big = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case ' ':
      if (e.target instanceof HTMLButtonElement) return; // buttons handle their own Space
      e.preventDefault(); toggle(); break;
    case 't': case 'T':
      if (!e.repeat) tap(); break;
    case 'ArrowRight': e.preventDefault(); setTempo(state.bpm + big); syncInputs(); break;
    case 'ArrowLeft':  e.preventDefault(); setTempo(state.bpm - big); syncInputs(); break;
    case 'ArrowUp':    e.preventDefault(); setBeatCount(beatCount() + 1); syncInputs(); break;
    case 'ArrowDown':  e.preventDefault(); setBeatCount(beatCount() - 1); syncInputs(); break;
  }
});

// ---------- Embedding (home page) ----------
// Inside the home page: accept play/stop commands and report status to the parent.
const EMBEDDED = window.parent !== window;
if (EMBEDDED) document.documentElement.classList.add('embedded');

function report() {
  if (!EMBEDDED) return;
  parent.postMessage({ type: 'status', app: 'metronome', playing: state.playing, info: `${effBpm()} BPM · ${beatCount()}${state.measures.length > 1 ? ` × ${state.measures.length}` : ''} beats` }, '*');
}

// If the browser refused to start audio (autoplay policy), tell the home page.
function checkBlocked() {
  setTimeout(() => {
    if (EMBEDDED && state.playing && ctx?.state !== 'running') parent.postMessage({ type: 'blocked', app: 'metronome' }, '*');
  }, 400);
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.type !== 'cmd') return;
  const a = e.data.action;
  if (a === 'toggle') toggle();
  else if (a === 'play' && !state.playing) start();
  else if (a === 'stop' && state.playing) stop();
  else if (a === 'ping') report();
  else if (a === 'volume' && Number.isFinite(e.data.value)) {
    shellVol = Math.min(1, Math.max(0, e.data.value));
    if (out) out.gain.setTargetAtTime(shellVol, ctx.currentTime, 0.02);
  }
});

// ---------- Beat sequence dialog ----------
// "2 2 3" → one measure of 7 beats, an accent at the start of each group: A N A N A N N.
const seqDialog = $('seqDialog');
const seqInput = $('seqInput');
const seqError = $('seqError');
const seqResult = $('seqResult');
const seqWarn = $('seqWarn');
const seqOk = $('seqOk');
const SEQ_INVALID = /[^1-9,.;+\-/\s]/g;   // anything not a digit 1–9 or a separator
let seqErrorTimer = 0;

const parseSeq = (text) => text.split(/[,.;+\-/\s]+/).filter(Boolean).map(Number);

const seqForm = $('seqForm');
const SEQ_DEFAULTS = { text: '2 2 3', down: 'accent', up: 'normal' };
const seqKind = (name) => seqForm.elements[name].value;

function showSeqError() {
  seqError.hidden = false;
  seqInput.classList.add('invalid');
  clearTimeout(seqErrorTimer);
  seqErrorTimer = setTimeout(() => { seqError.hidden = true; seqInput.classList.remove('invalid'); }, 2000);
}

function updateSeq() {
  const beats = parseSeq(seqInput.value);
  const sum = beats.reduce((a, b) => a + b, 0);
  seqResult.textContent = beats.length ? `${beats.join(' + ')} = ${sum}` : '';
  const tooMany = sum > MAX_BEATS;
  seqWarn.hidden = !tooMany;
  seqWarn.textContent = tooMany ? `Too many beats: the maximum is ${MAX_BEATS} (${sum - MAX_BEATS} over).` : '';
  seqOk.disabled = !beats.length || tooMany;
}

// Block invalid characters as they are typed…
seqInput.addEventListener('beforeinput', (e) => {
  if (e.data && SEQ_INVALID.test(e.data)) { e.preventDefault(); showSeqError(); }
  SEQ_INVALID.lastIndex = 0;
});
// …and strip them from anything that gets through (paste, drop, autocorrect).
seqInput.addEventListener('input', () => {
  const v = seqInput.value;
  const clean = v.replace(SEQ_INVALID, '');
  if (clean !== v) {
    const pos = seqInput.selectionStart - (v.length - clean.length);
    seqInput.value = clean;
    seqInput.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
    showSeqError();
  }
  updateSeq();
});

$('editSeq').addEventListener('click', () => {
  seqInput.value = SEQ_DEFAULTS.text;
  seqForm.elements.down.value = SEQ_DEFAULTS.down;
  seqForm.elements.up.value = SEQ_DEFAULTS.up;
  seqError.hidden = true;
  seqInput.classList.remove('invalid');
  updateSeq();
  seqDialog.showModal();
  $('seqOk').focus();   // not the text field: on touch devices that would pop the keyboard up straight away
});
$('seqCancel').addEventListener('click', () => seqDialog.close());
// Click on the backdrop = cancel.
seqDialog.addEventListener('click', (e) => { if (e.target === seqDialog) seqDialog.close(); });

seqForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const beats = parseSeq(seqInput.value);
  const sum = beats.reduce((a, b) => a + b, 0);
  if (!beats.length || sum > MAX_BEATS) return;
  const measure = Array(sum).fill(seqKind('up'));
  let at = 0;
  for (const n of beats) { measure[at] = seqKind('down'); at += n; }
  state.measures = [measure];
  renderBeats();
  syncInputs();
  save();
  seqDialog.close();
});

// ---------- Sound settings dialog ----------
const settingsDialog = $('settingsDialog');
const settingsForm = $('settingsForm');
settingsForm.addEventListener('change', (e) => {
  if (e.target.name !== 'timbre') return;
  state.timbre = e.target.value;
  save();
  ensureAudio();
  if (!state.playing) click(ctx.currentTime + 0.02, false);
});
const noteSels = {
  normal: [$('normalNote'), $('normalOct')],
  accent: [$('accentNote'), $('accentOct')],
};
for (const [noteSel, octSel] of Object.values(noteSels)) {
  noteSel.innerHTML = LETTERS.map((l, i) => `<option value="${i}">${l} - ${SOLFEGE[i]}</option>`).join('');
  octSel.innerHTML = Array.from({ length: MAX_OCT - MIN_OCT + 1 }, (_, i) =>
    `<option value="${MIN_OCT + i}">${MIN_OCT + i}</option>`).join('');
}
function syncNoteSelects() {
  settingsForm.elements.timbre.value = state.timbre;
  for (const kind of ['normal', 'accent']) {
    const midi = state[kind + 'Midi'];
    noteSels[kind][0].value = midi % 12;
    noteSels[kind][1].value = Math.floor(midi / 12) - 1;
  }
}
for (const kind of ['normal', 'accent']) {
  for (const sel of noteSels[kind]) {
    sel.addEventListener('change', () => {
      state[kind + 'Midi'] = 12 * (+noteSels[kind][1].value + 1) + +noteSels[kind][0].value;
      save();
      // Audition the note (a user gesture, so audio may start).
      ensureAudio();
      if (!state.playing) click(ctx.currentTime + 0.02, kind === 'accent');
    });
  }
}
const modeClick = $('modeClick'), modeInst = $('modeInst'), modePerc = $('modePerc');
const percDialog = $('percDialog'), percForm = $('percForm');
function syncMode() {
  modeClick.setAttribute('aria-pressed', state.mode === 'click');
  modeInst.setAttribute('aria-pressed', state.mode === 'instrument');
  modePerc.setAttribute('aria-pressed', state.mode === 'percussion');
}
modeClick.addEventListener('click', () => { state.mode = 'click'; syncMode(); save(); });
// Selecting Percussion (or tapping it again) opens its dialog.
modePerc.addEventListener('click', () => {
  state.mode = 'percussion';
  syncMode();
  save();
  ensureAudio();   // user gesture: creates the context and loads the samples
  percForm.elements.perc.value = state.perc;
  percDialog.showModal();
});
percForm.addEventListener('change', (e) => {
  if (e.target.name !== 'perc') return;
  const set = e.target.value;
  ensureAudio();
  // Switch only once the samples are decoded, so a running metronome keeps its old sound instead of going silent.
  loadPerc(set).then(() => {
    if (percForm.elements.perc.value !== set) return;   // another set was picked meanwhile
    state.perc = set;
    save();
    if (state.playing) return;
    // Audition: accent sound, then normal sound.
    const t = ctx.currentTime + 0.02; click(t, true); click(t + 0.5, false);
  });
});
percDialog.addEventListener('click', (e) => { if (e.target === percDialog) percDialog.close(); });
// Selecting Instrument (or tapping it again) opens the settings dialog.
modeInst.addEventListener('click', () => {
  state.mode = 'instrument';
  syncMode();
  save();
  syncNoteSelects();
  syncInputs();
  settingsDialog.showModal();
});
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });

syncMode();

// ---------- Presets ----------
// A preset stores the rhythm (tempo, multiplier, state of every beat of every measure) and the
// sound (mode, percussion set, instrument notes / length / timbre). Presets saved by an earlier
// version have no sound: loading them leaves the current sound unchanged.
const PRESETS_KEY = 'metronome:presets:v1';
const MAX_PRESETS = 50;
const MAX_LABEL = 20;
const presetsDialog = $('presetsDialog');
const presetName = $('presetName');
const presetList = $('presetList');
const presetEmpty = $('presetEmpty');
let presets = loadPresets();

function loadPresets() {
  try {
    const list = JSON.parse(localStorage.getItem(PRESETS_KEY));
    if (!Array.isArray(list)) return [];
    return list.flatMap((p) => {
      if (!p || typeof p.name !== 'string' || !Number.isInteger(p.bpm) || !Array.isArray(p.measures) || !p.measures.length) return [];
      const n = clamp(p.measures[0]?.length || 4, MIN_BEATS, MAX_BEATS);
      const q = {
        name: p.name.slice(0, MAX_LABEL),
        bpm: clamp(p.bpm, MIN_BPM, MAX_BPM),
        mult: Number.isInteger(p.mult) ? clamp(p.mult, 1, 4) : 1,
        measures: p.measures.slice(0, MAX_MEASURES).map((m) =>
          Array.from({ length: n }, (_, i) => (STATES.includes(m?.[i]) ? m[i] : 'normal'))),
      };
      if (MODES.includes(p.mode) && PERC_SETS.includes(p.perc) && TIMBRES.includes(p.timbre)
          && [p.normalMidi, p.accentMidi, p.denom].every(Number.isInteger)) {
        Object.assign(q, {
          mode: p.mode, perc: p.perc, timbre: p.timbre,
          normalMidi: clamp(p.normalMidi, MIN_MIDI, MAX_MIDI),
          accentMidi: clamp(p.accentMidi, MIN_MIDI, MAX_MIDI),
          denom: clamp(p.denom, MIN_DENOM, MAX_DENOM),
        });
      }
      return [q];
    }).slice(0, MAX_PRESETS);
  } catch { return []; }
}
function storePresets() {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

// Name of the current sound, used as the default label prefix and in the list.
const PERC_NAMES = { machine: 'Machine', 'bass-snare': 'Bass-Snare', darabuka: 'Darabuka', tapan: 'Tapan', pier: 'Pier' };
const soundName = (p) => (p.mode === 'percussion' ? PERC_NAMES[p.perc]
  : p.mode === 'instrument' ? (p.timbre === 'string' ? 'Pluck' : 'Sustain') : 'Click');

// Default label: <Sound> 01, <Sound> 02, … the smallest number not used yet (e.g. Darabuka 01).
function nextPresetName() {
  const base = soundName(state);
  const used = new Set(presets.map((p) => p.name.toLowerCase()));
  let k = 1;
  while (used.has(`${base} ${String(k).padStart(2, '0')}`.toLowerCase())) k++;
  return `${base} ${String(k).padStart(2, '0')}`;
}

// "120 BPM · 4 beats · Darabuka" / "90 × 2 BPM · 7 × 3 beats"
function presetSummary(p) {
  const tempo = p.mult === 1 ? `${p.bpm}` : `${p.bpm} × ${p.mult}`;
  const meas = p.measures.length > 1 ? ` × ${p.measures.length}` : '';
  return `${tempo} BPM · ${p.measures[0].length}${meas} beats${p.mode ? ` · ${soundName(p)}` : ''}`;
}

// Small row of disks showing the beat states of the first measure.
function presetDots(p) {
  const wrap = document.createElement('span');
  wrap.className = 'preset-dots';
  wrap.setAttribute('aria-hidden', 'true');
  for (const st of p.measures[0]) {
    const d = document.createElement('i');
    d.className = `dot ${st}`;
    wrap.append(d);
  }
  return wrap;
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
    load.append(head, presetDots(p));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn preset-del';
    del.dataset.del = i;
    del.setAttribute('aria-label', `Delete preset ${p.name}`);
    del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>';
    li.append(load, del);
    return li;
  }));
  presetName.value = nextPresetName();
}

function savePreset() {
  const name = presetName.value.trim().slice(0, MAX_LABEL) || nextPresetName();
  const p = {
    name, bpm: state.bpm, mult: state.mult, measures: state.measures.map((m) => [...m]),
    mode: state.mode, perc: state.perc, timbre: state.timbre,
    normalMidi: state.normalMidi, accentMidi: state.accentMidi, denom: state.denom,
  };
  const at = presets.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
  if (at >= 0) presets[at] = p;                       // same label: overwrite
  else if (presets.length < MAX_PRESETS) presets.push(p);
  else { presetEmpty.textContent = `Too many presets (max ${MAX_PRESETS}): delete one first.`; presetEmpty.hidden = false; return; }
  storePresets();
  renderPresets();
}

function applyPreset(p) {
  state.bpm = p.bpm;
  state.mult = p.mult;
  state.measures = p.measures.map((m) => [...m]);
  if (p.mode) {
    Object.assign(state, { mode: p.mode, perc: p.perc, timbre: p.timbre, normalMidi: p.normalMidi, accentMidi: p.accentMidi, denom: p.denom });
    syncMode();
    if (ctx && state.mode === 'percussion') loadPerc();   // samples of a set not used yet load now (silent until decoded)
  }
  renderBeats();
  syncInputs();
  save();
}

$('presetsBtn').addEventListener('click', () => {
  presetEmpty.textContent = 'No presets yet. Set up the metronome, edit the label if you like and press Save.';
  renderPresets();
  presetsDialog.showModal();
  $('presetSave').focus();   // not the text field: no virtual keyboard on touch devices
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

// ---------- Touch screens: display-only numbers ----------
// Tapping a number field (or near it) would open the virtual keyboard. On touch devices
// the −/+ buttons, slider and Tap button set the values, so the fields are display-only.
if (matchMedia('(pointer: coarse)').matches) {
  for (const input of [beatInput, measureInput, tempoInput]) {
    input.readOnly = true;
    input.tabIndex = -1;
    input.classList.add('display-only');
  }
}

// ---------- Init ----------
renderBeats();
syncInputs();
report();
