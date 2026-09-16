'use strict';

// 兼容拆分前发出的根路径邀请链接：/#r=ABCDE 或 /?r=ABCDE。
(function redirectLegacyInvite() {
  var invite = /[?&#]r=([A-Za-z0-9]{1,8})/.exec(location.search + location.hash);
  if (!invite) return;
  var target = new URL('24/', location.href);
  target.search = location.search;
  target.hash = location.hash;
  location.replace(target.href);
})();

(function rememberRecentGame() {
  var key = 'light_games_recent_v1';
  var cards = document.querySelectorAll('[data-game-id]');
  var panel = document.getElementById('recentGame');
  var link = document.getElementById('recentGameLink');
  var title = document.getElementById('recentGameTitle');
  var meta = document.getElementById('recentGameMeta');

  function readRecent() {
    try {
      var value = JSON.parse(localStorage.getItem(key) || 'null');
      if (!value || typeof value.href !== 'string' || typeof value.name !== 'string') return null;
      if (!/^(24\/|sudoku\/|checkers\/|gomoku\/|flight-chess\/)/.test(value.href)) return null;
      return value;
    } catch (error) { return null; }
  }

  function writeRecent(card) {
    try {
      localStorage.setItem(key, JSON.stringify({
        id: card.dataset.gameId,
        name: card.dataset.gameName,
        href: card.getAttribute('href'),
        visitedAt: Date.now()
      }));
    } catch (error) {}
  }

  function readJson(storageKey) {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); }
    catch (error) { return null; }
  }

  function checkersResume() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var storageKey = localStorage.key(i);
        if (!/^chinese_checkers_save_v3_(?:ai|local)_/.test(storageKey || '') || /_previous$/.test(storageKey)) continue;
        var saved = readJson(storageKey);
        if (saved && !saved.winner && Number(saved.moveNumber) > 1 && saved.pieces) {
          return { id: 'checkers', name: '中国跳棋', href: 'checkers/index.html', meta: '未完成棋局 · 第 ' + saved.moveNumber + ' 手' };
        }
      }
    } catch (error) {}
    return null;
  }

  function resumableGames() {
    var out = [];
    var twentyFour = readJson('g24_progress_v2');
    if (twentyFour && twentyFour.last && Number(twentyFour.last.level) > 0) {
      out.push({ id: '24', name: '24 点大挑战', href: '24/', meta: '闯关进度 · 第 ' + twentyFour.last.level + ' 大关' });
    }
    var sudoku = readJson('sudoku_save');
    if (sudoku && Array.isArray(sudoku.board) && sudoku.board.length === 81 && sudoku.board.some(function (value) { return value === 0; })) {
      out.push({ id: 'sudoku', name: '数独挑战', href: 'sudoku/', meta: '未完成数独 · 已用时 ' + Math.max(0, Number(sudoku.seconds) || 0) + ' 秒' });
    }
    var checkers = checkersResume();
    if (checkers) out.push(checkers);
    var gomoku = readJson('gomoku_save_ai_v1');
    if (gomoku && !gomoku.finished && Number(gomoku.moveNumber) > 0 && Array.isArray(gomoku.board)) {
      out.push({ id: 'gomoku', name: '五子棋', href: 'gomoku/', meta: '未完成人机棋局 · ' + gomoku.moveNumber + ' 手' });
    }
    var flight = readJson('light_games_flight_chess_save_v1');
    if (flight && flight.phase && flight.phase !== 'gameover' && Array.isArray(flight.players)) {
      out.push({ id: 'flight-chess', name: '飞行棋', href: 'flight-chess/', meta: '未完成棋局 · ' + flight.players.length + ' 人' });
    }
    return out;
  }

  var recent = readRecent();
  var games = resumableGames();
  var resume = games.find(function (game) { return recent && game.id === recent.id; }) || games[0];
  if (resume && panel && link && title && meta) {
    title.textContent = '继续' + resume.name;
    meta.textContent = resume.meta;
    link.href = resume.href;
    panel.hidden = false;
  }
  cards.forEach(function (card) {
    card.addEventListener('click', function () { writeRecent(card); });
  });
})();
