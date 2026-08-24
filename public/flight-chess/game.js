'use strict';

(function setupFlightChessGame() {
  const Core = window.FlightChessCore;
  const Net = window.FlightChessNet;
  const SAVE_KEY = 'light_games_flight_chess_save_v1';
  const COLOR_STYLE = {
    red: { solid: '#e85d64', soft: '#fff0f1' },
    yellow: { solid: '#e5ad20', soft: '#fff8df' },
    blue: { solid: '#4f68e8', soft: '#edf0ff' },
    green: { solid: '#18a874', soft: '#eaf9f3' }
  };
  const DICE_PIPS = {
    1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9]
  };
  const ERROR_TEXT = {
    ROOM_NOT_FOUND: '房间不存在或已失效，请向房主确认房间码。',
    ROOM_EXISTS: '房间码发生冲突，请返回大厅重新创建。',
    ROOM_FULL: '这个房间已经坐满了。',
    ROUND_IN_PROGRESS: '对局已经开始，只允许原玩家重连。',
    SESSION_INVALID: '重连身份已失效，请退出后重新加入。',
    SERVER_FULL: '联机服务当前已满，请稍后再试。',
    IP_ROOM_LIMIT: '当前网络已有正在使用的房间，请先退出旧房间再创建。',
    IP_PLAYER_LIMIT: '当前网络加入的玩家数已达上限。',
    HOST_ONLY: '只有房主可以执行这个操作。',
    ROOM_NOT_READY: '请等待所有飞行员到齐。',
    PLAYER_OFFLINE: '有飞行员离线，对局已暂停。',
    NOT_YOUR_TURN: '还没有轮到你。',
    STATE_OUTDATED: '棋局刚刚更新，请按最新状态操作。'
  };

  const params = new URLSearchParams(location.search);
  const roomCode = Net ? Net.normalizeRoom(params.get('room')) : '';
  const isOnline = params.get('mode') === 'online' && Net && Net.ROOM_RE.test(roomCode);
  const requestedPlayers = Core.normalizePlayerCount(params.get('players'));
  let game = null;
  let cellMap = new Map();
  let toastTimer = null;
  let winnerDialogShown = false;
  let netClient = null;
  const online = {
    cid: '', seat: null, status: 'connecting', state: null, pending: false, error: '',
    intent: params.get('intent') === 'create' ? 'create' : 'join'
  };

  function $(id) { return document.getElementById(id); }
  function safeGet(key) { try { return localStorage.getItem(key); } catch (error) { return null; } }
  function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (error) {} }
  function readSavedGame() {
    try { return Core.hydrateGame(JSON.parse(safeGet(SAVE_KEY) || 'null')); }
    catch (error) { return null; }
  }
  function saveGame() { if (!isOnline) safeSet(SAVE_KEY, JSON.stringify(game)); }
  function allOnline() {
    return !!(online.state && online.state.players.length === online.state.capacity &&
      online.state.players.every(function (player) { return player.online; }));
  }
  function isHost() { return !!(online.state && online.cid && online.state.host === online.cid); }
  function isMyTurn() {
    return !isOnline || !!(online.state && online.state.phase === 'playing' && allOnline() && online.seat === game.currentPlayer);
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
    return [(index % columns - (columns - 1) / 2) * 34,
      (Math.floor(index / columns) - (rows - 1) / 2) * 34];
  }
  function renderPlanes() {
    document.querySelectorAll('.plane-token').forEach(function (token) { token.remove(); });
    const mayMove = game.phase === 'move' && isMyTurn() && !online.pending;
    const movable = mayMove ? Core.getMovablePlanes(game, game.currentPlayer, game.dice) : [];
    const groups = new Map();
    game.players.forEach(function (player, playerIndex) {
      player.planes.forEach(function (progress, planeIndex) {
        const coordinate = Core.getPlaneCoordinate(game, playerIndex, planeIndex);
        const key = Core.coordinateKey(coordinate);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ player: player, playerIndex: playerIndex, planeIndex: planeIndex });
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
      row.innerHTML = '<i class="player-color" aria-hidden="true"></i><span class="player-copy"><strong></strong><span></span></span><b class="player-progress"></b>';
      row.querySelector('strong').textContent = player.name + (isOnline && playerIndex === online.seat ? '（你）' : '');
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
    if (move.type === 'pass') return playerName + '掷出 ' + move.roll + '，没有可移动的飞机' + (move.extraTurn ? '，继续掷骰。' : '，本轮跳过。');
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
    $('roundBadge').textContent = isOnline && online.state ? '第 ' + online.state.round + ' 局' : '第 ' + game.turnNumber + ' 轮';
    $('playersCount').textContent = game.playerCount + ' 人';

    if (isOnline && (!online.state || online.state.phase === 'waiting')) {
      $('turnName').textContent = '等待开局';
      $('turnInstruction').textContent = '玩家到齐后由房主开始';
      $('moveSummary').textContent = online.error || (online.status === 'offline' ? '连接中断，正在自动重连…' : '邀请好友加入房间，全部到齐即可开始。');
      $('rollButton').textContent = '等待开局';
      $('rollButton').disabled = true;
      $('diceTip').textContent = '骰点由服务器安全生成';
      return;
    }

    $('turnName').textContent = game.phase === 'gameover' ? '本局结束' : player.name;
    $('moveSummary').textContent = lastMoveMessage();
    const ownTurn = isMyTurn();
    const paused = isOnline && !allOnline();
    if (game.phase === 'roll') {
      $('turnInstruction').textContent = paused ? '等待离线玩家重连' : ownTurn ? '轮到你掷骰子' : '等待 ' + player.name + ' 掷骰子';
      $('rollButton').textContent = paused ? '对局已暂停' : ownTurn ? '掷骰子' : '等待对方';
      $('rollButton').disabled = paused || !ownTurn || online.pending;
      $('diceTip').textContent = game.lastMove && game.lastMove.extraTurn ? '额外机会：再掷一次' : '掷出 6 才能起飞';
    } else if (game.phase === 'move') {
      $('turnInstruction').textContent = ownTurn ? '选择一架高亮飞机' : '等待 ' + player.name + ' 移动飞机';
      $('rollButton').textContent = ownTurn ? '请选择飞机' : '等待对方';
      $('rollButton').disabled = true;
      $('diceTip').textContent = '本次点数：' + game.dice;
    } else {
      $('turnInstruction').textContent = '四架飞机已经抵达';
      $('rollButton').textContent = '本局结束';
      $('rollButton').disabled = true;
      $('diceTip').textContent = isOnline && !isHost() ? '等待房主发起下一局' : '可以再来一局';
    }
  }

  function renderOnlineRoom() {
    if (!isOnline) return;
    const state = online.state;
    const capacity = state ? state.capacity : requestedPlayers;
    $('onlineRoomTitle').textContent = roomCode;
    const badge = $('networkBadge');
    badge.className = 'network-badge ' + online.status;
    badge.innerHTML = '<i aria-hidden="true"></i>' + (online.status === 'online' ? ' 已连接' :
      online.status === 'offline' ? ' 重连中' : online.status === 'failed' ? ' 连接失败' : ' 连接中');
    const roster = $('onlineRoster');
    roster.textContent = '';
    for (let seat = 0; seat < capacity; seat++) {
      const member = state && state.players.find(function (player) { return player.seat === seat; });
      const colorId = game.players[seat] ? game.players[seat].colorId : 'red';
      const row = document.createElement('div');
      row.className = 'online-seat ' + (member ? (member.online ? 'online' : 'offline') : 'empty');
      row.style.setProperty('--seat-color', COLOR_STYLE[colorId].solid);
      row.innerHTML = '<i aria-hidden="true"></i><span></span><b></b>';
      row.querySelector('span').textContent = member ? member.nick + (member.cid === online.cid ? '（你）' : '') : '等待加入';
      row.querySelector('b').textContent = member ? (member.cid === state.host ? '房主' : member.online ? '在线' : '离线') : '空位';
      roster.appendChild(row);
    }
    const joined = state ? state.players.length : 0;
    const ready = state && state.phase === 'waiting' && joined === capacity && allOnline();
    $('onlineWaiting').classList.toggle('error', !!online.error);
    $('onlineWaiting').textContent = online.error || (state && state.phase === 'playing' ? '棋局进行中 · 离线后会自动保留席位' :
      state && state.phase === 'done' ? '本局已结束，房主可以发起下一局。' :
        '已加入 ' + joined + '/' + capacity + ' 位，' + (ready ? '人员已到齐。' : '继续邀请好友加入。'));
    $('onlineStartButton').hidden = online.status === 'failed' || !!(state && state.phase !== 'waiting');
    $('onlineStartButton').disabled = !isHost() || !ready || online.pending;
    $('onlineStartButton').textContent = !isHost() ? '等待房主开始' : ready ? '开始对局' : '等待玩家到齐';
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
    $('playAgainButton').hidden = isOnline && !isHost();
    $('playAgainButton').textContent = isOnline ? '发起下一局' : '再来一局';
    $('winnerModal').hidden = false;
    if (!winnerDialogShown) {
      winnerDialogShown = true;
      window.setTimeout(function () {
        const focusTarget = !$('playAgainButton').hidden ? $('playAgainButton') : $('winnerModal').querySelector('a');
        focusTarget.focus();
      }, 0);
    }
  }
  function render(animateDice) {
    renderPlanes();
    renderPlayers();
    renderTurn();
    renderDice(game.dice || game.lastRoll, animateDice);
    renderOnlineRoom();
    showWinner();
  }
  function showToast(message, duration) {
    window.clearTimeout(toastTimer);
    $('flightToast').textContent = message;
    $('flightToast').hidden = false;
    toastTimer = window.setTimeout(function () { $('flightToast').hidden = true; }, duration || 2200);
  }
  function sendOnline(message) {
    if (!netClient || online.pending) return false;
    message.rev = online.state ? online.state.revision : 0;
    if (!netClient.send(message)) { showToast('连接尚未恢复，请稍候'); return false; }
    online.pending = true;
    render(false);
    return true;
  }
  function roll() {
    if (game.phase !== 'roll') return;
    if (isOnline) { if (isMyTurn()) sendOnline({ t: 'roll' }); return; }
    game = Core.rollDice(game);
    saveGame();
    render(true);
    if (game.lastMove && game.lastMove.type === 'pass') showToast(lastMoveMessage());
  }
  function choosePlane(planeIndex) {
    if (isOnline) { if (isMyTurn()) sendOnline({ t: 'move', plane: planeIndex }); return; }
    try {
      game = Core.movePlane(game, planeIndex);
      saveGame();
      render(false);
    } catch (error) { showToast(error.message || '这架飞机当前不能移动'); }
  }
  function startNewGame(confirmOverwrite) {
    if (isOnline) { sendOnline({ t: 'again' }); return; }
    if (confirmOverwrite && game.phase !== 'gameover' && !window.confirm('确定重新开始当前 ' + game.playerCount + ' 人棋局吗？')) return;
    game = Core.createGame(game.playerCount);
    winnerDialogShown = false;
    saveGame();
    render(false);
  }
  function placeholderGame(capacity, players) {
    const next = Core.createGame(capacity);
    (players || []).forEach(function (member) {
      if (next.players[member.seat]) next.players[member.seat].name = String(member.nick || next.players[member.seat].name).slice(0, 12);
    });
    return next;
  }
  function receiveOnlineState(message) {
    const nextGame = message.game ? Core.hydrateGame(message.game) : placeholderGame(message.capacity, message.players);
    if (!nextGame) { showToast('服务器棋局数据无效，请重新进入房间', 4000); return; }
    const playerCountChanged = !game || nextGame.playerCount !== game.playerCount;
    const previousRevision = online.state ? online.state.revision : -1;
    online.state = message;
    online.pending = false;
    online.error = '';
    game = nextGame;
    if (playerCountChanged) buildBoard();
    render(message.revision > previousRevision && !!game.lastRoll);
  }
  function setupOnlineGame() {
    $('onlineRoomCard').hidden = false;
    $('newGameButton').hidden = true;
    $('gameModeTitle').textContent = '好友对战';
    $('syncBadge').innerHTML = '<i aria-hidden="true"></i> 服务器同步';
    game = placeholderGame(requestedPlayers, []);
    buildBoard();
    render(false);
    const nick = String(safeGet('light_games_nickname') || '飞行员').trim().slice(0, 16) || '飞行员';
    netClient = Net.createClient({
      room: roomCode,
      nick: nick,
      intent: online.intent,
      capacity: requestedPlayers,
      onStatus: function (status) { online.status = status; online.pending = false; render(false); },
      onSession: function (message) { online.cid = message.cid; online.seat = Number(message.seat); render(false); },
      onState: receiveOnlineState,
      onError: function (message) {
        online.pending = false;
        online.error = ERROR_TEXT[message.code] || message.msg || '联机操作失败';
        showToast(online.error, 4000);
        render(false);
      }
    });
    netClient.connect();
  }
  function setupLocalGame() {
    const forceNew = params.get('new') === '1';
    const saved = readSavedGame();
    game = forceNew || !saved || saved.phase === 'gameover' ? Core.createGame(requestedPlayers) : saved;
    if (forceNew && window.history && window.history.replaceState) window.history.replaceState({}, '', 'play.html?mode=local');
    buildBoard();
    saveGame();
    render(false);
  }
  function copyInvite() {
    const url = new URL('index.html?room=' + encodeURIComponent(roomCode), location.href).href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { showToast('邀请链接已复制'); }, function () { showToast('房间码：' + roomCode, 4000); });
    } else showToast('房间码：' + roomCode, 4000);
  }
  function leaveOnlineRoom(event) {
    if (!isOnline) return;
    if (event) event.preventDefault();
    const destination = event && event.currentTarget && event.currentTarget.href ? event.currentTarget.href : 'index.html';
    if (netClient) netClient.leave();
    window.setTimeout(function () { location.href = destination; }, 45);
  }
  function initGame() {
    if (!Core) return;
    $('rollButton').addEventListener('click', roll);
    $('newGameButton').addEventListener('click', function () { startNewGame(true); });
    $('playAgainButton').addEventListener('click', function () { startNewGame(false); });
    $('onlineStartButton').addEventListener('click', function () { sendOnline({ t: 'start' }); });
    $('copyInviteButton').addEventListener('click', copyInvite);
    $('leaveRoomButton').addEventListener('click', leaveOnlineRoom);
    document.querySelectorAll('[data-leave-room]').forEach(function (link) { link.addEventListener('click', leaveOnlineRoom); });
    if (isOnline) setupOnlineGame(); else setupLocalGame();
  }

  window.__flightChessGameTest = {
    dicePips: DICE_PIPS,
    tokenOffsets: tokenOffsets,
    playerPlaneCounts: playerPlaneCounts,
    placeholderGame: placeholderGame
  };
  window.addEventListener('beforeunload', function () { if (netClient) netClient.dispose(); });
  window.addEventListener('DOMContentLoaded', initGame);
})();
