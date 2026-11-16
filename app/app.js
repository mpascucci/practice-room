const APPS = ['metronome', 'drone', 'player'];
const TAB_KEY = 'home:tab';
const VOL_KEY = 'home:vol';
const slot = (app) => document.querySelector(`.slot[data-app="${app}"]`);
const pane = (app) => document.querySelector(`iframe[data-app="${app}"]`);

// ---------- Tabs ----------
function select(app, focus = false) {
  for (const a of APPS) {
    const on = a === app;
    slot(a).classList.toggle('active', on);
    const tab = slot(a).querySelector('.tab');
    tab.setAttribute('aria-selected', on);
    tab.tabIndex = on ? 0 : -1;
    pane(a).classList.toggle('active', on);
    pane(a).tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  history.replaceState(null, '', `#${app}`);
  try { localStorage.setItem(TAB_KEY, app); } catch {}
}

for (const app of APPS) {
  const s = slot(app);
  s.querySelector('.tab').addEventListener('click', () => select(app));
  s.querySelector('.play').addEventListener('click', () => {
    pane(app).contentWindow.postMessage({ type: 'cmd', action: 'toggle' }, '*');
  });
}

// Arrow keys move between tabs (WAI-ARIA tabs pattern).
document.querySelector('.bar').addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('tab') || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const i = APPS.indexOf(e.target.closest('.slot').dataset.app);
  select(APPS[(i + (e.key === 'ArrowRight' ? 1 : APPS.length - 1)) % APPS.length], true);
  e.preventDefault();
});


// ---------- Per-app volume ----------
// Each app has an independent output level (0-100, perceptual: gain = (v/100)^2), kept here and sent
// to the app as {type:'cmd', action:'volume', value: gain}.
const vols = { metronome: 100, drone: 100, player: 100 };
try {
  const saved = JSON.parse(localStorage.getItem(VOL_KEY));
  for (const a of APPS) if (saved && Number.isFinite(saved[a])) vols[a] = Math.min(100, Math.max(0, Math.round(saved[a])));
} catch {}

const volGain = (app) => (vols[app] / 100) ** 2;
const sendVol = (app) => pane(app).contentWindow?.postMessage({ type: 'cmd', action: 'volume', value: volGain(app) }, '*');
const pop = document.getElementById('volpop');
const popRange = document.getElementById('volrange');
const popOut = document.getElementById('volout');
let popApp = null;

function renderVol(app) {
  const b = slot(app).querySelector('.vol');
  slot(app).classList.toggle('muted', vols[app] === 0);
  b.title = `${app[0].toUpperCase()}${app.slice(1)} volume: ${vols[app]}%`;
}

function closePop() {
  if (!popApp) return;
  slot(popApp).querySelector('.vol').setAttribute('aria-expanded', 'false');
  pop.hidden = true;
  popApp = null;
}

function openPop(app) {
  closePop();
  popApp = app;
  const btn = slot(app).querySelector('.vol');
  btn.setAttribute('aria-expanded', 'true');
  document.getElementById('volname').textContent = app[0].toUpperCase() + app.slice(1);
  popRange.value = vols[app];
  popOut.textContent = `${vols[app]}%`;
  pop.style.setProperty('--c', getComputedStyle(slot(app)).getPropertyValue('--c'));
  pop.hidden = false;
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth;
  pop.style.top = `${r.bottom + 10}px`;
  pop.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8)}px`;
  popRange.focus();
}

for (const app of APPS) {
  renderVol(app);
  slot(app).querySelector('.vol').addEventListener('click', (e) => {
    e.stopPropagation();
    popApp === app ? closePop() : openPop(app);
  });
}
popRange.addEventListener('input', () => {
  vols[popApp] = +popRange.value;
  popOut.textContent = `${vols[popApp]}%`;
  renderVol(popApp);
  sendVol(popApp);
  try { localStorage.setItem(VOL_KEY, JSON.stringify(vols)); } catch {}
});
document.addEventListener('pointerdown', (e) => { if (popApp && !pop.contains(e.target) && !e.target.closest('.vol')) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popApp) { const b = slot(popApp).querySelector('.vol'); closePop(); b.focus(); } });
window.addEventListener('blur', closePop);     // focus moved into an app iframe
window.addEventListener('resize', closePop);

// ---------- Status from the apps ----------
const warnTimers = {};
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !APPS.includes(d.app) || e.source !== pane(d.app).contentWindow) return;
  const s = slot(d.app);
  const info = s.querySelector('[data-info]');
  if (d.type === 'status') {
    s.classList.toggle('playing', d.playing);
    const btn = s.querySelector('.play');
    btn.setAttribute('aria-pressed', d.playing);
    btn.setAttribute('aria-label', `${d.playing ? 'Stop' : 'Play'} ${d.app}`);
    if (!warnTimers[d.app]) info.textContent = d.info;
    info.dataset.last = d.info;
  } else if (d.type === 'blocked') {
    // Browser refused audio in the frame: ask for one tap inside the app.
    select(d.app);
    info.textContent = 'Audio blocked — press play inside the app';
    info.classList.add('warn');
    clearTimeout(warnTimers[d.app]);
    warnTimers[d.app] = setTimeout(() => {
      warnTimers[d.app] = 0;
      info.classList.remove('warn');
      info.textContent = info.dataset.last || '';
    }, 5000);
  }
});

// Apps report on load; ping too in case they loaded before this listener.
for (const app of APPS) {
  pane(app).addEventListener('load', () => {
    pane(app).contentWindow.postMessage({ type: 'cmd', action: 'ping' }, '*');
    sendVol(app);
  });
}

// ---------- Init ----------
let initial = location.hash.slice(1);
if (!APPS.includes(initial)) { try { initial = localStorage.getItem(TAB_KEY); } catch {} }
select(APPS.includes(initial) ? initial : 'metronome');

// ---------- Credits dialog ----------
// Shows CREDITS.md (cached by the service worker, so it works offline). A tiny Markdown subset is rendered
// with DOM nodes (never innerHTML): #/## headings, paragraphs, "- " lists, **bold**, `code` and [links](https://...).
const creditsDialog = document.getElementById('creditsDialog');
const creditsBody = document.getElementById('creditsBody');
let creditsLoaded = false;

function mdInline(text, parent) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/)) {
    let m;
    if (!part) continue;
    if ((m = part.match(/^\*\*([^*]+)\*\*$/))) parent.append(Object.assign(document.createElement('strong'), { textContent: m[1] }));
    else if ((m = part.match(/^`([^`]+)`$/))) parent.append(Object.assign(document.createElement('code'), { textContent: m[1] }));
    else if ((m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)) && /^https?:\/\//.test(m[2])) {
      const a = Object.assign(document.createElement('a'), { textContent: m[1], href: m[2], target: '_blank', rel: 'noopener' });
      parent.append(a);
    } else parent.append(part);
  }
}

function renderMarkdown(md, root) {
  root.replaceChildren();
  let list = null, para = null;
  const flush = () => { list = para = null; };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      const h = document.createElement(m[1].length === 1 ? 'h2' : 'h3');
      mdInline(m[2], h);
      if (!root.querySelector('[id="creditsTitle"]')) h.id = 'creditsTitle';
      root.append(h);
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      para = null;
      if (!list) root.append((list = document.createElement('ul')));
      const li = document.createElement('li');
      mdInline(m[1], li);
      list.append(li);
    } else {
      list = null;
      if (!para) root.append((para = document.createElement('p')));
      else para.append(' ');
      mdInline(line.trim(), para);
    }
  }
}

async function openCredits() {
  creditsDialog.showModal();
  if (creditsLoaded) return;
  try {
    const res = await fetch('CREDITS.md');
    if (!res.ok) throw new Error(res.status);
    renderMarkdown(await res.text(), creditsBody);
    creditsLoaded = true;
  } catch {
    creditsBody.replaceChildren();
    const p = document.createElement('p');
    p.append('Could not load the credits. See ');
    mdInline('[CREDITS.md on GitHub](https://github.com/mpascucci/practice-room/blob/main/app/CREDITS.md)', p);
    p.append('.');
    creditsBody.append(p);
  }
}
document.getElementById('creditsBtn').addEventListener('click', openCredits);
document.getElementById('creditsClose').addEventListener('click', () => creditsDialog.close());
creditsDialog.addEventListener('click', (e) => { if (e.target === creditsDialog) creditsDialog.close(); });   // backdrop

// ---------- PWA: install button ----------
// Always visible (hidden only in the installed app). Uses the native prompt when the browser offered one,
// otherwise explains how to install manually, so a click is never a no-op.
let deferredInstall = null;
const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  installBtn.hidden = true;
  installBtn.previousElementSibling.hidden = true;
});
installBtn.addEventListener('click', async () => {
  if (deferredInstall) {
    const ev = deferredInstall;
    deferredInstall = null;
    ev.prompt();
    await ev.userChoice;
    return;
  }
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  alert(ios ? 'To install: tap the Share button, then "Add to Home Screen".'
    : /Firefox/.test(ua) ? 'Firefox on desktop can\'t install web apps. Use Chrome or Edge, or Firefox on Android (menu → Install).'
    : /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) ? 'To install: File → Add to Dock.'
    : 'To install: use the browser menu → "Install app" (or "Add to Home screen"). If the app is already installed, open it from your apps.');
});

// ---------- PWA: offline support ----------
// Service workers need http(s); skip when opened as a local file.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed:', err));
}
