const APPS = ['metronome', 'drone', 'player'];
const TAB_KEY = 'home:tab';
const VOL_KEY = 'home:vol';
const slot = (app) => document.querySelector(`.slot[data-app="${app}"]`);
const pane = (app) => document.querySelector(`iframe[data-app="${app}"]`);
const appName = (app) => t(app);   // 'metronome' / 'drone' / 'player' are also the translation keys

// ---------- Tabs ----------
function select(app, focus = false) {
  for (const a of APPS) {
    const on = a === app;
    // Tell the app we are leaving (e.g. the drone's tuner stops listening to the microphone).
    if (!on && pane(a).classList.contains('active')) pane(a).contentWindow?.postMessage({ type: 'cmd', action: 'leave' }, '*');
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
  b.title = t('volTitle', { app: appName(app), n: vols[app] });
  b.setAttribute('aria-label', t('volApp', { app: appName(app) }));
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
  document.getElementById('volname').textContent = appName(app);
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
const busy = {};   // app -> playing or recording (from its status messages); blocks the auto update
const playing = {};
const renderPlay = (app) => slot(app).querySelector('.play')
  .setAttribute('aria-label', t(playing[app] ? 'stopApp' : 'playApp', { app: appName(app) }));
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !APPS.includes(d.app) || e.source !== pane(d.app).contentWindow) return;
  const s = slot(d.app);
  const info = s.querySelector('[data-info]');
  if (d.type === 'status') {
    busy[d.app] = d.busy ?? d.playing;
    s.classList.toggle('playing', d.playing);
    const btn = s.querySelector('.play');
    btn.setAttribute('aria-pressed', d.playing);
    playing[d.app] = d.playing;
    renderPlay(d.app);
    if (!warnTimers[d.app]) info.textContent = d.info;
    info.dataset.last = d.info;
  } else if (d.type === 'blocked') {
    // Browser refused audio in the frame: ask for one tap inside the app.
    select(d.app);
    info.textContent = t('audioBlocked');
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
    sendLang(app);
    sendTheme(app);
  });
}

// ---------- Theme ----------
// Light / dark toggle in the footer (theme.js applies it). The button names the theme it switches to.
// The apps follow through the `storage` event, and through a message in case storage is unavailable.
const themeBtn = document.getElementById('themeBtn');
const sendTheme = (app) => pane(app).contentWindow?.postMessage({ type: 'cmd', action: 'theme', value: THEME.get() }, '*');
function renderTheme() {
  const to = THEME.get() === 'light' ? 'Dark' : 'Light';
  document.getElementById('themeLabel').textContent = t(`theme${to}`);
  themeBtn.title = t(`themeTo${to}`);
  themeBtn.setAttribute('aria-label', themeBtn.title);
}
themeBtn.addEventListener('click', () => {
  THEME.set(THEME.get() === 'light' ? 'dark' : 'light', true);
  for (const app of APPS) sendTheme(app);
});
window.addEventListener('themechange', renderTheme);

// ---------- Language ----------
// The footer picker shows the current language (chosen, or detected from the browser) and saves an explicit
// choice. The apps follow through the `storage` event, and through a message in case storage is unavailable.
const langSel = document.getElementById('langSel');
const sendLang = (app) => pane(app).contentWindow?.postMessage({ type: 'cmd', action: 'lang', value: I18N.lang }, '*');
function renderLang() {
  langSel.value = I18N.lang;
  document.getElementById('langCode').textContent = I18N.lang.toUpperCase();
  for (const app of APPS) { renderVol(app); renderPlay(app); }
  renderTheme();
  closePop();
}
langSel.addEventListener('change', () => { I18N.set(langSel.value, true); for (const app of APPS) sendLang(app); });
I18N.onChange(renderLang);
renderLang();

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

// ---------- Share dialog ----------
// Static QR code (share-qr.svg, generated once for the public URL) plus the link.
const SHARE_URL = 'https://mpascucci.github.io/practice-room/';
const shareDialog = document.getElementById('shareDialog');
document.getElementById('shareBtn').addEventListener('click', () => shareDialog.showModal());
document.getElementById('shareClose').addEventListener('click', () => shareDialog.close());
shareDialog.addEventListener('click', (e) => { if (e.target === shareDialog) shareDialog.close(); });   // backdrop

const shareCopy = document.getElementById('shareCopy');
shareCopy.addEventListener('click', async () => {
  const url = SHARE_URL;
  try {
    await navigator.clipboard.writeText(url);
    const label = shareCopy.firstElementChild;
    label.textContent = t('copied');
    shareCopy.classList.add('done');
    setTimeout(() => { label.textContent = t('copyLink'); shareCopy.classList.remove('done'); }, 1500);
  } catch (e) {
    prompt(t('copyPrompt'), url);
  }
});

// System share sheet (phones, some desktop browsers); the button stays hidden when the API is missing.
const shareNative = document.getElementById('shareNative');
if (navigator.share) {
  shareNative.hidden = false;
  shareNative.addEventListener('click', async () => {
    try {
      await navigator.share({ title: 'Practice Room', text: t('shareText'), url: SHARE_URL });
    } catch (e) { /* cancelled */ }
  });
}

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
const installDialog = document.getElementById('installDialog');
document.getElementById('installClose').addEventListener('click', () => installDialog.close());
installDialog.addEventListener('click', (e) => { if (e.target === installDialog) installDialog.close(); });   // backdrop
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
  if (ios) { installDialog.showModal(); return; }   // a dialog, not an alert: the steps show the iOS share icon
  alert(t(/Firefox/.test(ua) ? 'installFirefox'
    : /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua) ? 'installSafari'
    : 'installOther'));
});

// ---------- PWA: offline support ----------
// Service workers need http(s); skip when opened as a local file.
// Auto update: a new sw.js installs and takes over by itself (skipWaiting + clients.claim), but the
// open page keeps running the old code, and an installed app on a phone is usually resumed, not
// relaunched. So check for a new version whenever the app comes back to the screen (and every
// 30 min), and once one has taken over, reload — only while nothing plays or records, and only
// when the app is hidden or just coming back, so it never cuts off practice or jumps under a tap.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const UPDATE_CHECK_MS = 30 * 60 * 1000;
  const hadController = !!navigator.serviceWorker.controller;   // false on first install: not an update
  let updateReady = false;
  const idle = () => !APPS.some((a) => busy[a]);
  const reloadIfReady = () => { if (updateReady && idle()) location.reload(); };

  navigator.serviceWorker.register('sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});   // offline: try again later
    setInterval(() => { if (document.visibilityState === 'visible') check(); }, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { reloadIfReady(); check(); }
    });
  }).catch((err) => console.warn('Service worker registration failed:', err));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || updateReady) return;
    updateReady = true;
    if (document.visibilityState === 'hidden') reloadIfReady();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reloadIfReady();
  });
}
