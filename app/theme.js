// Practice Room colour theme, shared by the home page and the three apps.
// Loaded synchronously in <head> (not `defer`), before the stylesheet, so the page never flashes the wrong theme.
//
// 'practice-room:theme' in localStorage: 'light' | 'dark', written only when the user clicks the footer button
// of the home page; until then the system setting (prefers-color-scheme), followed live.
// Sets <html data-theme="light|dark">: the stylesheets only key on that attribute. Fires a `themechange` event
// on window after each change (canvases that cache CSS colours redraw on it).
(() => {
  const KEY = 'practice-room:theme';
  const root = document.documentElement;
  const sys = matchMedia('(prefers-color-scheme: light)');
  const valid = (v) => (v === 'light' || v === 'dark' ? v : null);
  const stored = () => { try { return valid(localStorage.getItem(KEY)); } catch { return null; } };
  let pinned = stored();   // also the fallback when storage is unavailable (set by the home page's message)

  const resolve = () => pinned || (sys.matches ? 'light' : 'dark');

  // Browser / OS chrome colour: the shell's bar, or the app's background.
  function syncMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const cs = getComputedStyle(root);
    const c = (cs.getPropertyValue('--bar') || cs.getPropertyValue('--bg')).trim();
    if (c) meta.content = c;
  }

  function apply() {
    const v = resolve();
    if (root.dataset.theme === v) return;
    root.dataset.theme = v;
    if (document.readyState !== 'loading') syncMeta();
    window.dispatchEvent(new Event('themechange'));
  }

  // Explicit choice by the user (home page button), or from the home page's message.
  function set(v, persist = false) {
    if (!(v = valid(v))) return;
    pinned = v;
    if (persist) { try { localStorage.setItem(KEY, v); } catch {} }
    apply();
  }

  sys.addEventListener('change', apply);   // no effect once a theme is pinned
  window.addEventListener('storage', (e) => { if (e.key === KEY) { pinned = stored(); apply(); } });
  window.addEventListener('message', (e) => {
    if (window.parent !== window && e.source === window.parent && e.data?.type === 'cmd' && e.data.action === 'theme') set(e.data.value);
  });
  document.addEventListener('DOMContentLoaded', syncMeta);

  window.THEME = { get: resolve, set };
  apply();
})();
