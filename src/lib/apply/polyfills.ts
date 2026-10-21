/**
 * Stand-ins for JavaScript built-ins newer than the server's Chromium 93,
 * loaded into every page and frame before the site's own scripts. Sites ship
 * code that assumes them; without them the page's app crashes and the form
 * never renders (Ashby: "n.findLast is not a function", Chrome 97+).
 *
 * Each one is only defined when missing, so a current browser is untouched.
 * They follow the spec closely enough for normal use; they can't add new
 * syntax or CSS (e.g. :has()), only missing functions. Must itself parse on
 * Chrome 93: no newer syntax in here.
 */
export const POLYFILL_SCRIPT = String.raw`(() => {
  const define = (target, name, value) => {
    if (!target || typeof target[name] !== "undefined") return;
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  };
  const toLen = (o) => Math.max(0, Math.min(Number(o.length) || 0, Number.MAX_SAFE_INTEGER));
  const relIndex = (i, len) => { i = Math.trunc(Number(i)) || 0; return i < 0 ? Math.max(len + i, 0) : Math.min(i, len); };

  // Array.prototype.findLast / findLastIndex (Chrome 97), also on typed arrays.
  const TypedArrayProto = Object.getPrototypeOf(Int8Array.prototype);
  for (const proto of [Array.prototype, TypedArrayProto]) {
    define(proto, "findLast", function (fn, thisArg) {
      for (let i = toLen(this) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i];
      return undefined;
    });
    define(proto, "findLastIndex", function (fn, thisArg) {
      for (let i = toLen(this) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i;
      return -1;
    });
  }

  // Copying array methods (Chrome 110).
  define(Array.prototype, "toReversed", function () { return Array.from(this).reverse(); });
  define(Array.prototype, "toSorted", function (cmp) {
    if (cmp !== undefined && typeof cmp !== "function") throw new TypeError("The comparison function must be either a function or undefined");
    return Array.from(this).sort(cmp);
  });
  define(Array.prototype, "toSpliced", function (start, skip) {
    const copy = Array.from(this);
    const args = Array.prototype.slice.call(arguments);
    if (args.length === 0) return copy;
    if (args.length === 1) { copy.splice(relIndex(start, copy.length)); return copy; }
    copy.splice.apply(copy, [relIndex(start, copy.length), skip].concat(args.slice(2)));
    return copy;
  });
  define(Array.prototype, "with", function (index, value) {
    const copy = Array.from(this);
    let i = Math.trunc(Number(index)) || 0;
    if (i < 0) i += copy.length;
    if (i < 0 || i >= copy.length) throw new RangeError("Invalid index : " + index);
    copy[i] = value;
    return copy;
  });

  // Grouping (Chrome 117).
  define(Object, "groupBy", function (items, fn) {
    const out = Object.create(null);
    let i = 0;
    for (const item of items) { const k = fn(item, i++); (out[k] = out[k] || []).push(item); }
    return out;
  });
  define(Map, "groupBy", function (items, fn) {
    const out = new Map();
    let i = 0;
    for (const item of items) { const k = fn(item, i++); if (!out.has(k)) out.set(k, []); out.get(k).push(item); }
    return out;
  });

  // Promise.withResolvers (Chrome 119).
  define(Promise, "withResolvers", function () {
    let resolve, reject;
    const promise = new this((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  });

  // Set methods (Chrome 122).
  const keysOf = (other) => (other instanceof Set || other instanceof Map ? Array.from(other.keys()) : Array.from(other.keys ? other.keys() : other));
  define(Set.prototype, "union", function (o) { const s = new Set(this); for (const k of keysOf(o)) s.add(k); return s; });
  define(Set.prototype, "intersection", function (o) { const ks = new Set(keysOf(o)); return new Set(Array.from(this).filter((k) => ks.has(k))); });
  define(Set.prototype, "difference", function (o) { const ks = new Set(keysOf(o)); return new Set(Array.from(this).filter((k) => !ks.has(k))); });
  define(Set.prototype, "symmetricDifference", function (o) {
    const s = new Set(this);
    for (const k of keysOf(o)) { if (this.has(k)) s.delete(k); else s.add(k); }
    return s;
  });
  define(Set.prototype, "isSubsetOf", function (o) { const ks = new Set(keysOf(o)); return Array.from(this).every((k) => ks.has(k)); });
  define(Set.prototype, "isSupersetOf", function (o) { return keysOf(o).every((k) => this.has(k)); });
  define(Set.prototype, "isDisjointFrom", function (o) { return keysOf(o).every((k) => !this.has(k)); });

  // Well-formed strings (Chrome 111).
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
  define(String.prototype, "isWellFormed", function () { return !LONE.test(String(this)); });
  define(String.prototype, "toWellFormed", function () {
    return String(this).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|([^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, (m, before) => (before === undefined ? "�" : before + "�"));
  });

  // structuredClone (Chrome 98): deep copy of plain data, dates, regexps, maps, sets, typed arrays; keeps cycles.
  define(globalThis, "structuredClone", function (value) {
    const seen = new Map();
    const copy = (v) => {
      if (v === null || typeof v !== "object") {
        if (typeof v === "function" || typeof v === "symbol") throw new DOMException("could not be cloned", "DataCloneError");
        return v;
      }
      if (seen.has(v)) return seen.get(v);
      let out;
      if (v instanceof Date) out = new Date(v.getTime());
      else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
      else if (v instanceof ArrayBuffer) out = v.slice(0);
      else if (ArrayBuffer.isView(v)) out = new v.constructor(v.buffer.slice(0), v.byteOffset, v.length);
      else if (v instanceof Map) { out = new Map(); seen.set(v, out); v.forEach((val, k) => out.set(copy(k), copy(val))); return out; }
      else if (v instanceof Set) { out = new Set(); seen.set(v, out); v.forEach((k) => out.add(copy(k))); return out; }
      else if (Array.isArray(v)) { out = []; seen.set(v, out); v.forEach((x, i) => { out[i] = copy(x); }); return out; }
      else if (typeof Blob !== "undefined" && v instanceof Blob) return v;
      else { out = {}; seen.set(v, out); for (const k of Object.keys(v)) out[k] = copy(v[k]); return out; }
      seen.set(v, out);
      return out;
    };
    return copy(value);
  });

  // Array.prototype.at (Chrome 92) and Object.hasOwn (Chrome 93): present on 93, here for anything older.
  for (const proto of [Array.prototype, String.prototype, TypedArrayProto]) {
    define(proto, "at", function (i) { const len = this.length; let k = Math.trunc(Number(i)) || 0; if (k < 0) k += len; return k < 0 || k >= len ? undefined : this[k]; });
  }
  define(Object, "hasOwn", function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); });
})()`;
