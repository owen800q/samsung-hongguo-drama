// Language features newer than Chromium 56 (Tizen 4.0) that the app relies on.
// esbuild lowers syntax; these fill in the missing library methods.
/* eslint-disable no-extend-native */
if (!Array.prototype.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true, writable: true,
    value: function flat(depth) {
      const d = depth === undefined ? 1 : Number(depth);
      return d < 1 ? this.slice() : this.reduce((acc, v) => acc.concat(Array.isArray(v) ? v.flat(d - 1) : v), []);
    },
  });
}
if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true, writable: true,
    value: function flatMap(fn, thisArg) { return this.map(fn, thisArg).flat(1); },
  });
}
if (!Object.fromEntries) {
  Object.fromEntries = (entries) => {
    const out = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  };
}
if (!String.prototype.matchAll) {
  Object.defineProperty(String.prototype, 'matchAll', {
    configurable: true, writable: true,
    value: function matchAll(re) {
      const flags = re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g';
      const rx = new RegExp(re.source, flags);
      const out = [];
      let m;
      while ((m = rx.exec(this)) !== null) {
        out.push(m);
        if (m[0] === '') rx.lastIndex++;
      }
      return out[Symbol.iterator]();
    },
  });
}
if (!Promise.prototype.finally) {
  Object.defineProperty(Promise.prototype, 'finally', {
    configurable: true, writable: true,
    value: function (fn) {
      return this.then(v => Promise.resolve(fn()).then(() => v), e => Promise.resolve(fn()).then(() => { throw e; }));
    },
  });
}
if (!String.prototype.padStart) {
  String.prototype.padStart = function (len, fill) {
    let s = String(this);
    const f = fill === undefined ? ' ' : String(fill);
    while (s.length < len) s = f + s;
    return s.slice(s.length - Math.max(len, String(this).length));
  };
}
if (typeof String.fromCodePoint !== 'function') {
  String.fromCodePoint = (...codes) => codes.map(c => {
    if (c <= 0xffff) return String.fromCharCode(c);
    const v = c - 0x10000;
    return String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
  }).join('');
}
