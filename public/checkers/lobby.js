'use strict';

const CONFIG = {
  AI_LEVEL_KEY: 'chinese_checkers_ai_level',
  NICK_KEY: 'light_games_nickname',
  SAVE_PREFIX: 'chinese_checkers_save_v2_',
  ROOM_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  ROOM_RE: /^[A-HJ-NP-Z2-9]{5}$/
};

let aiLevel = 'normal';
function $(id) { return document.getElementById(id); }
function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

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

function showError(message) {
  const error = $('fieldError');
  if (message) setModeConfig('online');
  error.textContent = message;
  error.hidden = !message;
}

function setModeConfig(mode) {
  const aiOpen = mode === 'ai';
  const onlineOpen = mode === 'online';
  $('aiConfig').hidden = !aiOpen;
  $('onlineCard').hidden = !onlineOpen;
  $('selectAiBtn').setAttribute('aria-expanded', aiOpen ? 'true' : 'false');
  $('selectOnlineBtn').setAttribute('aria-expanded', onlineOpen ? 'true' : 'false');
}

function toggleModeConfig(mode) {
  const config = mode === 'ai' ? $('aiConfig') : $('onlineCard');
  setModeConfig(config.hidden ? mode : '');
}

function goToGame(params) {
  const query = new URLSearchParams(params);
  location.href = 'play.html?' + query.toString();
}

function saveNickname() {
  const nick = String($('nickInput').value || '').trim().slice(0, 16) || '玩家';
  safeSet(CONFIG.NICK_KEY, nick);
  return nick;
}

function selectLevel(level) {
  aiLevel = ['easy', 'normal', 'hard'].includes(level) ? level : 'normal';
  safeSet(CONFIG.AI_LEVEL_KEY, aiLevel);
  document.querySelectorAll('[data-level]').forEach(function (button) {
    const active = button.dataset.level === aiLevel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function hasSavedGame(mode) {
  try {
    const raw = JSON.parse(safeGet(CONFIG.SAVE_PREFIX + mode) || 'null');
    return !!(raw && Number(raw.moveNumber) > 1 && !raw.winner);
  } catch (e) { return false; }
}

function init() {
  aiLevel = ['easy', 'normal', 'hard'].includes(safeGet(CONFIG.AI_LEVEL_KEY)) ? safeGet(CONFIG.AI_LEVEL_KEY) : 'normal';
  selectLevel(aiLevel);
  $('nickInput').value = safeGet(CONFIG.NICK_KEY) || '玩家';
  $('startAiLabel').textContent = hasSavedGame('ai') ? '继续人机对战' : '开始人机对战';
  $('startLocalLabel').textContent = hasSavedGame('local') ? '继续本地对战' : '开始本地对战';

  const launchParams = new URLSearchParams(location.search);
  const invitedRoom = normalizeRoom(launchParams.get('room'));
  const launchError = String(launchParams.get('error') || '').slice(0, 80);
  if (invitedRoom) {
    $('roomInput').value = invitedRoom;
    setModeConfig('online');
    $('onlineCard').classList.add('invited');
    setTimeout(function () { $('onlineCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
  }
  if (launchError) {
    showError(launchError);
    setModeConfig('online');
    $('onlineCard').classList.add('invited');
    setTimeout(function () { $('onlineCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
  }

  document.querySelectorAll('[data-level]').forEach(function (button) {
    button.addEventListener('click', function () { selectLevel(button.dataset.level); });
  });
  $('selectAiBtn').addEventListener('click', function () { toggleModeConfig('ai'); });
  $('selectOnlineBtn').addEventListener('click', function () { toggleModeConfig('online'); });
  $('roomInput').addEventListener('input', function () {
    $('roomInput').value = normalizeRoom($('roomInput').value);
    showError('');
  });
  $('startAiBtn').addEventListener('click', function () { goToGame({ mode: 'ai', level: aiLevel }); });
  $('startLocalBtn').addEventListener('click', function () { goToGame({ mode: 'local' }); });
  $('createRoomBtn').addEventListener('click', function () {
    saveNickname();
    goToGame({ mode: 'online', intent: 'create', room: randomRoom() });
  });
  $('joinRoomBtn').addEventListener('click', function () {
    saveNickname();
    const room = normalizeRoom($('roomInput').value);
    if (!CONFIG.ROOM_RE.test(room)) { showError('请输入邀请中的 5 位房间码'); $('roomInput').focus(); return; }
    goToGame({ mode: 'online', intent: 'join', room: room });
  });
}

window.__checkersLobbyTest = { normalizeRoom: normalizeRoom, hasSavedGame: hasSavedGame };
window.addEventListener('DOMContentLoaded', init);
