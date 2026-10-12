// Thin wrappers over Tizen/Samsung platform APIs; every call is a no-op in a desktop browser.
export function exitApp() {
  try { window.tizen.application.getCurrentApplication().exit(); return; } catch (_) {}
  try { window.close(); } catch (_) {}
}

/** Keep the TV screensaver away while a video plays. */
export function setScreenSaver(enabled) {
  try {
    const api = window.webapis && window.webapis.appcommon;
    if (!api) return;
    api.setScreenSaver(enabled ? api.AppCommonScreenSaverState.SCREEN_SAVER_ON : api.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
  } catch (_) {}
}

export function onVisibilityChange(handler) {
  document.addEventListener('visibilitychange', () => handler(document.hidden));
}

export function appVersion() {
  try { return window.tizen.application.getCurrentApplication().appInfo.version; } catch (_) { return __APP_VERSION__; }
}
