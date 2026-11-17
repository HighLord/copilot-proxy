'use strict';

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const MAX_LIST_ITEMS = 200;
const MAX_JSON_CHARS = 20_000;

function checkString(value, max, field, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  if (!allowEmpty && value.trim() === '') throw new ValidationError(`${field} must not be empty`);
  return value;
}

function checkStringList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new ValidationError(`${field} must be a list of at most ${MAX_LIST_ITEMS} strings`);
  }
  return value.map((item) => checkString(item, 200, field).trim()).filter(Boolean);
}

function checkPlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${field} must be a JSON object`);
  }
  if (JSON.stringify(value).length > MAX_JSON_CHARS) {
    throw new ValidationError(`${field} is too large`);
  }
  return JSON.parse(JSON.stringify(value));
}

module.exports = { ValidationError, checkString, checkStringList, checkPlainObject };
