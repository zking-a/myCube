'use strict';

const CONFIG = {
  AI_LEVEL_KEY: 'chinese_checkers_ai_level',
  BOT_LEVEL_KEY: 'chinese_checkers_online_bot_level',
  NICK_KEY: 'light_games_nickname',
  SAVE_PREFIX: 'chinese_checkers_save_v2_',
  ROOM_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  ROOM_RE: /^[A-HJ-NP-Z2-9]{5}$/
};
const AI_LEVELS = ['easy', 'normal', 'hard'];

let aiLevel = 'normal';
let localPlayers = 2;
let localAi = 0;
let onlineBots = 0;
let onlineBotLevel = 'normal';
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
  if (message) {
    setModeConfig('online');
    setOnlineJoinConfig(true);
  }
  error.textContent = message;
  error.hidden = !message;
}

function setOnlineJoinConfig(open) {
  const config = $('joinRoomConfig');
  const trigger = $('openJoinRoomBtn');
  if (!config || !trigger) return;
  const visible = Boolean(open) && !$('onlineCard').hidden;
  config.hidden = !visible;
  trigger.setAttribute('aria-expanded', visible ? 'true' : 'false');
}

function setModeConfig(mode) {
  const aiOpen = mode === 'ai';
  const localOpen = mode === 'local';
  const onlineOpen = mode === 'online';
  $('aiConfig').hidden = !aiOpen;
  $('localConfig').hidden = !localOpen;
  $('onlineCard').hidden = !onlineOpen;
  $('selectAiBtn').setAttribute('aria-expanded', aiOpen ? 'true' : 'false');
  $('selectLocalBtn').setAttribute('aria-expanded', localOpen ? 'true' : 'false');
  $('selectOnlineBtn').setAttribute('aria-expanded', onlineOpen ? 'true' : 'false');
  setOnlineJoinConfig(false);
}

function toggleModeConfig(mode) {
  const config = mode === 'ai' ? $('aiConfig') : (mode === 'local' ? $('localConfig') : $('onlineCard'));
  setModeConfig(config.hidden ? mode : '');
}

function refreshLocalSeatUi() {
  document.querySelectorAll('[data-players]').forEach(function (button) {
    const active = Number(button.dataset.players) === localPlayers;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-ai]').forEach(function (button) {
    const value = Number(button.dataset.ai);
    const allowed = value <= localPlayers - 1;
    button.disabled = !allowed;
    const active = allowed && value === localAi;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  $('localSeatHint').textContent = '共 ' + localPlayers + ' 个席位' +
    (localAi ? '，其中 ' + localAi + ' 个由电脑代走。' : '，全部由玩家同屏轮流。');
}

function selectLocalPlayers(count) {
  localPlayers = Math.max(2, Math.min(6, Math.floor(Number(count) || 2)));
  if (localAi > localPlayers - 1) localAi = localPlayers - 1;
  refreshLocalSeatUi();
}

function selectLocalAi(count) {
  localAi = Math.max(0, Math.min(4, Math.floor(Number(count) || 0)));
  if (localAi > localPlayers - 1) localAi = localPlayers - 1;
  refreshLocalSeatUi();
}

function refreshOnlineBotUi() {
  document.querySelectorAll('[data-bots]').forEach(function (button) {
    const active = Number(button.dataset.bots) === onlineBots;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-bot-level]').forEach(function (button) {
    const active = button.dataset.botLevel === onlineBotLevel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  const hint = $('onlineBotHint');
  if (hint) {
    hint.textContent = onlineBots
      ? '创建后房间共 ' + (2 + onlineBots) + ' 席：你们两位真人 + ' + onlineBots + ' 个电脑（' +
        ({ easy: '轻松', normal: '标准', hard: '困难' }[onlineBotLevel]) + '），好友加入即开局。'
      : '不加电脑则为经典双人房，好友加入后开局。';
  }
}

function selectOnlineBots(count) {
  onlineBots = Math.max(0, Math.min(4, Math.floor(Number(count) || 0)));
  refreshOnlineBotUi();
}

function selectOnlineBotLevel(level) {
  onlineBotLevel = AI_LEVELS.includes(level) ? level : 'normal';
  safeSet(CONFIG.BOT_LEVEL_KEY, onlineBotLevel);
  refreshOnlineBotUi();
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
  aiLevel = AI_LEVELS.includes(level) ? level : 'normal';
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
  aiLevel = AI_LEVELS.includes(safeGet(CONFIG.AI_LEVEL_KEY)) ? safeGet(CONFIG.AI_LEVEL_KEY) : 'normal';
  selectLevel(aiLevel);
  $('nickInput').value = safeGet(CONFIG.NICK_KEY) || '玩家';
  $('startAiLabel').textContent = hasSavedGame('ai') ? '继续人机对战' : '开始人机对战';
  $('startLocalLabel').textContent = hasSavedGame('local') ? '继续本地对战' : '本地对战';

  const launchParams = new URLSearchParams(location.search);
  const invitedRoom = normalizeRoom(launchParams.get('room'));
  const launchError = String(launchParams.get('error') || '').slice(0, 80);
  if (invitedRoom) {
    $('roomInput').value = invitedRoom;
    setModeConfig('online');
    setOnlineJoinConfig(true);
    $('onlineCard').classList.add('invited');
    setTimeout(function () { $('onlineCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
  }
  if (launchError) {
    showError(launchError);
    setModeConfig('online');
    setOnlineJoinConfig(true);
    $('onlineCard').classList.add('invited');
    setTimeout(function () { $('onlineCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
  }

  document.querySelectorAll('[data-level]').forEach(function (button) {
    button.addEventListener('click', function () { selectLevel(button.dataset.level); });
  });
  document.querySelectorAll('[data-players]').forEach(function (button) {
    button.addEventListener('click', function () { selectLocalPlayers(button.dataset.players); });
  });
  document.querySelectorAll('[data-ai]').forEach(function (button) {
    button.addEventListener('click', function () { selectLocalAi(button.dataset.ai); });
  });
  selectLocalPlayers(localPlayers);
  selectLocalAi(localAi);
  onlineBotLevel = AI_LEVELS.includes(safeGet(CONFIG.BOT_LEVEL_KEY)) ? safeGet(CONFIG.BOT_LEVEL_KEY) : 'normal';
  refreshOnlineBotUi();
  document.querySelectorAll('[data-bots]').forEach(function (button) {
    button.addEventListener('click', function () { selectOnlineBots(button.dataset.bots); });
  });
  document.querySelectorAll('[data-bot-level]').forEach(function (button) {
    button.addEventListener('click', function () { selectOnlineBotLevel(button.dataset.botLevel); });
  });
  $('selectAiBtn').addEventListener('click', function () { toggleModeConfig('ai'); });
  $('selectLocalBtn').addEventListener('click', function () { toggleModeConfig('local'); });
  $('selectOnlineBtn').addEventListener('click', function () { toggleModeConfig('online'); });
  $('openJoinRoomBtn').addEventListener('click', function () {
    const opening = $('joinRoomConfig').hidden;
    setOnlineJoinConfig(opening);
    if (opening) $('roomInput').focus();
  });
  $('roomInput').addEventListener('input', function () {
    $('roomInput').value = normalizeRoom($('roomInput').value);
    showError('');
  });
  $('startAiBtn').addEventListener('click', function () {
    const params = { mode: 'ai', level: aiLevel };
    goToGame(params);
  });
  $('startLocalBtn').addEventListener('click', function () {
    const params = localPlayers === 2 && localAi === 0 ? { mode: 'local' } : { mode: 'local', players: localPlayers, ai: localAi };
    goToGame(params);
  });
  $('createRoomBtn').addEventListener('click', function () {
    saveNickname();
    const params = { mode: 'online', intent: 'create', room: randomRoom() };
    if (onlineBots) { params.bots = onlineBots; params.level = onlineBotLevel; }
    goToGame(params);
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
