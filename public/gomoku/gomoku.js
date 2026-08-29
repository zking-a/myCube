'use strict';

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const SAVE_KEYS = {
  ai: 'gomoku_save_ai_v1',
  local: 'gomoku_save_local_v1'
};
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

const params = new URLSearchParams(window.location.search);
const MODE = params.get('mode') === 'local' ? 'local' : 'ai';
const STORAGE_KEY = SAVE_KEYS[MODE];

const CONFIG = {
  aiColor: WHITE,
  humanColor: BLACK,
  aiThinkDelayMin: 110,
  aiThinkDelayMax: 240
};

function $(id) { return document.getElementById(id); }

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (error) {}
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch (error) {}
}

let board = [];
let state = {
  mode: MODE,
  turn: BLACK,
  winner: 0,
  finished: false,
  moveNumber: 0,
  history: [],
  lastMove: null,
  board: null,
  blackName: '黑方',
  whiteName: '白方'
};

const boardEl = $('gomokuBoard');
const cells = [];

function createEmptyBoard() {
  const b = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = new Array(BOARD_SIZE).fill(EMPTY);
    b.push(row);
  }
  return b;
}

function createState() {
  return {
    mode: MODE,
    turn: BLACK,
    winner: 0,
    finished: false,
    moveNumber: 0,
    history: [],
    lastMove: null,
    board: createEmptyBoard(),
    blackName: MODE === 'ai' ? '你（黑）' : '玩家 A（黑）',
    whiteName: MODE === 'ai' ? '电脑（白）' : '玩家 B（白）'
  };
}

function cloneBoard(source) {
  return source.map(function (row) { return row.slice(); });
}

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function loadSaved() {
  try {
    const raw = safeGet(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.mode !== MODE || data.finished || data.board == null) return null;
    if (!Number.isFinite(Number(data.moveNumber)) || data.moveNumber < 1) return null;
    if (!Array.isArray(data.board) || data.board.length !== BOARD_SIZE) return null;
    for (let r = 0; r < BOARD_SIZE; r++) {
      if (!Array.isArray(data.board[r]) || data.board[r].length !== BOARD_SIZE) return null;
      for (let c = 0; c < BOARD_SIZE; c++) {
        const v = data.board[r][c];
        if (v !== 0 && v !== 1 && v !== 2) return null;
      }
    }
    return {
      mode: MODE,
      turn: data.turn === WHITE ? WHITE : BLACK,
      winner: 0,
      finished: false,
      moveNumber: Math.max(0, safeNumber(data.moveNumber) || 0),
      history: Array.isArray(data.history) ? data.history : [],
      lastMove: data.lastMove || null,
      board: cloneBoard(data.board),
      blackName: MODE === 'ai' ? '你（黑）' : '玩家 A（黑）',
      whiteName: MODE === 'ai' ? '电脑（白）' : '玩家 B（白）'
    };
  } catch (error) {
    return null;
  }
}

function saveState() {
  if (state.finished) {
    safeRemove(STORAGE_KEY);
    return;
  }
  const data = {
    mode: state.mode,
    turn: state.turn,
    winner: state.winner,
    finished: state.finished,
    moveNumber: state.moveNumber,
    history: state.history,
    lastMove: state.lastMove,
    board: state.board,
    ts: Date.now()
  };
  safeSet(STORAGE_KEY, JSON.stringify(data));
}

function createBoardUI() {
  boardEl.innerHTML = '';
  cells.length = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = [];
    for (let c = 0; c < BOARD_SIZE; c++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gomoku-cell is-empty';
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', `第 ${r + 1} 行 第 ${c + 1} 列`);
      button.setAttribute('data-r', String(r));
      button.setAttribute('data-c', String(c));
      if (r === 0) button.classList.add('gomoku-row-first');
      button.style.setProperty('--r', r);
      button.style.setProperty('--c', c);
      const stone = document.createElement('span');
      stone.className = 'gomoku-stone';
      button.appendChild(stone);
      button.addEventListener('click', onCellClick);
      boardEl.appendChild(button);
      row.push(button);
    }
    cells.push(row);
  }
}

function isInside(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

function countRun(r, c, dr, dc, color) {
  let steps = 0;
  let rr = r + dr;
  let cc = c + dc;
  while (isInside(rr, cc) && board[rr][cc] === color) {
    steps++;
    rr += dr;
    cc += dc;
  }
  let open = isInside(rr, cc) && board[rr][cc] === EMPTY;
  return { steps: steps, open: open };
}

function checkWin(r, c, color) {
  for (let i = 0; i < DIRS.length; i++) {
    const [dr, dc] = DIRS[i];
    const forward = countRun(r, c, dr, dc, color);
    const backward = countRun(r, c, -dr, -dc, color);
    const total = forward.steps + backward.steps + 1;
    if (total >= 5) {
      return true;
    }
  }
  return false;
}

function renderBoard() {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const value = board[r][c];
      const cell = cells[r][c];
      const stone = cell.firstElementChild;
      cell.classList.remove('is-black', 'is-white', 'is-empty', 'is-last', 'is-disabled');
      if (value === BLACK) {
        cell.classList.add('is-black');
        stone.style.display = 'block';
      } else if (value === WHITE) {
        cell.classList.add('is-white');
        stone.style.display = 'block';
      } else {
        cell.classList.add('is-empty');
        stone.style.display = 'none';
      }
      if (state.lastMove && state.lastMove.r === r && state.lastMove.c === c) {
        cell.classList.add('is-last');
      }
      cell.disabled = state.finished || !!(value !== EMPTY);
      if (value !== EMPTY || state.finished) {
        cell.classList.add('is-disabled');
      }
    }
  }
  if (!state.finished) {
    cells.flat().forEach(function (cell) {
      if (cell.firstElementChild.style.display === 'none' && !cell.classList.contains('is-disabled')) {
        cell.classList.remove('is-disabled');
      }
    });
  }
  updatePlayers();
  updateStatus();
}

function updateStatus() {
  const turnText = $('turnText');
  const turnSub = $('turnSub');
  const moveText = $('moveText');
  const badge = $('modeBadge');
  const blackCount = $('blackCount');
  const whiteCount = $('whiteCount');
  const blackRow = $('blackRow');
  const whiteRow = $('whiteRow');

  const blackName = MODE === 'ai' ? '你（黑）' : '玩家 A（黑）';
  const whiteName = MODE === 'ai' ? '电脑（白）' : '玩家 B（白）';
  const turnName = state.turn === BLACK ? blackName : whiteName;

  $('blackName').textContent = blackName;
  $('whiteName').textContent = whiteName;
  $('blackSub').textContent = blackRow.classList.contains('active') ? '本回合' : '先手';
  $('whiteSub').textContent = whiteRow.classList.contains('active') ? '本回合' : '后手';

  moveText.textContent = `第 ${state.moveNumber} 手`;
  if (state.finished) {
    if (state.winner === BLACK) {
      turnText.textContent = '黑方赢了';
      turnSub.textContent = `${MODE === 'ai' ? '你' : '玩家 A'} 完成五子连珠`; 
    } else if (state.winner === WHITE) {
      turnText.textContent = '白方赢了';
      turnSub.textContent = `${MODE === 'ai' ? '电脑' : '玩家 B'} 完成五子连珠`;
    } else {
      turnText.textContent = '和局';
      turnSub.textContent = '棋盘已满，未分胜负';
    }
  } else if (state.winner === 0 && isAiTurn()) {
    turnText.textContent = turnName;
    turnSub.textContent = 'AI 正在思考…';
  } else {
    turnText.textContent = `${turnName}落子`; 
    turnSub.textContent = state.moveNumber === 0 ? '黑方先手，点击任意空位开始' : '点击空位落子';
  }

  blackCount.textContent = String(state.history.filter(function (m) { return m.player === BLACK; }).length);
  whiteCount.textContent = String(state.history.filter(function (m) { return m.player === WHITE; }).length);

  if (MODE === 'ai') {
    badge.textContent = '单机人机（AI 对局）';
  } else {
    badge.textContent = '本地双人（同屏对战）';
  }
}

function updatePlayers() {
  const blackRow = $('blackRow');
  const whiteRow = $('whiteRow');
  blackRow.classList.toggle('active', state.turn === BLACK);
  whiteRow.classList.toggle('active', state.turn === WHITE);
}

function setHint(text) {
  const hint = $('hintText');
  hint.textContent = text;
}

function isAiTurn() {
  return MODE === 'ai' && state.turn === CONFIG.aiColor;
}

function placeStone(r, c, player) {
  if (!isInside(r, c) || state.finished) return false;
  if (board[r][c] !== EMPTY) return false;
  board[r][c] = player;
  state.history.push({ r: r, c: c, player: player, t: Date.now() });
  state.moveNumber += 1;
  state.lastMove = { r: r, c: c, player: player };
  const isWin = checkWin(r, c, player);
  if (isWin) {
    state.finished = true;
    state.winner = player;
    const winner = player === BLACK ? '黑方' : '白方';
    showResult(`${winner}获胜`);
  }
  if (!state.finished && state.moveNumber >= BOARD_SIZE * BOARD_SIZE) {
    state.finished = true;
    state.winner = 0;
    showResult('和局，棋盘已满');
  }
  state.turn = player === BLACK ? WHITE : BLACK;
  saveState();
  renderBoard();
  return true;
}

function onCellClick(event) {
  if (state.finished) return;
  const cell = event.currentTarget;
  const r = parseInt(cell.dataset.r, 10);
  const c = parseInt(cell.dataset.c, 10);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  if (!canPlayNow()) {
    setHint('AI 回合，等待电脑落子');
    return;
  }
  if (!placeStone(r, c, state.turn)) return;
  if (!state.finished && isAiTurn()) {
    scheduleAiMove();
  }
}

function canPlayNow() {
  if (state.finished) return false;
  if (MODE === 'local') return true;
  return state.turn === CONFIG.humanColor;
}

function scheduleAiMove() {
  const delay = Math.floor(CONFIG.aiThinkDelayMin + Math.random() * (CONFIG.aiThinkDelayMax - CONFIG.aiThinkDelayMin));
  setHint('AI 思考中……');
  setTimeout(function () {
    if (!isAiTurn() || state.finished) return;
    const move = chooseAiMove();
    if (!move) {
      setHint('AI 暂无可下位置');
      return;
    }
    placeStone(move.r, move.c, CONFIG.aiColor);
    if (!state.finished) {
      setHint('你的回合，点击空位');
    }
  }, delay);
}

function chooseAiMove() {
  const candidates = collectCandidates();
  if (candidates.length === 0) return null;

  // 直接赢
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    board[m.r][m.c] = CONFIG.aiColor;
    const win = checkWin(m.r, m.c, CONFIG.aiColor);
    board[m.r][m.c] = EMPTY;
    if (win) {
      return m;
    }
  }

  // 阻挡对手先手必赢
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    board[m.r][m.c] = CONFIG.humanColor;
    const win = checkWin(m.r, m.c, CONFIG.humanColor);
    board[m.r][m.c] = EMPTY;
    if (win) {
      return m;
    }
  }

  let bestScore = -1;
  let bestMoves = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const attack = evalPoint(m.r, m.c, CONFIG.aiColor) * 1.15;
    const defend = evalPoint(m.r, m.c, CONFIG.humanColor) * 0.85;
    const score = attack + defend + (Math.random() * 18);
    if (score > bestScore) {
      bestScore = score;
      bestMoves = [m];
    } else if (score === bestScore) {
      bestMoves.push(m);
    }
  }

  const picked = bestMoves[Math.floor(Math.random() * bestMoves.length)];
  return picked || candidates[0];
}

function collectCandidates() {
  const occupied = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== EMPTY) {
        occupied.push([r, c]);
      }
    }
  }
  if (occupied.length === 0) {
    const center = Math.floor((BOARD_SIZE - 1) / 2);
    return [{ r: center, c: center }];
  }

  const used = new Set();
  const candidates = [];
  const add = function (r, c) {
    if (!isInside(r, c) || board[r][c] !== EMPTY) return;
    const key = r + ',' + c;
    if (used.has(key)) return;
    used.add(key);
    candidates.push({ r: r, c: c });
  };

  for (let i = 0; i < occupied.length; i++) {
    const [r, c] = occupied[i];
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        add(r + dr, c + dc);
      }
    }
  }

  if (candidates.length === 0) {
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (board[r][c] === EMPTY) candidates.push({ r: r, c: c });
      }
    }
  }

  return candidates;
}

function linePatternScore(total, openLeft, openRight) {
  const openCount = (openLeft ? 1 : 0) + (openRight ? 1 : 0);
  if (total >= 5) return 20000;
  if (total === 4) return openCount === 2 ? 6500 : 1900;
  if (total === 3) return openCount === 2 ? 1300 : 420;
  if (total === 2) return openCount === 2 ? 400 : 120;
  if (total === 1) return openCount === 2 ? 30 : 8;
  return 0;
}

function evalPoint(r, c, color) {
  let score = 0;
  board[r][c] = color;
  for (let i = 0; i < DIRS.length; i++) {
    const [dr, dc] = DIRS[i];
    const forward = countRun(r, c, dr, dc, color);
    const backward = countRun(r, c, -dr, -dc, color);
    const total = 1 + forward.steps + backward.steps;
    score += linePatternScore(total, forward.open, backward.open);
  }
  board[r][c] = EMPTY;
  return score;
}

function undo() {
  if (!state.history.length) {
    setHint('没有可悔棋的内容');
    return;
  }
  const last = state.history.pop();
  board[last.r][last.c] = EMPTY;
  state.moveNumber = Math.max(0, state.moveNumber - 1);
  state.turn = last.player;
  state.lastMove = state.history.length ? state.history[state.history.length - 1] : null;
  state.winner = 0;
  state.finished = false;
  state.winnerLine = null;
  setHint('已悔棋');
  saveState();
  renderBoard();
  if (isAiTurn()) {
    scheduleAiMove();
  }
}

function newGame() {
  state = createState();
  board = state.board;
  $('resultOverlay').classList.remove('show');
  safeRemove(STORAGE_KEY);
  setHint('新局已开始，黑方先手');
  saveState();
  renderBoard();
}

function normalizeBoardForTest(input) {
  const board = createEmptyBoard();
  if (!Array.isArray(input) || input.length !== BOARD_SIZE) return board;
  for (let r = 0; r < BOARD_SIZE; r++) {
    if (!Array.isArray(input[r]) || input[r].length !== BOARD_SIZE) return board;
    for (let c = 0; c < BOARD_SIZE; c++) {
      const value = input[r][c];
      board[r][c] = (value === BLACK || value === WHITE) ? value : EMPTY;
    }
  }
  return board;
}

function setStateForTest(seed) {
  const next = {
    mode: MODE,
    turn: seed && seed.turn === WHITE ? WHITE : BLACK,
    winner: seed && (seed.winner === WHITE ? WHITE : (seed.winner === BLACK ? BLACK : 0)),
    finished: !!(seed && seed.finished),
    moveNumber: seed && Number.isFinite(Number(seed.moveNumber)) ? Math.max(0, Math.floor(seed.moveNumber)) : 0,
    history: Array.isArray(seed && seed.history) ? seed.history.slice() : [],
    lastMove: seed && seed.lastMove ? {
      r: Number.isInteger(seed.lastMove.r) ? seed.lastMove.r : null,
      c: Number.isInteger(seed.lastMove.c) ? seed.lastMove.c : null,
      player: seed.lastMove.player === WHITE ? WHITE : BLACK
    } : null,
    board: normalizeBoardForTest(seed && seed.board)
  };
  if (!next.history.length && next.board) next.moveNumber = 0;
  state = {
    mode: MODE,
    turn: next.turn,
    winner: next.winner,
    finished: next.finished,
    moveNumber: next.moveNumber,
    history: next.history,
    lastMove: next.lastMove,
    board: next.board,
    blackName: MODE === 'ai' ? '你（黑）' : '玩家 A（黑）',
    whiteName: MODE === 'ai' ? '电脑（白）' : '玩家 B（白）'
  };
  board = state.board;
  renderBoard();
  return {
    turn: state.turn,
    winner: state.winner,
    finished: state.finished,
    moveNumber: state.moveNumber
  };
}

function getTestSnapshot() {
  return {
    mode: state.mode,
    turn: state.turn,
    winner: state.winner,
    finished: state.finished,
    moveNumber: state.moveNumber,
    history: state.history.slice(),
    lastMove: state.lastMove && Object.assign({}, state.lastMove),
    board: cloneBoard(board)
  };
}

function showResult(reason) {
  const overlay = $('resultOverlay');
  const title = $('resultTitle');
  const text = $('resultText');
  title.textContent = state.finished ? '本局结束' : '提示';
  if (reason) {
    text.textContent = reason;
  } else if (state.winner === BLACK) {
    text.textContent = '黑方获胜';
  } else if (state.winner === WHITE) {
    text.textContent = '白方获胜';
  } else {
    text.textContent = '本局结束';
  }
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  state.finished = true;
  safeRemove(STORAGE_KEY);
}

if (typeof window !== 'undefined') {
  window.__gomokuTest = {
    BOARD_SIZE: BOARD_SIZE,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    isInside: isInside,
    createEmptyBoard: createEmptyBoard,
    cloneBoard: cloneBoard,
    createState: createState,
    countRun: countRun,
    checkWin: checkWin,
    linePatternScore: linePatternScore,
    evalPoint: evalPoint,
    collectCandidates: collectCandidates,
    placeStone: placeStone,
    undo: undo,
    newGame: newGame,
    chooseAiMove: chooseAiMove,
    setStateForTest: setStateForTest,
    getTestSnapshot: getTestSnapshot,
    setHint: setHint,
    saveState: saveState
  };
}

function initMode() {
  const title = $('gameTitle');
  const isLocal = MODE === 'local';
  if (isLocal) {
    title.textContent = '五子棋 · 本地双人';
  } else {
    title.textContent = '五子棋 · 单机人机';
  }
  document.body.classList.add(isLocal ? 'mode-local' : 'mode-ai');
}

function bindEvents() {
  $('undoBtn').addEventListener('click', undo);
  $('resetBtn').addEventListener('click', newGame);
  $('resultRestart').addEventListener('click', newGame);
}

function init() {
  board = createEmptyBoard();
  createBoardUI();
  initMode();
  state = loadSaved() || createState();
  board = state.board;
  if (!Array.isArray(state.history)) state.history = [];
  bindEvents();
  renderBoard();
  if (state.history.length > 0) {
    setHint('检测到上局记录，已恢复对局');
  } else {
    setHint('新局已就绪，点击空位开始');
  }
  if (isAiTurn() && !state.finished) {
    scheduleAiMove();
  }
}

window.addEventListener('DOMContentLoaded', init);
