'use strict';

const Core = window.CheckersCore;
if (!Core) throw new Error('CheckersCore 未加载');

const CONFIG = {
  SAVE_PREFIX: 'chinese_checkers_save_v2_',
  SOUND_KEY: 'chinese_checkers_sound',
  AI_LEVEL_KEY: 'chinese_checkers_ai_level',
  NICK_KEY: 'light_games_nickname',
  CID_KEY: 'chinese_checkers_cid',
  TOKEN_PREFIX: 'chinese_checkers_token_',
  HISTORY_LIMIT: 80,
  ROOM_RE: /^[A-HJ-NP-Z2-9]{5}$/,
  AI_DELAY: 460,
  RECONNECT_BASE: 800,
  RECONNECT_MAX: 10000
};
const AI_LEVELS = ['easy', 'normal', 'hard'];

const launchParams = new URLSearchParams(location.search);
const launchRoom = normalizeRoom(launchParams.get('room'));
const requestedMode = launchParams.get('mode');
const mode = ['ai', 'local', 'online'].includes(requestedMode) ? requestedMode : (launchRoom ? 'online' : 'ai');
const launchIntent = launchParams.get('intent') === 'create' ? 'create' : 'join';
const BOARD_CELLS = Core.BOARD_CELLS;
const CELL_BY_KEY = new Map(BOARD_CELLS.map(function (cell) { return [cell.key, cell]; }));

let viewPlayer = 'red';
let pieces = Core.createInitialPieces();
let turn = 'red';
let selectedKey = '';
let legalMoves = emptyMoves();
let history = [];
let moveNumber = 1;
let gameOver = '';
let lastMove = null;
let soundEnabled = true;
let aiLevel = 'normal';
let aiThinking = false;
let aiTimer = null;
let aiWorker = null;
let aiRequestId = 0;
let toastTimer = null;

const online = {
  active: false, ws: null, room: '', cid: '', token: '', color: '', phase: 'idle',
  host: '', players: [], intent: 'join', nick: '', intentionalClose: false,
  reconnectTimer: null, retryAttempt: 0, retryDelay: 0
};

function $(id) { return document.getElementById(id); }
function emptyMoves() { return { steps: [], jumps: [], all: [] }; }
function svgElement(name) { return document.createElementNS('http://www.w3.org/2000/svg', name); }
function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
function playerLabel(player) { return player === 'red' ? '红方' : '蓝方'; }
function opposite(player) { return player === 'red' ? 'blue' : 'red'; }
function normalizeRoom(value) { return String(value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 5); }
function getViewPlayerForMode(currentMode, assignedColor) {
  return currentMode === 'online' && (assignedColor === 'red' || assignedColor === 'blue') ? assignedColor : 'red';
}

function randomString(length, alphabet) {
  const bytes = new Uint8Array(length);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function getClientId() {
  let id = safeGet(CONFIG.CID_KEY);
  if (!id || id.length < 12) {
    id = randomString(24, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    safeSet(CONFIG.CID_KEY, id);
  }
  return id;
}

function sanitizeLocalState(raw) {
  const clean = Core.sanitizeState(raw);
  if (!clean) return null;
  return { pieces: clean.pieces, turn: clean.turn, moveNumber: clean.moveNumber, gameOver: clean.winner, lastMove: clean.lastMove };
}

function saveGame() {
  if (mode === 'online') return;
  safeSet(CONFIG.SAVE_PREFIX + mode, JSON.stringify({ pieces: pieces, turn: turn, moveNumber: moveNumber, winner: gameOver, lastMove: lastMove }));
}

function loadGame() {
  try {
    const raw = safeGet(CONFIG.SAVE_PREFIX + mode);
    const saved = raw ? sanitizeLocalState(JSON.parse(raw)) : null;
    if (!saved) return false;
    pieces = saved.pieces; turn = saved.turn; moveNumber = saved.moveNumber;
    gameOver = saved.gameOver; lastMove = saved.lastMove;
    return true;
  } catch (e) { return false; }
}

function resetState() {
  pieces = Core.createInitialPieces(); turn = 'red'; selectedKey = ''; legalMoves = emptyMoves();
  history = []; moveNumber = 1; gameOver = ''; lastMove = null; aiThinking = false;
  clearTimeout(aiTimer); aiTimer = null; cancelAiSearch(); closeWinner();
}

function pushHistory() {
  history.push({ pieces: { ...pieces }, turn: turn, moveNumber: moveNumber, gameOver: gameOver, lastMove: lastMove ? { ...lastMove, path: lastMove.path.slice() } : null });
  if (history.length > CONFIG.HISTORY_LIMIT) history.shift();
}

function restoreHistory(snapshot) {
  pieces = snapshot.pieces; turn = snapshot.turn; moveNumber = snapshot.moveNumber;
  gameOver = snapshot.gameOver; lastMove = snapshot.lastMove || null;
  selectedKey = ''; legalMoves = emptyMoves(); closeWinner();
}

function showToast(message) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2100);
}

function playTone(kind) {
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!soundEnabled || !AudioEngine) return;
  try {
    const context = new AudioEngine(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = kind === 'jump' ? 620 : (kind === 'win' ? 760 : 470);
    gain.gain.setValueAtTime(.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + (kind === 'win' ? .32 : .13));
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
    oscillator.stop(context.currentTime + (kind === 'win' ? .32 : .13));
    oscillator.onended = function () { context.close(); };
  } catch (e) {}
}

function appendGradient(defs, id, light, dark) {
  const gradient = svgElement('radialGradient'); gradient.id = id; gradient.setAttribute('cx', '35%'); gradient.setAttribute('cy', '28%'); gradient.setAttribute('r', '72%');
  const first = svgElement('stop'); first.setAttribute('offset', '0%'); first.setAttribute('stop-color', light);
  const second = svgElement('stop'); second.setAttribute('offset', '100%'); second.setAttribute('stop-color', dark);
  gradient.append(first, second); defs.appendChild(gradient);
}

function orientedPoint(key) {
  const cell = CELL_BY_KEY.get(key);
  return cell ? Core.orientPoint(cell, viewPlayer) : null;
}

function drawBoardZones(board) {
  const zones = [
    { className: 'red-goal-zone', keys: ['16:0', '13:-3', '13:3'] },
    { className: 'blue-goal-zone', keys: ['0:0', '3:-3', '3:3'] }
  ];
  const group = svgElement('g'); group.classList.add('board-zones'); group.setAttribute('aria-hidden', 'true');
  zones.forEach(function (zone) {
    const points = zone.keys.map(orientedPoint).filter(Boolean);
    if (points.length !== 3) return;
    const shape = svgElement('polygon'); shape.classList.add('board-zone', zone.className);
    shape.setAttribute('points', points.map(function (point) { return point.x + ',' + point.y; }).join(' '));
    group.appendChild(shape);
  });
  board.appendChild(group);
}

function drawLastMove(board) {
  if (!lastMove || !Array.isArray(lastMove.path)) return;
  const points = lastMove.path.map(orientedPoint).filter(Boolean);
  if (points.length < 2) return;
  const group = svgElement('g'); group.classList.add('last-move-layer'); group.setAttribute('aria-hidden', 'true');
  const colorClass = lastMove.player + '-path';
  const route = svgElement('polyline'); route.classList.add('last-move-path', colorClass);
  route.setAttribute('points', points.map(function (point) { return point.x + ',' + point.y; }).join(' '));
  group.appendChild(route);
  const origin = svgElement('circle'); origin.classList.add('move-origin', colorClass);
  origin.setAttribute('cx', points[0].x); origin.setAttribute('cy', points[0].y); origin.setAttribute('r', '9.7'); group.appendChild(origin);
  const destination = svgElement('circle'); destination.classList.add('move-destination', colorClass);
  destination.setAttribute('cx', points[points.length - 1].x); destination.setAttribute('cy', points[points.length - 1].y); destination.setAttribute('r', '11'); group.appendChild(destination);
  board.appendChild(group);
}

function cellLabel(cell, owner, moveKind) {
  const base = '第 ' + (cell.row + 1) + ' 行';
  if (owner) return base + '，' + playerLabel(owner) + '棋子';
  if (moveKind) return base + '，可' + (moveKind === 'jump' ? '跳跃到达' : '移动到达');
  return base + '，空位';
}

function renderBoard() {
  const board = $('board'); board.replaceChildren();
  const defs = svgElement('defs'); appendGradient(defs, 'redPieceGradient', '#ff9a8f', '#c93648'); appendGradient(defs, 'bluePieceGradient', '#91adff', '#304bc9'); board.appendChild(defs);
  drawBoardZones(board);
  drawLastMove(board);
  const stepSet = new Set(legalMoves.steps); const jumpSet = new Set(legalMoves.jumps);
  const keyboardFocusKey = selectedKey || Object.keys(pieces).find(function (key) { return pieces[key] === turn; }) || BOARD_CELLS[0].key;
  BOARD_CELLS.forEach(function (cell) {
    const point = Core.orientPoint(cell, viewPlayer); const group = svgElement('g');
    const owner = pieces[cell.key] || ''; const moveKind = jumpSet.has(cell.key) ? 'jump' : (stepSet.has(cell.key) ? 'step' : '');
    group.classList.add('cell-node'); if (cell.camp) group.classList.add(cell.camp + '-camp');
    if (selectedKey === cell.key) group.classList.add('selected'); if (moveKind) group.classList.add(moveKind + '-target');
    if (lastMove && lastMove.target === cell.key) group.classList.add('last-destination');
    group.dataset.key = cell.key; group.setAttribute('role', 'gridcell'); group.setAttribute('tabindex', keyboardFocusKey === cell.key ? '0' : '-1');
    group.setAttribute('aria-label', cellLabel(cell, owner, moveKind));

    const hit = svgElement('circle'); hit.classList.add('hit-area'); hit.setAttribute('cx', point.x); hit.setAttribute('cy', point.y); hit.setAttribute('r', '12'); group.appendChild(hit);
    const hole = svgElement('circle'); hole.classList.add('hole'); hole.setAttribute('cx', point.x); hole.setAttribute('cy', point.y); hole.setAttribute('r', '6.2'); group.appendChild(hole);
    if (moveKind) {
      const halo = svgElement('circle'); halo.classList.add('target-halo'); halo.setAttribute('cx', point.x); halo.setAttribute('cy', point.y); halo.setAttribute('r', '7.1'); group.appendChild(halo);
      const dot = svgElement('circle'); dot.classList.add('target-dot'); dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y); dot.setAttribute('r', '3'); group.appendChild(dot);
    }
    if (selectedKey === cell.key) {
      const halo = svgElement('circle'); halo.classList.add('selection-halo'); halo.setAttribute('cx', point.x); halo.setAttribute('cy', point.y); halo.setAttribute('r', '10.5'); group.appendChild(halo);
    }
    if (owner) {
      const piece = svgElement('circle'); piece.classList.add('piece', owner + '-piece'); piece.setAttribute('cx', point.x); piece.setAttribute('cy', point.y); piece.setAttribute('r', '7.9'); group.appendChild(piece);
    }
    board.appendChild(group);
  });
}

function onlinePlayer(color) { return online.players.find(function (player) { return player.color === color; }); }
function updatePlayerNames() {
  if (mode === 'ai') { $('redName').textContent = '你 · 红方'; $('blueName').textContent = '电脑 · 蓝方'; return; }
  if (mode === 'local') { $('redName').textContent = '玩家 A · 红方'; $('blueName').textContent = '玩家 B · 蓝方'; return; }
  const red = onlinePlayer('red'); const blue = onlinePlayer('blue');
  $('redName').textContent = (red ? red.nick : '等待玩家') + ' · 红方' + (online.color === 'red' ? '（你）' : '');
  $('blueName').textContent = (blue ? blue.nick : '等待玩家') + ' · 蓝方' + (online.color === 'blue' ? '（你）' : '');
}

function canAct() {
  if (gameOver || aiThinking) return false;
  if (mode === 'ai') return turn === 'red';
  if (mode === 'local') return true;
  return online.phase === 'playing' && online.players.length === 2 && online.players.every(function (player) { return player.online; }) && online.color === turn && online.ws && online.ws.readyState === WebSocket.OPEN;
}

function onlineStatusText() {
  if (!online.active) return '尚未连接房间';
  if (online.phase === 'connecting') return '正在连接服务器…';
  if (online.phase === 'reconnecting') return '连接中断，' + Math.max(1, Math.ceil(online.retryDelay / 1000)) + ' 秒后重连';
  if (online.phase === 'waiting') return online.players.length < 2 ? '等待另一位玩家加入' : '正在准备开局';
  if (online.phase === 'playing') {
    if (online.players.some(function (player) { return !player.online; })) return '对手已离线，等待其自动重连';
    return online.color === turn ? '轮到你走' : '等待对手走棋';
  }
  if (online.phase === 'done') return '本局已结束';
  return '联机状态不可用';
}

function updateLastMoveBar() {
  const bar = $('lastMoveBar'); bar.hidden = !lastMove;
  if (!lastMove) return;
  const isOpponent = mode === 'online' && online.color && lastMove.player !== online.color;
  const subject = isOpponent ? '对手（' + playerLabel(lastMove.player) + '）' : playerLabel(lastMove.player);
  const jumps = Math.max(1, lastMove.path.length - 1);
  $('lastMovePiece').className = 'last-move-piece ' + lastMove.player;
  $('lastMoveText').textContent = subject + (lastMove.kind === 'jump' ? '完成了 ' + jumps + ' 段跳跃' : '移动了一枚棋子');
  $('lastMoveKind').textContent = lastMove.kind === 'jump' ? (jumps > 1 ? '连续跳跃' : '跳跃') : '相邻移动';
}

function updateStatus() {
  const isRed = turn === 'red'; const selfTurn = mode === 'online' && online.color === turn;
  $('board').setAttribute('aria-label', '中国跳棋棋盘，' + playerLabel(viewPlayer) + '固定视角，己方位于下方');
  $('turnPiece').className = 'turn-piece ' + turn;
  let title = playerLabel(turn) + '回合'; let kicker = playerLabel(viewPlayer) + '固定视角 · 己方在下';
  if (gameOver) { title = playerLabel(gameOver) + '获胜'; kicker = '本局已经结束'; }
  else if (mode === 'ai') { title = aiThinking || turn === 'blue' ? '电脑思考中…' : '你的回合'; kicker = '你的视角 · 红方始终在下'; }
  else if (mode === 'local') kicker = '红方固定视角 · 换手不翻转棋盘';
  else if (!online.color) { title = onlineStatusText(); kicker = '加入房间后由服务器分配阵营'; }
  else { title = online.phase === 'playing' ? (selfTurn ? '轮到你走' : '对手回合') : onlineStatusText(); kicker = '你的视角 · ' + playerLabel(online.color) + '始终在下'; }
  $('turnText').textContent = title; $('turnKicker').textContent = kicker; $('moveCount').textContent = '第 ' + moveNumber + ' 手';
  $('redProgress').textContent = Core.countInGoal(pieces, 'red') + '/10'; $('blueProgress').textContent = Core.countInGoal(pieces, 'blue') + '/10';
  $('redPlayer').classList.toggle('active', !gameOver && isRed); $('bluePlayer').classList.toggle('active', !gameOver && !isRed);
  updatePlayerNames(); updateLastMoveBar();
  $('undoBtn').disabled = mode === 'online' || history.length === 0 || aiThinking; $('undoBtn').title = mode === 'online' ? '联机棋局不能撤销' : '';
  if (mode === 'online') {
    const mayRestart = online.phase === 'done' && online.host === online.cid;
    $('newGameBtn').disabled = !mayRestart; $('newGameBtn').innerHTML = mayRestart ? '<span>↻</span> 再来一局' : '<span>↻</span> 房主可重开';
  } else { $('newGameBtn').disabled = false; $('newGameBtn').innerHTML = '<span>↻</span> 重新开局'; }
  const opponentOffline = online.phase === 'playing' && online.players.some(function (player) { return !player.online; });
  const showWait = mode === 'online' && online.active && ['connecting','reconnecting','waiting'].includes(online.phase) || (mode === 'online' && opponentOffline);
  $('boardWait').hidden = !showWait;
  if (showWait) {
    const reconnecting = online.phase === 'connecting' || online.phase === 'reconnecting';
    $('boardWait').querySelector('strong').textContent = reconnecting ? '正在恢复联机' : (opponentOffline ? '对手暂时离线' : '等待对手加入');
    $('boardWait').querySelector('small').textContent = reconnecting ? onlineStatusText() : (opponentOffline ? '已保留其阵营，重连后继续当前棋局' : '复制邀请链接发给朋友即可开始');
  }
  if (mode === 'online') $('onlineStatus').textContent = onlineStatusText();
  $('boardTip').textContent = selectedKey
    ? (legalMoves.all.length ? '绿色是相邻落点，橙色是跳跃落点；再次点击棋子可取消。' : '这枚棋子当前没有可走位置。')
    : (canAct() ? '点击己方棋子，再点击高亮落点；上一步路线会保留在棋盘上。' : (mode === 'online' ? onlineStatusText() : '请等待电脑完成走棋。'));
}

function render() { renderBoard(); updateStatus(); }
function selectPiece(key) { selectedKey = key; legalMoves = Core.getLegalMoves(pieces, key); if (!legalMoves.all.length) showToast('这枚棋子暂时没有可走位置'); render(); }

function showWinner(player) {
  const alreadyOpen = $('winnerOverlay').classList.contains('active');
  $('winnerPiece').className = 'winner-piece ' + player; $('winnerTitle').textContent = playerLabel(player) + '获胜！';
  $('winnerText').textContent = '率先把 10 枚棋子全部移入了对方营地';
  if (mode === 'online') $('winnerNewBtn').textContent = online.host === online.cid ? '再来一局' : '返回房间等待房主';
  else $('winnerNewBtn').textContent = '再来一局';
  $('winnerNewBtn').disabled = false; $('winnerOverlay').classList.add('active'); $('winnerOverlay').setAttribute('aria-hidden', 'false');
  if (!alreadyOpen) setTimeout(function () { $('winnerNewBtn').focus(); }, 0);
}
function closeWinner() { const overlay = $('winnerOverlay'); if (!overlay) return; overlay.classList.remove('active'); overlay.setAttribute('aria-hidden', 'true'); }

function applyLocalMove(fromKey, targetKey, actor) {
  const result = Core.applyMove(pieces, actor, fromKey, targetKey); if (!result) return false;
  pushHistory(); pieces = result.pieces;
  lastMove = { player: actor, from: fromKey, target: targetKey, kind: result.kind, path: result.path.slice(), moveNumber: moveNumber };
  selectedKey = ''; legalMoves = emptyMoves();
  if (result.winner) { gameOver = result.winner; playTone('win'); showWinner(result.winner); }
  else { turn = opposite(actor); moveNumber++; playTone(result.kind); }
  saveGame(); render(); return true;
}

/** 取消过期计算；终止 Worker 才能真正释放正在执行的深层搜索。 */
function cancelAiSearch() {
  aiRequestId++;
  if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
}

/**
 * 优先在 Worker 中运行搜索。旧浏览器或 Worker 加载失败时回退到同步核心，
 * 保证离线文件部署和历史环境仍然能够完成人机对局。
 */
function requestAiMove(recentPositions, callback) {
  const requestId = ++aiRequestId;
  const snapshot = { ...pieces };
  const finish = function (move, error) {
    if (requestId !== aiRequestId) return;
    callback(move, error);
  };
  const fallback = function (error) {
    if (requestId !== aiRequestId) return;
    const searchOptions = aiLevel === 'hard' ? {
      model: window.CheckersAiModel || null,
      recentPositions: recentPositions
    } : null;
    finish(Core.chooseAiMove(snapshot, 'blue', aiLevel, null, searchOptions), error);
  };

  if (typeof window.Worker !== 'function') { fallback(null); return; }
  try {
    if (!aiWorker) aiWorker = new window.Worker('checkers_ai_worker.js');
    aiWorker.onmessage = function (event) {
      const response = event && event.data ? event.data : {};
      if (Number(response.requestId) !== requestId) return;
      if (response.error) fallback(response.error);
      else finish(response.move || null, null);
    };
    aiWorker.onerror = function (event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
      fallback('搜索线程加载失败');
    };
    aiWorker.postMessage({
      requestId: requestId,
      pieces: snapshot,
      player: 'blue',
      level: aiLevel,
      recentPositions: recentPositions
    });
  } catch (error) {
    if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
    fallback(String(error && error.message || error));
  }
}

function scheduleAiMove() {
  if (mode !== 'ai' || turn !== 'blue' || gameOver) return;
  clearTimeout(aiTimer); cancelAiSearch(); aiThinking = true; render();
  aiTimer = setTimeout(function () {
    aiTimer = null;
    if (mode !== 'ai' || turn !== 'blue' || gameOver) { aiThinking = false; render(); return; }
    const recentPositions = history.slice(-20).map(function (snapshot) { return Core.positionKey(snapshot.pieces); });
    requestAiMove(recentPositions, function (move) {
      if (mode !== 'ai' || turn !== 'blue' || gameOver) { aiThinking = false; render(); return; }
      aiThinking = false;
      if (!move) { showToast('电脑当前没有可走位置'); render(); return; }
      applyLocalMove(move.from, move.target, 'blue');
    });
  }, CONFIG.AI_DELAY);
}

function movePiece(targetKey) {
  if (mode === 'online') {
    if (!sendOnline({ t: 'move', from: selectedKey, target: targetKey, seq: moveNumber })) showToast('连接尚未恢复，请稍后再试');
    else { selectedKey = ''; legalMoves = emptyMoves(); render(); }
    return;
  }
  const actor = turn; if (applyLocalMove(selectedKey, targetKey, actor) && mode === 'ai') scheduleAiMove();
}

function handleCell(key) {
  if (gameOver) return;
  if (!canAct()) { showToast(mode === 'online' ? onlineStatusText() : '请等待电脑完成走棋'); return; }
  if (selectedKey && legalMoves.all.includes(key)) { movePiece(key); return; }
  const owner = pieces[key];
  if (owner === turn) {
    if (selectedKey === key) { selectedKey = ''; legalMoves = emptyMoves(); render(); } else selectPiece(key);
    return;
  }
  if (owner) showToast('现在是' + playerLabel(turn) + '回合'); else if (selectedKey) showToast('这个位置不能到达');
}

function undoMove() {
  if (mode === 'online') return;
  clearTimeout(aiTimer); aiTimer = null; cancelAiSearch(); aiThinking = false;
  let previous = history.pop(); if (!previous) return;
  if (mode === 'ai' && previous.turn === 'blue' && history.length) previous = history.pop();
  restoreHistory(previous); saveGame(); render();
}

function resetGame(skipConfirm) {
  if (mode === 'online') {
    if (online.phase === 'done' && online.host === online.cid) sendOnline({ t: 'again' }); else closeWinner();
    return;
  }
  if (!skipConfirm && moveNumber > 1 && typeof window.confirm === 'function' && !window.confirm('确定重新开始当前棋局吗？')) return;
  resetState(); saveGame(); render();
}

function toggleSound() {
  soundEnabled = !soundEnabled; safeSet(CONFIG.SOUND_KEY, soundEnabled ? '1' : '0');
  var soundBtnEl = $('soundBtn');
  if (soundBtnEl) { soundBtnEl.innerHTML = '<i class="fa-solid ' + (soundEnabled ? 'fa-volume-high' : 'fa-volume-xmark') + '" aria-hidden="true"></i>'; soundBtnEl.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); soundBtnEl.setAttribute('aria-label', soundEnabled ? '关闭音效' : '开启音效'); }
}

function websocketUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/checkers-ws'; }
function sendOnline(message) { if (!online.ws || online.ws.readyState !== WebSocket.OPEN) return false; try { online.ws.send(JSON.stringify(message)); return true; } catch (e) { return false; } }

function reconnectDelayForAttempt(attempt, random) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const numericRandom = Number(random);
  const safeRandom = Number.isFinite(numericRandom) ? Math.max(0, Math.min(1, numericRandom)) : .5;
  const rawDelay = CONFIG.RECONNECT_BASE * Math.pow(1.7, safeAttempt - 1);
  return Math.min(CONFIG.RECONNECT_MAX, Math.round(rawDelay * (.85 + safeRandom * .3)));
}

function scheduleReconnect() {
  if (!online.active || online.intentionalClose || online.reconnectTimer) return;
  online.retryAttempt++;
  online.retryDelay = reconnectDelayForAttempt(online.retryAttempt, Math.random()); online.phase = 'reconnecting'; render();
  online.reconnectTimer = setTimeout(function () { online.reconnectTimer = null; if (online.active) connectOnline('join'); }, online.retryDelay);
}

function connectOnline(intent) {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') { showToast('联机模式需要通过服务器网址打开'); return; }
  const firstConnection = !online.active;
  if (firstConnection) {
    if (!CONFIG.ROOM_RE.test(launchRoom)) { showToast('房间码无效，请返回跳棋首页'); return; }
    online.active = true; online.room = launchRoom; online.cid = getClientId(); online.token = safeGet(CONFIG.TOKEN_PREFIX + launchRoom) || '';
    online.color = ''; online.players = []; online.host = ''; online.nick = safeGet(CONFIG.NICK_KEY) || '玩家'; online.intent = intent;
  }
  clearTimeout(online.reconnectTimer); online.reconnectTimer = null;
  if (online.ws) { online.intentionalClose = true; try { online.ws.close(1000, 'replace'); } catch (e) {} }
  online.phase = online.retryAttempt ? 'reconnecting' : 'connecting'; online.intentionalClose = false; render();
  let ws;
  try { ws = new WebSocket(websocketUrl()); } catch (e) { showToast('无法创建联机连接'); scheduleReconnect(); return; }
  online.ws = ws;
  ws.addEventListener('open', function () { if (online.ws === ws) sendOnline({ t: 'join', room: online.room, nick: online.nick, cid: online.cid, token: online.token, intent: online.intent }); });
  ws.addEventListener('message', function (event) {
    if (online.ws !== ws) return;
    let message; try { message = JSON.parse(event.data); } catch (e) { return; }
    if (message.t === 'session') {
      if (message.cid === online.cid && typeof message.token === 'string') { online.token = message.token; online.intent = 'join'; safeSet(CONFIG.TOKEN_PREFIX + online.room, online.token); }
      return;
    }
    if (message.t === 'state') {
      const clean = Core.sanitizeState(message); if (!clean || message.room !== online.room || !Array.isArray(message.players)) return;
      pieces = clean.pieces; turn = clean.turn; moveNumber = clean.moveNumber; gameOver = clean.winner; lastMove = clean.lastMove;
      online.phase = ['waiting','playing','done'].includes(message.phase) ? message.phase : 'waiting'; online.host = typeof message.host === 'string' ? message.host : '';
      online.players = message.players.slice(0, 2).map(function (player) { return { cid: String(player.cid || '').slice(0, 32), nick: String(player.nick || '玩家').slice(0, 16), color: player.color === 'blue' ? 'blue' : 'red', online: !!player.online }; });
      const self = online.players.find(function (player) { return player.cid === online.cid; }); if (self) online.color = self.color;
      viewPlayer = getViewPlayerForMode('online', online.color); selectedKey = ''; legalMoves = emptyMoves(); history = [];
      online.retryAttempt = 0; online.retryDelay = 0; online.intent = 'join';
      if (gameOver) showWinner(gameOver); else closeWinner(); render(); return;
    }
    if (message.t === 'err') {
      const errorMessage = String(message.msg || '联机操作失败').slice(0, 80);
      showToast(errorMessage);
      if (['ROOM_NOT_FOUND','ROOM_FULL','ROOM_EXISTS','SERVER_FULL','SESSION_INVALID','IP_ROOM_LIMIT','CREATE_RATE_LIMIT'].includes(message.code)) {
        leaveOnline(false);
        setTimeout(function () { location.href = 'index.html?error=' + encodeURIComponent(errorMessage); }, 650);
      }
    }
  });
  ws.addEventListener('close', function () { if (online.ws !== ws) return; online.ws = null; if (!online.active || online.intentionalClose) return; scheduleReconnect(); });
  ws.addEventListener('error', function () {});
}

function leaveOnline(notifyServer) {
  clearTimeout(online.reconnectTimer); online.reconnectTimer = null; online.intentionalClose = true;
  if (notifyServer !== false) sendOnline({ t: 'leave' }); if (online.ws) { try { online.ws.close(1000, 'left room'); } catch (e) {} }
  online.active = false; online.ws = null; online.room = ''; online.color = ''; online.players = []; online.host = ''; online.phase = 'idle'; online.retryAttempt = 0; online.retryDelay = 0;
}

function copyInvite() {
  if (!online.room) return;
  const url = new URL('index.html', location.href); url.searchParams.set('room', online.room);
  const text = '来和我下中国跳棋：' + url.toString();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { showToast('邀请链接已复制'); }, function () { showToast('房间码：' + online.room); });
  else showToast('房间码：' + online.room);
}

function exitToLobby() {
  clearTimeout(aiTimer); cancelAiSearch();
  if (mode === 'online') leaveOnline(true);
  location.href = 'index.html';
}

function init() {
  soundEnabled = safeGet(CONFIG.SOUND_KEY) !== '0';
  const requestedLevel = launchParams.get('level'); aiLevel = AI_LEVELS.includes(requestedLevel) ? requestedLevel : (AI_LEVELS.includes(safeGet(CONFIG.AI_LEVEL_KEY)) ? safeGet(CONFIG.AI_LEVEL_KEY) : 'normal');
  safeSet(CONFIG.AI_LEVEL_KEY, aiLevel); viewPlayer = 'red';
  if (mode === 'online') resetState(); else if (!loadGame()) { resetState(); saveGame(); }
  var soundBtnEl = $('soundBtn');
  if (soundBtnEl) { soundBtnEl.innerHTML = '<i class="fa-solid ' + (soundEnabled ? 'fa-volume-high' : 'fa-volume-xmark') + '" aria-hidden="true"></i>'; soundBtnEl.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); }
  $('onlineRoomBar').hidden = mode !== 'online';
  $('modeBadge').textContent = mode === 'ai' ? '人机对战 · ' + ({ easy:'轻松', normal:'标准', hard:'困难 · 自学习' }[aiLevel]) : (mode === 'local' ? '本地双人' : '好友对战');
  $('saveNote').textContent = mode === 'online' ? '联机棋局由服务器同步与校验，短暂断线会自动恢复。' : '棋局会自动保存在当前浏览器中，刷新后可以继续。';
  if (mode === 'online') $('roomCodeText').textContent = launchRoom || '-----';

  $('board').addEventListener('click', function (event) { const node = event.target.closest('[data-key]'); if (node) handleCell(node.dataset.key); });
  $('board').addEventListener('keydown', function (event) { const node = event.target.closest('[data-key]'); if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); handleCell(node.dataset.key); } });
  $('undoBtn').addEventListener('click', undoMove); $('newGameBtn').addEventListener('click', function () { resetGame(false); }); $('winnerNewBtn').addEventListener('click', function () { resetGame(true); });
  $('soundBtn').addEventListener('click', toggleSound); $('exitBtn').addEventListener('click', exitToLobby); $('copyInviteBtn').addEventListener('click', copyInvite); $('leaveRoomBtn').addEventListener('click', exitToLobby);
  window.addEventListener('beforeunload', function () { cancelAiSearch(); if (online.active) sendOnline({ t: 'ping' }); });
  render(); if (mode === 'ai' && turn === 'blue' && !gameOver) scheduleAiMove(); if (gameOver) showWinner(gameOver); if (mode === 'online') connectOnline(launchIntent);
}

window.__checkersTest = {
  CONFIG: CONFIG, Core: Core, mode: mode, getViewPlayerForMode: getViewPlayerForMode,
  normalizeRoom: normalizeRoom, sanitizeLocalState: sanitizeLocalState, websocketUrl: websocketUrl,
  reconnectDelayForAttempt: reconnectDelayForAttempt
};
window.addEventListener('DOMContentLoaded', init);
