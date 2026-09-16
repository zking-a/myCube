'use strict';

const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const SAVE_KEYS = {
  ai: 'gomoku_save_ai_v1'
};
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const STAR_POINTS = new Set(['3,3', '3,11', '7,7', '11,3', '11,11']);

const params = new URLSearchParams(window.location.search);
const RAW_MODE = params.get('mode');
const MODE = RAW_MODE === 'online' ? 'online' : 'ai';
const AI_LEVEL = ['easy', 'normal', 'hard'].includes(params.get('level')) ? params.get('level') : 'normal';
const STORAGE_KEY = SAVE_KEYS[MODE] || SAVE_KEYS.ai;
const IS_ONLINE = MODE === 'online';
// 联机态：棋盘与轮次完全由 /gomoku-ws 下发，本地只负责渲染与上报落子。
const ONLINE = {
  room: String(params.get('room') || '').toUpperCase(),
  intent: params.get('intent') === 'create' ? 'create' : 'join',
  nick: '',
  seat: -1,
  color: 0,
  revision: 0,
  phase: '',
  status: 'connecting',
  client: null,
  host: '',
  players: [],
  inviteUrl: ''
};

const CONFIG = {
  aiColor: WHITE,
  humanColor: BLACK,
  aiThinkDelayMin: 110,
  aiThinkDelayMax: 240,
  aiLevel: AI_LEVEL
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
let previewMove = null;
let focusedCell = { r: Math.floor(BOARD_SIZE / 2), c: Math.floor(BOARD_SIZE / 2) };

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
    blackName: '你（黑）',
    whiteName: '电脑（' + ({ easy: '轻松', normal: '标准', hard: '困难' }[CONFIG.aiLevel]) + '）'
  };
}

function cloneBoard(source) {
  return source.map(function (row) { return row.slice(); });
}

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function loadSaved() {
  // 联机局的权威状态在服务端，本地存档会让重连后出现两套棋局。
  if (IS_ONLINE) return null;
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
      blackName: '你（黑）',
      whiteName: '电脑（' + ({ easy: '轻松', normal: '标准', hard: '困难' }[CONFIG.aiLevel]) + '）'
    };
  } catch (error) {
    return null;
  }
}

function saveState() {
  if (IS_ONLINE) return;
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
    const rowElement = document.createElement('div');
    rowElement.className = 'gomoku-row';
    rowElement.setAttribute('role', 'row');
    rowElement.setAttribute('aria-rowindex', String(r + 1));
    const row = [];
    for (let c = 0; c < BOARD_SIZE; c++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gomoku-cell is-empty';
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', `第 ${r + 1} 行 第 ${c + 1} 列`);
      button.setAttribute('aria-colindex', String(c + 1));
      button.setAttribute('data-r', String(r));
      button.setAttribute('data-c', String(c));
      button.tabIndex = -1;
      if (STAR_POINTS.has(r + ',' + c)) button.classList.add('is-star');
      button.style.setProperty('--r', r);
      button.style.setProperty('--c', c);
      const stone = document.createElement('span');
      stone.className = 'gomoku-stone';
      button.appendChild(stone);
      button.addEventListener('click', onCellClick);
      button.addEventListener('keydown', onCellKeydown);
      rowElement.appendChild(button);
      row.push(button);
    }
    boardEl.appendChild(rowElement);
    cells.push(row);
  }
  setGridFocus(focusedCell.r, focusedCell.c, false);
}

function setGridFocus(r, c, shouldFocus) {
  const nextR = Math.max(0, Math.min(BOARD_SIZE - 1, r));
  const nextC = Math.max(0, Math.min(BOARD_SIZE - 1, c));
  const previous = cells[focusedCell.r] && cells[focusedCell.r][focusedCell.c];
  const next = cells[nextR] && cells[nextR][nextC];
  if (!next) return;
  if (previous && previous !== next) previous.tabIndex = -1;
  next.tabIndex = 0;
  focusedCell = { r: nextR, c: nextC };
  if (shouldFocus && typeof next.focus === 'function') next.focus();
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
      const isPreview = !!previewMove && previewMove.r === r && previewMove.c === c && value === EMPTY;
      cell.classList.remove('is-black', 'is-white', 'is-empty', 'is-last', 'is-disabled', 'is-preview');
      if (value === BLACK) {
        cell.classList.add('is-black');
        stone.style.display = 'block';
      } else if (value === WHITE) {
        cell.classList.add('is-white');
        stone.style.display = 'block';
      } else if (isPreview) {
        cell.classList.add(previewMove.player === BLACK ? 'is-black' : 'is-white', 'is-preview');
        stone.style.display = 'block';
      } else {
        cell.classList.add('is-empty');
        stone.style.display = 'none';
      }
      if (state.lastMove && state.lastMove.r === r && state.lastMove.c === c) {
        cell.classList.add('is-last');
      }
      cell.disabled = state.finished;
      cell.setAttribute('aria-disabled', value !== EMPTY || state.finished ? 'true' : 'false');
      cell.setAttribute('aria-selected', isPreview ? 'true' : 'false');
      if (value === BLACK) {
        cell.setAttribute('aria-label', `第 ${r + 1} 行 第 ${c + 1} 列，黑方棋子`);
      } else if (value === WHITE) {
        cell.setAttribute('aria-label', `第 ${r + 1} 行 第 ${c + 1} 列，白方棋子`);
      } else if (isPreview) {
        cell.setAttribute('aria-label', `第 ${r + 1} 行 第 ${c + 1} 列，${previewMove.player === BLACK ? '黑方' : '白方'}预览，按回车或再次点击确认`);
      } else {
        cell.setAttribute('aria-label', `第 ${r + 1} 行 第 ${c + 1} 列，空位`);
      }
      if (value !== EMPTY || state.finished) {
        cell.classList.add('is-disabled');
      }
    }
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

  const blackName = state.blackName || '你（黑）';
  const whiteName = state.whiteName || '电脑（白）';
  const turnName = state.turn === BLACK ? blackName : whiteName;

  $('blackName').textContent = blackName;
  $('whiteName').textContent = whiteName;
  $('blackSub').textContent = blackRow.classList.contains('active') ? '本回合' : '先手';
  $('whiteSub').textContent = whiteRow.classList.contains('active') ? '本回合' : '后手';

  moveText.textContent = `第 ${state.moveNumber} 手`;
  if (state.finished) {
    if (state.winner === BLACK) {
      turnText.textContent = '黑方赢了';
      turnSub.textContent = `${blackName} 完成五子连珠`;
    } else if (state.winner === WHITE) {
      turnText.textContent = '白方赢了';
      turnSub.textContent = `${whiteName} 完成五子连珠`;
    } else {
      turnText.textContent = '和局';
      turnSub.textContent = '棋盘已满，未分胜负';
    }
  } else if (state.winner === 0 && isAiTurn()) {
    turnText.textContent = turnName;
    turnSub.textContent = 'AI 正在思考…';
  } else if (previewMove) {
    turnText.textContent = `${turnName}确认落子`;
    turnSub.textContent = '再次点击同一位置确认，或选择其他空位重新预览';
  } else {
    turnText.textContent = `${turnName}落子`; 
    turnSub.textContent = state.moveNumber === 0 ? '黑方先手，点击空位预览后再次确认' : '点击空位预览后再次确认';
  }

  if (IS_ONLINE) {
    // 服务端只下发盘面，子数直接数棋盘，避免依赖本地 history。
    blackCount.textContent = String(countStones(BLACK));
    whiteCount.textContent = String(countStones(WHITE));
  } else {
    blackCount.textContent = String(state.history.filter(function (m) { return m.player === BLACK; }).length);
    whiteCount.textContent = String(state.history.filter(function (m) { return m.player === WHITE; }).length);
  }

  if (IS_ONLINE) {
    badge.textContent = '好友联机';
  } else {
    badge.textContent = '单机人机';
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
  previewMove = null;
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
  const cell = event.currentTarget;
  const r = parseInt(cell.dataset.r, 10);
  const c = parseInt(cell.dataset.c, 10);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  setGridFocus(r, c, false);
  requestMove(r, c);
}

function onCellKeydown(event) {
  const cell = event.currentTarget;
  const r = parseInt(cell.dataset.r, 10);
  const c = parseInt(cell.dataset.c, 10);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (arrows[event.key]) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    setGridFocus(r + arrows[event.key][0], c + arrows[event.key][1], true);
    return;
  }
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    requestMove(r, c);
  }
}

function requestMove(r, c) {
  if (state.finished || !isInside(r, c)) return false;
  if (!canPlayNow()) {
    setHint(IS_ONLINE ? '对手回合，请等待对方落子' : 'AI 回合，等待电脑落子');
    return false;
  }
  if (board[r][c] !== EMPTY) {
    setHint('该位置已有棋子，请选择空位');
    return false;
  }
  if (!previewMove || previewMove.r !== r || previewMove.c !== c || previewMove.player !== state.turn) {
    previewMove = { r: r, c: c, player: state.turn };
    setHint('已显示预览，再次点击同一位置确认落子');
    renderBoard();
    return true;
  }
  if (IS_ONLINE) return sendOnlineMove(r, c);
  if (!placeStone(r, c, state.turn)) return false;
  if (!state.finished && isAiTurn()) {
    scheduleAiMove();
  }
  return true;
}

function canPlayNow() {
  if (state.finished) return false;
  if (IS_ONLINE) return isMyOnlineTurn();
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
  const profile = {
    easy: { attack: 1, defend: 0.72, noise: 700, pool: 5 },
    normal: { attack: 1.15, defend: 0.85, noise: 18, pool: 1 },
    hard: { attack: 1.12, defend: 1.08, noise: 0, pool: 1 }
  }[CONFIG.aiLevel];
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const attack = evalPoint(m.r, m.c, CONFIG.aiColor) * profile.attack;
    const defend = evalPoint(m.r, m.c, CONFIG.humanColor) * profile.defend;
    let score = attack + defend + (Math.random() * profile.noise);
    // 困难档多看半步：落子后评估玩家最强的下一处线段，优先压制双活三等复合威胁。
    if (CONFIG.aiLevel === 'hard') {
      board[m.r][m.c] = CONFIG.aiColor;
      let opponentReply = 0;
      for (let j = 0; j < candidates.length; j++) {
        const reply = candidates[j];
        if (board[reply.r][reply.c] !== EMPTY) continue;
        opponentReply = Math.max(opponentReply, evalPoint(reply.r, reply.c, CONFIG.humanColor));
      }
      board[m.r][m.c] = EMPTY;
      score -= opponentReply * 0.32;
    }
    scored.push({ move: m, score: score });
    if (score > bestScore) {
      bestScore = score;
      bestMoves = [m];
    } else if (score === bestScore) {
      bestMoves.push(m);
    }
  }

  if (profile.pool > 1) {
    scored.sort(function (a, b) { return b.score - a.score; });
    const pool = scored.slice(0, Math.min(profile.pool, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].move;
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
  previewMove = null;
  setHint('已悔棋');
  saveState();
  renderBoard();
  if (isAiTurn()) {
    scheduleAiMove();
  }
}

function hideResultOverlay() {
  const overlay = $('resultOverlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}

function newGame() {
  state = createState();
  board = state.board;
  previewMove = null;
  hideResultOverlay();
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
    blackName: '你（黑）',
    whiteName: '电脑（白）'
  };
  board = state.board;
  previewMove = null;
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
    previewMove: previewMove && Object.assign({}, previewMove),
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
    aiLevel: CONFIG.aiLevel,
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
    requestMove: requestMove,
    setStateForTest: setStateForTest,
    getTestSnapshot: getTestSnapshot,
    setHint: setHint,
    saveState: saveState
  };
}

/* ===================== 联机模式 ===================== */
/* 棋盘、轮次与胜负全部由服务端裁决；本地只渲染并上报落子坐标。 */

function onlineNick() {
  try { return String(localStorage.getItem('light_games_nickname') || '').trim().slice(0, 16); }
  catch (error) { return ''; }
}

function isMyOnlineTurn() {
  if (!IS_ONLINE || !ONLINE.client) return false;
  if (ONLINE.status !== 'online') return false;
  return ONLINE.color !== 0 && state.turn === ONLINE.color;
}

function setNetBadge(status) {
  const badge = $('netBadge');
  if (badge) {
    const labels = { online: '已连接', connecting: '连接中', offline: '重连中', failed: '连接失败' };
    badge.hidden = false;
    badge.classList.remove('is-online', 'is-connecting', 'is-offline', 'is-failed');
    badge.classList.add('is-' + status);
    badge.textContent = labels[status] || status;
  }
  ONLINE.status = status;
  if (status === 'failed') {
    setHint('连接失败，请返回五子棋首页重新创建或加入房间');
  } else if (status === 'offline') {
    setHint('连接中断，正在尝试重连…');
  }
}

function countStones(color) {
  let total = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) if (board[r][c] === color) total++;
  }
  return total;
}

function applyServerGame(game) {
  if (!game) {
    board = createEmptyBoard();
    state.board = board;
    state.turn = BLACK;
    state.moveNumber = 0;
    state.history = [];
    state.lastMove = null;
    state.winner = 0;
    state.finished = false;
  } else {
    board = normalizeBoardForTest(game.board);
    state.board = board;
    state.turn = game.turn === WHITE ? WHITE : BLACK;
    state.moveNumber = Number(game.moveNumber) || 0;
    state.lastMove = game.lastMove || null;
    state.winner = game.winner === BLACK ? BLACK : (game.winner === WHITE ? WHITE : 0);
    state.finished = !!game.finished;
  }
  previewMove = null;
  renderBoard();
  if (state.finished && IS_ONLINE) showOnlineResult();
  else if (IS_ONLINE) hideResultOverlay();
}

function sendOnlineMove(r, c) {
  if (!ONLINE.client || ONLINE.status !== 'online') {
    setHint('正在连接房间，请稍候');
    return false;
  }
  const sent = ONLINE.client.send({ t: 'move', r: r, c: c, rev: ONLINE.revision });
  if (!sent) {
    setHint('网络不稳定，落子没有送出，请再点一次');
    return false;
  }
  previewMove = null;
  setHint('已落子，等待对手…');
  renderBoard();
  return true;
}

function updateRoomPanel() {
  const panel = $('roomPanel');
  if (panel) panel.hidden = false;
  const code = $('roomCode');
  if (code) code.textContent = ONLINE.room || '-----';
  const players = $('roomPlayers');
  if (!players) return;
  if (!ONLINE.players.length) {
    players.textContent = '正在连接房间…';
    return;
  }
  const myCid = ONLINE.client && ONLINE.client.identity ? ONLINE.client.identity.cid : '';
  // 整段用 textContent 输出：昵称是用户可控内容，不拼 HTML。
  const lines = ONLINE.players.map(function (player) {
    const side = player.color === WHITE ? '白方' : '黑方';
    const presence = player.online ? '在线' : '离线';
    const tag = player.cid === myCid ? '（你）' : (player.cid === ONLINE.host ? '（房主）' : '');
    return side + ' ' + player.nick + tag + ' · ' + presence;
  });
  if (ONLINE.players.length < 2) lines.push('等待对手加入，把房间码或邀请链接发给朋友。');
  players.textContent = lines.join('\n');
}

function showOnlineResult() {
  const overlay = $('resultOverlay');
  const title = $('resultTitle');
  const text = $('resultText');
  const restart = $('resultRestart');
  title.textContent = '本局结束';
  if (state.winner && state.winner === ONLINE.color) text.textContent = '你赢了，完成五子连珠';
  else if (state.winner === BLACK) text.textContent = '黑方获胜';
  else if (state.winner === WHITE) text.textContent = '白方获胜';
  else text.textContent = '和局，棋盘已满';
  if (restart) {
    const myCid = ONLINE.client && ONLINE.client.identity ? ONLINE.client.identity.cid : '';
    const isHost = !!ONLINE.host && ONLINE.host === myCid;
    restart.textContent = isHost ? '再战一局' : '等待房主开新局';
    restart.disabled = !isHost;
  }
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
}

function handleOnlineState(message) {
  ONLINE.revision = Number(message.revision) || 0;
  ONLINE.phase = message.phase || '';
  ONLINE.host = message.host || '';
  ONLINE.players = Array.isArray(message.players) ? message.players : [];
  const myCid = ONLINE.client && ONLINE.client.identity ? ONLINE.client.identity.cid : '';
  const me = ONLINE.players.find(function (player) { return player.cid === myCid; });
  if (me) {
    ONLINE.seat = me.seat;
    ONLINE.color = me.color === WHITE ? WHITE : BLACK;
  }
  const black = ONLINE.players.find(function (player) { return player.seat === 0; });
  const white = ONLINE.players.find(function (player) { return player.seat === 1; });
  state.blackName = black ? black.nick : '黑方';
  state.whiteName = white ? white.nick : '白方';
  applyServerGame(message.game);
  updateRoomPanel();
  if (!message.game) {
    setHint(ONLINE.players.length >= 2 ? '两位棋手已就位，准备开局' : '等待对手加入房间…');
  } else if (!state.finished) {
    setHint(isMyOnlineTurn() ? '轮到你落子' : '对手回合，请稍候');
  }
}

function initOnline() {
  if (typeof GomokuNet === 'undefined') {
    setHint('联机模块没有加载成功，请刷新页面重试');
    setNetBadge('failed');
    return;
  }
  ONLINE.nick = onlineNick();
  let client = null;
  try {
    client = GomokuNet.createClient({
      room: ONLINE.room,
      intent: ONLINE.intent,
      nick: ONLINE.nick || '玩家',
      onStatus: setNetBadge,
      onState: handleOnlineState,
      onError: function (message) {
        if (message && message.msg) setHint(message.msg);
      }
    });
  } catch (error) {
    setHint('房间码不正确，请返回五子棋首页重新创建或加入房间');
    setNetBadge('failed');
    return;
  }
  ONLINE.client = client;
  ONLINE.room = client.room;
  const base = String(window.location.href).split('?')[0].replace(/play\.html$/, '');
  ONLINE.inviteUrl = base + '?r=' + encodeURIComponent(ONLINE.room);
  updateRoomPanel();
  setNetBadge('connecting');
  client.connect();

  const leaveBtn = $('leaveRoomBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', function () {
    client.leave();
    window.location.href = './';
  });

  const copyBtn = $('copyInviteBtn');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    if (!ONLINE.inviteUrl) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ONLINE.inviteUrl).then(
        function () { setHint('邀请链接已复制，发给朋友即可加入'); },
        function () { setHint('复制失败，请手动复制地址栏链接'); }
      );
    } else {
      setHint('请手动复制地址栏链接邀请朋友');
    }
  });

  window.addEventListener('beforeunload', function () { client.dispose(); });
}

function initMode() {
  const title = $('gameTitle');
  title.textContent = '五子棋';
  document.body.classList.add(IS_ONLINE ? 'mode-online' : 'mode-ai');
  if (!IS_ONLINE) return;
  // 联机不提供本地悔棋与自由重开，回合推进交给服务端，新局由房主发起。
  const undoBtn = $('undoBtn');
  const resetBtn = $('resetBtn');
  if (undoBtn) undoBtn.hidden = true;
  if (resetBtn) resetBtn.hidden = true;
  const caption = document.querySelector('.status-caption');
  if (caption) caption.textContent = '联机对局由服务端同步棋盘与轮次，刷新或断线后可带着原身份续局。';
}

function bindEvents() {
  $('undoBtn').addEventListener('click', undo);
  $('resetBtn').addEventListener('click', newGame);
  $('resultRestart').addEventListener('click', function () {
    if (!IS_ONLINE) {
      newGame();
      return;
    }
    if (!ONLINE.client || ONLINE.status !== 'online') {
      setHint('正在连接房间，请稍候');
      return;
    }
    ONLINE.client.send({ t: 'again', rev: ONLINE.revision });
    setHint('已请求再战一局');
  });
}

function init() {
  board = createEmptyBoard();
  createBoardUI();
  initMode();
  if (IS_ONLINE) {
    state = createState();
    state.blackName = '黑方';
    state.whiteName = '白方';
    board = state.board;
    bindEvents();
    renderBoard();
    setHint('正在连接房间…');
    initOnline();
    return;
  }
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
