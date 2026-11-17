'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const NOOP = Object.freeze({ file: null, log() {}, close() {} });

/**
 * One JSONL file per Copilot request when COPILOT_DEBUG_FRAMES=1.
 * Used to see exactly what a mode sends and what Copilot streams back.
 */
function createDebugLog(label) {
  if (!config.DEBUG_FRAMES) return NOOP;
  const dir = path.join(config.DATA_DIR, 'debug');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', (error) => console.error(`Debug log write failed: ${error.message}`));
  let closed = false;
  return {
    file,
    log(direction, payload) {
      if (closed) return;
      stream.write(`${JSON.stringify({ t: new Date().toISOString(), dir: direction, payload })}\n`);
    },
    close() {
      closed = true;
      stream.end();
    },
  };
}

module.exports = { createDebugLog };
