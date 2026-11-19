'use strict';

// Microsoft TSS (Type Structure Serialization) codec, reverse-engineered from captured
// copilot.cloud.microsoft /_serverFn traffic. Used for the chat-history serverFn calls that are
// NOT carried over the Chathub WebSocket (e.g. deleting a conversation).
//
// Type tags observed on the wire:
//   t:0  int64  -> { t: 0, s: "<decimal string>" }   (JS cannot hold 64-bit ints)
//   t:1  string -> { t: 1, s: "..." }
//   t:2  int32  -> { t: 2, s: <number> }              (also used for small flags/enums)
//   t:9  array  -> { t: 9, i: <idx>, a: [ ... ], o: 0 }
//   t:10 struct -> { t: 10, i: <idx>, p: { k: [ ... ], v: [ ... ] }, o: 0 }
//
// `i` is a per-tree unique node index; the captured traffic never back-references a node, so
// sequential indices are safe. `o` is always 0 in the traffic we reproduce.

function encode(value, state = { index: 0 }) {
  if (value === null || value === undefined) return { t: 1, s: '' };
  const type = typeof value;
  if (type === 'string') return { t: 1, s: value };
  if (type === 'boolean') return { t: 2, s: value ? 1 : 0 };
  if (type === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) return { t: 2, s: value };
    return { t: 0, s: String(value) };
  }
  if (Array.isArray(value)) {
    return { t: 9, i: state.index++, a: value.map((item) => encode(item, state)), o: 0 };
  }
  if (value && type === 'object') {
    const keys = Object.keys(value);
    return { t: 10, i: state.index++, p: { k: keys, v: keys.map((key) => encode(value[key], state)) }, o: 0 };
  }
  return { t: 1, s: String(value) };
}

function decode(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  switch (node.t) {
    case 0:
    case 1:
    case 2:
      return node.s;
    case 9:
      return (node.a ?? []).map(decode);
    case 10: {
      const out = {};
      const keys = node.p?.k ?? [];
      const values = node.p?.v ?? [];
      for (let i = 0; i < keys.length; i += 1) out[keys[i]] = decode(values[i]);
      return out;
    }
    default:
      return node;
  }
}

// Every /_serverFn request and response is wrapped as { t: <struct>, f: 127, m: [] } where the
// struct carries a single "data" key pointing at the payload object.
function wrapData(data) {
  return { t: encode({ data }, { index: 0 }), f: 127, m: [] };
}

module.exports = { encode, decode, wrapData };
