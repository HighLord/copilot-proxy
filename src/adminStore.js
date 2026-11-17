'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { defaultAdminSettings } = require('./defaults');
const { writeJsonAtomicSync, readJsonSync } = require('./fsUtil');
const { ValidationError, checkString, checkStringList, checkPlainObject } = require('./validate');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
const ADMIN_FILE = path.join(config.DATA_DIR, 'admin.json');

const MODE_IDS = ['quick', 'deep'];
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_STARTERS = 8;

function sanitizeMode(input, current, id) {
  if (input === null || typeof input !== 'object') throw new ValidationError(`modes.${id} must be an object`);
  const next = { ...current };
  if ('label' in input) next.label = checkString(input.label, 40, `modes.${id}.label`, { allowEmpty: false }).trim();
  if ('description' in input) next.description = checkString(input.description, 120, `modes.${id}.description`).trim();
  if ('prompt' in input) next.prompt = checkString(input.prompt, 1_500, `modes.${id}.prompt`);
  if ('addOptionsSets' in input) next.addOptionsSets = checkStringList(input.addOptionsSets, `modes.${id}.addOptionsSets`);
  if ('removeOptionsSets' in input) next.removeOptionsSets = checkStringList(input.removeOptionsSets, `modes.${id}.removeOptionsSets`);
  for (const key of ['argOverrides', 'messageOverrides', 'urlParams']) {
    if (key in input) next[key] = checkPlainObject(input[key], `modes.${id}.${key}`);
  }
  if ('timeoutMs' in input) {
    const ms = Number(input.timeoutMs);
    if (!Number.isFinite(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
      throw new ValidationError(`modes.${id}.timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    }
    next.timeoutMs = Math.round(ms);
  }
  return next;
}

function sanitizeStarters(list) {
  if (!Array.isArray(list) || list.length > MAX_STARTERS) {
    throw new ValidationError(`starters must be a list of at most ${MAX_STARTERS} items`);
  }
  return list.map((item, index) => ({
    label: checkString(item?.label, 30, `starters[${index}].label`, { allowEmpty: false }).trim(),
    icon: typeof item.icon === 'string' ? item.icon.slice(0, 20) : '',
    prompt: checkString(item?.prompt, 1_000, `starters[${index}].prompt`),
  }));
}

let admin = null;

function loadAdmin() {
  const defaults = defaultAdminSettings();
  const stored = readJsonSync(ADMIN_FILE, {});
  const merged = { ...defaults, ...stored, modes: {} };
  for (const id of MODE_IDS) merged.modes[id] = { ...defaults.modes[id], ...(stored.modes?.[id] ?? {}) };
  if (!merged.modes[merged.defaultMode]) merged.defaultMode = defaults.defaultMode;
  return merged;
}

function getAdmin() {
  admin ??= loadAdmin();
  return admin;
}

function updateAdmin(input) {
  if (input === null || typeof input !== 'object') throw new ValidationError('Body must be a JSON object');
  const next = structuredClone(getAdmin());
  if ('appName' in input) next.appName = checkString(input.appName, 40, 'appName', { allowEmpty: false }).trim();
  if ('systemPrompt' in input) next.systemPrompt = checkString(input.systemPrompt, config.MAX_SYSTEM_PROMPT_CHARS, 'systemPrompt');
  if ('defaultMode' in input) {
    if (!MODE_IDS.includes(input.defaultMode)) throw new ValidationError('defaultMode must be "quick" or "deep"');
    next.defaultMode = input.defaultMode;
  }
  if ('modes' in input) {
    if (input.modes === null || typeof input.modes !== 'object') throw new ValidationError('modes must be an object');
    for (const id of Object.keys(input.modes)) {
      if (!MODE_IDS.includes(id)) throw new ValidationError(`Unknown mode "${id}"`);
      next.modes[id] = sanitizeMode(input.modes[id], next.modes[id], id);
    }
  }
  if ('starters' in input) next.starters = sanitizeStarters(input.starters);
  writeJsonAtomicSync(ADMIN_FILE, next);
  admin = next;
  return admin;
}

function resetAdmin() {
  admin = defaultAdminSettings();
  writeJsonAtomicSync(ADMIN_FILE, admin);
  return admin;
}

module.exports = { ValidationError, getAdmin, updateAdmin, resetAdmin };
