// Practice audio player: local file, speed without pitch change, A-B loop.
// Uses a plain <audio> element: playbackRate + preservesPitch does the time-stretching.

const KEY = 'player:v1';
const SPEED_MIN = 25, SPEED_MAX = 150;
const TRANSPOSE_MIN = -12, TRANSPOSE_MAX = 12;   // semitones
const SEEK_STEP = 5;     // seconds, arrow keys
const $ = (id) => document.getElementById(id);

const el = {
  app: $('app'), file: $('file'), name: $('trackName'), seek: $('seek'), cur: $('cur'), dur: $('dur'),
  rewind: $('rewind'), pause: $('pause'), play: $('play'), addMarker: $('addMarker'), markerStrip: $('markerStrip'), markerDialog: $('markerDialog'), markerName: $('markerName'), markerCancel: $('markerCancel'), markerTitle: $('markerTitle'), markerOk: $('markerOk'), markerRemove: $('markerRemove'),
  speed: $('speed'), speedOut: $('speedOut'), speedDown: $('speedDown'), speedUp: $('speedUp'), speedReset: $('speedReset'), speedTick: $('speedTick'),
  transpose: $('transpose'), transposeOut: $('transposeOut'), transposeInt: $('transposeInt'), transposeDown: $('transposeDown'), transposeUp: $('transposeUp'), transposeReset: $('transposeReset'), transposeFine: $('transposeFine'),
  loopOn: $('loopOn'), loopOut: $('loopOut'), setA: $('setA'), setB: $('setB'), clearLoop: $('clearLoop'),
  wave: $('wave'), armLoop: $('armLoop'), loopPause: $('loopPause'), loopPauseOut: $('loopPauseOut'), zoomReset: $('zoomReset'), progressView: $('progressView'), progress: $('progress'), progressHandle: $('progressHandle'), progressWave: $('progressWave'), progressMarks: $('progressMarks'),
  rec: $('rec'), recLabel: $('recLabel'), recMsg: $('recMsg'), takeDownload: $('takeDownload'),
  meter: $('meter'), meterFill: $('meterFill'), meterPeak: $('meterPeak'),
  confirmDialog: $('confirmDialog'), confirmOk: $('confirmOk'), confirmCancel: $('confirmCancel'),
  infoBtn: $('infoBtn'), infoDialog: $('infoDialog'), infoClose: $('infoClose'),
  recDialog: $('recDialog'), recTime: $('recTime'), recStop: $('recStop'),
  normalize: $('normalize'), normDialog: $('normDialog'), normForm: $('normForm'), normCanvas: $('normCanvas'), normLimit: $('normLimit'), normInfo: $('normInfo'), normCancel: $('normCancel'), normOk: $('normOk'),
};

const state = { speed: 100, transpose: 0, transposeFine: false, loop: true, loopPause: 0 };   // loop = the A-B loop toggle; remembered even when no A-B is set
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
let curFile = null;      // the File currently loaded (decoded again by Normalize)
let rawPeak = 0;         // highest absolute sample of the loaded file (0..1), 0 until decoded

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
    if (s && Number.isFinite(s.transpose)) state.transpose = Math.min(TRANSPOSE_MAX, Math.max(TRANSPOSE_MIN, Math.round(s.transpose * 2) / 2));
    if (s && typeof s.transposeFine === 'boolean') state.transposeFine = s.transposeFine;
  } catch {}
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
}

// ---------- Per-file memory ----------
// Markers, the A-B loop and the start mark are remembered for every file that is opened, keyed by a fingerprint of the
// file (size + hash of its first and last 64 KB, so a renamed or copied file is recognised). Small: kept in localStorage,
// for the MAX_FILES most recently used files (older ones are dropped silently, so the stored data cannot grow forever).
// The audio itself is kept for the current track only (one IndexedDB slot, replaced by the next file or take), so it is
// restored when the app is reopened.
const FILES_KEY = 'player:files:v1';
const MAX_FILES = 100;
const CHUNK = 65536;
let trackKey = null;        // fingerprint of the loaded track (null until computed)
let trackSynced = false;    // the saved state has been applied (or there was none): only then are changes written back
let lastSnap = '';

function readFiles() {
  try {
    const f = JSON.parse(localStorage.getItem(FILES_KEY));
    return f && typeof f === 'object' && !Array.isArray(f) ? f : {};
  } catch { return {}; }
}
function writeFiles(f) {
  const keys = Object.keys(f);
  if (keys.length > MAX_FILES) for (const k of keys.sort((a, b) => (f[a].used || 0) - (f[b].used || 0)).slice(0, keys.length - MAX_FILES)) delete f[k];
  try { localStorage.setItem(FILES_KEY, JSON.stringify(f)); } catch {}
}

function fnv(bytes) {
  let h = 2166136261;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
async function fingerprint(file) {
  const head = new Uint8Array(await file.slice(0, CHUNK).arrayBuffer());
  const tail = file.size > CHUNK ? new Uint8Array(await file.slice(Math.max(CHUNK, file.size - CHUNK)).arrayBuffer()) : head;
  return `${file.size}-${fnv(head)}-${fnv(tail)}`;
}

function trackSnapshot() {
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  return { markers: markers.map((m) => ({ t: num(m.t), name: m.name })), seq: markerSeq, a: num(loopA), b: num(loopB), start: startMark > 0 ? num(startMark) : null };
}
// Called every second, when the page is hidden and before the track is replaced: writes only if something changed.
function persistTrack() {
  if (!trackKey || !trackSynced) return;
  const s = trackSnapshot();
  const json = JSON.stringify(s);
  if (json === lastSnap) return;
  lastSnap = json;
  const files = readFiles();
  if (!s.markers.length && s.a == null && s.start == null) delete files[trackKey];
  else files[trackKey] = { ...s, name: trackName, used: Date.now() };
  writeFiles(files);
}
// Once both the fingerprint and the duration are known: restore what was saved for this file.
function syncTrack() {
  if (!trackKey || !loaded || trackSynced) return;
  trackSynced = true;
  const files = readFiles(), r = files[trackKey];
  if (r && !markers.length && loopA == null) {
    const ok = (t) => Number.isFinite(t) && t >= 0 && t <= audio.duration;
    markers = (Array.isArray(r.markers) ? r.markers : [])
      .filter((m) => m && ok(m.t) && typeof m.name === 'string')
      .map((m) => ({ t: m.t, name: m.name.slice(0, 24) }))
      .sort((a, b) => a.t - b.t);
    markerSeq = Number.isInteger(r.seq) && r.seq >= 1 ? r.seq : markers.length + 1;
    markerKey = '';
    if (ok(r.a) && ok(r.b) && r.b > r.a) { loopA = r.a; loopB = r.b; }
    if (ok(r.start) && r.start > 0) seekTo(r.start, true);
    r.used = Date.now();   // opening a file counts as using it
    writeFiles(files);
    renderLoop();
    drawWave();
  }
  lastSnap = JSON.stringify(trackSnapshot());
}
setInterval(persistTrack, 1000);
addEventListener('pagehide', persistTrack);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistTrack(); });

// The current audio, one slot in IndexedDB (a Blob is stored on disk by the browser, not in memory).
const MAX_KEEP_BYTES = 50 * 1024 * 1024;   // bigger files are not stored (their markers and loops still are)
const IDB_NAME = 'practice-room-player', IDB_STORE = 'audio', IDB_SLOT = 'current';
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(IDB_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}
// Replaces the stored audio with this file; a file over the limit just empties the slot, so the next launch does not
// reopen an older file instead. Quota errors or private mode: silently not kept.
// `saving` counts writes in progress: the shell does not auto-update (reload) during one, so a take is never lost.
let saving = 0;
const keepAudio = (file, isTake) => {
  saving++;
  report();
  return idb('readwrite', (st) => (file.size > MAX_KEEP_BYTES
    ? st.delete(IDB_SLOT)
    : st.put({ blob: file, name: file.name, type: file.type, isTake }, IDB_SLOT)))
    .catch(() => {})
    .finally(() => { saving--; report(); });
};
const recallAudio = () => idb('readonly', (st) => st.get(IDB_SLOT)).catch(() => null);

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
    rawPeak = max;
    renderEnabled();
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

// Smooth playback position: audio.currentTime can advance in coarse, uneven steps, so while playing the position is a clock of our own: set
// from audio.currentTime when the audio really starts to move, then advanced by real time x playbackRate, never pulled back by the
// (stale, stepped) currentTime readings. It is re-synced only when the audio itself jumps (seek, loop wrap, a difference over 0.5 s) or
// stalls (waiting). Stopped (or before the audio has really started to move) it is audio.currentTime itself.
let ppCT = -1, ppEst = 0, ppNow = 0, ppRunning = false, ppSync = false;   // ppRunning: audio.currentTime has really started to advance since play began
let framePos = null;   // the position sampled once per animation frame, so the follow logic and the drawing agree to the pixel
function playPos() {
  if (framePos != null) return framePos;
  const ct = audio.currentTime, now = performance.now();
  if (!playing || audio.paused || loopWaitTimer) { ppCT = ct; ppEst = ct; ppNow = now; ppRunning = false; return ct; }
  if (ppRunning) ppEst += Math.min(0.1, (now - ppNow) / 1000) * audio.playbackRate;
  ppNow = now;
  if (ppSync) { ppSync = false; ppEst = ct; ppCT = ct; }
  if (ct !== ppCT) {
    ppCT = ct;
    if (!ppRunning) { ppRunning = true; ppEst = ct; }
    else if (Math.abs(ct - ppEst) > 0.5) ppEst = ct;
  }
  if (!ppRunning) return ct;   // the audio pipeline is still starting up: don't run ahead of it
  let t = ppEst;
  if (hasLoop() && state.loop) t = Math.min(t, loopB);
  return Math.min(t, audio.duration || t);
}
audio.addEventListener('seeking', () => { ppSync = true; });                                 // a seek (click, arrow keys, loop wrap): take the new position
audio.addEventListener('waiting', () => { ppRunning = false; });                             // buffering: stand still until the audio moves again

// While playing, the zoomed waveform scrolls at playback speed under a playhead that stays fixed in the middle of the window. p = playhead
// position in the window (0..1): left of the middle (e.g. a play started at the left edge) the window stays still and the playhead
// moves alone until it reaches the middle; at the middle or right of it (after a seek, a zoom, a pan, a loop wrap) the window recentres
// on it at once. Near the ends of the track clampView() keeps the window inside the track, so the playhead leaves the middle and
// runs to the edge at the end.
function followPlayhead(dt = 0) {
  const d = audio.duration || 0;
  if (!d || viewSpan >= 0.999 || interacting || !playing) return;
  const f = playPos() / d;
  const p = (f - viewStart) / viewSpan;
  if (p < 0 || p >= 0.5) { viewStart = f - viewSpan / 2; clampView(); }   // else: left of the middle, only the playhead moves
}

// Frame loop while playing: smooth scrolling needs more than the 25 Hz tick.
let raf = 0, rafT = 0;
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - rafT) / 1000);
  rafT = now;
  framePos = null;
  framePos = playPos();   // kept until the next frame (or stopFrames), so draws in between agree with the window
  followPlayhead(dt);
  drawWave();
}
// Start the animation only once the audio really runs (currentTime has moved), so a slow audio start-up is not shown as a hesitation.
function startFramesWhenRunning() {
  const t0 = audio.currentTime, since = performance.now();
  const check = () => {
    if (!playing) return;
    if (Math.abs(audio.currentTime - t0) > 0.02 || performance.now() - since > 800) startFrames();   // 800 ms: never wait forever
    else requestAnimationFrame(check);
  };
  check();
}
function startFrames() { if (!raf) { rafT = performance.now(); raf = requestAnimationFrame(frame); } }
function stopFrames() { cancelAnimationFrame(raf); raf = 0; framePos = null; }

// Markers: added at the playback start position. Magenta dashed lines in the waveform, numbered labels above it (outside the waveform). Click a label to go
// to the marker, double-click to remove it. They belong to the loaded track and are not saved.
let markers = [];      // [{t: seconds, name}], sorted by t
let markerSeq = 1;     // the next default name: an increasing integer, per loaded track
let markerKey = '';    // what the labels were last laid out for
let markerDrag = null; // {index, t} while a marker is being dragged with the mouse (preview, applied on release)
let markerEditing = null;   // index of the marker being renamed / removed, or null when adding a new one
const shownMarkers = () => markers.map((m, i) => (markerDrag && markerDrag.index === i ? markerDrag.t : m.t));
const clearMarkers = () => { markers = []; markerSeq = 1; };

// The bookmark button / M key places a marker named with an increasing integer. Clicking its label opens a dialog to rename or remove it.
function addMarker() {
  if (!loaded) return;
  // Stopped: the marker goes at the start position (the yellow line). Playing: at the current position (the start
  // mark doesn't move during playback, so using it would put every marker on the same spot).
  const t = playing ? audio.currentTime : (startMark ?? audio.currentTime);
  if (markers.some((m) => Math.abs(m.t - t) < 0.1)) return;   // already marked here
  markers.push({ t, name: String(markerSeq) });
  markerSeq++;
  markers.sort((x, y) => x.t - y.t);
  markerKey = '';
  drawWave();
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
  const key = [w, d, markers.map((m) => `${m.t}:${m.name}`).join('|')].join('/');
  if (key === markerKey) { placeMarkerLabels(d); return; }   // only the view moved: reposition the existing labels
  markerKey = key;
  el.markerStrip.replaceChildren();
  labelEls = [];
  trashFor = null;
  markers.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'marker-label';
    b.textContent = m.name;
    b.title = `Marker "${m.name}" at ${fmt(m.t)}: click to rename or remove, drag to move`;
    b.setAttribute('aria-label', `Marker ${m.name} at ${fmt(m.t)}`);
    let x0 = 0, moved = false;
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !markerDrag) showTrash(i); });
    b.addEventListener('pointerleave', hideTrashSoon);
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      hideTrash();
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
    labelEls.push(b);
  });
  el.markerStrip.append(markerTrash());
  placeMarkerLabels(d);
}
let labelEls = [];   // the marker label buttons, same order as markers

// Hovering a label (mouse) shows a row with round edit and trash buttons just above it. One shared row.
let trashEl = null, trashFor = null, trashTimer = 0;
function markerTrash() {
  if (trashEl) return trashEl;
  trashEl = document.createElement('div');   // the tools row: edit and trash side by side
  trashEl.className = 'marker-tools';
  trashEl.hidden = true;
  const tool = (cls, label, path, fn) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = `marker-tool ${cls}`;
    t.title = label;
    t.setAttribute('aria-label', label);
    t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    t.addEventListener('click', () => { const i = trashFor; hideTrash(); if (i != null) fn(i); });
    return t;
  };
  trashEl.append(
    tool('edit', 'Edit marker', '<path d="M4 20h4L19 9l-4-4L4 16z"/>', editMarker),
    tool('trash', 'Delete marker', '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>', removeMarker),
  );
  trashEl.addEventListener('pointerenter', () => clearTimeout(trashTimer));
  trashEl.addEventListener('pointerleave', hideTrashSoon);
  return trashEl;
}
function showTrash(i) {
  clearTimeout(trashTimer);
  trashFor = i;
  markerTrash().hidden = false;
  placeTrash();
}
function hideTrash() { clearTimeout(trashTimer); trashFor = null; if (trashEl) trashEl.hidden = true; }
function hideTrashSoon() { clearTimeout(trashTimer); trashTimer = setTimeout(hideTrash, 200); }   // time to move from the label to the button
function placeTrash() {
  if (trashFor == null || !labelEls[trashFor]) return;
  const b = labelEls[trashFor];
  trashEl.style.left = b.style.left;
  trashEl.style.display = b.style.display === 'none' ? 'none' : '';
}
function placeMarkerLabels(d) {
  labelEls.forEach((b, i) => {
    const f = d ? (markers[i].t / d - viewStart) / viewSpan : -1;
    b.style.display = f < -0.01 || f > 1.01 ? 'none' : '';   // outside the zoomed view
    b.style.left = `${f * 100}%`;
  });
  placeTrash();
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
  const pos = playPos();
  const frac = d ? pos / d : 0;
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
    // fixed bar grid over the whole track, so scrolling only translates the bars (no shimmer)
    const bw = 2, gap = 1, nTot = w / (bw + gap) / viewSpan;
    for (let i = Math.floor(viewStart * nTot), iEnd = Math.ceil((viewStart + viewSpan) * nTot); i < iEnd; i++) {
      const x = (i - viewStart * nTot) * (bw + gap);
      const f0 = i / nTot, f1 = (i + 1) / nTot;
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
    const x = xOf(pos);
    if (x >= 0 && x <= w) {
      g.fillStyle = '#fff';
      g.fillRect(Math.min(w - 1, x), 0, 1, h);
    }
  }
  renderMarkerLabels(w);
  renderProgress();
}
// Full-track progress bar: visible window (zoom) + playback position
function renderProgress() {
  const d = audio.duration;
  el.progressView.style.left = (viewStart * 100) + '%';
  el.progressView.style.width = (viewSpan * 100) + '%';
  const pct = d > 0 && isFinite(d) ? Math.min(100, (playing ? playPos() : (startMark ?? audio.currentTime)) / d * 100) : 0;
  el.progressHandle.style.left = pct + '%';
  drawProgressWave();
  renderProgressMarks();
}
// Mini-map of the whole waveform (large displays only: the canvas is hidden by CSS otherwise). Redrawn only when the peaks or the size change.
let pwKey = '';
function drawProgressWave() {
  const cv = el.progressWave, w = cv.clientWidth, h = cv.clientHeight;
  const key = `${w}x${h}:${peaks ? PEAK_BUCKETS : 0}:${peaks ? peaks[0] + peaks[PEAK_BUCKETS >> 1] : 0}`;
  if (key === pwKey) return;
  pwKey = key;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!peaks) return;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-dim').trim();
  const bw = 2, gap = 1, n = Math.floor(w / (bw + gap));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i / n * PEAK_BUCKETS), b = Math.max(a + 1, Math.floor((i + 1) / n * PEAK_BUCKETS));
    let p = 0;
    for (let k = a; k < b && k < PEAK_BUCKETS; k++) if (peaks[k] > p) p = peaks[k];
    const bh = Math.max(1, p * (h - 6));
    g.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
  }
}
// Loop ends and markers on the bar (dots, or vertical lines on large displays); rebuilt only when something changed
let pmKey = '';
function renderProgressMarks() {
  const d = audio.duration;
  const ok = d > 0 && isFinite(d);
  const items = [];
  if (ok) {
    shownMarkers().forEach((t) => items.push(['', t]));
    if (hasLoop()) { const c = state.loop ? 'loop' : 'loop off'; items.push([c, loopA], [c, loopB]); }
  }
  const key = items.map((i) => i.join('@')).join('|') + '/' + d;
  if (key === pmKey) return;
  pmKey = key;
  el.progressMarks.replaceChildren(...items.map(([c, t]) => {
    const e = document.createElement('i');
    e.className = ('pm ' + c).trim();
    e.style.left = (t / d * 100) + '%';
    return e;
  }));
}
// Click or drag on the progress bar to move the position (zoom is kept, the window is centred on it)
let progressDrag = false;
const progressSeek = (e) => {
  const r = el.progress.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  viewStart = f - viewSpan / 2;   // keep the zoom, centre the window on the new position
  clampView();
  seekTo(f * (audio.duration || 0));
};
el.progress.addEventListener('pointerdown', (e) => {
  if (!loaded) return;
  if (playing) stop();   // any use of the bar stops playback
  progressDrag = true;
  el.progress.setPointerCapture(e.pointerId);
  progressSeek(e);
});
el.progress.addEventListener('pointermove', (e) => { if (progressDrag) progressSeek(e); });
const progressEnd = () => { progressDrag = false; };
el.progress.addEventListener('pointerup', progressEnd);
el.progress.addEventListener('pointercancel', progressEnd);
window.addEventListener('resize', drawWave);
new ResizeObserver(drawWave).observe(el.wave.parentElement);   // the waveform height follows the available space

// ---------- Rendering ----------
function renderSpeed() {
  el.speed.value = state.speed;
  fill(el.speed, state.speed, SPEED_MIN, SPEED_MAX);
  el.speedOut.textContent = `${state.speed}%`;
  audio.defaultPlaybackRate = audio.playbackRate = state.speed / 100;
}
// ---------- Transpose (pitch shift) ----------
// The <audio> element keeps doing the speed (preservesPitch). To shift the pitch it is routed through an
// AudioWorklet (pitchshift.js). The graph is built lazily, the first time a non-zero transpose is needed, and only
// once the AudioContext is really running: createMediaElementSource() is irreversible, so on a suspended context
// (no user gesture yet) the audio would stay silent. The element's own volume still applies before the worklet.
let pitchNode = null, pitchBuilding = null, pitchFailed = false;
function applyPitch() {
  if (pitchNode) pitchNode.parameters.get('pitch').value = 2 ** (state.transpose / 12);
}
function ensurePitch() {
  if (pitchNode || pitchFailed) return Promise.resolve(!!pitchNode);
  if (!pitchBuilding) pitchBuilding = (async () => {
    let ctx;
    try {
      ctx = new AudioContext();
      await ctx.resume();
      if (ctx.state !== 'running') { ctx.close(); return false; }   // no gesture yet: try again on the next one
      await ctx.audioWorklet.addModule('pitchshift.js');
      const node = new AudioWorkletNode(ctx, 'pitch-shifter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      ctx.createMediaElementSource(audio).connect(node).connect(ctx.destination);
      pitchNode = node;
      applyPitch();
      return true;
    } catch (err) {
      console.warn('Transpose unavailable:', err);
      pitchFailed = true;
      try { ctx && ctx.close(); } catch {}
      for (const b of [el.transpose, el.transposeDown, el.transposeUp, el.transposeReset, el.transposeFine]) { b.disabled = true; b.title = 'Transpose is not supported on this device'; }
      return false;
    } finally { pitchBuilding = null; }
  })();
  return pitchBuilding;
}
document.addEventListener('visibilitychange', () => { if (pitchNode && !document.hidden && pitchNode.context.state === 'suspended' && playing) pitchNode.context.resume(); });

const INTERVALS = ['', '2m', '2', '3m', '3', '4', '5b', '5', '6m', '6', '7m', '7', '8'];   // by number of semitones
function renderTranspose() {
  el.transpose.step = state.transposeFine ? 0.5 : 1;
  el.transposeFine.setAttribute('aria-pressed', String(state.transposeFine));
  el.transpose.value = state.transpose;
  fill(el.transpose, state.transpose, TRANSPOSE_MIN, TRANSPOSE_MAX);
  const sign = state.transpose > 0 ? '+' : state.transpose < 0 ? '−' : '';
  el.transposeOut.textContent = `${sign}${Math.abs(state.transpose)}`;
  el.transposeOut.dataset.unit = Math.abs(state.transpose) === 1 ? 'semitone' : 'semitones';   // the unit is added in CSS (short "st" in the compact box)
  const abs = Math.abs(state.transpose);   // a quarter tone (half a semitone) is shown as a trailing ¼
  el.transposeInt.textContent = state.transpose ? `${sign}${INTERVALS[Math.floor(abs)]}${abs % 1 ? '¼' : ''}` : '';
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
  if (!raf) { followPlayhead(); drawWave(); }   // while playing, the frame loop does this
}
function renderPlay() {
  el.play.setAttribute('aria-pressed', playing);
  el.pause.disabled = !playing || recording;
  el.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
function renderEnabled() {
  for (const b of [el.play, el.rewind, el.addMarker, el.setA, el.setB, el.seek, el.armLoop]) b.disabled = !loaded;
  if (!loaded) setArm(false);
  el.normalize.hidden = !loaded;
  el.normalize.disabled = !(loaded && peaks && rawPeak > 0);
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
  // Only seek when needed: assigning currentTime, even to the same value, flushes the media pipeline and delays the start.
  if (startMark != null) { if (Math.abs(audio.currentTime - startMark) > 0.01) audio.currentTime = startMark; }
  else startMark = audio.currentTime;
  try {
    if (state.transpose !== 0) await ensurePitch();
    await audio.play();
  } catch (err) {
    if (err.name === 'NotAllowedError') blocked();
    return;
  }
  ppCT = audio.currentTime; ppRunning = false;   // wait for the audio to really move before extrapolating
  playing = true;
  timer = setInterval(tick, 40);
  startFramesWhenRunning();
  acquireWake();
  renderPlay();
  report();
}

// pause = true: stay where the audio is and make that position the new start, instead of going back to the old one.
function stop(pause = false) {
  if (recording) { stopRec(); return; }
  if (!playing) return;
  loopWaitCancel();
  audio.pause();
  if (pause) startMark = audio.currentTime;
  else if (startMark != null) audio.currentTime = startMark;   // back to where playback started
  viewToMark();
  playing = false;
  clearInterval(timer);
  stopFrames();
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
  stopFrames();
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
  persistTrack();
  trackKey = null; trackSynced = false; lastSnap = '';
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
function openFile(file, isTake = false, restored = false) {
  if (!file) return;
  el.name.classList.remove('placeholder');
  if (!(file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(file.name))) {
    el.name.classList.remove('loaded');
    el.name.textContent = `"${file.name}" doesn't look like an audio file.`;
    return;
  }
  persistTrack();   // the track being replaced
  trackKey = null; trackSynced = false; lastSnap = '';
  if (playing) stop();
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  trackName = file.name.replace(/\.[^.]+$/, '');
  loopA = loopB = null;
  clearMarkers();
  startMark = null;
  loaded = false;
  peaks = null;
  rawPeak = 0;
  curFile = file;
  renderEnabled();
  viewStart = 0; viewSpan = 1;
  el.zoomReset.hidden = true;
  computePeaks(file, ++loadToken);
  const token = loadToken;
  if (!restored) keepAudio(file, isTake);   // replaces the previous file / take in the one storage slot
  fingerprint(file).then((k) => { if (token === loadToken) { trackKey = k; syncTrack(); } }).catch(() => {});
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
  syncTrack();
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

// ---------- Normalize ----------
// The dialog draws the whole track on the same scale as the main waveform (its peak fills the height) with two linked lines
// that mark a threshold; the slider moves them. OK scales the audio so the threshold reaches the ceiling (NORM_CEIL_DB) and
// reloads it as a WAV (markers, loop and start mark stay), so the result can be downloaded like a take. Peaks above the
// threshold (the grayed-out part) are clipped. With the lines at the peak nothing is clipped.
const NORM_CEIL_DB = -1;      // level the threshold is brought to: just under full scale
const NORM_RANGE_DB = 24;     // how far below the peak the lines can go
const NORM_CEIL = 10 ** (NORM_CEIL_DB / 20);
const normGain = () => NORM_CEIL / 10 ** (+el.normLimit.value / 20);
const dbText = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`;

function drawNorm() {
  const cv = el.normCanvas;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h || !peaks) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  if (!colors) {
    const cs = getComputedStyle(document.documentElement);
    colors = { accent: cs.getPropertyValue('--accent').trim(), dim: cs.getPropertyValue('--accent-dim').trim(), text: cs.getPropertyValue('--text').trim() };
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const mid = h / 2;
  // Same scale as the main waveform: the file's peak fills the height (h - 12). The lines sit at limit / peak on that
  // scale, so they are only visible inside the display while the limit is below the peak; above it they stay on the edge.
  const half = (h - 12) / 2;
  const lim = Math.min(half, 10 ** (+el.normLimit.value / 20) / rawPeak * half);   // threshold, pixels from the centre
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x / w * PEAK_BUCKETS), b = Math.max(a + 1, Math.floor((x + 1) / w * PEAK_BUCKETS));
    let p = 0;
    for (let k = a; k < b && k < PEAK_BUCKETS; k++) if (peaks[k] > p) p = peaks[k];
    const bh = Math.max(1, p * half), inner = Math.min(bh, lim);
    g.fillStyle = colors.accent;
    g.fillRect(x, mid - inner, 1, inner * 2);
    if (bh > lim) {   // outside the safe region: clipped
      g.fillStyle = '#5b6663';
      g.fillRect(x, mid - bh, 1, bh - lim);
      g.fillRect(x, mid + lim, 1, bh - lim);
    }
  }
  g.fillStyle = 'rgba(143, 160, 155, 0.35)';
  g.fillRect(0, mid, w, 1);
  g.strokeStyle = colors.text;
  g.lineWidth = 1.5;
  g.setLineDash([6, 4]);
  g.beginPath();
  g.moveTo(0, mid - lim); g.lineTo(w, mid - lim);
  g.moveTo(0, mid + lim); g.lineTo(w, mid + lim);
  g.stroke();
  g.setLineDash([]);
}
function renderNorm() {
  const db = +el.normLimit.value, peakDb = 20 * Math.log10(rawPeak), gainDb = NORM_CEIL_DB - db;
  const clipped = db < peakDb - 0.05;
  el.normInfo.textContent = `Limit ${dbText(db)} → ${dbText(NORM_CEIL_DB)} (gain ${dbText(gainDb)})${clipped ? ' · peaks above the lines are clipped' : ''}`;
  el.normInfo.classList.toggle('warn', clipped);
  fill(el.normLimit, db, +el.normLimit.min, +el.normLimit.max);
  drawNorm();
}
function openNormalize() {
  if (!loaded || !peaks || !(rawPeak > 0)) return;
  if (playing) stop();
  const peakDb = Math.ceil(20 * Math.log10(rawPeak) * 10) / 10;   // rounded up to the slider step, so the max is never below the peak
  el.normLimit.min = peakDb - NORM_RANGE_DB;
  el.normLimit.max = peakDb;
  el.normLimit.value = peakDb;   // estimate: the lines at the peak, so nothing is clipped
  el.normOk.disabled = false;
  el.normDialog.showModal();
  renderNorm();
  el.normOk.focus();
}

function encodeWav(buf, gain, ceil) {
  const ch = buf.numberOfChannels, n = buf.length, bytes = n * ch * 2;
  const out = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, bytes, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-ceil, Math.min(ceil, data[c][i] * gain));
      out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

// Swap the audio for another rendering of the same track: unlike openFile, markers, loop, start mark and per-track memory stay.
function replaceAudio(file) {
  if (playing) stop();
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(file);
  curFile = file;
  trackName = file.name.replace(/\.[^.]+$/, '');
  el.name.textContent = trackName;
  loaded = false;
  peaks = null;
  rawPeak = 0;
  renderEnabled();
  computePeaks(file, ++loadToken);
  keepAudio(file, true);
  takeUnsaved = true;
  el.takeDownload.hidden = false;
  el.takeDownload.href = url;
  el.takeDownload.download = file.name;
  audio.src = url;
  renderSpeed();
}

async function applyNormalize() {
  const gain = normGain(), file = curFile, token = loadToken;
  el.normOk.disabled = true;
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const buf = await new Ctx(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    if (token !== loadToken) return;   // another file was opened meanwhile
    const blob = encodeWav(buf, gain, NORM_CEIL);
    replaceAudio(new File([blob], `${trackName.replace(/-normalized$/, '')}-normalized.wav`, { type: 'audio/wav' }));
    el.normDialog.close();
  } catch {
    el.normInfo.textContent = 'Could not process this file.';
    el.normInfo.classList.add('warn');
    el.normOk.disabled = false;
  }
}
el.normalize.addEventListener('click', openNormalize);
el.normLimit.addEventListener('input', renderNorm);
el.normCancel.addEventListener('click', () => el.normDialog.close());
el.normForm.addEventListener('submit', (e) => { e.preventDefault(); applyNormalize(); });
window.addEventListener('resize', () => { if (el.normDialog.open) drawNorm(); });

// ---------- Controls ----------
function setSpeed(v) {
  state.speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(v)));
  renderSpeed();
  save();
  report();
}
function setTranspose(v) {
  const q = state.transposeFine ? 2 : 1;   // steps per semitone
  state.transpose = Math.min(TRANSPOSE_MAX, Math.max(TRANSPOSE_MIN, Math.round(v * q) / q));
  renderTranspose();
  save();
  applyPitch();
  if (state.transpose !== 0) ensurePitch().then(applyPitch);   // first use: build the graph (we are inside a user gesture)
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
// small screens: the speed slider moves in 5% steps (1% on wide screens)
const smallScreen = matchMedia('(max-width: 600px)');
const speedStep = () => {
  const small = smallScreen.matches;
  el.speed.step = small ? 5 : 1;
  // small screens: the 100% tick under the slider is a button that resets the speed (the reset button is hidden there)
  if (small) { el.speedTick.setAttribute('role', 'button'); el.speedTick.tabIndex = 0; el.speedTick.title = 'Reset speed to 100%'; }
  else { el.speedTick.removeAttribute('role'); el.speedTick.removeAttribute('tabindex'); el.speedTick.removeAttribute('title'); el.speedTick.setAttribute('aria-hidden', 'true'); }
  if (small) el.speedTick.removeAttribute('aria-hidden');
  renderSpeed();
};
el.speedTick.addEventListener('click', () => { if (smallScreen.matches) setSpeed(100); });
el.speedTick.addEventListener('keydown', (e) => { if (smallScreen.matches && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSpeed(100); } });
smallScreen.addEventListener('change', speedStep);
el.speed.addEventListener('input', () => setSpeed(+el.speed.value));
el.speedDown.addEventListener('click', () => setSpeed(state.speed - 5));
el.speedUp.addEventListener('click', () => setSpeed(state.speed + 5));
el.speedReset.addEventListener('click', () => setSpeed(100));
el.transpose.addEventListener('input', () => setTranspose(+el.transpose.value));
// small screens: tap the compact transpose box to expand it (speed collapses to a tab), tap the speed tab to go back
for (const b of document.querySelectorAll('.tab-open')) b.addEventListener('click', () => { $('tune').dataset.open = b.dataset.tune; });
const transposeStep = () => state.transposeFine ? 0.5 : 1;
el.transposeDown.addEventListener('click', () => setTranspose(state.transpose - transposeStep()));
el.transposeUp.addEventListener('click', () => setTranspose(state.transpose + transposeStep()));
el.transposeFine.addEventListener('click', () => { state.transposeFine = !state.transposeFine; setTranspose(state.transpose); });   // back to semitones: rounds
el.transposeReset.addEventListener('click', () => setTranspose(0));

el.play.addEventListener('click', toggle);
el.pause.addEventListener('click', () => stop(true));
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
  if (e.pointerType === 'mouse' && e.button !== 0) return;   // a right-click opens a menu and may never send pointerup
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
box.addEventListener('lostpointercapture', endPointer);   // safety net: never leave `interacting` stuck on
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
  const info = loaded || trackName ? `${trackName}${state.speed !== 100 ? ` · ${state.speed}%` : ''}${state.transpose ? ` · ${state.transpose > 0 ? '+' : '−'}${Math.abs(state.transpose)} st` : ''}` : 'No file';
  parent.postMessage({ type: 'status', app: 'player', playing, busy: playing || recording || !!recStream || saving > 0, info: recording ? `● rec · ${info}` : info }, '*');
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
speedStep();
renderTranspose();
renderLoopPause();
renderEnabled();
renderTime();
renderPlay();
report();
// Reopen the audio that was loaded last time (unless something was opened in the meantime).
recallAudio().then((r) => {
  if (r?.blob && !trackName && !recording) openFile(new File([r.blob], r.name || 'audio', { type: r.type || r.blob.type }), !!r.isTake, true);
}).catch(() => {});
