'use strict';

(function setupFlightChessLobby() {
  const SAVE_KEY = 'light_games_flight_chess_save_v1';
  const PLAYER_HINTS = {
    2: '红蓝双方对角入场，节奏更快，适合两个人。',
    3: '三个阵营依次行动，路线碰撞更频繁。',
    4: '四个阵营全部入场，最热闹的经典玩法。'
  };
  let playerCount = 4;

  function $(id) { return document.getElementById(id); }
  function safeGet(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }

  function readSavedGame() {
    try {
      const raw = JSON.parse(safeGet(SAVE_KEY) || 'null');
      const game = window.FlightChessCore && window.FlightChessCore.hydrateGame(raw);
      return game && game.phase !== 'gameover' ? game : null;
    } catch (error) {
      return null;
    }
  }

  function setConfigOpen(open) {
    const visible = Boolean(open);
    $('localConfig').hidden = !visible;
    $('selectLocalBtn').setAttribute('aria-expanded', visible ? 'true' : 'false');
  }

  function selectPlayerCount(value) {
    playerCount = window.FlightChessCore.normalizePlayerCount(value);
    document.querySelectorAll('[data-player-count]').forEach(function (button) {
      const active = Number(button.dataset.playerCount) === playerCount;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    $('playerHint').textContent = PLAYER_HINTS[playerCount];
    $('startGameLabel').textContent = '开始 ' + playerCount + ' 人对战';
  }

  function goToGame(params) {
    const query = new URLSearchParams(params || {});
    location.href = 'play.html' + (query.toString() ? '?' + query.toString() : '');
  }

  function init() {
    selectPlayerCount(4);
    const saved = readSavedGame();
    if (saved) {
      $('resumeCard').hidden = false;
      $('resumeMeta').textContent = saved.playerCount + ' 人 · 第 ' + saved.turnNumber + ' 轮 · ' + saved.players[saved.currentPlayer].name + '行动';
    }

    $('selectLocalBtn').addEventListener('click', function () {
      setConfigOpen($('localConfig').hidden);
    });
    document.querySelectorAll('[data-player-count]').forEach(function (button) {
      button.addEventListener('click', function () { selectPlayerCount(button.dataset.playerCount); });
    });
    $('resumeBtn').addEventListener('click', function () { goToGame(); });
    $('startGameBtn').addEventListener('click', function () {
      if (saved && !window.confirm('开始新局会覆盖当前飞行棋进度，确定继续吗？')) return;
      goToGame({ players: playerCount, new: 1 });
    });
  }

  window.__flightChessLobbyTest = {
    readSavedGame: readSavedGame,
    playerHints: PLAYER_HINTS
  };
  window.addEventListener('DOMContentLoaded', init);
})();
