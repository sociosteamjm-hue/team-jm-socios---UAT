(function () {
  'use strict';

  var STORAGE_KEY = 'team-jm-color-theme';
  var root = document.documentElement;
  var media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  function storedTheme() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === 'dark' || value === 'light' ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function systemTheme() {
    return media && media.matches ? 'dark' : 'light';
  }

  function updateControl(theme) {
    var button = document.getElementById('theme-toggle');
    var label = document.getElementById('theme-toggle-label');
    if (!button) return;
    var isDark = theme === 'dark';
    var nextLabel = isDark ? 'Modo claro' : 'Modo escuro';
    var accessibleLabel = isDark ? 'Ativar modo claro' : 'Ativar modo escuro';
    button.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    button.setAttribute('aria-label', accessibleLabel);
    button.title = accessibleLabel;
    if (label) label.textContent = nextLabel;
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    var themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === 'dark' ? '#091520' : '#102a43';
    updateControl(theme);
  }

  function saveTheme(theme) {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (_error) {
      // The selected theme still applies for this page when storage is blocked.
    }
  }

  function toggleTheme() {
    var nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    saveTheme(nextTheme);
  }

  applyTheme(storedTheme() || systemTheme());

  document.addEventListener('DOMContentLoaded', function () {
    updateControl(root.dataset.theme || systemTheme());
    var button = document.getElementById('theme-toggle');
    if (button) button.addEventListener('click', toggleTheme);
  }, { once: true });

  if (media) {
    var followSystemTheme = function (event) {
      if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', followSystemTheme);
    } else if (typeof media.addListener === 'function') {
      media.addListener(followSystemTheme);
    }
  }
}());
