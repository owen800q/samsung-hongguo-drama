// Samsung remote key codes. Arrow/Enter/Back are always delivered; media, colour
// and number keys must be registered through tizen.tvinputdevice first.
export const KEY = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
  BACK: 10009, ESCAPE: 27, BACKSPACE: 8,
  PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, STOP: 413,
  FAST_FORWARD: 417, REWIND: 412, NEXT: 10233, PREVIOUS: 10232,
  CHANNEL_UP: 427, CHANNEL_DOWN: 428,
  RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
  INFO: 457,
  IME_DONE: 65376, IME_CANCEL: 65385,
};

const TIZEN_KEYS = [
  'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
  'MediaTrackNext', 'MediaTrackPrevious', 'ChannelUp', 'ChannelDown',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

export function registerRemoteKeys() {
  const input = window.tizen && window.tizen.tvinputdevice;
  if (!input) return;
  const oneByOne = () => TIZEN_KEYS.forEach(name => { try { input.registerKey(name); } catch (e) {} });
  try {
    // registerKeyBatch rejects the whole batch if one name is unknown, so filter first.
    const supported = input.getSupportedKeys().map(k => k.name);
    const wanted = TIZEN_KEYS.filter(name => supported.indexOf(name) >= 0);
    // Samsung's web simulator reports different names (KEY_PLAY, ...): fall back to one by one.
    if (!wanted.length) oneByOne();
    else if (input.registerKeyBatch) input.registerKeyBatch(wanted);
    else wanted.forEach(name => input.registerKey(name));
  } catch (_) {
    oneByOne();
  }
}

/** Normalise a keydown into a logical action; desktop keys stand in for remote keys in dev. */
export function actionOf(e) {
  switch (e.keyCode) {
    case KEY.LEFT: return 'left';
    case KEY.RIGHT: return 'right';
    case KEY.UP: return 'up';
    case KEY.DOWN: return 'down';
    case KEY.ENTER: return 'enter';
    case KEY.BACK: case KEY.ESCAPE: return 'back';
    case KEY.BACKSPACE: return isTyping(e) ? null : 'back';
    case KEY.PLAY_PAUSE: return 'playpause';
    case KEY.PLAY: return 'play';
    case KEY.PAUSE: return 'pause';
    case KEY.STOP: return 'stop';
    case KEY.FAST_FORWARD: return 'forward';
    case KEY.REWIND: return 'rewind';
    case KEY.NEXT: case KEY.CHANNEL_UP: return 'next';
    case KEY.PREVIOUS: case KEY.CHANNEL_DOWN: return 'previous';
    case KEY.RED: return 'red';
    case KEY.GREEN: return 'green';
    case KEY.YELLOW: return 'yellow';
    case KEY.BLUE: return 'blue';
    case KEY.INFO: return 'info';
    case KEY.IME_DONE: return 'imedone';
    case KEY.IME_CANCEL: return 'imecancel';
    default: break;
  }
  if (isTyping(e)) return null;
  // Desktop stand-ins: space = play/pause, PageUp/PageDown = previous/next episode.
  if (e.keyCode === 32) return 'playpause';
  if (e.keyCode === 33) return 'previous';
  if (e.keyCode === 34) return 'next';
  if (e.keyCode >= 48 && e.keyCode <= 57) return 'digit' + (e.keyCode - 48);
  return null;
}

export function isTyping(e) {
  const t = e && e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && !t.readOnly;
}
