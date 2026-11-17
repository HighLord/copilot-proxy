'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const config = require('./config');
const { defaultUserData } = require('./defaults');
const { writeJsonAtomicSync, readJsonSync } = require('./fsUtil');
const { ValidationError, checkString } = require('./validate');

// Deterministic, filesystem-safe folder name for an email address.
function userKey(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

const ROOT = path.join(config.DATA_DIR, 'users');
fs.mkdirSync(ROOT, { recursive: true });

function dirFor(email) {
  const dir = path.join(ROOT, userKey(email));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(email) {
  return path.join(dirFor(email), 'user.json');
}

const cache = new Map();

function getUser(email) {
  const key = String(email).trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const user = { ...defaultUserData(), ...readJsonSync(fileFor(key), {}) };
  cache.set(key, user);
  return user;
}

function saveUser(email) {
  writeJsonAtomicSync(fileFor(email), getUser(email));
}

function updatePreferences(email, input) {
  if (input === null || typeof input !== 'object') throw new ValidationError('Body must be a JSON object');
  const current = getUser(email);
  if ('displayName' in input) current.displayName = checkString(input.displayName, 60, 'displayName').trim();
  if ('customInstructions' in input) {
    current.customInstructions = checkString(input.customInstructions, config.MAX_CUSTOM_INSTRUCTIONS_CHARS, 'customInstructions');
  }
  if ('memoryEnabled' in input) {
    if (typeof input.memoryEnabled !== 'boolean') throw new ValidationError('memoryEnabled must be true or false');
    current.memoryEnabled = input.memoryEnabled;
  }
  saveUser(email);
  return publicPreferences(email);
}

function publicPreferences(email) {
  const { displayName, customInstructions, memoryEnabled } = getUser(email);
  return { displayName, customInstructions, memoryEnabled };
}

function listMemories(email) {
  return getUser(email).memories;
}

function addMemory(email, text) {
  const current = getUser(email);
  const clean = checkString(text, config.MAX_MEMORY_CHARS, 'text', { allowEmpty: false }).trim();
  if (current.memories.length >= config.MAX_MEMORY_ITEMS) {
    throw new ValidationError(`You can store at most ${config.MAX_MEMORY_ITEMS} memories`);
  }
  const now = new Date().toISOString();
  const memory = { id: randomUUID(), text: clean, createdAt: now, updatedAt: now };
  current.memories.push(memory);
  saveUser(email);
  return memory;
}

function updateMemory(email, id, text) {
  const memory = getUser(email).memories.find((item) => item.id === id);
  if (!memory) return null;
  memory.text = checkString(text, config.MAX_MEMORY_CHARS, 'text', { allowEmpty: false }).trim();
  memory.updatedAt = new Date().toISOString();
  saveUser(email);
  return memory;
}

function deleteMemory(email, id) {
  const current = getUser(email);
  const before = current.memories.length;
  current.memories = current.memories.filter((item) => item.id !== id);
  if (current.memories.length === before) return false;
  saveUser(email);
  return true;
}

function clearMemories(email) {
  getUser(email).memories = [];
  saveUser(email);
}

module.exports = {
  ValidationError,
  userKey,
  getUser, publicPreferences, updatePreferences,
  listMemories, addMemory, updateMemory, deleteMemory, clearMemories,
};
