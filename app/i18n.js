// Practice Room translations, shared by the home page and the three apps.
// Each page loads, in this order (all `defer`): ../i18n.js, its own strings.js, its app.js.
//
// Language: 'practice-room:lang' in localStorage, written only when the user picks one (footer of the home
// page); until then the first supported browser language, falling back to English.
// English is the source text: static text stays in the HTML and is captured on the first pass, so strings.js
// holds English only for strings built in JS, plus the translations of everything.
//
// Markup:
//   data-i18n="key"                         the element's own text: its last non-blank text node, so icons,
//                                           inputs and child elements (e.g. <small>) are left alone
//   data-i18n-attr="title:key aria-label:k" attributes
// In JS: t('key', {name: value}) with {name} placeholders; a plural is {one: '…', other: '…'} chosen by {n}.
// I18N.onChange(fn) re-renders strings built in JS after a language switch.
(() => {
  const LANGS = ['en', 'it', 'fr', 'es', 'de'];
  const KEY = 'practice-room:lang';
  const dict = Object.fromEntries(LANGS.map((l) => [l, {}]));
  const handlers = [];
  const pads = new WeakMap();   // text node -> [leading, trailing] whitespace of the original HTML text

  const valid = (v) => (LANGS.includes(v) ? v : null);
  const stored = () => { try { return valid(localStorage.getItem(KEY)); } catch { return null; } };
  function detect() {
    const list = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const l of list) { const v = valid(String(l).slice(0, 2).toLowerCase()); if (v) return v; }
    return 'en';
  }
  let lang = stored() || detect();

  function t(key, vars) {
    let from = lang, s = dict[lang][key];
    if (s == null) { from = 'en'; s = dict.en[key]; }
    if (s == null) return key;
    if (typeof s === 'object') s = s[new Intl.PluralRules(from).select(vars?.n ?? 0)] ?? s.other;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
  }

  function setText(el, key) {
    let node = null;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) node = n;
    if (!node) el.append((node = document.createTextNode('')));
    if (!pads.has(node)) {
      const m = node.data.match(/^(\s*)([\s\S]*?)(\s*)$/);
      pads.set(node, [m[1], m[3]]);
      if (m[2]) dict.en[key] ??= m[2].replace(/\s+/g, ' ');
    }
    const [a, b] = pads.get(node);
    node.data = a + t(key) + b;
  }

  function setAttrs(el) {
    for (const pair of el.dataset.i18nAttr.trim().split(/\s+/)) {
      const [attr, key] = pair.split(':');
      if (el.hasAttribute(attr)) dict.en[key] ??= el.getAttribute(attr);
      el.setAttribute(attr, t(key));
    }
  }

  function apply(root = document) {
    document.documentElement.lang = lang;
    for (const el of root.querySelectorAll('[data-i18n]')) setText(el, el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-attr]')) setAttrs(el);
  }

  // Switch language; `persist` only for an explicit choice by the user.
  function set(l, persist = false) {
    if (!(l = valid(l))) return;
    if (persist) { try { localStorage.setItem(KEY, l); } catch {} }
    if (l === lang) return;
    lang = l;
    apply();
    for (const fn of handlers) fn(lang);
  }

  // Other panes follow: same-origin `storage` event, or the home page's message when storage is unavailable.
  window.addEventListener('storage', (e) => { if (e.key === KEY) set(stored() || detect()); });
  window.addEventListener('message', (e) => {
    if (window.parent !== window && e.source === window.parent && e.data?.type === 'cmd' && e.data.action === 'lang') set(e.data.value);
  });

  window.I18N = {
    LANGS,
    get lang() { return lang; },
    // Called once by each strings.js; translates the page right away, before app.js runs.
    add(d) { for (const l of Object.keys(d)) if (dict[l]) Object.assign(dict[l], d[l]); apply(); },
    set,
    apply,
    onChange(fn) { handlers.push(fn); },
  };
  window.t = t;
})();
