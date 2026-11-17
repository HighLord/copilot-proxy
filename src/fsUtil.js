'use strict';

const fs = require('fs');
const { randomUUID } = require('crypto');

// Write to a temp file then rename, so a crash mid-write never leaves a half-written JSON file.
function writeJsonAtomicSync(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.promises.rename(tmp, file);
}

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Could not read ${file}: ${error.message}`);
    return fallback;
  }
}

module.exports = { writeJsonAtomicSync, writeJsonAtomic, readJsonSync };
