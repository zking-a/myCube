'use strict';

(function setupFlightChessLobby() {
  const CONFIG = {
    SAVE_KEY: 'light_games_flight_chess_save_v1',
    NICK_KEY: 'light_games_nickname',
    CPU_KEY: 'light_games_flight_chess_cpu_v1',
    ROOM_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    ROOM_RE: /^[A-HJ-NP-Z2-9]{5}$/
  };
  const PLAYER_HINTS = {
    2: '红蓝双方对角入场，节奏更快，适合两个人。',
    3: '三个阵营依次行动，路线碰撞更频繁。',
    4: '四个阵营全部入场，最热闹的经典玩法。'
  };
  let localPlayerCount = 4;
  let onlinePlayerCount = 2;
  let cpuTotal = 4;
  let cpuCount = 3;

  function $(id) { return document.getElementById(id); }
  function safeGet(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (error) {} }

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

  function readSavedGame() {
    try {
      const raw = JSON.parse(safeGet(CONFIG.SAVE_KEY) || 'null');
      const game = window.FlightChessCore && window.FlightChessCore.hydrateGame(raw);
      return game && game.phase !== 'gameover' ? game : null;
    } catch (error) {
      return null;
    }
  }

  function showError(message) {
    $('fieldError').textContent = message || '';
    $('fieldError').hidden = !message;
    if (message) {
      setModeConfig('online');
      setJoinOpen(true);
    }
  }

  function setJoinOpen(open) {
    const visible = Boolean(open) && !$('onlineConfig').hidden;
    $('joinConfig').hidden = !visible;
    $('openJoinBtn').setAttribute('aria-expanded', visible ? 'true' : 'false');
  }

  function setModeConfig(mode) {
    const localOpen = mode === 'local';
    const onlineOpen = mode === 'online';
    const cpuOpen = mode === 'cpu';
    $('localConfig').hidden = !localOpen;
    $('onlineConfig').hidden = !onlineOpen;
    $('cpuConfig').hidden = !cpuOpen;
    $('selectLocalBtn').setAttribute('aria-expanded', localOpen ? 'true' : 'false');
    $('selectOnlineBtn').setAttribute('aria-expanded', onlineOpen ? 'true' : 'false');
    $('selectCpuBtn').setAttribute('aria-expanded', cpuOpen ? 'true' : 'false');
    if (!onlineOpen) setJoinOpen(false);
  }
  function selectCpuTotal(value) {
    cpuTotal = window.FlightChessCore.normalizePlayerCount(value);
    cpuCount = Math.min(Math.max(cpuCount, 1), cpuTotal - 1);
    document.querySelectorAll('[data-cpu-total]').forEach(function (button) {
      const active = Number(button.dataset.cpuTotal) === cpuTotal;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    updateCpuHint();
  }
  function selectCpuCount(value) {
    cpuCount = Math.min(Math.max(Number(value) || 1, 1), cpuTotal - 1);
    document.querySelectorAll('[data-cpu-count]').forEach(function (button) {
      const active = Number(button.dataset.cpuCount) === cpuCount;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    updateCpuHint();
  }
  function updateCpuHint() {
    const human = cpuTotal - cpuCount;
    $('cpuHint').textContent = '你执红方，' + cpuCount + ' 个电脑对手' + (human > 1 ? '（另有 ' + (human - 1) + ' 名真人）' : '') + '同时行动。';
  }

  function selectLocalPlayerCount(value) {
    localPlayerCount = window.FlightChessCore.normalizePlayerCount(value);
    document.querySelectorAll('[data-player-count]').forEach(function (button) {
      const active = Number(button.dataset.playerCount) === localPlayerCount;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    $('playerHint').textContent = PLAYER_HINTS[localPlayerCount];
    $('startGameLabel').textContent = '开始 ' + localPlayerCount + ' 人对战';
  }

  function selectOnlinePlayerCount(value) {
    onlinePlayerCount = window.FlightChessCore.normalizePlayerCount(value);
    document.querySelectorAll('[data-online-count]').forEach(function (button) {
      const active = Number(button.dataset.onlineCount) === onlinePlayerCount;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  function saveNickname() {
    const nick = String($('nickInput').value || '').trim().slice(0, 16) || '玩家';
    safeSet(CONFIG.NICK_KEY, nick);
    return nick;
  }

  function goToGame(params) {
    const query = new URLSearchParams(params || {});
    location.href = 'play.html' + (query.toString() ? '?' + query.toString() : '');
  }

  function init() {
    selectLocalPlayerCount(4);
    selectOnlinePlayerCount(2);
    selectCpuTotal(4);
    selectCpuCount(3);
    $('nickInput').value = safeGet(CONFIG.NICK_KEY) || '玩家';
    const saved = readSavedGame();
    if (saved) {
      $('resumeCard').hidden = false;
      $('resumeMeta').textContent = saved.playerCount + ' 人 · 第 ' + saved.turnNumber + ' 轮 · ' + saved.players[saved.currentPlayer].name + '行动';
    }

    const launchParams = new URLSearchParams(location.search);
    const invitedRoom = normalizeRoom(launchParams.get('room'));
    const launchError = String(launchParams.get('error') || '').slice(0, 80);
    if (invitedRoom || launchError) {
      $('roomInput').value = invitedRoom;
      setModeConfig('online');
      setJoinOpen(true);
      if (launchError) showError(launchError);
      window.setTimeout(function () { $('onlineConfig').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 120);
    }

    $('selectLocalBtn').addEventListener('click', function () {
      setModeConfig($('localConfig').hidden ? 'local' : '');
    });
    $('selectOnlineBtn').addEventListener('click', function () {
      setModeConfig($('onlineConfig').hidden ? 'online' : '');
    });
    document.querySelectorAll('[data-player-count]').forEach(function (button) {
      button.addEventListener('click', function () { selectLocalPlayerCount(button.dataset.playerCount); });
    });
    document.querySelectorAll('[data-online-count]').forEach(function (button) {
      button.addEventListener('click', function () { selectOnlinePlayerCount(button.dataset.onlineCount); });
    });
    $('openJoinBtn').addEventListener('click', function () {
      const opening = $('joinConfig').hidden;
      setJoinOpen(opening);
      if (opening) $('roomInput').focus();
    });
    $('roomInput').addEventListener('input', function () {
      $('roomInput').value = normalizeRoom($('roomInput').value);
      showError('');
    });
    $('resumeBtn').addEventListener('click', function () {
      const cpu = Number(safeGet(CONFIG.CPU_KEY)) || 0;
      goToGame({ mode: 'local', cpu: cpu || undefined });
    });
    $('startGameBtn').addEventListener('click', function () {
      if (saved && !window.confirm('开始新局会覆盖当前飞行棋进度，确定继续吗？')) return;
      safeSet(CONFIG.CPU_KEY, '');
      goToGame({ mode: 'local', players: localPlayerCount, new: 1 });
    });
    $('selectCpuBtn').addEventListener('click', function () {
      setModeConfig($('cpuConfig').hidden ? 'cpu' : '');
    });
    document.querySelectorAll('[data-cpu-total]').forEach(function (button) {
      button.addEventListener('click', function () { selectCpuTotal(button.dataset.cpuTotal); });
    });
    document.querySelectorAll('[data-cpu-count]').forEach(function (button) {
      button.addEventListener('click', function () { selectCpuCount(button.dataset.cpuCount); });
    });
    $('startCpuBtn').addEventListener('click', function () {
      if (saved && !window.confirm('开始新局会覆盖当前飞行棋进度，确定继续吗？')) return;
      const clamped = Math.min(Math.max(cpuCount, 1), cpuTotal - 1);
      safeSet(CONFIG.CPU_KEY, String(clamped));
      goToGame({ mode: 'local', players: cpuTotal, cpu: clamped, new: 1 });
    });
    $('createRoomBtn').addEventListener('click', function () {
      saveNickname();
      goToGame({ mode: 'online', intent: 'create', room: randomRoom(), players: onlinePlayerCount });
    });
    $('joinRoomBtn').addEventListener('click', function () {
      saveNickname();
      const room = normalizeRoom($('roomInput').value);
      if (!CONFIG.ROOM_RE.test(room)) { showError('请输入邀请中的 5 位房间码'); $('roomInput').focus(); return; }
      goToGame({ mode: 'online', intent: 'join', room: room });
    });
  }

  window.__flightChessLobbyTest = {
    normalizeRoom: normalizeRoom,
    readSavedGame: readSavedGame,
    playerHints: PLAYER_HINTS,
    randomRoom: randomRoom
  };
  window.addEventListener('DOMContentLoaded', init);
})();
