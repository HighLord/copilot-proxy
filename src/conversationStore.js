'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const { userKey } = require('./userStore');
const { writeJsonAtomic } = require('./fsUtil');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// email (lowercased) -> Map<conversationId, metadata>. Message bodies stay on disk.
const indexes = new Map();
// "${email}\u0000${id}" -> promise chain, serialising read-modify-write cycles per conversation.
const locks = new Map();

function dirFor(email) {
  const dir = path.join(config.DATA_DIR, 'users', userKey(email), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(email, id) {
  // The id is used in a file path, so it must be a UUID before it gets anywhere near the filesystem.
  if (!UUID_PATTERN.test(id)) throw new Error('Invalid conversation id');
  return path.join(dirFor(email), `${id.toLowerCase()}.json`);
}

function metaOf(conv) {
  return {
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    pinned: Boolean(conv.pinned),
    messageCount: conv.messages.length,
  };
}

function indexFor(email) {
  const key = String(email).trim().toLowerCase();
  let index = indexes.get(key);
  if (index) return index;
  index = new Map();
  const dir = dirFor(email);
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const conv = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      index.set(conv.id, metaOf(conv));
    } catch (error) {
      console.error(`Skipping unreadable conversation file ${name}: ${error.message}`);
    }
  }
  indexes.set(key, index);
  return index;
}

function withLock(key, task) {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

async function readConversation(email, id) {
  try {
    return JSON.parse(await fsp.readFile(fileFor(email, id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function list(email) {
  const index = indexFor(email);
  return [...index.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
}

function get(email, id) {
  return readConversation(email, id);
}

function create(email, id, title = 'New chat') {
  const key = `${String(email).toLowerCase()}\u0000${id}`;
  return withLock(key, async () => {
    const existing = await readConversation(email, id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const conv = { id: id.toLowerCase(), title, createdAt: now, updatedAt: now, pinned: false, injectedHash: null, messages: [] };
    await writeJsonAtomic(fileFor(email, id), conv);
    indexFor(email).set(conv.id, metaOf(conv));
    return conv;
  });
}

/**
 * Loads the conversation, lets `change` modify it, and writes it back.
 * Returns null when the conversation no longer exists (for example it was deleted mid-stream).
 * `touch` bumps updatedAt, which moves the chat to the top of the list.
 */
function mutate(email, id, change, { touch = false } = {}) {
  const key = `${String(email).toLowerCase()}\u0000${id}`;
  return withLock(key, async () => {
    const conv = await readConversation(email, id);
    if (!conv) return null;
    await change(conv);
    if (touch) conv.updatedAt = new Date().toISOString();
    await writeJsonAtomic(fileFor(email, id), conv);
    indexFor(email).set(conv.id, metaOf(conv));
    return conv;
  });
}

function remove(email, id) {
  const key = `${String(email).toLowerCase()}\u0000${id}`;
  return withLock(key, async () => {
    try {
      await fsp.unlink(fileFor(email, id));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return indexFor(email).delete(id.toLowerCase());
  });
}

async function removeAll(email) {
  const index = indexFor(email);
  const ids = [...index.keys()];
  await Promise.all(ids.map((id) => remove(email, id)));
  return ids.length;
}

module.exports = { UUID_PATTERN, list, get, create, mutate, remove, removeAll };
