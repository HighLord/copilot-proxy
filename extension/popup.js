'use strict';

const $ = (id) => document.getElementById(id);

function flag(ok) {
  return ok ? '<span class="ok">✓</span>' : '<span class="no">✗</span>';
}

async function refresh() {
  const { config, capture } = await chrome.runtime.sendMessage({ type: 'copilot-status' });
  $('targetUrl').value = config.targetUrl;
  $('key').value = config.key;
  const hasToken = Boolean(capture.token);
  const email = capture.email ? ` (${capture.email})` : '';
  const last = capture.lastPush
    ? `Last push: ${capture.lastPush.ok ? 'ok' : capture.lastPush.detail} at ${new Date(capture.lastPush.at).toLocaleTimeString()}`
    : 'Not pushed yet';
  $('status').innerHTML = [
    `<div>Chat token ${flag(hasToken)}${email}</div>`,
    `<div>Copilot cookies ${flag(Boolean(capture.serverFnCookies))}</div>`,
    `<div>Upload tokens ${flag(Boolean(capture.refreshToken || capture.graphToken))}</div>`,
    `<div style="font-size:11px;color:#888">${last}</div>`,
  ].join('');
}

$('save').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'copilot-save-config', targetUrl: $('targetUrl').value.trim(), key: $('key').value.trim() });
  $('result').textContent = 'Saved.';
  await refresh();
});

$('push').addEventListener('click', async () => {
  $('result').textContent = 'Sending…';
  const result = await chrome.runtime.sendMessage({ type: 'copilot-push' });
  $('result').textContent = result.ok ? 'Sent to proxy.' : (result.error || `HTTP ${result.status}`);
  await refresh();
});

refresh();
