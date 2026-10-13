/*
 * Runs before anything else, as a classic script (the Content-Security-Policy
 * allows no inline script). Three jobs, all of which must happen before the
 * first paint:
 *
 *   1. choose the theme, so no frame is ever drawn in the wrong one;
 *   2. stamp the language and layout class the launch screen needs;
 *   3. own the launch screen: take it down when the app says it has painted,
 *      and replace it with an honest error screen when start-up fails.
 *
 * Keep it small and dependency-free. The app talks to it through
 * `window.__studioBoot`; see src/shell/launch.ts.
 */
(function () {
  'use strict';
  var doc = document;
  var root = doc.documentElement;
  var THEME_KEY = 'studio.theme';
  var LANG_KEY = 'studio.language';
  var THEME_COLORS = { light: '#f3f1ec', dark: '#100f0e' };

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  // ---- 1. theme ----------------------------------------------------------
  var saved = read(THEME_KEY);
  var preference = saved === 'light' || saved === 'dark' ? saved : 'auto';
  var systemDark = false;
  try {
    systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (_error) {
    /* very old browser: stay light */
  }
  var theme = preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-preference', preference);
  var meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[theme]);

  // ---- 2. language, layout class, installed-app flag -----------------------
  var language = read(LANG_KEY);
  if (language !== 'en' && language !== 'zh-CN') {
    var wanted = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])
      .join(',')
      .toLowerCase();
    var firstZh = wanted.indexOf('zh');
    var firstEn = wanted.indexOf('en');
    language = firstZh !== -1 && (firstEn === -1 || firstZh < firstEn) ? 'zh-CN' : 'en';
  }
  root.setAttribute('lang', language);

  var width = window.innerWidth || root.clientWidth || 0;
  root.setAttribute('data-layout', width <= 699 ? 'phone' : width <= 1023 ? 'tablet' : 'wide');

  var standalone = false;
  try {
    standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  } catch (_error) {
    /* ignore */
  }
  if (standalone) {
    var apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    root.setAttribute('data-standalone', apple ? 'ios' : 'yes');
  }

  // ---- 3. launch screen and launch error ---------------------------------
  var ready = false;
  var failed = false;

  function launchElement() {
    return doc.getElementById('launch');
  }

  function removeLaunch(immediately) {
    var element = launchElement();
    if (!element) return;
    if (immediately || doc.visibilityState === 'hidden') {
      element.remove();
      return;
    }
    element.setAttribute('data-leaving', '');
    var done = function () {
      element.remove();
    };
    element.addEventListener('transitionend', done);
    window.setTimeout(done, 400);
  }

  function fail(kind) {
    if (failed) return;
    failed = true;
    var panel = doc.getElementById('launch-error');
    if (!panel) return;
    panel.setAttribute('data-kind', kind === 'download' ? 'download' : 'crash');
    panel.hidden = false;
    removeLaunch(true);
    var app = doc.getElementById('root');
    if (app) app.setAttribute('hidden', '');
  }

  // A script or stylesheet that will not download fires `error` on the element
  // (it does not bubble, hence the capture listener). Anything thrown before
  // the first screen is up is a crash: the app's own error boundaries are not
  // mounted yet, so nobody else would tell the user.
  window.addEventListener(
    'error',
    function (event) {
      if (ready) return;
      var target = event.target;
      if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
        if (target.tagName === 'LINK' && target.rel !== 'stylesheet' && target.rel !== 'modulepreload') return;
        fail('download');
        return;
      }
      if (target === window) fail('crash');
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (event) {
    if (ready) return;
    var reason = event.reason;
    var text = reason && reason.message ? String(reason.message) : '';
    fail(/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(text) ? 'download' : 'crash');
  });

  window.__studioBoot = {
    theme: theme,
    themePreference: preference,
    language: language,
    /** The first real screen has painted: the launch screen can go. */
    ready: function () {
      if (ready || failed) return;
      ready = true;
      removeLaunch(false);
    },
    /** Start-up cannot continue. `kind` is "crash" or "download". */
    fail: fail,
    isReady: function () {
      return ready;
    },
  };
})();
