(() => {
  'use strict';

  // ---------- icons ----------
  const ICONS = {
    logo: '<path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.3 5.3l4.2 4.2M14.5 14.5l4.2 4.2M18.7 5.3l-4.2 4.2M9.5 14.5l-4.2 4.2"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    arrowup: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    arrowdown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    chevrons: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
    bulb: '<path d="M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.4 2 4.5.6.8 1 1.5 1 2.5h6c0-1 .4-1.7 1-2.5.8-1.1 2-2.3 2-4.5a6 6 0 0 0-6-6zM9 19h6M10 22h4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    attach: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    cap: '<path d="M22 10 12 5 2 10l10 5 10-5zM6 12v5c3 2 9 2 12 0v-5"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    coffee: '<path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4ZM6 2v3M10 2v3M14 2v3"/>',
  };

  function icon(name, size = 18) {
    return `<svg class="ic${name === 'logo' ? ' logo' : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  }

  function hydrateIcons(root = document) {
    for (const node of root.querySelectorAll('i[data-icon]')) {
      node.outerHTML = icon(node.dataset.icon, Number(node.dataset.size) || 18);
    }
  }

  // ---------- tiny DOM helper ----------
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    let value;
    for (const [key, val] of Object.entries(props ?? {})) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key === 'html') node.innerHTML = val;
      else if (key === 'value') value = val;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
      else node.setAttribute(key, val === true ? '' : val);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    if (value !== undefined) node.value = value;
    return node;
  }
  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------
  const store = {
    get(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
  };

  // ---------- state ----------
  const state = {
    adminKey: store.get('adminKey'),
    boot: null,
    conversations: [],
    current: null, // { id, title, pinned, messages } or null for a fresh chat
    mode: store.get('mode', ''),
    attachments: [], // pending file attachments: [{ id, name, url }] (LocalFile annotations)
    search: '',
    streaming: false,
    abort: null,
    autoScroll: true,
  };

  // ---------- api ----------
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  function authHeaders(admin) {
    const headers = {};
    if (admin && state.adminKey) headers['x-admin-key'] = state.adminKey;
    return headers;
  }

  async function api(method, url, body, { admin = false, quiet = false } = {}) {
    const headers = authHeaders(admin);
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new ApiError(0, `Network error: ${error.message}`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      if (res.status === 401 && !quiet) showLogin({ message: data?.error ?? 'Your session expired — sign in again' });
      throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
    }
    return data;
  }

  async function postAuth(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    return data;
  }

  // Waits for a sign-in step the server is finishing in the background. Every poll is a short request,
  // so a slow Microsoft page can no longer make a phone drop a long-held connection ("Load failed").
  async function pollFlow(loginId) {
    const deadline = Date.now() + 5 * 60_000;
    let failures = 0;
    let attempt = 0;
    for (;;) {
      // Check quickly at first so fast steps feel instant, then ease off while Microsoft is slow.
      await new Promise((resolve) => setTimeout(resolve, attempt < 4 ? 600 : 1500));
      attempt += 1;
      try {
        const res = await fetch(`/api/auth/flow/${encodeURIComponent(loginId)}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
        failures = 0;
        if (data.state !== 'working') return data;
      } catch (error) {
        // A 4xx means the server has no such sign-in. Anything else (phone asleep, network blip) is retried.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
        failures += 1;
        if (failures >= 10) throw new Error('Lost contact with the server. Check your connection and try again.');
      }
      if (Date.now() > deadline) throw new Error('Sign-in took too long. Please try again.');
    }
  }

  // ---------- popups: menu, modal, toast ----------
  let closeMenuFn = null;

  function closeMenu() {
    if (closeMenuFn) closeMenuFn();
  }

  function openMenu(anchor, items, { above = false, alignRight = false, width } = {}) {
    closeMenu();
    const menu = h('div', { class: 'popover', role: 'menu' });
    if (width) menu.style.width = `${width}px`;
    for (const item of items) {
      if (item === 'sep') { menu.append(h('div', { class: 'menu-sep' })); continue; }
      menu.append(h('button', {
        class: `menu-item${item.danger ? ' danger' : ''}${item.className ? ` ${item.className}` : ''}`,
        role: 'menuitem',
        onclick: () => { closeMenu(); item.onClick?.(); },
        html: item.html ?? `${item.icon ? icon(item.icon, 16) : ''}<span>${item.label}</span>`,
      }));
    }
    $('popups').append(menu);
    const rect = anchor.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    let left = alignRight ? rect.right - box.width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    let top = above ? rect.top - box.height - 8 : rect.bottom + 4;
    if (!above && top + box.height > window.innerHeight - 8) top = rect.top - box.height - 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    const host = anchor.closest('.chat-item');
    host?.classList.add('menu-open');
    anchor.setAttribute('aria-expanded', 'true');
    const onDown = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) closeMenu(); };
    const onKey = (event) => { if (event.key === 'Escape') { closeMenu(); anchor.focus(); } };
    setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    document.addEventListener('keydown', onKey);
    closeMenuFn = () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      menu.remove();
      host?.classList.remove('menu-open');
      anchor.setAttribute('aria-expanded', 'false');
      closeMenuFn = null;
    };
    menu.querySelector('.menu-item')?.focus({ preventScroll: true });
    return closeMenuFn;
  }

  const modalStack = [];

  function openModal({ title, content, actions = [], wide = false, dismissible = true }) {
    const close = () => {
      const index = modalStack.indexOf(entry);
      if (index !== -1) modalStack.splice(index, 1);
      backdrop.remove();
    };
    const head = h('div', { class: 'modal-head' }, h('h2', null, title),
      dismissible ? h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close, html: icon('x', 18) }) : null);
    const modal = h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      head, content, actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (event) => { if (dismissible && event.target === backdrop) close(); } }, modal);
    const entry = { close, dismissible };
    modalStack.push(entry);
    $('modalRoot').append(backdrop);
    (modal.querySelector('input:not([type=hidden]), textarea') ?? modal.querySelector('.btn.primary, .btn.danger'))?.focus();
    return { close, el: modal };
  }

  function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } modal.close(); };
      const modal = openModal({
        title,
        content: h('div', { class: 'modal-body' }, h('p', null, message)),
        actions: [
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, confirmLabel),
        ],
      });
      const originalClose = modal.close;
      modalStack[modalStack.length - 1].close = () => { originalClose(); if (!settled) { settled = true; resolve(false); } };
    });
  }

  function promptDialog({ title, label, value = '', confirmLabel = 'Save', maxLength = 120 }) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', value, maxlength: maxLength, 'aria-label': label });
      let settled = false;
      const finish = (result) => { if (!settled) { settled = true; resolve(result); } modal.close(); };
      const submit = () => { if (input.value.trim()) finish(input.value.trim()); };
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
      const modal = openModal({
        title,
        content: h('div', { class: 'modal-body' }, h('div', { class: 'field' }, input)),
        actions: [
          h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: submit }, confirmLabel),
        ],
      });
      input.select();
      const originalClose = modal.close;
      modalStack[modalStack.length - 1].close = () => { originalClose(); if (!settled) { settled = true; resolve(null); } };
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalStack.length && !closeMenuFn) {
      const top = modalStack[modalStack.length - 1];
      if (top.dismissible) top.close();
    }
  });

  let toastTimer;
  function toast(message) {
    document.querySelector('.toast')?.remove();
    const el = h('div', { class: 'toast', role: 'status' }, message);
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Plain-http pages have no clipboard API, so fall back to a hidden textarea.
      const area = h('textarea', { style: 'position:fixed;opacity:0;top:0' });
      area.value = text;
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      return ok;
    }
  }

  // ---------- theme ----------
  function applyTheme() {
    const pref = store.get('theme', 'auto');
    const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // ---------- helpers ----------
  const modeInfo = (id) => state.boot?.modes.find((mode) => mode.id === id);
  const isEmptyChat = () => !state.current || state.current.messages.length === 0;
  const isTouch = () => matchMedia('(pointer: coarse)').matches;

  function greetingText() {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
    const name = state.boot?.preferences.displayName;
    return name ? `Good ${part}, ${name}` : `Good ${part}`;
  }

  function sortConversations() {
    state.conversations.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async function refreshList() {
    try {
      state.conversations = (await api('GET', '/api/conversations')).conversations;
      renderSidebar();
    } catch (error) { /* auth errors already surface through the sign-in prompt */ }
  }

  // ---------- sidebar ----------
  function renderSidebar() {
    const list = $('chatList');
    list.replaceChildren();
    const query = state.search.trim().toLowerCase();
    const visible = state.conversations.filter((c) => !query || c.title.toLowerCase().includes(query));
    if (!visible.length) {
      list.append(h('div', { class: 'side-empty' }, query ? 'No chats match your search' : 'Your chats will show up here'));
      return;
    }
    const addGroup = (label, items) => {
      if (!items.length) return;
      list.append(h('div', { class: 'side-heading' }, label), ...items.map(chatItem));
    };
    addGroup('Starred', visible.filter((c) => c.pinned));
    addGroup('Recents', visible.filter((c) => !c.pinned));
  }

  function chatMenuItems(conv) {
    return [
      { label: conv.pinned ? 'Unstar' : 'Star', icon: 'star', onClick: () => togglePin(conv.id, !conv.pinned) },
      { label: 'Rename', icon: 'pencil', onClick: () => renameChat(conv.id) },
      'sep',
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteChat(conv.id) },
    ];
  }

  function chatItem(conv) {
    const more = h('button', {
      class: 'icon-btn chat-more', 'aria-label': `Options for ${conv.title}`, 'aria-haspopup': 'menu',
      onclick: (event) => { event.stopPropagation(); openMenu(more, chatMenuItems(conv)); },
      html: icon('dots', 18),
    });
    return h('div', { class: `chat-item${state.current?.id === conv.id ? ' active' : ''}` },
      h('button', { class: 'chat-link', title: conv.title, onclick: () => openChat(conv.id) }, conv.title), more);
  }

  async function togglePin(id, pinned) {
    try {
      await api('PATCH', `/api/conversations/${id}`, { pinned });
      const entry = state.conversations.find((c) => c.id === id);
      if (entry) entry.pinned = pinned;
      if (state.current?.id === id) state.current.pinned = pinned;
      sortConversations();
      renderSidebar();
    } catch (error) { toast(error.message); }
  }

  async function renameChat(id) {
    const entry = state.conversations.find((c) => c.id === id) ?? state.current;
    const title = await promptDialog({ title: 'Rename chat', label: 'Chat name', value: entry?.title ?? '' });
    if (!title) return;
    try {
      await api('PATCH', `/api/conversations/${id}`, { title });
      const listed = state.conversations.find((c) => c.id === id);
      if (listed) listed.title = title;
      if (state.current?.id === id) state.current.title = title;
      renderSidebar();
      renderHeader();
    } catch (error) { toast(error.message); }
  }

  async function deleteChat(id) {
    const entry = state.conversations.find((c) => c.id === id) ?? state.current;
    const ok = await confirmDialog({
      title: 'Delete chat?',
      message: `"${entry?.title ?? 'This chat'}" will be permanently deleted from the server.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/conversations/${id}`);
      state.conversations = state.conversations.filter((c) => c.id !== id);
      if (state.current?.id === id) newChat();
      else renderSidebar();
      toast('Chat deleted');
    } catch (error) {
      if (error.status === 404) { state.conversations = state.conversations.filter((c) => c.id !== id); renderSidebar(); }
      else toast(error.message);
    }
  }

  function setSidebar(open) {
    $('app').classList.toggle('side-closed', !open);
    if (window.innerWidth > 820) store.set('sidebar', open ? 'open' : 'closed');
  }
  const closeSidebarOnMobile = () => { if (window.innerWidth <= 820) $('app').classList.add('side-closed'); };

  // ---------- header + thread ----------
  function renderHeader() {
    $('main').classList.toggle('empty', isEmptyChat());
    $('titleText').textContent = state.current?.title ?? 'New chat';
    const app = state.boot?.appName ?? 'Copilot';
    document.title = isEmptyChat() ? app : `${state.current.title} - ${app}`;
  }

  function userEl(message) {
    const el = h('div', { class: 'msg user', 'data-id': message.id }, h('div', { class: 'bubble' }, message.text));
    if (message.attachments?.length) {
      el.append(h('div', { class: 'msg-files' }, message.attachments.map((a) =>
        h('span', { class: 'msg-file', title: a.url }, `${icon('attach', 13)} ${a.name}`))));
    }
    return el;
  }

  function actionsRow(message) {
    const copy = h('button', { class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy response', html: icon('copy', 16) });
    copy.addEventListener('click', async () => {
      if (await copyText(message.text)) {
        copy.innerHTML = icon('check', 16);
        setTimeout(() => { copy.innerHTML = icon('copy', 16); }, 1500);
      } else toast('Could not copy');
    });
    const label = modeInfo(message.mode)?.label;
    return h('div', { class: 'actions' }, message.text ? copy : null, label ? h('span', { class: 'mode-tag' }, label) : null);
  }

  function reasoningEl(reasoning) {
    return h('details', { class: 'reasoning' },
      h('summary', null, 'Thought process'),
      h('div', { class: 'reasoning-body' }, reasoning));
  }

  function assistantEl(message) {
    const el = h('div', { class: 'msg assistant', 'data-id': message.id });
    if (message.reasoning) el.append(reasoningEl(message.reasoning));
    el.append(h('div', { class: 'prose', html: window.renderMarkdown(message.text || '') }));
    if (message.status === 'stopped') el.append(h('div', { class: 'meta-note' }, 'Response stopped'));
    if (message.status === 'error') el.append(h('div', { class: 'error-box' }, `The response was interrupted: ${message.error ?? 'unknown error'}`));
    el.append(actionsRow(message));
    return el;
  }

  function renderThread() {
    const thread = $('thread');
    thread.replaceChildren();
    for (const message of state.current?.messages ?? []) {
      thread.append(message.role === 'user' ? userEl(message) : assistantEl(message));
    }
  }

  function renderAll({ scroll = true } = {}) {
    renderHeader();
    renderSidebar();
    renderThread();
    if (scroll) scrollToBottom(true);
    updateComposer();
  }

  function scrollToBottom(force = false) {
    const box = $('scroll');
    if (force || state.autoScroll) box.scrollTop = box.scrollHeight;
  }

  $('scroll').addEventListener('scroll', () => {
    const box = $('scroll');
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    state.autoScroll = distance < 80;
    $('toBottom').classList.toggle('hidden', distance < 240);
  });
  $('toBottom').addEventListener('click', () => { state.autoScroll = true; scrollToBottom(true); });

  // ---------- navigation ----------
  async function openChat(id, { push = true } = {}) {
    if (state.streaming) stopStream();
    closeSidebarOnMobile();
    if (state.current?.id === id) return;
    try {
      state.current = await api('GET', `/api/conversations/${id}`);
      if (push) history.pushState(null, '', `#/c/${id}`);
      renderAll();
      $('input').focus();
    } catch (error) {
      if (error.status === 404) {
        toast('That chat no longer exists');
        state.conversations = state.conversations.filter((c) => c.id !== id);
        newChat();
      } else toast(error.message);
    }
  }

  function newChat({ push = true } = {}) {
    if (state.streaming) stopStream();
    state.current = null;
    if (push && location.hash !== '#/') history.pushState(null, '', '#/');
    hideNotice();
    renderAll();
    $('input').focus();
    closeSidebarOnMobile();
  }

  function route() {
    const match = location.hash.match(/^#\/c\/([0-9a-f-]{36})$/i);
    if (match) openChat(match[1].toLowerCase(), { push: false });
    else newChat({ push: false });
  }
  window.addEventListener('popstate', route);

  // ---------- composer ----------
  function updateComposer() {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
    const length = input.value.length;
    const max = state.boot?.maxPromptChars ?? 8000;
    const counter = $('charCount');
    counter.classList.toggle('hidden', length < max * 0.8);
    counter.classList.toggle('over', length > max);
    counter.textContent = `${length} / ${max}`;
    const send = $('sendBtn');
    if (state.streaming) {
      send.disabled = false;
      send.title = 'Stop response';
      send.setAttribute('aria-label', 'Stop response');
      send.innerHTML = '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
    } else {
      send.disabled = (input.value.trim() === '' && state.attachments.length === 0) || length > max;
      send.title = 'Send message';
      send.setAttribute('aria-label', 'Send message');
      send.innerHTML = icon('arrowup', 18);
    }
    $('modeLabel').textContent = modeInfo(state.mode)?.label ?? '';
  }

  function showNotice(message) {
    $('noticeText').textContent = message;
    $('notice').classList.remove('hidden');
  }
  function hideNotice() { $('notice').classList.add('hidden'); }
  $('noticeClose').addEventListener('click', hideNotice);

  function setMode(id) {
    if (!modeInfo(id)) return;
    state.mode = id;
    store.set('mode', id);
    updateComposer();
  }

  $('modeBtn').addEventListener('click', () => {
    if (closeMenuFn) { closeMenu(); return; }
    openMenu($('modeBtn'), (state.boot?.modes ?? []).map((mode) => ({
      className: 'mode-option',
      onClick: () => setMode(mode.id),
      html: `<span class="mo-text"><span class="mo-title">${esc(mode.label)}</span><span class="mo-desc">${esc(mode.description)}</span></span>`
        + `<span class="check">${mode.id === state.mode ? icon('check', 16) : ''}</span>`,
    })), { above: true, alignRight: true, width: 300 });
  });

  function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  $('plusBtn').addEventListener('click', () => {
    if (closeMenuFn) { closeMenu(); return; }
    openMenu($('plusBtn'), [
      { label: 'Add message to memory', icon: 'bulb', onClick: addInputToMemory },
      { label: 'Manage memory', icon: 'sliders', onClick: () => openSettings('memory') },
      { label: 'Personal preferences', icon: 'pencil', onClick: () => openSettings('personal') },
    ], { above: true, width: 260 });
  });

  // ---------- file attachments ----------
  function renderAttachments() {
    const box = $('attachments');
    box.replaceChildren();
    box.classList.toggle('hidden', state.attachments.length === 0);
    state.attachments.forEach((att, index) => {
      const remove = h('button', {
        class: 'icon-btn', 'aria-label': `Remove ${att.name}`, title: 'Remove attachment',
        onclick: () => { state.attachments.splice(index, 1); renderAttachments(); },
        html: icon('x', 14),
      });
      box.append(h('div', { class: 'attachment' },
        h('span', { class: 'att-name', title: att.name }, att.name), remove));
    });
    updateComposer();
  }

  async function uploadAttachment(file) {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { ...authHeaders(false), 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) showLogin({ message: data.error ?? 'Please sign in again' });
      throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
    }
    return data;
  }

  async function attachFiles(fileList) {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    for (const file of files) {
      try {
        const result = await uploadAttachment(file);
        state.attachments.push({ id: result.annotation.id, name: result.name, url: result.url });
      } catch (error) {
        toast(`Could not attach ${file.name}: ${error.message}`);
      }
    }
    renderAttachments();
  }

  $('uploadBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (event) => {
    attachFiles(event.target.files);
    event.target.value = '';
  });

  async function addInputToMemory() {
    const text = $('input').value.trim();
    if (!text) { toast('Type something to remember first'); return; }
    try {
      await api('POST', '/api/memories', { text });
      $('input').value = '';
      updateComposer();
      toast('Saved to memory');
    } catch (error) { toast(error.message); }
  }

  $('input').addEventListener('input', updateComposer);
  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isTouch()) {
      event.preventDefault();
      if (!state.streaming) send();
    }
  });
  $('sendBtn').addEventListener('click', () => { if (state.streaming) stopStream(); else send(); });
  $('composer').addEventListener('click', (event) => { if (event.target === $('composer')) $('input').focus(); });

  // ---------- streaming ----------
  function stopStream() {
    state.abort?.abort();
  }

  async function readSse(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let name = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) {
          let parsed;
          try { parsed = JSON.parse(data.join('\n')); } catch { parsed = {}; }
          onEvent(name, parsed);
        }
      }
    }
  }

  function makeStreamingEl() {
    const label = h('span', { class: 'label' }, 'Thinking');
    const elapsed = h('span', { class: 'elapsed' });
    const thinking = h('div', { class: 'thinking' }, h('span', { html: icon('logo', 18) }), label, elapsed);
    const reasoningBody = h('div', { class: 'reasoning-body' });
    const reasoning = h('details', { class: 'reasoning hidden' }, h('summary', null, 'Thought process'), reasoningBody);
    const prose = h('div', { class: 'prose hidden' });
    const el = h('div', { class: 'msg assistant streaming' }, thinking, reasoning, prose);
    return { el, thinking, label, elapsed, prose, reasoning, reasoningBody };
  }

  async function send() {
    if (state.streaming) return;
    const text = $('input').value.trim();
    const max = state.boot.maxPromptChars;
    if ((!text && state.attachments.length === 0) || text.length > max) return;
    hideNotice();
    closeMenu();
    const attachments = state.attachments.slice();
    state.attachments = [];
    renderAttachments();

    const conv = state.current ?? { id: null, title: 'New chat', pinned: false, messages: [] };
    state.current = conv;
    const userMessage = { id: `pending-${Date.now()}`, role: 'user', text };
    if (attachments.length) userMessage.attachments = attachments.map((a) => ({ name: a.name, url: a.url }));
    conv.messages.push(userMessage);
    $('input').value = '';
    renderHeader();
    const userNode = userEl(userMessage);
    $('thread').append(userNode);
    const live = makeStreamingEl();
    $('thread').append(live.el);

    const modeId = state.mode;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      live.elapsed.textContent = seconds >= 5 ? `${seconds}s` : '';
    }, 1000);

    state.streaming = true;
    state.autoScroll = true;
    const controller = new AbortController();
    state.abort = controller;
    updateComposer();
    scrollToBottom(true);

    let reply = '';
    let reasoning = '';
    let started = false;
    let frame = 0;
    let assistantId = null;
    let failure = null;
    let finalStatus = 'complete';
    const paint = () => {
      frame = 0;
      live.prose.innerHTML = window.renderMarkdown(reply);
      scrollToBottom();
    };

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { ...authHeaders(false), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: text, conversationId: conv.id ?? undefined, mode: modeId, attachments }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) showLogin({ message: data.error ?? 'Please sign in again' });
        failure = { message: data.error ?? `HTTP ${res.status}`, persisted: false, conversationDeleted: !conv.id };
      } else {
        await readSse(res, (name, data) => {
          if (name === 'meta') {
            conv.id = data.conversationId;
            conv.title = data.title;
            userMessage.id = data.userMessageId;
            assistantId = data.assistantMessageId;
            if (data.isNew) {
              history.replaceState(null, '', `#/c/${conv.id}`);
              state.conversations.unshift({ id: conv.id, title: conv.title, pinned: false, updatedAt: new Date().toISOString(), messageCount: 1 });
            }
            renderHeader();
            renderSidebar();
          } else if (name === 'status') {
            if (!started) live.label.textContent = (data.kind === 'InternalSearchQuery' ? `Searching: ${data.text}` : data.text).slice(0, 90);
          } else if (name === 'reasoning') {
            reasoning += (reasoning ? '\n' : '') + (data.text ?? '');
            live.reasoning.classList.remove('hidden');
            live.reasoningBody.textContent = reasoning;
          } else if (name === 'delta') {
            if (!started) {
              started = true;
              live.thinking.classList.add('hidden');
              live.prose.classList.remove('hidden');
            }
            reply += data.text ?? '';
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (name === 'done') {
            finalStatus = data.status ?? 'complete';
            if (data.title) conv.title = data.title;
          } else if (name === 'error') {
            failure = data;
          }
        });
      }
    } catch (error) {
      if (error.name === 'AbortError') finalStatus = 'stopped';
      else failure = { message: error.message, persisted: Boolean(reply), conversationDeleted: false };
    } finally {
      clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
      state.streaming = false;
      state.abort = null;
    }

    live.el.remove();
    if (failure && !reply && !failure.persisted) {
      // Nothing was kept on the server, so undo the optimistic message and give the text back.
      userNode.remove();
      conv.messages.pop();
      $('input').value = text;
      state.attachments = attachments;
      renderAttachments();
      if (failure.conversationDeleted || !conv.id) {
        state.current = null;
        state.conversations = state.conversations.filter((c) => c.id !== conv.id);
        history.replaceState(null, '', '#/');
      }
      showNotice(failure.message);
    } else {
      const message = {
        id: assistantId ?? `local-${Date.now()}`,
        role: 'assistant',
        text: reply,
        mode: modeId,
        status: failure ? 'error' : finalStatus,
        error: failure?.message,
      };
      if (reasoning) message.reasoning = reasoning;
      conv.messages.push(message);
      $('thread').append(assistantEl(message));
      if (failure) showNotice(failure.message);
    }
    renderHeader();
    updateComposer();
    scrollToBottom();
    refreshList();
    if (!isTouch()) $('input').focus();
  }

  // ---------- code-block copy (event delegation) ----------
  $('thread').addEventListener('click', async (event) => {
    const button = event.target.closest('.copy-code');
    if (!button) return;
    const code = button.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
    if (await copyText(code)) {
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    }
  });

  // ---------- sidebar wiring ----------
  $('newChatBtn').addEventListener('click', () => newChat());
  $('collapseBtn').addEventListener('click', () => setSidebar(false));
  $('openSidebarBtn').addEventListener('click', () => setSidebar(true));
  $('backdrop').addEventListener('click', () => setSidebar(false));
  $('memoryBtn').addEventListener('click', () => { openSettings('memory'); closeSidebarOnMobile(); });
  $('searchInput').addEventListener('input', (event) => { state.search = event.target.value; renderSidebar(); });
  $('titleBtn').addEventListener('click', () => {
    if (!state.current?.id) return;
    openMenu($('titleBtn'), chatMenuItems(state.current));
  });
  $('userBtn').addEventListener('click', () => {
    openMenu($('userBtn'), [
      { label: 'Settings', icon: 'sliders', onClick: () => openSettings('general') },
      { label: 'Admin', icon: 'shield', onClick: () => openSettings('admin') },
      'sep',
      { label: 'Sign out', icon: 'logout', onClick: signOut },
    ], { above: true, width: 240 });
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      newChat();
    }
  });

  async function signOut() {
    try { await fetch('/api/auth/signout', { method: 'POST' }); } catch { /* offline */ }
    store.del('adminKey');
    state.adminKey = '';
    state.conversations = [];
    state.current = null;
    state.boot = null;
    showLogin();
  }

  // ---------- sign-in (Microsoft) ----------
  let loginOpen = false;

  // Status lines shown while the server drives the Microsoft sign-in in a real browser.
  const WORKING = {
    email: ['Opening Microsoft sign-in…', 'Loading the sign-in page…', 'Verifying your account…', 'Connecting to Copilot…', 'Almost there…'],
    password: ['Checking your password…', 'Waiting for Microsoft…', 'Setting up your Copilot session…', 'Almost there…'],
    mfa: ['Verifying your code…', 'Signing you in…', 'Setting up your Copilot session…', 'Almost there…'],
  };

  function showLogin({ message = '' } = {}) {
    if (loginOpen) return;
    loginOpen = true;
    let loginId = null;
    const error = h('div', { class: 'form-error' }, message);
    const body = h('div', { class: 'modal-body gate' });
    const foot = h('div', { class: 'modal-foot' });
    const modal = openModal({ title: ' ', dismissible: false, content: h('div', null, body, foot), actions: [] });

    const cancelFlow = () => { if (loginId) { postAuth('/api/auth/cancel', { loginId }).catch(() => {}); loginId = null; } };

    // Spinner + rotating status lines + elapsed time, so the page never looks frozen.
    // Returns a function that stops the timers.
    function showWorking(title, steps) {
      const label = h('span', { class: 'label' }, steps[0]);
      const elapsed = h('span', { class: 'elapsed' }, '0s');
      const note = h('p', { class: 'wait-note' }, 'This can take up to a minute. Please keep this page open.');
      body.replaceChildren(
        h('div', { class: 'working-ic', html: icon('logo', 44) }),
        h('h2', null, title),
        h('div', { class: 'thinking working' }, label, elapsed),
        note);
      foot.replaceChildren();
      const started = Date.now();
      let step = 0;
      const timer = setInterval(() => {
        const secs = Math.floor((Date.now() - started) / 1000);
        elapsed.textContent = `${secs}s`;
        const next = Math.min(Math.floor(secs / 7), steps.length - 1);
        if (next !== step) { step = next; label.textContent = steps[step]; }
        if (secs >= 45) note.textContent = 'Still working — Microsoft is responding slowly. Hang tight.';
      }, 1000);
      return () => clearInterval(timer);
    }

    // Send the server's answer to the right screen.
    function route(data) {
      if (data.state === 'done') return close();
      if (data.state === 'mfa') return drawMfa(data.error ?? '');
      if (data.state === 'password') return drawPassword(data.error ?? '');
      loginId = null;
      return drawEmail(data.error ?? 'Sign-in failed');
    }

    function drawEmail(message = '') {
      const input = h('input', { type: 'email', value: store.get('email'), placeholder: 'name@company.com', autocomplete: 'username', 'aria-label': 'Email' });
      const go = async () => {
        const email = input.value.trim();
        if (!email) return;
        store.set('email', email);
        const stop = showWorking('Signing you in', WORKING.email);
        try {
          const first = await postAuth('/api/auth/login', { email, async: true });
          loginId = first.loginId;
          const data = first.state === 'working' ? await pollFlow(loginId) : first;
          stop();
          route(data);
        } catch (err) { stop(); drawEmail(err.message); }
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
      error.textContent = message;
      body.replaceChildren(
        h('div', { html: icon('logo', 40) }), h('h2', null, 'Sign in to Copilot'),
        h('p', null, 'Use your Microsoft account. You will be asked for your password, and for a code if your account uses two-step verification.'), input, error);
      foot.replaceChildren(h('button', { class: 'btn accent', onclick: go }, 'Continue'));
      input.focus();
    }

    function drawPassword(message = '') {
      const input = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
      const go = async () => {
        const password = input.value;
        if (!password) return;
        const stop = showWorking('Signing you in', WORKING.password);
        try {
          const first = await postAuth('/api/auth/password', { loginId, password, async: true });
          const data = first.state === 'working' ? await pollFlow(loginId) : first;
          stop();
          route(data);
        } catch (err) { stop(); drawPassword(err.message); }
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
      error.textContent = message;
      body.replaceChildren(
        h('div', { html: icon('logo', 40) }), h('h2', null, 'Enter your password'),
        h('p', null, store.get('email') || 'Microsoft account'), input, error);
      foot.replaceChildren(
        h('button', { class: 'btn', onclick: () => { cancelFlow(); drawEmail(); } }, 'Back'),
        h('button', { class: 'btn accent', onclick: go }, 'Sign in'));
      input.focus();
    }

    function drawMfa(message = '') {
      const input = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '000000', autocomplete: 'one-time-code', 'aria-label': 'Verification code' });
      const go = async () => {
        const code = input.value.trim();
        if (!code) return;
        const stop = showWorking('Verifying', WORKING.mfa);
        try {
          const first = await postAuth('/api/auth/mfa', { loginId, code, async: true });
          const data = first.state === 'working' ? await pollFlow(loginId) : first;
          stop();
          route(data);
        } catch (err) { stop(); drawMfa(err.message); }
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
      error.textContent = message;
      body.replaceChildren(
        h('div', { html: icon('shield', 40) }), h('h2', null, 'Two-step verification'),
        h('p', null, 'Enter the 6-digit code from your Microsoft Authenticator app.'), input, error);
      foot.replaceChildren(
        h('button', { class: 'btn', onclick: () => { cancelFlow(); drawEmail(); } }, 'Back'),
        h('button', { class: 'btn accent', onclick: go }, 'Verify'));
      input.focus();
    }

    function close() {
      loginOpen = false;
      loginId = null;
      modal.close();
      initSignedIn();
    }

    drawEmail(message);
  }

  // ---------- settings ----------
  function field(label, control, hint) {
    return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
  }

  function switchRow(title, description, checked, onChange) {
    const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': title });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h('div', { class: 'switch-row' },
      h('div', null, h('div', { class: 't' }, title), h('div', { class: 'd' }, description)),
      h('label', { class: 'switch' }, input, h('i')));
  }

  function openSettings(tab = 'general') {
    closeMenu();
    const body = h('div', { class: 'settings-body' });
    const nav = h('div', { class: 'settings-nav', role: 'tablist' });
    const tabs = [['general', 'General'], ['personal', 'Personalization'], ['memory', 'Memory'], ['admin', 'Admin']];
    const builders = { general: buildGeneral, personal: buildPersonal, memory: buildMemory, admin: buildAdmin };
    const show = (id) => {
      for (const button of nav.children) {
        const on = button.dataset.tab === id;
        button.classList.toggle('on', on);
        button.setAttribute('aria-selected', on);
      }
      body.replaceChildren();
      builders[id](body);
    };
    for (const [id, label] of tabs) nav.append(h('button', { 'data-tab': id, role: 'tab', onclick: () => show(id) }, label));
    openModal({ title: 'Settings', wide: true, content: h('div', { class: 'settings' }, nav, body) });
    show(tab);
  }

  function buildGeneral(body) {
    const prefs = state.boot.preferences;
    const name = h('input', { type: 'text', maxlength: 60, value: prefs.displayName, placeholder: 'What should we call you?' });
    const saveName = h('button', { class: 'btn small', onclick: async () => {
      try {
        state.boot.preferences = await api('PUT', '/api/preferences', { displayName: name.value });
        applyIdentity();
        toast('Saved');
      } catch (error) { toast(error.message); }
    } }, 'Save');

    const themeSeg = h('div', { class: 'seg' });
    const drawThemes = () => {
      themeSeg.replaceChildren(...['light', 'auto', 'dark'].map((id) => h('button', {
        class: store.get('theme', 'auto') === id ? 'on' : '',
        onclick: () => { store.set('theme', id); applyTheme(); drawThemes(); },
      }, id[0].toUpperCase() + id.slice(1))));
    };
    drawThemes();

    const wipe = h('button', { class: 'btn danger small', onclick: async () => {
      const ok = await confirmDialog({
        title: 'Delete all chats?',
        message: `All ${state.conversations.length} chats will be permanently deleted from the server. Memory is not affected.`,
        confirmLabel: 'Delete all', danger: true,
      });
      if (!ok) return;
      try {
        const result = await api('DELETE', '/api/conversations');
        state.conversations = [];
        newChat();
        toast(`Deleted ${result.deleted} chats`);
      } catch (error) { toast(error.message); }
    } }, 'Delete all chats');

    body.append(
      h('h3', null, 'Profile'),
      field('Display name', h('div', { class: 'row' }, name, saveName), 'Used in the greeting and shared with the model as context.'),
      h('h3', null, 'Appearance'),
      h('div', { class: 'field' }, themeSeg),
      h('h3', null, 'Account'),
      h('p', { class: 'hint' }, state.boot.identity?.email ?? ''),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: signOut }, 'Sign out')),
      h('h3', null, 'Data'),
      h('p', { class: 'hint' }, 'Chats are stored on the server and can be deleted individually from the sidebar.'),
      wipe,
    );
  }

  function buildPersonal(body) {
    const prefs = state.boot.preferences;
    const text = h('textarea', { maxlength: 1500, placeholder: 'e.g. Keep explanations short. I prefer metric units.' });
    text.value = prefs.customInstructions;
    const save = h('button', { class: 'btn primary', onclick: async () => {
      try {
        state.boot.preferences = await api('PUT', '/api/preferences', { customInstructions: text.value });
        toast('Saved');
      } catch (error) { toast(error.message); }
    } }, 'Save preferences');
    body.append(
      h('h3', null, 'Personal preferences'),
      field('What should the assistant know about how you like to work?', text,
        'Sent at the start of each chat and again whenever it changes.'),
      save,
      h('h3', null, 'Memory'),
      switchRow('Use memory', 'Include saved memories as context in your chats.', prefs.memoryEnabled, async (on) => {
        try { state.boot.preferences = await api('PUT', '/api/preferences', { memoryEnabled: on }); } catch (error) { toast(error.message); }
      }),
    );
  }

  async function buildMemory(body) {
    body.append(h('h3', null, 'Memory'),
      h('p', { class: 'hint' }, 'Things the assistant should remember about you. They are added to the start of a chat, and sent again if they change.'));
    const list = h('div', { class: 'mem-list' });
    const input = h('input', { type: 'text', maxlength: 400, placeholder: 'Add something to remember' });
    const add = async () => {
      if (!input.value.trim()) return;
      try {
        const memory = await api('POST', '/api/memories', { text: input.value });
        memories.push(memory);
        input.value = '';
        draw();
      } catch (error) { toast(error.message); }
    };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') add(); });
    const clear = h('button', { class: 'btn danger small', onclick: async () => {
      if (!memories.length) return;
      if (!(await confirmDialog({ title: 'Clear all memory?', message: 'Every saved memory will be deleted.', confirmLabel: 'Clear all', danger: true }))) return;
      try { await api('DELETE', '/api/memories'); memories = []; draw(); } catch (error) { toast(error.message); }
    } }, 'Clear all');
    let memories = [];

    const draw = () => {
      list.replaceChildren();
      if (!memories.length) list.append(h('div', { class: 'mem-empty' }, 'Nothing saved yet.'));
      for (const memory of memories) {
        const row = h('div', { class: 'mem-item' });
        const showView = () => {
          row.replaceChildren(
            h('div', { class: 'txt' }, memory.text),
            h('button', { class: 'icon-btn', 'aria-label': 'Edit memory', onclick: showEdit, html: icon('pencil', 16) }),
            h('button', { class: 'icon-btn', 'aria-label': 'Delete memory', onclick: async () => {
              try { await api('DELETE', `/api/memories/${memory.id}`); memories = memories.filter((m) => m.id !== memory.id); draw(); } catch (error) { toast(error.message); }
            }, html: icon('trash', 16) }),
          );
        };
        const showEdit = () => {
          const edit = h('input', { type: 'text', maxlength: 400, value: memory.text });
          const commit = async () => {
            if (!edit.value.trim() || edit.value.trim() === memory.text) { showView(); return; }
            try { Object.assign(memory, await api('PATCH', `/api/memories/${memory.id}`, { text: edit.value })); } catch (error) { toast(error.message); }
            showView();
          };
          edit.addEventListener('keydown', (event) => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { event.stopPropagation(); showView(); } });
          row.replaceChildren(edit, h('button', { class: 'icon-btn', 'aria-label': 'Save', onclick: commit, html: icon('check', 16) }));
          edit.focus();
        };
        showView();
        list.append(row);
      }
    };

    body.append(list, h('div', { class: 'row' }, input, h('button', { class: 'btn primary small', onclick: add }, 'Add')),
      h('div', { style: 'margin-top:18px' }, clear));
    try { memories = (await api('GET', '/api/memories')).memories; } catch (error) { toast(error.message); }
    draw();
  }

  // ----- admin -----
  const lines = (value) => value.split('\n').map((s) => s.trim()).filter(Boolean);

  function jsonField(label, value, hint) {
    const area = h('textarea', { class: 'mono', spellcheck: 'false' });
    area.value = JSON.stringify(value ?? {}, null, 2);
    return {
      node: field(label, area, hint),
      get() {
        try { return JSON.parse(area.value.trim() || '{}'); } catch (error) { throw new Error(`${label}: ${error.message}`); }
      },
    };
  }

  function modeCard(id, mode) {
    const label = h('input', { type: 'text', maxlength: 40, value: mode.label });
    const description = h('input', { type: 'text', maxlength: 120, value: mode.description });
    const prompt = h('textarea', { maxlength: 1500 });
    prompt.value = mode.prompt;
    const tone = h('input', { type: 'text', maxlength: 120, value: mode.tone ?? '', placeholder: 'Magic' });
    const timeout = h('input', { type: 'number', min: 10, max: 1800, value: Math.round(mode.timeoutMs / 1000) });
    const add = h('textarea', { class: 'mono' });
    add.value = mode.addOptionsSets.join('\n');
    const remove = h('textarea', { class: 'mono' });
    remove.value = mode.removeOptionsSets.join('\n');
    const args = jsonField('Argument overrides (JSON)', mode.argOverrides, 'Deep-merged into the chat arguments sent to Copilot.');
    const message = jsonField('Message overrides (JSON)', mode.messageOverrides, 'Deep-merged into arguments.message. The text field is always the prompt.');
    const urlParams = jsonField('URL parameters (JSON)', mode.urlParams, 'Extra query-string values on the WebSocket URL.');
    const node = h('div', { class: 'mode-card' },
      h('h4', null, id === 'quick' ? 'Quick response' : 'Think deeper'),
      field('Label', label), field('Description', description),
      field('Tone', tone, 'The model mode on the wire. GPT-5.6: "Gpt_5_6_Chat" = quick, "Gpt_5_6_Reasoning" = think. Leave blank for the Copilot default ("Magic").'),
      field('Extra instructions for this mode', prompt, 'Added to the system prompt when this mode is selected.'),
      field('Idle timeout (seconds)', timeout, 'How long to wait with no frames from Copilot before giving up.'),
      h('details', { class: 'adv' }, h('summary', null, 'Copilot request overrides'),
        field('Add options sets (one per line)', add),
        field('Remove options sets (one per line)', remove),
        args.node, message.node, urlParams.node));
    return {
      node,
      get: () => ({
        label: label.value, description: description.value, prompt: prompt.value, tone: tone.value.trim(),
        timeoutMs: Number(timeout.value) * 1000,
        addOptionsSets: lines(add.value), removeOptionsSets: lines(remove.value),
        argOverrides: args.get(), messageOverrides: message.get(), urlParams: urlParams.get(),
      }),
    };
  }

  async function buildAdmin(body) {
    body.append(h('p', { class: 'hint' }, 'Loading...'));
    let data;
    try {
      data = await api('GET', '/api/admin/settings', undefined, { admin: true });
    } catch (error) {
      body.replaceChildren();
      if (error.status === 403) {
        const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Admin key' });
        const unlock = () => { state.adminKey = input.value.trim(); store.set('adminKey', state.adminKey); body.replaceChildren(); buildAdmin(body); };
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') unlock(); });
        body.append(h('h3', null, 'Admin'), h('p', { class: 'hint' }, 'This server requires an admin key (ADMIN_API_KEY).'),
          field('Admin key', h('div', { class: 'row' }, input, h('button', { class: 'btn primary small', onclick: unlock }, 'Unlock'))),
          state.adminKey ? h('div', { class: 'form-error' }, 'That admin key was not accepted.') : null);
      } else body.append(h('div', { class: 'form-error' }, error.message));
      return;
    }
    body.replaceChildren();

    const appName = h('input', { type: 'text', maxlength: 40, value: data.appName });
    const system = h('textarea', { maxlength: 3000, placeholder: 'e.g. You are a helpful assistant for our team. Answer briefly.' });
    system.value = data.systemPrompt;
    const defaultMode = h('select', null, h('option', { value: 'quick' }, 'Quick response'), h('option', { value: 'deep' }, 'Think deeper'));
    defaultMode.value = data.defaultMode;
    const cards = { quick: modeCard('quick', data.modes.quick), deep: modeCard('deep', data.modes.deep) };

    let starters = data.starters.map((s) => ({ ...s }));
    const starterList = h('div');
    const drawStarters = () => {
      starterList.replaceChildren(...starters.map((s, index) => {
        const label = h('input', { type: 'text', maxlength: 30, value: s.label, placeholder: 'Label', 'aria-label': 'Starter label' });
        const prompt = h('input', { type: 'text', maxlength: 1000, value: s.prompt, placeholder: 'Prompt text', 'aria-label': 'Starter prompt' });
        label.addEventListener('input', () => { s.label = label.value; });
        prompt.addEventListener('input', () => { s.prompt = prompt.value; });
        return h('div', { class: 'starter-row' }, label, prompt,
          h('button', { class: 'icon-btn', 'aria-label': 'Remove starter', onclick: () => { starters.splice(index, 1); drawStarters(); }, html: icon('x', 16) }));
      }));
    };
    drawStarters();

    const errorLine = h('div', { class: 'form-error' });
    const save = h('button', { class: 'btn primary', onclick: async () => {
      errorLine.textContent = '';
      let payload;
      try {
        payload = {
          appName: appName.value, systemPrompt: system.value, defaultMode: defaultMode.value,
          modes: { quick: cards.quick.get(), deep: cards.deep.get() },
          starters: starters.filter((s) => s.label.trim()),
        };
      } catch (error) { errorLine.textContent = error.message; return; }
      try {
        await api('PUT', '/api/admin/settings', payload, { admin: true });
        state.boot = await api('GET', '/api/bootstrap');
        applyBoot();
        toast('Admin settings saved');
      } catch (error) { errorLine.textContent = error.message; }
    } }, 'Save changes');
    const reset = h('button', { class: 'btn', onclick: async () => {
      if (!(await confirmDialog({ title: 'Reset admin settings?', message: 'Prompts, mode overrides and starters return to their defaults.', confirmLabel: 'Reset', danger: true }))) return;
      try {
        await api('POST', '/api/admin/settings/reset', undefined, { admin: true });
        state.boot = await api('GET', '/api/bootstrap');
        applyBoot();
        body.replaceChildren();
        buildAdmin(body);
      } catch (error) { toast(error.message); }
    } }, 'Reset to defaults');

    body.append(
      h('h3', null, 'Instructions'),
      field('System prompt', system, 'Sent at the start of every chat and again whenever it changes. Copilot has no separate system field, so it is written ahead of the first message.'),
      field('App name', appName),
      field('Default mode', defaultMode),
      h('h3', null, 'Modes'),
      cards.quick.node, cards.deep.node,
      h('h3', null, 'Starter prompts'),
      h('p', { class: 'hint' }, 'Shown under the message box on a new chat.'),
      starterList,
      h('button', { class: 'btn small', onclick: () => { if (starters.length < 8) { starters.push({ label: '', icon: '', prompt: '' }); drawStarters(); } } }, 'Add starter'),
      errorLine,
      h('div', { class: 'sticky-save' }, reset, save),
    );
  }

  // ---------- boot ----------
  function applyIdentity() {
    const name = state.boot.preferences.displayName;
    const email = state.boot.identity?.email ?? '';
    $('userName').textContent = name || email || 'Account';
    $('avatar').textContent = (name || email || state.boot.appName || '?').trim().charAt(0).toUpperCase() || '?';
    $('userSub').textContent = state.boot.mock ? 'Mock Copilot' : (email || 'Settings');
    $('greeting').textContent = greetingText();
  }

  function applyBoot() {
    const boot = state.boot;
    if (!modeInfo(state.mode)) state.mode = boot.defaultMode;
    $('brandName').textContent = boot.appName;
    $('disclaimer').textContent = `${boot.appName} can make mistakes. Please double-check responses.`;
    applyIdentity();
    $('chips').replaceChildren(...boot.starters.map((starter) => h('button', {
      class: 'chip',
      onclick: () => {
        $('input').value = starter.prompt;
        updateComposer();
        $('input').focus();
        $('input').setSelectionRange(starter.prompt.length, starter.prompt.length);
      },
      html: `${ICONS[starter.icon] ? icon(starter.icon, 16) : ''}<span>${esc(starter.label)}</span>`,
    })));
    renderHeader();
    updateComposer();
  }

  async function start(boot) {
    state.boot = boot;
    applyBoot();
    await refreshList();
    route();
  }

  async function init() {
    hydrateIcons();
    applyTheme();
    const open = window.innerWidth > 820 && store.get('sidebar', 'open') !== 'closed';
    $('app').classList.toggle('side-closed', !open);
    try {
      const res = await fetch('/api/auth/status');
      const status = await res.json();
      if (status.signedIn) await initSignedIn();
      else showLogin();
    } catch (error) {
      document.body.append(h('div', { class: 'toast' }, `Cannot reach the server: ${error.message}`));
    }
  }

  async function initSignedIn() {
    try {
      await start(await api('GET', '/api/bootstrap', undefined, { quiet: true }));
    } catch (error) {
      if (error.status === 401) showLogin({ message: error.message });
      else { document.body.append(h('div', { class: 'toast' }, `Cannot reach the server: ${error.message}`)); }
    }
  }

  init();
})();
