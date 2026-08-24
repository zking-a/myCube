'use strict';

(function setupFlightChessGame() {
  const Core = window.FlightChessCore;
  const SAVE_KEY = 'light_games_flight_chess_save_v1';
  const COLOR_STYLE = {
    red: { solid: '#e85d64', soft: '#fff0f1' },
    yellow: { solid: '#e5ad20', soft: '#fff8df' },
    blue: { solid: '#4f68e8', soft: '#edf0ff' },
    green: { solid: '#18a874', soft: '#eaf9f3' }
  };
  const DICE_PIPS = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
  };

  let game = null;
  let cellMap = new Map();
  let toastTimer = null;
  let winnerDialogShown = false;

  function $(id) { return document.getElementById(id); }
  function safeGet(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (error) {} }

  function readSavedGame() {
    try { return Core.hydrateGame(JSON.parse(safeGet(SAVE_KEY) || 'null')); }
    catch (error) { return null; }
  }

  function saveGame() {
    safeSet(SAVE_KEY, JSON.stringify(game));
  }

  function placeAt(node, coordinate) {
    node.style.gridRow = String(coordinate[0] + 1);
    node.style.gridColumn = String(coordinate[1] + 1);
  }

  function createSlot(className, coordinate, key) {
    const slot = document.createElement('div');
    slot.className = 'board-slot ' + className;
    slot.dataset.key = key || Core.coordinateKey(coordinate);
    placeAt(slot, coordinate);
    $('flightBoard').appendChild(slot);
    cellMap.set(slot.dataset.key, slot);
    return slot;
  }

  function buildBoard() {
    const board = $('flightBoard');
    board.textContent = '';
    cellMap = new Map();
    const activeColors = new Set(game.players.map(function (player) { return player.colorId; }));

    Core.COLOR_DEFS.forEach(function (color) {
      const zone = document.createElement('div');
      zone.className = 'hangar-zone ' + color.id + (activeColors.has(color.id) ? '' : ' inactive');
      zone.dataset.label = activeColors.has(color.id) ? color.name + '停机坪' : '本局未入场';
      board.appendChild(zone);
    });

    Core.TRACK_COORDINATES.forEach(function (coordinate, trackIndex) {
      const colorId = Core.trackColor(trackIndex);
      const slot = createSlot('track-cell ' + colorId, coordinate);
      slot.dataset.trackIndex = String(trackIndex);
      if (Core.SAFE_TRACK_INDEXES.includes(trackIndex)) {
        slot.classList.add('start-cell');
        slot.setAttribute('aria-label', '安全起点');
      }
      const shortcutColor = Core.COLOR_DEFS.find(function (color) {
        return Core.shortcutTrackIndex(color.id) === trackIndex;
      });
      if (shortcutColor) {
        slot.classList.add('shortcut-cell', shortcutColor.id);
        slot.setAttribute('aria-label', shortcutColor.name + '跨越飞行格');
      }
    });

    Core.COLOR_DEFS.forEach(function (color) {
      color.homeLane.forEach(function (coordinate, laneIndex) {
        const slot = createSlot('home-cell ' + color.id, coordinate);
        slot.dataset.homeLane = color.id + ':' + laneIndex;
      });
      color.bases.forEach(function (coordinate, planeIndex) {
        const slot = createSlot('base-cell ' + color.id, coordinate);
        slot.dataset.base = color.id + ':' + planeIndex;
      });
    });

    const goal = document.createElement('div');
    goal.className = 'board-slot goal-cell';
    goal.dataset.key = '7:7';
    goal.setAttribute('aria-label', '中心终点');
    board.appendChild(goal);
    cellMap.set('7:7', goal);
  }

  function tokenOffsets(count, index) {
    if (count <= 1) return [0, 0];
    const columns = count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / columns);
    const column = index % columns;
    const row = Math.floor(index / columns);
    return [
      (column - (columns - 1) / 2) * 34,
      (row - (rows - 1) / 2) * 34
    ];
  }

  function renderPlanes() {
    document.querySelectorAll('.plane-token').forEach(function (token) { token.remove(); });
    const movable = game.phase === 'move' ? Core.getMovablePlanes(game, game.currentPlayer, game.dice) : [];
    const groups = new Map();

    game.players.forEach(function (player, playerIndex) {
      player.planes.forEach(function (progress, planeIndex) {
        const coordinate = Core.getPlaneCoordinate(game, playerIndex, planeIndex);
        const key = Core.coordinateKey(coordinate);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ player: player, playerIndex: playerIndex, planeIndex: planeIndex, progress: progress });
      });
    });

    groups.forEach(function (planes, key) {
      const slot = cellMap.get(key);
      if (!slot) return;
      planes.forEach(function (item, stackIndex) {
        const canMove = item.playerIndex === game.currentPlayer && movable.includes(item.planeIndex);
        const offset = tokenOffsets(planes.length, stackIndex);
        const token = document.createElement('button');
        token.type = 'button';
        token.className = 'plane-token ' + item.player.colorId + (canMove ? ' movable' : '');
        token.textContent = '✈︎';
        token.disabled = !canMove;
        token.dataset.player = String(item.playerIndex);
        token.dataset.plane = String(item.planeIndex);
        token.style.setProperty('--plane-x', offset[0] + '%');
        token.style.setProperty('--plane-y', offset[1] + '%');
        token.setAttribute('aria-label', item.player.name + ' ' + (item.planeIndex + 1) + ' 号机' + (canMove ? '，可移动' : ''));
        if (canMove) token.addEventListener('click', function () { choosePlane(item.planeIndex); });
        slot.appendChild(token);
      });
    });
  }

  function renderDice(value, animate) {
    const dice = $('dice');
    const visible = new Set(DICE_PIPS[value] || []);
    dice.querySelectorAll('[data-pip]').forEach(function (pip) {
      pip.classList.toggle('visible', visible.has(Number(pip.dataset.pip)));
    });
    dice.setAttribute('aria-label', value ? '骰子点数 ' + value : '尚未掷骰');
    if (animate) {
      dice.classList.remove('rolling');
      void dice.offsetWidth;
      dice.classList.add('rolling');
      window.setTimeout(function () { dice.classList.remove('rolling'); }, 450);
    }
  }

  function playerPlaneCounts(player) {
    return {
      hangar: player.planes.filter(function (progress) { return progress === Core.HANGAR; }).length,
      finished: player.planes.filter(function (progress) { return progress === Core.FINISHED; }).length
    };
  }

  function renderPlayers() {
    const list = $('playerList');
    list.textContent = '';
    game.players.forEach(function (player, playerIndex) {
      const counts = playerPlaneCounts(player);
      const row = document.createElement('div');
      const style = COLOR_STYLE[player.colorId];
      row.className = 'player-row' + (playerIndex === game.currentPlayer && game.phase !== 'gameover' ? ' active' : '');
      row.style.setProperty('--player-color', style.solid);
      row.style.setProperty('--player-soft', style.soft);
      row.innerHTML = '<i class="player-color" aria-hidden="true"></i>' +
        '<span class="player-copy"><strong></strong><span></span></span>' +
        '<b class="player-progress"></b>';
      row.querySelector('strong').textContent = player.name;
      row.querySelector('.player-copy span').textContent = '停机坪 ' + counts.hangar + ' · 航线 ' + (Core.PLANE_COUNT - counts.hangar - counts.finished);
      row.querySelector('.player-progress').textContent = counts.finished + '/' + Core.PLANE_COUNT;
      list.appendChild(row);
    });
  }

  function lastMoveMessage() {
    const move = game.lastMove;
    if (!move) return game.players[game.currentPlayer].name + '先行，请掷骰子。';
    const player = game.players[move.player];
    const playerName = player ? player.name : '玩家';
    if (move.type === 'roll') return playerName + '掷出 ' + move.roll + '，请选择一架高亮飞机。';
    if (move.type === 'pass') {
      return playerName + '掷出 ' + move.roll + '，没有可移动的飞机' + (move.extraTurn ? '，继续掷骰。' : '，本轮跳过。');
    }
    if (move.type === 'move') {
      let message = playerName + '的 ' + (move.plane + 1) + ' 号机' + (move.from === Core.HANGAR ? '起飞' : '前进 ' + move.roll + ' 格');
      if (move.bonus === 'color-hop') message += '，同色连跳 4 格';
      if (move.bonus === 'shortcut') message += '，沿星标航线跨越 12 格';
      if (move.captured && move.captured.length) message += '，撞回 ' + move.captured.length + ' 架对方飞机';
      if (move.extraTurn) message += '；掷出 6，继续行动';
      return message + '。';
    }
    return '棋局进行中。';
  }

  function renderTurn() {
    const player = game.players[game.currentPlayer];
    const style = COLOR_STYLE[player.colorId];
    $('turnCard').style.setProperty('--turn-color', style.solid);
    $('turnCard').style.setProperty('--turn-soft', style.soft);
    $('turnColor').style.background = style.solid;
    $('turnName').textContent = game.phase === 'gameover' ? '本局结束' : player.name;
    $('roundBadge').textContent = '第 ' + game.turnNumber + ' 轮';
    $('playersCount').textContent = game.playerCount + ' 人';
    $('moveSummary').textContent = lastMoveMessage();

    if (game.phase === 'roll') {
      $('turnInstruction').textContent = '点击按钮掷骰子';
      $('rollButton').textContent = '掷骰子';
      $('rollButton').disabled = false;
      $('diceTip').textContent = game.lastMove && game.lastMove.extraTurn ? '额外机会：再掷一次' : '掷出 6 才能起飞';
    } else if (game.phase === 'move') {
      $('turnInstruction').textContent = '选择一架高亮飞机';
      $('rollButton').textContent = '请选择飞机';
      $('rollButton').disabled = true;
      $('diceTip').textContent = '本次点数：' + game.dice;
    } else {
      $('turnInstruction').textContent = '四架飞机已经抵达';
      $('rollButton').textContent = '本局结束';
      $('rollButton').disabled = true;
      $('diceTip').textContent = '可以再来一局';
    }
  }

  function showWinner() {
    if (game.phase !== 'gameover' || game.winner === null) {
      $('winnerModal').hidden = true;
      winnerDialogShown = false;
      return;
    }
    const winner = game.players[game.winner];
    $('winnerTitle').textContent = winner.name + '获胜';
    $('winnerText').textContent = winner.name + '的四架飞机已经安全抵达中心。';
    $('winnerMark').style.setProperty('--winner-color', COLOR_STYLE[winner.colorId].solid);
    $('winnerModal').hidden = false;
    if (!winnerDialogShown) {
      winnerDialogShown = true;
      window.setTimeout(function () { $('playAgainButton').focus(); }, 0);
    }
  }

  function render(animateDice) {
    renderPlanes();
    renderPlayers();
    renderTurn();
    renderDice(game.dice || game.lastRoll, animateDice);
    showWinner();
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    $('flightToast').textContent = message;
    $('flightToast').hidden = false;
    toastTimer = window.setTimeout(function () { $('flightToast').hidden = true; }, 1800);
  }

  function roll() {
    if (game.phase !== 'roll') return;
    game = Core.rollDice(game);
    saveGame();
    render(true);
    if (game.lastMove && game.lastMove.type === 'pass') showToast(lastMoveMessage());
  }

  function choosePlane(planeIndex) {
    try {
      game = Core.movePlane(game, planeIndex);
      saveGame();
      render(false);
    } catch (error) {
      showToast(error.message || '这架飞机当前不能移动');
    }
  }

  function startNewGame(confirmOverwrite) {
    if (confirmOverwrite && game.phase !== 'gameover' && !window.confirm('确定重新开始当前 ' + game.playerCount + ' 人棋局吗？')) return;
    game = Core.createGame(game.playerCount);
    winnerDialogShown = false;
    saveGame();
    render(false);
  }

  function initGame() {
    const params = new URLSearchParams(location.search);
    const requestedPlayers = Core.normalizePlayerCount(params.get('players'));
    const forceNew = params.get('new') === '1';
    const saved = readSavedGame();
    game = forceNew || !saved || saved.phase === 'gameover' ? Core.createGame(requestedPlayers) : saved;
    if (forceNew && window.history && window.history.replaceState) window.history.replaceState({}, '', 'play.html');
    buildBoard();
    saveGame();
    render(false);

    $('rollButton').addEventListener('click', roll);
    $('newGameButton').addEventListener('click', function () { startNewGame(true); });
    $('playAgainButton').addEventListener('click', function () { startNewGame(false); });
  }

  window.__flightChessGameTest = {
    dicePips: DICE_PIPS,
    tokenOffsets: tokenOffsets,
    playerPlaneCounts: playerPlaneCounts
  };
  window.addEventListener('DOMContentLoaded', initGame);
})();
