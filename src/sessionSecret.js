'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DIR = path.join(config.DATA_DIR, 'auth');
fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'secret');

let secret = null;

// One random secret per install, persisted so browser sessions survive server restarts.
function load() {
  if (secret) return secret;
  try {
    const stored = fs.readFileSync(FILE, 'utf8').trim();
    if (stored.length >= 32) {
      secret = stored;
      return secret;
    }
  } catch { /* fall through and generate */ }
  secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(FILE, secret);
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', load()).update(String(value)).digest('hex');
}

function verify(value, signature) {
  const expected = sign(value);
  const a = Buffer.from(String(signature), 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify };
