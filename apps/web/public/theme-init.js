/* global document, window */
(function () {
  var KEY = 'tidings.theme';
  var SIZE_KEY = 'tidings.textSize';
  var BAR = { light: '#ffffff', dark: '#1b1c20' }; // keep equal to --c-surface in both themes
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function read(key) {
    try {
      return localStorage.getItem(key);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      return null;
    }
  }
  function apply() {
    var stored = read(KEY);
    var pref = stored === 'light' || stored === 'dark' ? stored : 'system';
    var theme = pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-theme-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BAR[theme]);
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', theme);
    var size = read(SIZE_KEY);
    root.setAttribute('data-text-size', size === 's' || size === 'l' ? size : 'm');
  }

  apply();
  // Launch screen failsafe (TID-059): if the app never starts (bundle blocked or crashed), do not
  // leave the splash covering the error forever. The app normally removes it much sooner.
  setTimeout(function () {
    var splash = document.getElementById('splash');
    if (splash) splash.remove();
  }, 10000);
  if (mq.addEventListener) mq.addEventListener('change', apply);
  else mq.addListener(apply); // old Safari
  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === SIZE_KEY || e.key === null) apply();
  });
  window.addEventListener('tidings:theme', apply);
})();
