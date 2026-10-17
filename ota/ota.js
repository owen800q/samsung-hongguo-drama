// Over-the-air updates for the packaged TV app. index.html in the widget is a
// loader: it writes in either the build shipped inside the widget (app/) or a
// newer build that a previous launch downloaded from the Worker. Checking for
// updates happens in the background after the app is up and never during
// playback; a downloaded build is used from the next launch.
// Written in ES5: Tizen 4.0 TVs run Chromium 56.
(function () {
  'use strict';
  var C = window.__OTA_CONFIG__;
  var KEY = '__ota:' + C.key;
  var CHECK_DELAY = 10000;        // after the page has loaded
  var RECHECK_AFTER = 3 * 3600e3; // when the app returns to the foreground
  var HEALTHY_AFTER = 5000;       // after load: a launch that lasts this long counts as working
  var MAX_FAILED_LAUNCHES = 3;
  var RETRY_BAD_AFTER = 24 * 3600e3;

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch (e) { return false; } }

  var state = load();
  var bundled = { id: C.id, base: 'app/', head: C.head, body: C.body, bodyAttrs: C.bodyAttrs };
  var run = bundled;
  var ready = state.ready;
  if (ready && ready.id !== C.id && ready.id !== state.bad) {
    // A build that keeps ending its launches early (crash, blank screen) is dropped for the bundled one.
    if ((state.tries || 0) >= MAX_FAILED_LAUNCHES) {
      state.bad = ready.id;
      state.badAt = Date.now();
      state.ready = null;
      state.tries = 0;
    } else {
      run = ready;
      state.tries = (state.tries || 0) + 1;
    }
    save(state);
  }
  var remote = run !== bundled;

  if (remote) {
    // A file of the downloaded build that cannot load (cache evicted while offline): start the bundled build instead.
    // Only the build's own files count, not ones the runtime injects.
    var fellBack = false;
    window.addEventListener('error', function (e) {
      var el = e.target;
      var tag = el && el.tagName;
      var url = tag === 'SCRIPT' ? el.src : tag === 'LINK' ? el.href : '';
      if (fellBack || !url || url.indexOf(run.base) !== 0) return;
      if (run.files && run.files.indexOf(url.slice(run.base.length).split(/[?#]/)[0]) < 0) return;
      fellBack = true;
      var s = load();
      s.ready = null;
      s.tries = 0;
      save(s);
      location.reload();
    }, true);
  }

  window.__ota = { running: run.id, bundled: C.id, remote: remote, check: function (cb) { check(true, cb); } };
  document.write('<base href="' + run.base + '">' + run.head + '</head><body' + run.bodyAttrs + '>' + run.body);

  window.addEventListener('load', function () {
    setTimeout(function () {
      var s = load();
      if (s.tries) { s.tries = 0; save(s); }
    }, HEALTHY_AFTER);
    setTimeout(auto, CHECK_DELAY);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - (load().checked || 0) > RECHECK_AFTER) auto();
  });

  function playing() {
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) if (!videos[i].paused && !videos[i].ended) return true;
    return false;
  }

  var busy = false;
  function auto() {
    if (playing()) { setTimeout(auto, 60000); return; }
    check(false);
  }

  function get(url, type, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = type;
    xhr.timeout = 60000;
    xhr.onload = function () { cb(xhr.status === 200 ? xhr.response : null); };
    xhr.onerror = xhr.ontimeout = function () { cb(null); };
    xhr.send();
  }

  // cb(result): 'current', 'downloaded', 'pending' (downloaded earlier, applies on restart),
  // 'off' (widget packaged without updates), 'busy' or 'error'.
  function check(manual, cb) {
    cb = cb || function () {};
    if (!C.manifest) return cb('off');
    if (busy) return cb('busy');
    if (navigator.onLine === false) return cb('error');
    busy = true;
    function done(result) { busy = false; cb(result); }
    get(C.manifest + '?t=' + Date.now(), 'text', function (text) {
      var m;
      try { m = JSON.parse(text); } catch (e) { m = null; }
      if (!m || !m.id || !m.files) return done('error');
      var s = load();
      s.checked = Date.now();
      save(s);
      if (m.id === C.id) {
        // The Worker serves the bundled build again (rollback or reinstall): drop any downloaded build.
        if (s.ready) { s.ready = null; s.tries = 0; save(s); }
        return done(run.id === m.id ? 'current' : 'pending');
      }
      if (m.id === run.id) {
        if (s.ready && s.ready.id !== m.id) { s.ready = remote ? run : null; s.tries = 0; save(s); }
        return done('current');
      }
      if (s.ready && s.ready.id === m.id) return done('pending');
      if (m.id === s.bad && !manual && Date.now() - (s.badAt || 0) < RETRY_BAD_AFTER) return done('current');
      var base = C.manifest.replace(/[^\/]*$/, '') + 'v/' + m.id + '/';
      var i = 0;
      (function next() {
        if (i === m.files.length) {
          var s2 = load();
          var paths = [];
          for (var j = 0; j < m.files.length; j++) paths.push(m.files[j].path);
          s2.ready = { id: m.id, base: base, head: m.head, body: m.body, bodyAttrs: m.bodyAttrs || '', files: paths };
          s2.tries = 0;
          if (s2.bad === m.id) s2.bad = null;
          if (!save(s2)) return done('error');
          if (!manual) toast(C.text);
          return done('downloaded');
        }
        var f = m.files[i++];
        // Fetching the file fills the HTTP cache (immutable, a year) that the next launch loads from.
        get(base + f.path, 'arraybuffer', function (buf) {
          if (!buf || buf.byteLength !== f.size) return done('error');
          next();
        });
      })();
    });
  }

  function toast(text) {
    if (!text || !document.body) return;
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;right:48px;bottom:48px;z-index:2147483647;padding:16px 28px;border-radius:12px;' +
      'background:rgba(20,20,28,.92);color:#fff;font:28px/1.4 sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
  }
})();
