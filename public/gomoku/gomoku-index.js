'use strict';

const SAVE_KEYS = {
  ai: 'gomoku_save_ai_v1'
};

const CONFIG = {
  NICK_KEY: 'light_games_nickname',
  AI_LEVEL_KEY: 'light_games_gomoku_ai_level',
  ROOM_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  ROOM_RE: /^[A-HJ-NP-Z2-9]{5}$/
};

function $(id) { return document.getElementById(id); }

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (error) {}
}

function loadMeta(mode) {
  try {
    const raw = safeGet(SAVE_KEYS[mode]);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.mode !== mode || data.finished) return null;
    if (!Number.isInteger(data.moveNumber) || data.moveNumber <= 0) return null;
    return data;
  } catch (error) {
    return null;
  }
}

function updateModeButton(button, meta, baseLabel) {
  if (!button) return;
  if (!meta) return;
  const label = `${baseLabel}（继续 ${meta.modeLabel || '上局'} · ${meta.moveNumber} 步）`;
  button.textContent = label;
}

function normalizeMeta(meta) {
  const created = Number.isFinite(Number(meta.createdAt)) ? new Date(meta.createdAt) : null;
  const at = Number.isFinite(Number(meta.updatedAt)) ? new Date(meta.updatedAt) : null;
  const now = Date.now();
  const stamp = at ? new Date(at).toLocaleString() : '';
  const ageText = created ? `${Math.max(1, Math.floor((now - new Date(created).getTime()) / (60 * 1000)))} 分钟前` : '';
  return {
    moveText: `${meta.moveNumber} 步`,
    updatedText: stamp || ageText || '进行中'
  };
}

function bindMode(mode, buttonId, label) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  const meta = loadMeta(mode);
  if (meta) {
    const display = normalizeMeta(meta);
    button.textContent = `继续${display.moveText}`;
    button.setAttribute('aria-label', `${label}继续上局，共 ${display.moveText}`);
  }
  button.addEventListener('click', function () {
    const level = normalizeAiLevel(safeGet(CONFIG.AI_LEVEL_KEY));
    window.location.href = `play.html?mode=${mode}&level=${level}`;
  });
}

function normalizeAiLevel(value) {
  return ['easy', 'normal', 'hard'].includes(value) ? value : 'normal';
}

function initAiDifficulty() {
  const buttons = Array.from(document.querySelectorAll('[data-ai-level]'));
  if (!buttons.length) return;
  let selected = normalizeAiLevel(safeGet(CONFIG.AI_LEVEL_KEY));
  function render() {
    buttons.forEach(function (button) {
      const active = button.dataset.aiLevel === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      selected = normalizeAiLevel(button.dataset.aiLevel);
      safeSet(CONFIG.AI_LEVEL_KEY, selected);
      render();
    });
  });
  render();
}

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 5);
}

function randomRoom() {
  const bytes = new Uint8Array(5);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let room = '';
  for (let i = 0; i < bytes.length; i++) room += CONFIG.ROOM_ALPHABET[bytes[i] % CONFIG.ROOM_ALPHABET.length];
  return room;
}

function saveNickname() {
  const input = $('nickInput');
  const nick = String((input && input.value) || '').trim().slice(0, 16);
  safeSet(CONFIG.NICK_KEY, nick);
  return nick;
}

function showError(message) {
  const target = $('fieldError');
  if (!target) return;
  target.textContent = message;
  target.hidden = false;
}

function clearError() {
  const target = $('fieldError');
  if (!target) return;
  target.textContent = '';
  target.hidden = true;
}

function goToGame(params) {
  const query = new URLSearchParams(params || {});
  location.href = 'play.html' + (query.toString() ? '?' + query.toString() : '');
}

function initOnline() {
  const nickInput = $('nickInput');
  const createBtn = $('createRoomBtn');
  const openJoinBtn = $('openJoinBtn');
  const joinBtn = $('joinRoomBtn');
  const roomInput = $('roomInput');
  const joinConfig = $('joinConfig');
  if (!createBtn || !openJoinBtn || !joinBtn || !roomInput || !joinConfig) return;

  try { nickInput.value = safeGet(CONFIG.NICK_KEY) || ''; } catch (error) {}

  createBtn.addEventListener('click', function () {
    clearError();
    saveNickname();
    goToGame({ mode: 'online', intent: 'create', room: randomRoom() });
  });

  openJoinBtn.addEventListener('click', function () {
    clearError();
    saveNickname();
    const shouldOpen = joinConfig.hidden;
    joinConfig.hidden = !shouldOpen;
    openJoinBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
    if (shouldOpen) roomInput.focus();
  });

  joinBtn.addEventListener('click', function () {
    clearError();
    saveNickname();
    const room = normalizeRoom(roomInput.value);
    if (!CONFIG.ROOM_RE.test(room)) {
      showError('请输入邀请中的 5 位房间码');
      roomInput.focus();
      return;
    }
    goToGame({ mode: 'online', intent: 'join', room: room });
  });

  roomInput.addEventListener('input', clearError);
}

// 支持 /gomoku/?r=ABCDE 这样的邀请链接直达房间。
function redirectInvite() {
  const params = new URLSearchParams(window.location.search);
  const room = normalizeRoom(params.get('r') || params.get('room') || '');
  if (!CONFIG.ROOM_RE.test(room)) return;
  goToGame({ mode: 'online', intent: 'join', room: room });
}

function init() {
  redirectInvite();
  initAiDifficulty();
  bindMode('ai', 'startAiBtn', '单机人机');
  initOnline();
}

window.addEventListener('DOMContentLoaded', init);
