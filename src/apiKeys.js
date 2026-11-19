'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { writeJsonAtomicSync, readJsonSync } = require('./fsUtil');
const { ValidationError, checkString } = require('./validate');

// Keys let an external tool use a signed-in person's Copilot session, so they are treated like passwords:
// only a SHA-256 hash is stored, and the plain key is shown once, when it is created.
const KEY_PREFIX = 'cpk_';
const KEY_RANDOM_BYTES = 32;
const SHOWN_PREFIX_CHARS = 8;
const MAX_LABEL_CHARS = 60;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

const DIR = path.join(config.DATA_DIR, 'auth');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'apikeys.json');

let records = null;
let byHash = null;

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

function load() {
  if (records) return;
  const stored = readJsonSync(FILE, { keys: [] });
  records = Array.isArray(stored.keys) ? stored.keys : [];
  byHash = new Map(records.map((record) => [record.hash, record]));
}

function persist() {
  writeJsonAtomicSync(FILE, { keys: records });
}

function publicView(record) {
  return {
    id: record.id,
    label: record.label,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function createKey(email, label) {
  load();
  const owner = String(email).trim().toLowerCase();
  const cleanLabel = checkString(label ?? '', MAX_LABEL_CHARS, 'label').trim() || 'Untitled key';
  if (records.filter((record) => record.email === owner).length >= config.API_MAX_KEYS_PER_USER) {
    throw new ValidationError(`You can have at most ${config.API_MAX_KEYS_PER_USER} API keys. Revoke one first.`);
  }
  const key = KEY_PREFIX + crypto.randomBytes(KEY_RANDOM_BYTES).toString('base64url');
  const record = {
    id: crypto.randomUUID(),
    email: owner,
    label: cleanLabel,
    prefix: key.slice(0, SHOWN_PREFIX_CHARS),
    hash: hashKey(key),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  records.push(record);
  byHash.set(record.hash, record);
  persist();
  return { key, ...publicView(record) };
}

function listKeys(email) {
  load();
  const owner = String(email).trim().toLowerCase();
  return records.filter((record) => record.email === owner).map(publicView);
}

function revokeKey(email, id) {
  load();
  const owner = String(email).trim().toLowerCase();
  const index = records.findIndex((record) => record.id === id && record.email === owner);
  if (index < 0) return false;
  byHash.delete(records[index].hash);
  records.splice(index, 1);
  persist();
  return true;
}

// Returns { email, id, label } for a valid key, otherwise null.
function authenticate(presented) {
  load();
  const text = String(presented ?? '').trim();
  if (!text.startsWith(KEY_PREFIX)) return null;
  const record = byHash.get(hashKey(text));
  if (!record) return null;
  const now = Date.now();
  // Not written on every request: a busy harness would otherwise rewrite the file constantly.
  if (!record.lastUsedAt || now - Date.parse(record.lastUsedAt) > LAST_USED_WRITE_INTERVAL_MS) {
    record.lastUsedAt = new Date(now).toISOString();
    persist();
  }
  return { email: record.email, id: record.id, label: record.label };
}

module.exports = { createKey, listKeys, revokeKey, authenticate, KEY_PREFIX };
