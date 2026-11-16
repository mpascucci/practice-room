// Practice audio player: local file, speed without pitch change, A-B loop.
// Uses a plain <audio> element: playbackRate + preservesPitch does the time-stretching.

const KEY = 'player:v1';
const SPEED_MIN = 25, SPEED_MAX = 150;
const SEEK_STEP = 5;     // seconds, arrow keys
const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'), file: $('file'), name: $('trackName'), seek: $('seek'), cur: $('cur'), dur: $('dur'),
  rewind: $('rewind'), play: $('play'), addMarker: $('addMarker'), markerStrip: $('markerStrip'), markerDialog: $('markerDialog'), markerName: $('markerName'), markerCancel: $('markerCancel'), markerTitle: $('markerTitle'), markerOk: $('markerOk'), markerRemove: $('markerRemove'),
  speed: $('speed'), speedOut: $('speedOut'), speedDown: $('speedDown'), speedUp: $('speedUp'), speedReset: $('speedReset'),
  loopOn: $('loopOn'), loopOut: $('loopOut'), setA: $('setA'), setB: $('setB'), clearLoop: $('clearLoop'),
  wave: $('wave'), armLoop: $('armLoop'), loopPause: $('loopPause'), loopPauseOut: $('loopPauseOut'), zoomReset: $('zoomReset'),
  rec: $('rec'), recLabel: $('recLabel'), recMsg: $('recMsg'), takeDownload: $('takeDownload'),
  meter: $('meter'), meterFill: $('meterFill'), meterPeak: $('meterPeak'),
  confirmDialog: $('confirmDialog'), confirmOk: $('confirmOk'), confirmCancel: $('confirmCancel'),
  infoBtn: $('infoBtn'), infoDialog: $('infoDialog'), infoClose: $('infoClose'),
  recDialog: $('recDialog'), recTime: $('recTime'), recStop: $('recStop'),
};

const state = { speed: 100, loop: true, loopPause: 0 };   // loop = the A-B loop toggle; remembered even when no A-B is set
let trackName = '';
let url = null;
let loaded = false;
let playing = false;
let loopA = null, loopB = null;
let startMark = null;   // seconds: where the next play starts (set by clicking the waveform)
let timer = 0;
let loadToken = 0;
let wakeLock = null;
let peaks = null;        // Float32Array of per-bucket peak amplitudes (0..1), null until decoded
let colors = null;

const audio = new Audio();
audio.preload = 'auto';
audio.preservesPitch = true;
audio.webkitPreservesPitch = true;
audio.mozPreservesPitch = true;

// ---------- Persistence ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && typeof s.loop === 'boolean') state.loop = s.loop;
    if (s && Number.isFinite(s.loopPause)) state.loopPause = Math.min(10, Math.max(0, Math.round(s.loopPause * 2) / 2));
    if (s && Number.isFinite(s.speed)) state.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(s.speed)));
  } catch {}
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
}

// ---------- Helpers ----------
function fmt(t) {
  if (!Number.isFinite(t)) return '0:00';
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fill(input, v, min, max) { input.style.setProperty('--p', (v - min) / (max - min)); }
const hasLoop = () => loopA != null && loopB != null;


// ---------- Waveform ----------
const PEAK_BUCKETS = 20000;   // fine enough to stay readable when zoomed in

// Decode the file once (offline context, no audio output) and keep a coarse peak envelope.
async function computePeaks(file, token) {
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buf = await new Ctx(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    if (token !== loadToken) return;
    const out = new Float32Array(PEAK_BUCKETS);
    const size = buf.length / PEAK_BUCKETS;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < PEAK_BUCKETS; i++) {
        let m = out[i];
        const end = Math.min(d.length, Math.floor((i + 1) * size));
        for (let j = Math.floor(i * size); j < end; j++) { const v = Math.abs(d[j]); if (v > m) m = v; }
        out[i] = m;
      }
    }
    let max = 0;
    for (const v of out) if (v > max) max = v;
    if (max > 0) for (let i = 0; i < PEAK_BUCKETS; i++) out[i] /= max;   // normalise so quiet files are readable
    peaks = out;
    drawWave();
  } catch {
    // undecodable here (or out of memory): keep the flat line; playback may still work
  }
}

// Zoom: the visible window is [viewStart, viewStart + viewSpan] as fractions of the duration.
let viewStart = 0, viewSpan = 1;
let interacting = false;
const MIN_VIEW_SECONDS = 0.25;

function clampView() {
  const d = audio.duration || 0;
  const minSpan = d ? Math.min(1, MIN_VIEW_SECONDS / d) : 1;
  viewSpan = Math.min(1, Math.max(minSpan, viewSpan));
  viewStart = Math.min(1 - viewSpan, Math.max(0, viewStart));
}
function resetView() {
  viewStart = 0; viewSpan = 1;
  el.zoomReset.hidden = true;
  drawWave();
}
function afterZoom() {
  clampView();
  el.zoomReset.hidden = viewSpan >= 0.999;
  el.zoomReset.textContent = `×${(1 / viewSpan).toFixed(1)}`;
  drawWave();
}
// After stop / end of track: scroll the zoomed view so the start mark is at the left edge (zoom level kept).
function viewToMark() {
  const d = audio.duration || 0;
  if (!d || startMark == null || viewSpan >= 0.999) return;
  viewStart = startMark / d;
  afterZoom();
}

// While playing, scroll the zoomed view so the playhead stays visible.
function followPlayhead() {
  const d = audio.duration || 0;
  if (!d || viewSpan >= 0.999 || interacting || !playing) return;
  const f = audio.currentTime / d;
  if (f < viewStart || f > viewStart + viewSpan * 0.95) {
    viewStart = f - viewSpan * 0.1;
    clampView();
  }
}

// Markers: added at the playback start position. Magenta dashed lines in the waveform, numbered labels above it (outside the waveform). Click a label to go
// to the marker, double-click to remove it. They belong to the loaded track and are not saved.
let markers = [];      // [{t: seconds, name}], sorted by t
let markerSeq = 1;     // the next default name: an increasing integer, per loaded track
let markerKey = '';    // what the labels were last laid out for
let markerDrag = null; // {index, t} while a marker is being dragged with the mouse (preview, applied on release)
let markerAt = 0;      // where the marker being named will go (captured when the dialog opens)
let markerEditing = null;   // index of the marker being renamed / removed, or null when adding a new one
const shownMarkers = () => markers.map((m, i) => (markerDrag && markerDrag.index === i ? markerDrag.t : m.t));
const clearMarkers = () => { markers = []; markerSeq = 1; };

// The bookmark button / M key opens a dialog to name the marker; the default name is an increasing integer.
function addMarker() {
  if (!loaded) return;
  // Stopped: the marker goes at the start position (the yellow line). Playing: at the current position (the start
  // mark doesn't move during playback, so using it would put every marker on the same spot).
  const t = playing ? audio.currentTime : (startMark ?? audio.currentTime);
  if (markers.some((m) => Math.abs(m.t - t) < 0.1)) return;   // already marked here
  markerAt = t;
  markerEditing = null;
  el.markerTitle.textContent = 'New marker';
  el.markerOk.textContent = 'Add';
  el.markerRemove.hidden = true;
  el.markerName.value = String(markerSeq);
  el.markerDialog.showModal();
  el.markerOk.focus();   // not the text field: on touch devices that would pop the keyboard up straight away
}
// Clicking a label opens the same dialog for that marker: rename it, or remove it.
function editMarker(i) {
  markerEditing = i;
  el.markerTitle.textContent = 'Marker';
  el.markerOk.textContent = 'Save';
  el.markerRemove.hidden = false;
  el.markerName.value = markers[i].name;
  el.markerDialog.showModal();
  el.markerOk.focus();   // not the text field: on touch devices that would pop the keyboard up straight away
}
function confirmMarker() {
  if (markerEditing != null) {
    markers[markerEditing].name = el.markerName.value.trim() || markers[markerEditing].name;   // empty keeps the old name
    markerEditing = null;
    markerKey = '';
  } else {
    const name = el.markerName.value.trim() || String(markerSeq);   // an empty name falls back to the default
    markers.push({ t: markerAt, name });
    markers.sort((a, b) => a.t - b.t);
    markerSeq++;
  }
  el.markerDialog.close();
  drawWave();
}
function removeMarker(i) {
  markers.splice(i, 1);
  markerKey = '';
  drawWave();
}
// A marker is moved by dragging its label (mouse or touch). While dragging, the labels are not rebuilt (that would drop
// the pointer); the dragged label and the dashed line follow live, and the move is applied on release.
let lastLabelDrag = 0;   // time of the last label drag end, to ignore the click that follows it
function renderMarkerLabels(w) {
  if (markerDrag) return;
  const d = audio.duration || 0;
  const key = [viewStart, viewSpan, w, d, markers.map((m) => `${m.t}:${m.name}`).join('|')].join('/');
  if (key === markerKey) return;
  markerKey = key;
  el.markerStrip.replaceChildren();
  markers.forEach((m, i) => {
    const f = d ? (m.t / d - viewStart) / viewSpan : -1;
    if (f < -0.01 || f > 1.01) return;   // outside the zoomed view
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'marker-label';
    b.textContent = m.name;
    b.style.left = `${f * 100}%`;
    b.title = `Marker "${m.name}" at ${fmt(m.t)}: click to rename or remove, drag to move`;
    b.setAttribute('aria-label', `Marker ${m.name} at ${fmt(m.t)}`);
    let x0 = 0, moved = false;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      b.setPointerCapture(e.pointerId);
      x0 = e.clientX;
      moved = false;
    });
    b.addEventListener('pointermove', (e) => {
      if (!b.hasPointerCapture(e.pointerId)) return;
      if (!moved && Math.abs(e.clientX - x0) > 4) { moved = true; b.classList.add('dragging'); }
      if (!moved) return;
      const t = timeAtX(e.clientX);
      markerDrag = { index: i, t };
      b.style.left = `${((t / audio.duration - viewStart) / viewSpan) * 100}%`;
      drawWave();
    });
    const end = (e) => {
      if (!b.hasPointerCapture(e.pointerId)) return;
      b.releasePointerCapture(e.pointerId);
      b.classList.remove('dragging');
      if (!moved) return;   // a plain click: leave the label in place so the click / double-click still reaches it
      if (e.type === 'pointerup' && markerDrag) {
        markers[i].t = markerDrag.t;
        markers.sort((p, q) => p.t - q.t);
      }
      lastLabelDrag = performance.now();
      markerDrag = null;
      markerKey = '';     // lay the labels out again (the order may have changed)
      moved = false;
      drawWave();
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('click', () => { if (performance.now() - lastLabelDrag > 300) editMarker(i); });
    el.markerStrip.append(b);
  });
}

function drawWave() {
  const cv = el.wave;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  if (!colors) {
    const cs = getComputedStyle(document.documentElement);
    colors = { accent: cs.getPropertyValue('--accent').trim(), dim: cs.getPropertyValue('--accent-dim').trim(), text: cs.getPropertyValue('--text').trim() };
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const d = audio.duration || 0;
  const frac = d ? audio.currentTime / d : 0;
  const mid = h / 2;
  const xOf = (t) => (t / d - viewStart) / viewSpan * w;   // seconds -> pixel in the current view

  // loop region (the live drag selection while dragging, else the A-B loop)
  const [la, lb] = dragRange ?? [loopA, loopB];
  const live = !!dragRange || state.loop;   // gray when the loop is off
  if (la != null && d) {
    const xa = Math.max(0, xOf(la)), xb = Math.min(w, xOf(lb ?? la));
    g.fillStyle = live ? 'rgba(95, 201, 160, 0.14)' : 'rgba(143, 160, 155, 0.12)';
    if (xb > xa) g.fillRect(xa, 0, xb - xa, h);
  }

  // waveform: bright before the playhead, dim after
  if (peaks) {
    const bw = 2, gap = 1, n = Math.floor(w / (bw + gap));
    for (let i = 0; i < n; i++) {
      const x = i * (bw + gap);
      const f0 = viewStart + i / n * viewSpan, f1 = viewStart + (i + 1) / n * viewSpan;
      const a = Math.floor(f0 * PEAK_BUCKETS), b = Math.max(a + 1, Math.floor(f1 * PEAK_BUCKETS));
      let p = 0;
      for (let k = a; k < b && k < PEAK_BUCKETS; k++) if (peaks[k] > p) p = peaks[k];
      const bh = Math.max(2, p * (h - 12));
      g.fillStyle = (f0 + f1) / 2 <= frac ? colors.accent : colors.dim;
      g.fillRect(x, mid - bh / 2, bw, bh);
    }
  } else {
    g.fillStyle = colors.dim;
    g.fillRect(0, mid - 1, w, 2);
  }

  // A / B bars (only when inside the view)
  g.font = '700 11px system-ui, sans-serif';
  g.textBaseline = 'top';
  for (const [t, label, left] of [[la, 'A', true], [lb, 'B', false]]) {
    if (t == null || !d) continue;
    const x = xOf(t);
    if (x < -1 || x > w + 1) continue;
    const cx = Math.min(w - 1, Math.max(1, x));
    g.fillStyle = live ? colors.text : '#6f7c78';
    g.fillRect(cx - 1, 0, 2, h);
    g.fillText(label, left ? cx + 4 : cx - 4 - g.measureText(label).width, 3);
  }

  // start mark (where the next play begins)
  if (startMark != null && d) {
    const x = xOf(startMark);
    if (x >= 0 && x <= w) {
      g.fillStyle = '#f2c744';
      g.fillRect(Math.min(w - 2, Math.max(0, x - 1)), 0, 2, h);
    }
  }

  // markers
  if (markers.length && d) {
    g.save();
    g.setLineDash([5, 4]);
    g.strokeStyle = '#e040fb';
    g.lineWidth = 1.5;
    for (const t of shownMarkers()) {
      const x = xOf(t);
      if (x < 0 || x > w) continue;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    g.restore();
  }

  // playhead
  if (d) {
    const x = xOf(audio.currentTime);
    if (x >= 0 && x <= w) {
      g.fillStyle = '#fff';
      g.fillRect(Math.min(w - 1, x), 0, 1, h);
    }
  }
  renderMarkerLabels(w);
}
window.addEventListener('resize', drawWave);
new ResizeObserver(drawWave).observe(el.wave.parentElement);   // the waveform height follows the available space

// ---------- Rendering ----------
function renderSpeed() {
  el.speed.value = state.speed;
  fill(el.speed, state.speed, SPEED_MIN, SPEED_MAX);
  el.speedOut.textContent = `${state.speed}%`;
  audio.defaultPlaybackRate = audio.playbackRate = state.speed / 100;
}
function renderLoop() {
  drawWave();
  // the button names the action it will do: "Start Loop" when off, "Stop Loop" when on
  const label = state.loop ? 'Stop Loop' : 'Start Loop';
  el.loopOn.dataset.on = state.loop;
  el.loopOn.setAttribute('aria-label', label);
  el.loopOn.title = `${label} (L)`;
  el.loopOn.querySelector('.txt').textContent = label;
  el.clearLoop.disabled = loopA == null && loopB == null;
  const a = loopA == null ? '–' : fmt(loopA), b = loopB == null ? '–' : fmt(loopB);
  el.loopOut.textContent = loopA == null && loopB == null ? 'off' : `${a} → ${b}${hasLoop() && !state.loop ? ' (loop off)' : ''}`;
}
function renderTime() {
  const d = audio.duration || 0;
  el.cur.textContent = fmt(audio.currentTime);
  el.dur.textContent = fmt(d);
  {
    el.seek.value = d ? Math.round(audio.currentTime / d * 1000) : 0;
    fill(el.seek, el.seek.value, 0, 1000);
  }
  followPlayhead();
  drawWave();
}
function renderPlay() {
  el.play.setAttribute('aria-pressed', playing);
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
function renderEnabled() {
  for (const b of [el.play, el.rewind, el.addMarker, el.setA, el.setB, el.seek, el.armLoop]) b.disabled = !loaded;
  if (!loaded) setArm(false);
  renderLoop();
}

// ---------- Playback ----------
// Loop pause: when the loop reaches B the audio is paused for state.loopPause seconds (real time, not scaled by
// the speed) with the playhead already back on A, then plays on from A. `playing` stays true during the wait.
let loopWaitTimer = 0;
function loopWaitCancel() { clearTimeout(loopWaitTimer); loopWaitTimer = 0; }

function tick() {
  if (hasLoop() && state.loop && !loopWaitTimer && audio.currentTime >= loopB) {
    audio.currentTime = loopA;
    if (state.loopPause > 0) {
      audio.pause();
      loopWaitTimer = setTimeout(() => {
        loopWaitTimer = 0;
        if (playing) audio.play().catch(() => stop());
      }, state.loopPause * 1000);
    }
  }
  renderTime();
}

async function start() {
  if (!loaded || playing) return;
  if (startMark != null) audio.currentTime = startMark;
  else startMark = audio.currentTime;
  try {
    await audio.play();
  } catch (err) {
    if (err.name === 'NotAllowedError') blocked();
    return;
  }
  playing = true;
  timer = setInterval(tick, 40);
  acquireWake();
  renderPlay();
  report();
}

function stop() {
  if (recording) { stopRec(); return; }
  if (!playing) return;
  loopWaitCancel();
  audio.pause();
  if (startMark != null) audio.currentTime = startMark;   // back to where playback started
  viewToMark();
  playing = false;
  clearInterval(timer);
  releaseWake();
  renderPlay();
  renderTime();
  report();
}

const toggle = () => (recording ? stopRec() : playing ? stop() : start());

// The start mark is where play begins and where it returns on stop / end of track. Waveform clicks set
// it; while stopped, any other seek (skip buttons, arrows) moves it too.
function seekTo(t, mark = false) {
  if (!loaded) return;
  audio.currentTime = Math.min(Math.max(0, t), audio.duration || 0);
  if (mark || !playing) startMark = audio.currentTime;
  renderTime();
}

function releaseWake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
async function acquireWake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (playing && document.visibilityState === 'visible' && !wakeLock) acquireWake();
});

audio.addEventListener('ended', () => {
  loopWaitCancel();
  if (startMark != null) audio.currentTime = startMark;
  viewToMark();
  playing = false;
  clearInterval(timer);
  releaseWake();
  renderPlay();
  renderTime();
  report();
});
audio.addEventListener('seeked', renderTime);
audio.addEventListener('error', () => {
  if (!url) return;
  loaded = false;
  playing = false;
  clearInterval(timer);
  el.name.classList.remove('loaded', 'placeholder');
  el.name.textContent = `Can't play "${trackName}" — unsupported or damaged file.`;
  renderPlay();
  renderEnabled();
  report();
});


// ---------- Recording a take (microphone) ----------
// Record while the track plays (if any). The finished recording replaces the loaded track, so it gets
// the waveform, speed and A-B loop like any file; it can also be downloaded.
const REC_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
let recording = false, recorder = null, recStream = null, recChunks = [], recStartedAt = 0, recTimer = 0;

function recMessage(text, warn = false) {
  el.recMsg.textContent = text;
  el.recMsg.classList.toggle('warn', warn);
}

// Explain a failed getUserMedia. A blocked permission can't be re-prompted by the page: the user
// has to change the site setting, so say how.
async function micErrorText(err) {
  if (err.name === 'NotFoundError') return 'No microphone found. Plug one in and press Rec again.';
  if (err.name === 'NotReadableError') return 'The microphone is in use by another app or can\'t be opened. Close the other app and try again.';
  if (err.name !== 'NotAllowedError' && err.name !== 'SecurityError') return `Can't open the microphone (${err.name}).`;
  if (!window.isSecureContext) return 'Microphone access needs a secure page: open the app over https or on localhost.';
  let state = '';
  try { state = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}   // not supported everywhere (Safari)
  if (state === 'prompt') return 'Microphone permission was not granted. Press Rec again and choose Allow.';
  const ua = navigator.userAgent;
  const where = /iPhone|iPad/.test(ua) ? 'Settings → Safari → Microphone (or the "aA" menu → Website Settings), set it to Allow'
    : /Firefox/.test(ua) ? 'the icon left of the address bar → Permissions → Use the Microphone → Allow'
    : /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) ? 'Safari → Settings → Websites → Microphone, set this site to Allow'
    : 'the icon left of the address bar → Site settings → Microphone → Allow';
  return `Microphone access is blocked. Open ${where}, then reload this page and press Rec again. If it still fails, enable your browser in the system's microphone privacy settings.`;
}
const HINT = el.recMsg.textContent;


// Live input level: AnalyserNode on the mic stream, drawn as a bar (dB scale) with a peak hold.
let meterCtx = null, meterRaf = 0, peakHold = 0, peakAt = 0;
const METER_FLOOR_DB = -60;

function meterStart(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    meterCtx = new Ctx();
    meterCtx.resume?.();
    const an = meterCtx.createAnalyser();
    an.fftSize = 1024;
    meterCtx.createMediaStreamSource(stream).connect(an);   // not connected to the output: no feedback
    const buf = new Float32Array(an.fftSize);
    peakHold = 0;
    const frame = (now) => {
      an.getFloatTimeDomainData(buf);
      let peak = 0, sum = 0;
      for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      const lvl = (x) => Math.min(1, Math.max(0, (20 * Math.log10(x || 1e-6) - METER_FLOOR_DB) / -METER_FLOOR_DB));
      const level = lvl(rms * 1.4);          // RMS, nudged up so normal playing sits mid-bar
      const pk = lvl(peak);
      if (pk >= peakHold || now - peakAt > 1200) { peakHold = pk; peakAt = now; }
      el.meterFill.style.width = `${level * 100}%`;
      el.meterFill.classList.toggle('hot', pk > 0.85);
      el.meterFill.classList.toggle('clip', peak >= 0.99);
      el.meterPeak.style.left = `calc(${peakHold * 100}% - 2px)`;
      el.meter.setAttribute('aria-valuenow', Math.round(level * 100));
      meterRaf = requestAnimationFrame(frame);
    };
    meterRaf = requestAnimationFrame(frame);
  } catch {
    // no meter, recording still works
  }
}

function meterStop() {
  cancelAnimationFrame(meterRaf);
  meterCtx?.close().catch(() => {});
  meterCtx = null;
  el.meterFill.style.width = '0';
  el.meterFill.classList.remove('hot', 'clip');
  el.meterPeak.style.left = '0';
}

// Recording starts from a clean slate: drop the loaded track (stopped, waveform and markers cleared).
const PLACEHOLDER = el.name.textContent;
function unloadTrack() {
  if (playing) stop();
  if (url) URL.revokeObjectURL(url);
  url = null;
  audio.removeAttribute('src');
  audio.load();
  loaded = false;
  loadToken++;            // ignore a waveform still being decoded
  peaks = null;
  loopA = loopB = null;
  clearMarkers();
  startMark = null;
  trackName = '';
  takeUnsaved = false;
  viewStart = 0; viewSpan = 1;
  el.zoomReset.hidden = true;
  el.takeDownload.hidden = true;
  el.name.classList.remove('loaded');
  el.name.classList.add('placeholder');
  el.name.textContent = PLACEHOLDER;
  renderEnabled();
  renderTime();
  report();
}

async function startRec() {
  if (recording || !canRecord) return;
  if (!(await okToReplace())) return;
  try {
    // Raw input: echo cancellation / noise suppression would mangle music.
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (err) {
    recMessage(await micErrorText(err), true);
    return;
  }
  unloadTrack();   // the previous track is wiped, not played along
  const type = REC_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  recorder = new MediaRecorder(recStream, type ? { mimeType: type } : undefined);
  recChunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size) recChunks.push(e.data); });
  recorder.addEventListener('stop', finishRec);
  recorder.start();
  meterStart(recStream);
  recStartedAt = performance.now();
  recording = true;
  recTimer = setInterval(renderRec, 250);
  recMessage(HINT);
  renderRec();
  el.recDialog.showModal();
  el.recStop.focus();
  report();
}

function stopRec() {
  if (!recording) return;
  recording = false;
  clearInterval(recTimer);
  recorder.stop();
  meterStop();
  if (el.recDialog.open) el.recDialog.close();
  stop();
  renderRec();
  report();
}

function finishRec() {
  recStream.getTracks().forEach((t) => t.stop());
  recStream = null;
  const mime = recorder.mimeType || 'audio/webm';
  const blob = new Blob(recChunks, { type: mime });
  recChunks = [];
  if (!blob.size) return;
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  // Replace the loaded track with the recording.
  openFile(new File([blob], `Take ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`, { type: mime }), true);
}

function renderRec() {
  el.rec.setAttribute('aria-pressed', recording);
  el.rec.setAttribute('aria-label', recording ? 'Stop recording' : 'Record a take');
  const t = fmt((performance.now() - recStartedAt) / 1000);
  el.recLabel.textContent = recording ? t : 'Rec';
  el.recTime.textContent = recording ? t : '0:00';
}

el.rec.addEventListener('click', () => (recording ? stopRec() : startRec()));
el.recStop.addEventListener('click', stopRec);
el.recDialog.addEventListener('close', stopRec);   // Esc also ends the recording (it is kept)
if (!canRecord) { el.rec.disabled = true; recMessage('Recording is not supported in this browser.'); }


// ---------- Unsaved recording guard ----------
// A recording only lives in memory: ask before something replaces it (until it has been downloaded).
let takeUnsaved = false;

function okToReplace() {
  if (!takeUnsaved) return Promise.resolve(true);
  return new Promise((resolve) => {
    const d = el.confirmDialog;
    const done = (v) => { d.close(); resolve(v); };
    el.confirmOk.onclick = () => done(true);
    el.confirmCancel.onclick = () => done(false);
    d.oncancel = () => resolve(false);   // Esc
    d.showModal();
    el.confirmCancel.focus();
  });
}

// ---------- Files ----------
function openFile(file, isTake = false) {
  if (!file) return;
  el.name.classList.remove('placeholder');
  if (!(file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(file.name))) {
    el.name.classList.remove('loaded');
    el.name.textContent = `"${file.name}" doesn't look like an audio file.`;
    return;
  }
  if (playing) stop();
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  trackName = file.name.replace(/\.[^.]+$/, '');
  loopA = loopB = null;
  clearMarkers();
  startMark = null;
  loaded = false;
  peaks = null;
  viewStart = 0; viewSpan = 1;
  el.zoomReset.hidden = true;
  computePeaks(file, ++loadToken);
  el.name.classList.add('loaded');
  el.name.textContent = trackName;
  takeUnsaved = isTake;
  el.takeDownload.hidden = !isTake;
  if (isTake) { el.takeDownload.href = url; el.takeDownload.download = file.name; }
  audio.src = url;
  renderSpeed();   // a new src resets the rate unless defaultPlaybackRate is set; set both anyway
  renderLoop();
  renderTime();
  report();
}

function ready() {
  loaded = true;
  if (startMark == null) startMark = 0;
  renderEnabled();
  renderTime();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: trackName, artist: 'Practice Room' });
  }
  report();
}
audio.addEventListener('loadedmetadata', () => {
  if (isFinite(audio.duration)) return ready();
  // MediaRecorder webm has no duration header (Chrome): seeking far past the end makes the browser compute it.
  audio.currentTime = 1e101;
});
audio.addEventListener('durationchange', () => {
  if (!loaded && isFinite(audio.duration) && audio.readyState >= 1) {
    audio.currentTime = 0;
    ready();
  }
});

async function openChecked(file) {
  if (file && await okToReplace()) openFile(file);
}
el.file.addEventListener('change', () => { openChecked(el.file.files[0]); el.file.value = ''; });
el.takeDownload.addEventListener('click', () => { takeUnsaved = false; });
for (const ev of ['dragenter', 'dragover']) {
  window.addEventListener(ev, (e) => { e.preventDefault(); el.app.classList.add('drag'); });
}
for (const ev of ['dragleave', 'drop']) {
  window.addEventListener(ev, (e) => { e.preventDefault(); el.app.classList.remove('drag'); });
}
window.addEventListener('drop', (e) => openChecked(e.dataTransfer?.files?.[0]));

// ---------- Controls ----------
function setSpeed(v) {
  state.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v)));
  renderSpeed();
  save();
  report();
}
function renderLoopPause() {
  el.loopPause.value = state.loopPause;
  fill(el.loopPause, state.loopPause, 0, 10);
  el.loopPauseOut.textContent = state.loopPause ? `${state.loopPause} s` : 'none';
}
el.loopPause.addEventListener('input', () => {
  state.loopPause = +el.loopPause.value;
  renderLoopPause();
  save();
});
el.speed.addEventListener('input', () => setSpeed(+el.speed.value));
el.speedDown.addEventListener('click', () => setSpeed(state.speed - 5));
el.speedUp.addEventListener('click', () => setSpeed(state.speed + 5));
el.speedReset.addEventListener('click', () => setSpeed(100));

el.play.addEventListener('click', toggle);
el.rewind.addEventListener('click', () => {
  seekTo(0, true);   // the start mark goes back to the beginning too
  if (viewSpan < 0.999) { viewStart = 0; afterZoom(); }
});


// Waveform gestures. One finger / mouse: tap or click sets the start mark, drag-and-drop sets the A-B loop. Two fingers: pinch to zoom the time
// axis (and pan with the midpoint). Mouse wheel (or Ctrl+wheel / trackpad pinch) zooms around the pointer, Shift+wheel pans, double-click resets. With a mouse, drag pans and Shift+drag selects the loop.
const box = el.wave.parentElement;
const ptrs = new Map();
let pinch = null, gestureHadPinch = false;
let sel = null;          // drag in progress: {x0, t0, active, mode, start}  mode: 'loop' (select a region), 'scrub' (touch: move the start mark) or 'pan' (mouse: translate the view)
let armLoop = false;     // touch devices: the Select button is on, so the next drag selects a loop region
let dragRange = null;    // [lo, hi] seconds while dragging out a loop region (preview only, applied on release)
const MIN_LOOP = 0.2, DRAG_PX = 6, LIMIT_PX = 6;

function timeAtX(clientX) {
  const r = box.getBoundingClientRect();
  const f = viewStart + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * viewSpan;
  return Math.min(1, Math.max(0, f)) * (audio.duration || 0);
}
// Loop limit bars (mouse only): hovering one shows a resize cursor, click-drag moves it. (Markers are not draggable here: they are moved by dragging their labels.) The new range is previewed in
// dragRange and applied on release, like a region drag, so the audio loop never jumps mid-drag.
function xOfTime(t) {
  const r = box.getBoundingClientRect();
  return r.left + ((t / audio.duration - viewStart) / viewSpan) * r.width;
}
function hitBar(clientX) {
  if (!loaded || !audio.duration) return null;
  let best = null, bestDist = LIMIT_PX + 1;
  const consider = (hit, t) => {
    const dist = Math.abs(clientX - xOfTime(t));
    if (dist < bestDist) { best = hit; bestDist = dist; }   // the nearest bar wins; on a tie the earlier candidate (loop bars) wins
  };
  if (loopA != null) consider({ type: 'limit', which: 'A' }, loopA);
  if (loopB != null) consider({ type: 'limit', which: 'B' }, loopB);
  return best;
}
function setLoopLimits(a, b) {
  const aMoved = loopA !== a;
  loopA = a;
  loopB = b;
  // The playback start becomes the new A: the start mark moves there, and so does a stopped playhead (otherwise a
  // white line would stay at the old start). While playing, the playhead keeps going.
  if (aMoved) {
    if (playing) startMark = a;
    else seekTo(a, true);
  }
  renderLoop();
}
function seekAtX(clientX) {
  if (!loaded || !audio.duration) return;
  seekTo(timeAtX(clientX), true);
}
// Click-drag-drop on the waveform: the dragged region becomes the A-B loop (and the loop is switched on).
function setLoopRegion(lo, hi) {
  loopA = lo;
  loopB = hi;
  state.loop = true;
  save();
  seekTo(lo, true);   // play starts at A (and jumps there if already playing)
  renderLoop();
}
// Touch devices only: the Select button arms the loop drag until the drop. Not armed, a one-finger drag scrubs the
// start mark as before. A mouse always drags out a loop region (no button needed).
function setArm(on) {
  armLoop = on;
  el.armLoop.setAttribute('aria-pressed', on);
  box.classList.toggle('armed', on);
}
function startPinch() {
  const [a, b] = [...ptrs.values()];
  const r = box.getBoundingClientRect();
  const midX = (a + b) / 2;
  pinch = { dist: Math.max(10, Math.abs(a - b)), span: viewSpan, anchor: viewStart + (midX - r.left) / r.width * viewSpan };
  gestureHadPinch = true;
  sel = dragRange = null;   // a second finger turns the gesture into a pinch
  drawWave();
}
function applyPinch() {
  const [a, b] = [...ptrs.values()];
  const r = box.getBoundingClientRect();
  const midX = (a + b) / 2;
  viewSpan = pinch.span * pinch.dist / Math.max(10, Math.abs(a - b));
  clampView();
  viewStart = pinch.anchor - (midX - r.left) / r.width * viewSpan;   // keep the touched time under the fingers
  afterZoom();
}

box.addEventListener('pointerdown', (e) => {
  if (!loaded || e.target.closest('.zoom-reset')) return;
  box.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, e.clientX);
  interacting = true;
  if (ptrs.size === 1) {
    gestureHadPinch = false;
    // Mouse: drag a loop limit bar if the pointer is on one; else drag = translate the view, Shift+drag = select a
    // loop region. Touch: drag = move the start mark, or select a loop region when the Select button is on.
    const hit = e.pointerType !== 'touch' ? hitBar(e.clientX) : null;
    const mode = hit ? hit.type : e.pointerType === 'touch' ? (armLoop ? 'loop' : 'scrub') : (e.shiftKey ? 'loop' : 'pan');
    sel = { x0: e.clientX, t0: timeAtX(e.clientX), active: false, mode, which: hit?.which, start: viewStart };
    if (hit) box.classList.add('dragging-limit');
  } else if (ptrs.size === 2) startPinch();
});
box.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, e.clientX);
  if (pinch && ptrs.size >= 2) applyPinch();
  else if (sel && ptrs.size === 1 && !gestureHadPinch) {
    if (!sel.active && Math.abs(e.clientX - sel.x0) > (sel.mode === 'limit' ? 2 : DRAG_PX)) {
      sel.active = true;
      if (sel.mode === 'pan') box.classList.add('panning');
    }
    if (sel.active && sel.mode === 'limit') {
      const t = timeAtX(e.clientX), d = audio.duration;
      let a = loopA, b = loopB;
      if (sel.which === 'A') a = Math.min(t, b != null ? b - MIN_LOOP : d);
      else b = Math.max(t, (a ?? 0) + MIN_LOOP);
      a = Math.max(0, a);
      if (b != null) b = Math.min(d, b);
      dragRange = [a, b];
      drawWave();
    } else if (sel.active && sel.mode === 'pan') {
      viewStart = sel.start - (e.clientX - sel.x0) / box.getBoundingClientRect().width * viewSpan;
      afterZoom();
    } else if (sel.active && sel.mode === 'scrub') seekAtX(e.clientX);   // not armed on touch: move the start mark
    else if (sel.active) {
      const t = timeAtX(e.clientX);
      dragRange = [Math.min(sel.t0, t), Math.max(sel.t0, t)];
      drawWave();
    }
  }
});
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  const s = sel;
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size > 0) return;   // other fingers still down
  if (s && s.mode === 'limit' && e.type === 'pointerup') {
    if (dragRange) setLoopLimits(dragRange[0], dragRange[1]);   // a plain click on a limit bar changes nothing
  } else if (s && e.type === 'pointerup' && !gestureHadPinch) {
    const t = timeAtX(e.clientX), lo = Math.min(s.t0, t), hi = Math.max(s.t0, t);
    if (s.mode === 'loop' && s.active) {
      if (hi - lo >= MIN_LOOP) setLoopRegion(lo, hi);   // drag: loop region
      else seekAtX(e.clientX);
      setArm(false);                                     // the drop releases the Select button
    } else if (!(s.mode === 'pan' && s.active)) seekAtX(e.clientX);   // click / tap / scrub end: start mark (a pan drag only moves the view)
  }
  sel = dragRange = null;
  box.classList.remove('panning', 'dragging-limit');
  interacting = false;
  drawWave();
}
// While Shift is held over the waveform (mouse), the pointer becomes a vertical line selector: Shift+drag selects a loop.
const setShiftCursor = (on) => box.classList.toggle('shift-select', on);
window.addEventListener('keydown', (e) => { if (e.key === 'Shift') setShiftCursor(true); });
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') setShiftCursor(false); });
window.addEventListener('blur', () => setShiftCursor(false));
box.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  setShiftCursor(e.shiftKey);
  if (!sel) box.classList.toggle('over-limit', !!hitBar(e.clientX));   // resize cursor while hovering a loop limit bar
});
box.addEventListener('pointerleave', () => box.classList.remove('over-limit'));   // stays right even if the key event went elsewhere
// The Select button only makes sense with a touch screen.
el.armLoop.hidden = !matchMedia('(any-pointer: coarse)').matches;
el.armLoop.addEventListener('click', () => setArm(!armLoop));
box.addEventListener('pointerup', endPointer);
box.addEventListener('pointercancel', endPointer);
box.addEventListener('wheel', (e) => {
  if (!loaded) return;
  e.preventDefault();
  const r = box.getBoundingClientRect();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;   // lines / pages -> pixels
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
    // horizontal wheel / Shift+wheel: pan the zoomed view
    viewStart += (dx || dy) / r.width * viewSpan;
    afterZoom();
    return;
  }
  // wheel (mouse) or Ctrl+wheel (trackpad pinch): zoom around the pointer
  const anchor = viewStart + (e.clientX - r.left) / r.width * viewSpan;
  viewSpan *= Math.exp(dy * (e.ctrlKey ? 0.01 : 0.002));
  clampView();
  viewStart = anchor - (e.clientX - r.left) / r.width * viewSpan;
  afterZoom();
}, { passive: false });
box.addEventListener('dblclick', resetView);
el.zoomReset.addEventListener('click', resetView);

el.seek.addEventListener('input', () => {
  if (!loaded) return;
  fill(el.seek, el.seek.value, 0, 1000);
  seekTo(+el.seek.value / 1000 * audio.duration);
});

function setA() {
  loopA = audio.currentTime;
  if (loopB != null && loopB <= loopA + 0.2) loopB = null;
  renderLoop();
}
function setB() {
  const t = audio.currentTime;
  if (loopA == null) loopA = 0;
  if (t <= loopA + 0.2) return;
  loopB = t;
  renderLoop();
}
el.setA.addEventListener('click', setA);
el.setB.addEventListener('click', setB);
el.addMarker.addEventListener('click', addMarker);
$('markerForm').addEventListener('submit', (e) => { e.preventDefault(); confirmMarker(); });   // Enter or the Add button
el.markerCancel.addEventListener('click', () => el.markerDialog.close());
el.markerRemove.addEventListener('click', () => {
  if (markerEditing != null) removeMarker(markerEditing);
  markerEditing = null;
  el.markerDialog.close();
});
el.clearLoop.addEventListener('click', () => { loopA = loopB = null; renderLoop(); });
const toggleLoop = () => { state.loop = !state.loop; save(); renderLoop(); };
el.loopOn.addEventListener('click', toggleLoop);

// Keyboard: Space play/pause, arrows seek, [ ] set A/B, L loop on/off.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog && openDialog !== el.recDialog) return;   // no shortcuts behind a help / confirm dialog
  const t = e.target;
  const onControl = t instanceof HTMLButtonElement || t instanceof HTMLLabelElement || (t instanceof HTMLInputElement && t.type === 'checkbox');
  const onRange = t instanceof HTMLInputElement && t.type === 'range';
  if (e.key === ' ' && !onControl) toggle();
  else if (e.key === 'ArrowLeft' && !onRange) seekTo(audio.currentTime - SEEK_STEP);
  else if (e.key === 'ArrowRight' && !onRange) seekTo(audio.currentTime + SEEK_STEP);
  else if ((e.key === 'r' || e.key === 'R') && canRecord) (recording ? stopRec() : startRec());
  else if ((e.key === 'm' || e.key === 'M') && loaded) addMarker();
  else if (e.key === '[' && loaded) setA();
  else if (e.key === ']' && loaded) setB();
  else if (e.key === 'l' || e.key === 'L') toggleLoop();
  else return;
  e.preventDefault();
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', start);
  navigator.mediaSession.setActionHandler('pause', stop);
}

// ---------- Info dialog ----------
// Only show the gestures that apply to this device: mouse text if a fine pointer exists, touch text if a
// touch screen does (both on hybrids; both if the device can't tell).
function fillInfo() {
  const fine = matchMedia('(any-pointer: fine)').matches, coarse = matchMedia('(any-pointer: coarse)').matches;
  const both = fine === coarse;
  for (const dd of el.infoDialog.querySelectorAll('dd')) {
    dd.textContent = [(fine || both) && dd.dataset.mouse, (coarse || both) && dd.dataset.touch].filter(Boolean).join(' / ');
    dd.hidden = dd.previousElementSibling.hidden = !dd.textContent;   // rows that don't apply to this device
  }
}
el.infoBtn.addEventListener('click', () => { fillInfo(); el.infoDialog.showModal(); el.infoClose.focus(); });
el.infoClose.addEventListener('click', () => el.infoDialog.close());
el.infoDialog.addEventListener('click', (e) => { if (e.target === el.infoDialog) el.infoDialog.close(); });   // backdrop click

// ---------- Embedding (home page) ----------
const EMBEDDED = window.parent !== window;
if (EMBEDDED) document.documentElement.classList.add('embedded');

function report() {
  if (!EMBEDDED) return;
  const info = loaded || trackName ? `${trackName}${state.speed !== 100 ? ` · ${state.speed}%` : ''}` : 'No file';
  parent.postMessage({ type: 'status', app: 'player', playing, info: recording ? `● rec · ${info}` : info }, '*');
}
function blocked() {
  if (EMBEDDED) parent.postMessage({ type: 'blocked', app: 'player' }, '*');
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.type !== 'cmd') return;
  const a = e.data.action;
  if (a === 'toggle') toggle();
  else if (a === 'play') start();
  else if (a === 'stop') stop();
  else if (a === 'ping') report();
  else if (a === 'volume' && Number.isFinite(e.data.value)) audio.volume = Math.min(1, Math.max(0, e.data.value));   // ignored by iOS Safari
});

// ---------- Init ----------
load();
renderSpeed();
renderLoopPause();
renderEnabled();
renderTime();
renderPlay();
report();
