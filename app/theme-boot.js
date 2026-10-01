// Classic synchronous script from <head>: sets data-theme on <html> before the first paint (no
// theme flash). Reads 'czd2.theme' (JSON) and falls back to cZEROde 1's 'czd_theme' when that holds
// a valid theme. settings.js owns every other localStorage access.
(function () {
  'use strict';
  var THEMES = ['gothic', 'minimal-white', 'minimal-black'];
  var COLORS = { gothic: '#0d0d0d', 'minimal-white': '#f5f5f5', 'minimal-black': '#0a0a0a' };
  var theme = 'gothic';
  try {
    var raw = window.localStorage.getItem('czd2.theme');
    var t = raw === null ? null : JSON.parse(raw);
    if (t === null) t = window.localStorage.getItem('czd_theme');
    if (THEMES.indexOf(t) !== -1) theme = t;
  } catch (e) {
    // storage blocked or corrupt: keep the default
  }
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  try {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', COLORS[theme]);
  } catch (e) {
    // ignore
  }
})();
