/**
 * Chat Room Module — human-only, real-time group chat over WebSocket.
 *
 * No AI is involved. Mirrors the Calendar tool's floating/draggable modal
 * pattern (see calendar.js): a `.modal` > `.modal-content` element made
 * draggable via makeWindowDraggable and registered with modalManager so it
 * minimizes/restores to the bottom dock like every other tool window.
 *
 * Messages are kept in server memory (last 100); the backend lives in
 * routes/chatroom_routes.py and is reachable over a Cloudflare Tunnel.
 */

import uiModule from './ui.js';
import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';

const NAME_KEY = 'odysseus-chatroom-name';

// A compact, curated emoji set for the picker (no external library needed).
const CHATROOM_EMOJIS = [
  '😀','😄','😁','😂','🤣','😊','😍','😘','😉','😎','🤩','🥳','😋','🤔','🤨','😐',
  '😴','😢','😭','😤','😡','🥺','😱','😬','🙄','😏','😅','😇','🤗','🤭','🤫','🫡',
  '👍','👎','👏','🙌','🙏','💪','🤝','👋','✌️','🤞','🫶','👌','🤙','💯','🔥','✨',
  '❤️','🧡','💛','💚','💙','💜','🖤','💔','💕','💖','⭐','🎉','🎊','🎁','✅','❌',
];

// Insert text into an <input> at the caret, preserving focus/selection.
function _insertAtCaret(input, text) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const pos = start + text.length;
  input.focus();
  try { input.setSelectionRange(pos, pos); } catch {}
}

let _modal = null;
let _open = false;
let _ws = null;
let _name = '';
let _online = [];
let _escHandler = null;
let _reconnectTimer = null;
let _intentionalClose = false;

function _esc(s) {
  return uiModule.esc ? uiModule.esc(s || '') : String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _savedName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}
function _saveName(n) {
  try { localStorage.setItem(NAME_KEY, n); } catch {}
}

// ── Modal ──

function _getModal() {
  if (_modal) return _modal;
  _modal = document.createElement('div');
  _modal.id = 'chatroom-modal';
  _modal.className = 'modal';
  _modal.style.display = 'none';
  _modal.innerHTML = `
    <div class="modal-content chatroom-modal-content">
      <div class="modal-header">
        <h4><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>Chat Room<span class="chatroom-status" id="chatroom-status"></span></h4>
        <div class="chatroom-header-actions">
          <button class="chatroom-clear-btn" id="chatroom-clear" title="Clear all messages (admin only)" style="display:none">Clear</button>
          <button class="close-btn" id="chatroom-close">✖</button>
        </div>
      </div>
      <div class="modal-body chatroom-body" id="chatroom-body">
        <div class="chatroom-namegate" id="chatroom-namegate">
          <div class="chatroom-namegate-title">Join the room</div>
          <p class="chatroom-namegate-sub">Pick a display name others will see.</p>
          <input type="text" id="chatroom-name-input" class="chatroom-input" maxlength="32" placeholder="Your name" autocomplete="off" />
          <button class="chatroom-btn chatroom-btn-primary" id="chatroom-join-btn">Join chat</button>
        </div>
        <div class="chatroom-main" id="chatroom-main" style="display:none">
          <div class="chatroom-online" id="chatroom-online"></div>
          <div class="chatroom-messages" id="chatroom-messages"></div>
          <div class="chatroom-emoji-picker" id="chatroom-emoji-picker" style="display:none"></div>
          <form class="chatroom-inputrow" id="chatroom-form">
            <button type="button" class="chatroom-icon-btn" id="chatroom-emoji-btn" title="Emoji">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
            </button>
            <button type="button" class="chatroom-icon-btn" id="chatroom-image-btn" title="Send image">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            </button>
            <input type="text" id="chatroom-msg-input" class="chatroom-input" maxlength="2000" placeholder="Message…" autocomplete="off" />
            <button type="submit" class="chatroom-btn chatroom-btn-primary chatroom-send">Send</button>
          </form>
          <input type="file" id="chatroom-file-input" accept="image/*" style="display:none" />
        </div>
      </div>
    </div>`;
  document.body.appendChild(_modal);

  _modal.querySelector('#chatroom-close').addEventListener('click', closeChatRoom);

  // Join via the name gate
  const nameInput = _modal.querySelector('#chatroom-name-input');
  const joinBtn = _modal.querySelector('#chatroom-join-btn');
  const doJoin = () => {
    const n = (nameInput.value || '').trim().slice(0, 32);
    if (!n) { nameInput.focus(); return; }
    _name = n;
    _saveName(n);
    _showChat();
    _connect();
  };
  joinBtn.addEventListener('click', doJoin);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });

  // Send a message
  const form = _modal.querySelector('#chatroom-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = _modal.querySelector('#chatroom-msg-input');
    const text = (input.value || '').trim();
    if (!text) return;
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: 'message', text }));
      input.value = '';
    } else {
      uiModule.showError?.('Not connected — reconnecting…');
    }
  });

  // Emoji picker — pure client-side, works for everyone. Toggles a popover of
  // common emoji; clicking one inserts it into the message input at the caret.
  const emojiBtn = _modal.querySelector('#chatroom-emoji-btn');
  const picker = _modal.querySelector('#chatroom-emoji-picker');
  picker.innerHTML = CHATROOM_EMOJIS
    .map(e => `<button type="button" class="chatroom-emoji" tabindex="-1">${e}</button>`).join('');
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    picker.style.display = picker.style.display === 'none' ? '' : 'none';
  });
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('.chatroom-emoji');
    if (!b) return;
    _insertAtCaret(_modal.querySelector('#chatroom-msg-input'), b.textContent);
    picker.style.display = 'none';
  });
  // Dismiss the picker on any outside click.
  document.addEventListener('click', (e) => {
    if (picker.style.display !== 'none' && !picker.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) {
      picker.style.display = 'none';
    }
  });

  // Image upload — uses the existing auth'd /api/upload. Since the UI requires
  // login, every chat participant can upload AND view. The sent message carries
  // only the returned upload id (validated server-side).
  const imageBtn = _modal.querySelector('#chatroom-image-btn');
  const fileInput = _modal.querySelector('#chatroom-file-input');
  imageBtn.addEventListener('click', () => fileInput.click());

  // Click a posted image to open it in the lightbox (delegated so it covers
  // images added later). Replaces the old download-on-click behavior.
  _modal.querySelector('#chatroom-messages').addEventListener('click', (e) => {
    const img = e.target.closest('.chatroom-msg-img');
    if (img?.dataset.full) _openLightbox(img.dataset.full);
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';  // reset so the same file can be re-picked
    if (!file) return;
    if (!file.type.startsWith('image/')) { uiModule.showError?.('Please pick an image'); return; }
    if (file.size > 15 * 1024 * 1024) { uiModule.showError?.('Image too large (max 15 MB)'); return; }
    if (!_ws || _ws.readyState !== WebSocket.OPEN) { uiModule.showError?.('Not connected'); return; }
    _setStatus('uploading…');
    try {
      const fd = new FormData();
      fd.append('files', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) {
        uiModule.showError?.(res.status === 401 ? 'Sign in to send images' : 'Upload failed');
        _setStatus('online', 'ok');
        return;
      }
      const data = await res.json();
      const id = data.files?.[0]?.id;
      if (!id) { uiModule.showError?.('Upload failed'); _setStatus('online', 'ok'); return; }
      const input = _modal.querySelector('#chatroom-msg-input');
      const text = (input.value || '').trim();
      _ws.send(JSON.stringify({ type: 'message', text, image: id }));
      input.value = '';
      _setStatus('online', 'ok');
    } catch {
      uiModule.showError?.('Upload failed');
      _setStatus('online', 'ok');
    }
  });

  // Clear all messages (admin only — the button is hidden for non-admins and
  // the server re-checks admin on POST, so hiding it is just UX).
  _modal.querySelector('#chatroom-clear').addEventListener('click', async () => {
    if (!confirm('Clear all messages for everyone? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/chatroom/clear', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        uiModule.showError?.(res.status === 403 ? 'Admins only' : 'Failed to clear');
        return;
      }
      // The server broadcasts a "clear" event to every client (incl. us), so
      // the message list empties via _handle — no local clearing needed here.
    } catch {
      uiModule.showError?.('Failed to clear');
    }
  });

  // Make draggable — same shared helper Calendar uses. No fullscreen snap.
  const content = _modal.querySelector('.modal-content');
  const header = _modal.querySelector('.modal-header');
  if (content && header) makeWindowDraggable(_modal, { content, header });

  return _modal;
}

function _setStatus(text, kind) {
  const el = document.getElementById('chatroom-status');
  if (!el) return;
  el.textContent = text ? `· ${text}` : '';
  el.dataset.kind = kind || '';
}

function _showNameGate() {
  const gate = document.getElementById('chatroom-namegate');
  const main = document.getElementById('chatroom-main');
  if (gate) gate.style.display = '';
  if (main) main.style.display = 'none';
  const input = document.getElementById('chatroom-name-input');
  if (input) { input.value = _savedName(); setTimeout(() => input.focus(), 30); }
}

// Reveal the admin-only Clear button. `window._isAdmin` is populated by app.js
// from /api/auth/status on load; fall back to a fetch if it isn't ready yet.
function _refreshAdminControls() {
  const btn = document.getElementById('chatroom-clear');
  if (!btn) return;
  if (window._isAdmin === true) { btn.style.display = ''; return; }
  if (window._isAdmin === false) { btn.style.display = 'none'; return; }
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      window._isAdmin = !!d.is_admin;
      btn.style.display = window._isAdmin ? '' : 'none';
    })
    .catch(() => { btn.style.display = 'none'; });
}

function _showChat() {
  const gate = document.getElementById('chatroom-namegate');
  const main = document.getElementById('chatroom-main');
  if (gate) gate.style.display = 'none';
  if (main) main.style.display = '';
  setTimeout(() => document.getElementById('chatroom-msg-input')?.focus(), 30);
}

// ── WebSocket ──

function _connect() {
  _intentionalClose = false;
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  _setStatus('connecting');
  try {
    _ws = new WebSocket(`${proto}://${location.host}/ws/chatroom`);
  } catch {
    _scheduleReconnect();
    return;
  }
  _ws.addEventListener('open', () => {
    _setStatus('online', 'ok');
    _ws.send(JSON.stringify({ type: 'join', username: _name }));
  });
  _ws.addEventListener('message', (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    _handle(data);
  });
  _ws.addEventListener('close', () => {
    if (_intentionalClose) return;
    _setStatus('offline', 'warn');
    if (_open) _scheduleReconnect();
  });
  _ws.addEventListener('error', () => { try { _ws.close(); } catch {} });
}

function _scheduleReconnect() {
  if (_reconnectTimer || _intentionalClose) return;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    if (_open && !_intentionalClose) _connect();
  }, 2000);
}

function _disconnect() {
  _intentionalClose = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) { try { _ws.close(); } catch {} _ws = null; }
}

function _handle(data) {
  switch (data.type) {
    case 'history':
      _renderHistory(data.messages || []);
      break;
    case 'message':
      _appendMessage(data);
      break;
    case 'clear':
      _renderHistory([]);
      break;
    case 'error':
      // Server rejected us (e.g. not signed in). Stop the reconnect loop and
      // tell the user instead of silently flapping between connecting/offline.
      if (data.reason === 'auth') {
        _intentionalClose = true;
        if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
        _setStatus('sign in to chat', 'warn');
        _appendSystem('You must be signed in to use the chat room.');
      }
      break;
    case 'presence':
      _online = Array.isArray(data.online) ? data.online : [];
      _renderOnline();
      if (data.event === 'join' || data.event === 'leave') {
        _appendSystem(`${data.username} ${data.event === 'join' ? 'joined' : 'left'}`);
      }
      break;
  }
}

// ── Render ──

function _fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── Image lightbox ──
// Click a chat image to view it large (fit-to-screen); click the image again
// to toggle original 1:1 size; click the backdrop / × / Esc to close.
let _lightboxEl = null;

function _openLightbox(src) {
  if (!_lightboxEl) {
    _lightboxEl = document.createElement('div');
    _lightboxEl.className = 'chatroom-lightbox';
    _lightboxEl.style.display = 'none';
    _lightboxEl.innerHTML =
      '<button class="chatroom-lightbox-close" title="Close">✖</button>' +
      '<img class="chatroom-lightbox-img" alt="image">';
    document.body.appendChild(_lightboxEl);
    const imgEl = _lightboxEl.querySelector('.chatroom-lightbox-img');
    _lightboxEl.addEventListener('click', (e) => {
      // Clicking the backdrop or the × closes; clicking the image itself
      // toggles between fit-to-screen and original size.
      if (e.target === imgEl) { imgEl.classList.toggle('zoomed'); return; }
      _closeLightbox();
    });
  }
  const img = _lightboxEl.querySelector('.chatroom-lightbox-img');
  img.classList.remove('zoomed');
  img.src = src;
  _lightboxEl.style.display = 'flex';
}

function _closeLightbox() {
  if (!_lightboxEl) return;
  _lightboxEl.style.display = 'none';
  _lightboxEl.querySelector('.chatroom-lightbox-img').src = '';
}

function _isLightboxOpen() {
  return _lightboxEl && _lightboxEl.style.display !== 'none';
}

function _messageHtml(m) {
  const mine = m.username === _name ? ' chatroom-msg-mine' : '';
  const textHtml = m.text ? `<div class="chatroom-msg-text">${_esc(m.text)}</div>` : '';
  // m.image is a server-validated upload id; build the same-origin URL. Clicking
  // the thumbnail opens an in-app lightbox (see the delegated handler in
  // _getModal) instead of downloading the file.
  const imgHtml = m.image
    ? `<img class="chatroom-msg-img" src="/api/upload/${encodeURIComponent(m.image)}" data-full="/api/upload/${encodeURIComponent(m.image)}" alt="image" loading="lazy">`
    : '';
  return `<div class="chatroom-msg${mine}">
    <div class="chatroom-msg-meta"><span class="chatroom-msg-user">${_esc(m.username)}</span><span class="chatroom-msg-time">${_esc(_fmtTime(m.ts))}</span></div>
    ${textHtml}${imgHtml}
  </div>`;
}

function _atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
}

function _scrollToBottom(box) {
  box.scrollTop = box.scrollHeight;
}

function _renderHistory(messages) {
  const box = document.getElementById('chatroom-messages');
  if (!box) return;
  box.innerHTML = messages.length
    ? messages.map(_messageHtml).join('')
    : '<div class="chatroom-empty">No messages yet — say hello 👋</div>';
  _scrollToBottom(box);
}

function _appendMessage(m) {
  const box = document.getElementById('chatroom-messages');
  if (!box) return;
  const empty = box.querySelector('.chatroom-empty');
  if (empty) empty.remove();
  const stick = _atBottom(box);
  box.insertAdjacentHTML('beforeend', _messageHtml(m));
  if (stick || m.username === _name) _scrollToBottom(box);
}

function _appendSystem(text) {
  const box = document.getElementById('chatroom-messages');
  if (!box) return;
  const stick = _atBottom(box);
  box.insertAdjacentHTML('beforeend', `<div class="chatroom-sys">${_esc(text)}</div>`);
  if (stick) _scrollToBottom(box);
}

function _renderOnline() {
  const el = document.getElementById('chatroom-online');
  if (!el) return;
  const count = _online.length;
  el.innerHTML =
    `<span class="chatroom-online-dot"></span>` +
    `<span class="chatroom-online-count">${count} online</span>` +
    _online.map(n => `<span class="chatroom-online-chip">${_esc(n)}</span>`).join('');
}

// ── Open / close ──

function openChatRoom() {
  if (_open) return;
  if (Modals.isMinimized('chatroom-modal')) {
    Modals.restore('chatroom-modal');
    _open = true;
    if (!_ws || _ws.readyState > WebSocket.OPEN) _connect();
    return;
  }
  _open = true;
  const modal = _getModal();
  modal.classList.remove('hidden', 'modal-minimized');
  modal.style.display = 'flex';
  Modals.register('chatroom-modal', {
    railBtnId: 'rail-chatroom',
    sidebarBtnId: 'tool-chatroom-btn',
    closeFn: () => _doCloseChatRoom(),
    restoreFn: () => {},
  });
  _escHandler = (e) => {
    if (e.key !== 'Escape') return;
    // Layer Esc: close the lightbox first if it's open, only then the panel.
    if (_isLightboxOpen()) { _closeLightbox(); return; }
    closeChatRoom();
  };
  document.addEventListener('keydown', _escHandler);
  _refreshAdminControls();

  // Already named (returning user) → straight into the chat + connect.
  const saved = _savedName();
  if (saved) {
    _name = saved;
    _showChat();
    _connect();
  } else {
    _showNameGate();
  }
}

function _doCloseChatRoom() {
  _open = false;
  _closeLightbox();
  _disconnect();
  if (_modal) {
    _modal.style.display = 'none';
    _modal.classList.add('hidden');
  }
  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
}

function closeChatRoom() {
  if (!_open && !Modals.isMinimized('chatroom-modal')) return;
  if (Modals.isRegistered('chatroom-modal')) {
    Modals.close('chatroom-modal');
  } else {
    _doCloseChatRoom();
  }
}

function isChatRoomOpen() {
  if (Modals.isMinimized('chatroom-modal')) return false;
  return _open;
}

const chatroomModule = { openChatRoom, closeChatRoom, isChatRoomOpen };
export { openChatRoom, closeChatRoom, isChatRoomOpen };
export default chatroomModule;
