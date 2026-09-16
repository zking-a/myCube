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

  var recent = readRecent();
  if (recent && panel && link && title && meta) {
    title.textContent = '继续' + recent.name;
    meta.textContent = '回到最近玩过的游戏';
    link.href = recent.href;
    panel.hidden = false;
  }
  cards.forEach(function (card) {
    card.addEventListener('click', function () { writeRecent(card); });
  });
})();
