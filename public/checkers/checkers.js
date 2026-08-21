'use strict';

const CONFIG = {
  STORAGE_KEY: 'chinese_checkers_save_v1',
  SOUND_KEY: 'chinese_checkers_sound',
  HISTORY_LIMIT: 80,
  ROW_COUNTS: [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1],
  DIRECTIONS: [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]],
};

function keyOf(row, unit) { return row + ':' + unit; }

function buildBoardCells() {
  const cells = [];
  CONFIG.ROW_COUNTS.forEach((count, row) => {
    for (let column = 0; column < count; column++) {
      const unit = -(count - 1) + column * 2;
      cells.push({
        key: keyOf(row, unit), row, unit,
        x: 160 + unit * 10.8,
        y: 16 + row * 18,
        camp: row <= 3 ? 'top' : (row >= 13 ? 'bottom' : ''),
      });
    }
  });
  return cells;
}

const BOARD_CELLS = buildBoardCells();
const CELL_MAP = new Map(BOARD_CELLS.map(cell => [cell.key, cell]));
const TOP_CAMP = new Set(BOARD_CELLS.filter(cell => cell.camp === 'top').map(cell => cell.key));
const BOTTOM_CAMP = new Set(BOARD_CELLS.filter(cell => cell.camp === 'bottom').map(cell => cell.key));

function createInitialPieces() {
  const pieceMap = {};
  TOP_CAMP.forEach(key => { pieceMap[key] = 'red'; });
  BOTTOM_CAMP.forEach(key => { pieceMap[key] = 'blue'; });
  return pieceMap;
}

function getLegalMoves(pieceMap, fromKey) {
  const from = CELL_MAP.get(fromKey);
  if (!from || !pieceMap || !pieceMap[fromKey]) return { steps: [], jumps: [], all: [] };
  const steps = [];
  CONFIG.DIRECTIONS.forEach(direction => {
    const targetKey = keyOf(from.row + direction[0], from.unit + direction[1]);
    if (CELL_MAP.has(targetKey) && !pieceMap[targetKey]) steps.push(targetKey);
  });

  const jumps = [];
  const visited = new Set([fromKey]);
  const queue = [fromKey];
  const occupied = key => key !== fromKey && !!pieceMap[key];
  while (queue.length) {
    const current = CELL_MAP.get(queue.shift());
    CONFIG.DIRECTIONS.forEach(direction => {
      const overKey = keyOf(current.row + direction[0], current.unit + direction[1]);
      const landingKey = keyOf(current.row + direction[0] * 2, current.unit + direction[1] * 2);
      if (!CELL_MAP.has(landingKey) || !occupied(overKey) || occupied(landingKey) || visited.has(landingKey)) return;
      visited.add(landingKey);
      jumps.push(landingKey);
      queue.push(landingKey);
    });
  }
  return { steps, jumps, all: steps.concat(jumps) };
}

function countInGoal(pieceMap, player) {
  const goal = player === 'red' ? BOTTOM_CAMP : TOP_CAMP;
  let count = 0;
  goal.forEach(key => { if (pieceMap[key] === player) count++; });
  return count;
}

function hasWon(pieceMap, player) { return countInGoal(pieceMap, player) === 10; }

function getBoardRotation(player) { return player === 'red' ? 180 : 0; }

function sanitizeSavedGame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.turn !== 'red' && raw.turn !== 'blue') return null;
  if (!raw.pieces || typeof raw.pieces !== 'object' || Array.isArray(raw.pieces)) return null;
  const cleanPieces = {};
  let red = 0, blue = 0;
  Object.keys(raw.pieces).forEach(key => {
    const owner = raw.pieces[key];
    if (!CELL_MAP.has(key) || (owner !== 'red' && owner !== 'blue') || cleanPieces[key]) return;
    cleanPieces[key] = owner;
    if (owner === 'red') red++;
    else blue++;
  });
  if (red !== 10 || blue !== 10) return null;
  return {
    pieces: cleanPieces,
    turn: raw.turn,
    moveNumber: Math.max(1, Math.min(9999, Math.floor(Number(raw.moveNumber) || 1))),
    gameOver: (raw.gameOver === 'red' || raw.gameOver === 'blue') && hasWon(cleanPieces, raw.gameOver) ? raw.gameOver : '',
  };
}

let pieces = createInitialPieces();
let turn = 'red';
let selectedKey = '';
let legalMoves = { steps: [], jumps: [], all: [] };
let history = [];
let moveNumber = 1;
let gameOver = '';
let soundEnabled = true;
let toastTimer = null;

function $(id) { return document.getElementById(id); }
function svgElement(name) { return document.createElementNS('http://www.w3.org/2000/svg', name); }

function saveGame() {
  try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({ pieces, turn, moveNumber, gameOver })); } catch (e) {}
}

function loadGame() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    const saved = raw ? sanitizeSavedGame(JSON.parse(raw)) : null;
    if (!saved) return false;
    pieces = saved.pieces; turn = saved.turn; moveNumber = saved.moveNumber; gameOver = saved.gameOver;
    return true;
  } catch (e) { return false; }
}

function pushHistory() {
  history.push({ pieces: { ...pieces }, turn, moveNumber, gameOver });
  if (history.length > CONFIG.HISTORY_LIMIT) history.shift();
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function playTone(kind) {
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!soundEnabled || !AudioEngine) return;
  try {
    const context = new AudioEngine();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = kind === 'jump' ? 620 : (kind === 'win' ? 760 : 470);
    gain.gain.setValueAtTime(.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + (kind === 'win' ? .32 : .13));
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + (kind === 'win' ? .32 : .13));
    oscillator.onended = () => context.close();
  } catch (e) {}
}

function cellLabel(cell, owner, moveKind) {
  const base = '第 ' + (cell.row + 1) + ' 行';
  if (owner) return base + '，' + (owner === 'red' ? '红方棋子' : '蓝方棋子');
  if (moveKind) return base + '，可' + (moveKind === 'jump' ? '跳跃到达' : '移动到达');
  return base + '，空位';
}

function renderBoard() {
  const board = $('board');
  board.replaceChildren();
  const stepSet = new Set(legalMoves.steps);
  const jumpSet = new Set(legalMoves.jumps);
  const keyboardFocusKey = selectedKey || Object.keys(pieces).find(key => pieces[key] === turn) || BOARD_CELLS[0].key;
  BOARD_CELLS.forEach(cell => {
    const group = svgElement('g');
    const owner = pieces[cell.key] || '';
    const moveKind = jumpSet.has(cell.key) ? 'jump' : (stepSet.has(cell.key) ? 'step' : '');
    group.classList.add('cell-node');
    if (cell.camp) group.classList.add(cell.camp + '-camp');
    if (selectedKey === cell.key) group.classList.add('selected');
    if (moveKind) group.classList.add(moveKind + '-target');
    group.dataset.key = cell.key;
    group.setAttribute('role', 'gridcell');
    group.setAttribute('tabindex', keyboardFocusKey === cell.key ? '0' : '-1');
    group.setAttribute('aria-label', cellLabel(cell, owner, moveKind));

    const hit = svgElement('circle');
    hit.classList.add('hit-area');
    hit.setAttribute('cx', cell.x); hit.setAttribute('cy', cell.y); hit.setAttribute('r', '12');
    group.appendChild(hit);
    const hole = svgElement('circle');
    hole.classList.add('hole');
    hole.setAttribute('cx', cell.x); hole.setAttribute('cy', cell.y); hole.setAttribute('r', moveKind ? '7.1' : '6.2');
    group.appendChild(hole);
    if (owner) {
      const piece = svgElement('circle');
      piece.classList.add('piece', owner + '-piece');
      piece.setAttribute('cx', cell.x); piece.setAttribute('cy', cell.y); piece.setAttribute('r', '7.9');
      group.appendChild(piece);
    }
    board.appendChild(group);
  });
}

function updateStatus() {
  const isRed = turn === 'red';
  const board = $('board');
  board.dataset.rotation = String(getBoardRotation(turn));
  board.classList.toggle('view-red', isRed);
  board.classList.toggle('view-blue', !isRed);
  board.setAttribute('aria-label', '中国跳棋棋盘，' + (isRed ? '红方' : '蓝方') + '视角，当前行动方位于下方');
  $('turnPiece').className = 'turn-piece ' + turn;
  $('turnText').textContent = gameOver ? (gameOver === 'red' ? '红方获胜' : '蓝方获胜') : (isRed ? '红方回合' : '蓝方回合');
  $('turnKicker').textContent = gameOver ? '本局已经结束' : (isRed ? '红方' : '蓝方') + '视角 · 己方在下';
  $('moveCount').textContent = '第 ' + moveNumber + ' 手';
  $('redProgress').textContent = countInGoal(pieces, 'red') + '/10';
  $('blueProgress').textContent = countInGoal(pieces, 'blue') + '/10';
  $('redPlayer').classList.toggle('active', !gameOver && isRed);
  $('bluePlayer').classList.toggle('active', !gameOver && !isRed);
  $('undoBtn').disabled = history.length === 0;
  $('boardTip').textContent = selectedKey
    ? (legalMoves.all.length ? '绿色为空位移动，金色为跳跃；再次点击已选棋子可以取消。' : '这枚棋子当前没有可走位置。')
    : '点击己方棋子，再点击高亮位置移动；金色圆环表示可以跳跃。';
}

function render() { renderBoard(); updateStatus(); }

function selectPiece(key) {
  selectedKey = key; legalMoves = getLegalMoves(pieces, key);
  if (!legalMoves.all.length) showToast('这枚棋子暂时没有可走位置');
  render();
}

function showWinner(player) {
  const isRed = player === 'red';
  $('winnerPiece').className = 'winner-piece ' + player;
  $('winnerTitle').textContent = (isRed ? '红方' : '蓝方') + '获胜！';
  $('winnerText').textContent = '率先把 10 枚棋子全部移入了对方营地';
  $('winnerOverlay').classList.add('active');
  $('winnerOverlay').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('winnerNewBtn').focus(), 0);
}

function closeWinner() {
  const overlay = $('winnerOverlay');
  overlay.classList.remove('active'); overlay.setAttribute('aria-hidden', 'true');
}

function movePiece(targetKey) {
  const owner = pieces[selectedKey];
  const wasJump = legalMoves.jumps.includes(targetKey);
  pushHistory();
  delete pieces[selectedKey]; pieces[targetKey] = owner;
  selectedKey = ''; legalMoves = { steps: [], jumps: [], all: [] };
  if (hasWon(pieces, owner)) {
    gameOver = owner; playTone('win'); showWinner(owner);
  } else {
    turn = owner === 'red' ? 'blue' : 'red'; moveNumber++; playTone(wasJump ? 'jump' : 'step');
  }
  saveGame(); render();
}

function handleCell(key) {
  if (gameOver) return;
  if (selectedKey && legalMoves.all.includes(key)) { movePiece(key); return; }
  const owner = pieces[key];
  if (owner === turn) {
    if (selectedKey === key) {
      selectedKey = ''; legalMoves = { steps: [], jumps: [], all: [] }; render();
    } else selectPiece(key);
    return;
  }
  if (owner) showToast('现在是' + (turn === 'red' ? '红方' : '蓝方') + '回合');
  else if (selectedKey) showToast('这个位置不能到达');
}

function undoMove() {
  const previous = history.pop();
  if (!previous) return;
  pieces = previous.pieces; turn = previous.turn; moveNumber = previous.moveNumber; gameOver = previous.gameOver;
  selectedKey = ''; legalMoves = { steps: [], jumps: [], all: [] };
  closeWinner(); saveGame(); render();
}

function resetGame(skipConfirm) {
  if (!skipConfirm && moveNumber > 1 && typeof window.confirm === 'function' && !window.confirm('确定重新开始当前棋局吗？')) return;
  pieces = createInitialPieces(); turn = 'red'; selectedKey = '';
  legalMoves = { steps: [], jumps: [], all: [] }; history = []; moveNumber = 1; gameOver = '';
  closeWinner(); saveGame(); render();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem(CONFIG.SOUND_KEY, soundEnabled ? '1' : '0'); } catch (e) {}
  $('soundBtn').textContent = soundEnabled ? '🔊' : '🔇';
  $('soundBtn').setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
  $('soundBtn').setAttribute('aria-label', soundEnabled ? '关闭音效' : '开启音效');
}

function init() {
  try { soundEnabled = localStorage.getItem(CONFIG.SOUND_KEY) !== '0'; } catch (e) {}
  $('soundBtn').textContent = soundEnabled ? '🔊' : '🔇';
  $('soundBtn').setAttribute('aria-pressed', soundEnabled ? 'true' : 'false');
  loadGame();
  $('board').addEventListener('click', event => {
    const node = event.target.closest('[data-key]');
    if (node) handleCell(node.dataset.key);
  });
  $('board').addEventListener('keydown', event => {
    const node = event.target.closest('[data-key]');
    if (node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); handleCell(node.dataset.key); }
  });
  $('undoBtn').addEventListener('click', undoMove);
  $('newGameBtn').addEventListener('click', () => resetGame(false));
  $('winnerNewBtn').addEventListener('click', () => resetGame(true));
  $('soundBtn').addEventListener('click', toggleSound);
  render();
  if (gameOver) showWinner(gameOver);
}

window.__checkersTest = {
  CONFIG,
  BOARD_CELLS: BOARD_CELLS.map(cell => ({ ...cell })),
  TOP_CAMP: [...TOP_CAMP], BOTTOM_CAMP: [...BOTTOM_CAMP],
  buildBoardCells, createInitialPieces, getLegalMoves,
  countInGoal, hasWon, getBoardRotation, sanitizeSavedGame,
};

window.addEventListener('DOMContentLoaded', init);
