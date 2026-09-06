'use strict';

const Core = window.CheckersCore;
if (!Core) throw new Error('CheckersCore 未加载');

const CONFIG = {
  SAVE_PREFIX: 'chinese_checkers_save_v2_',
  SOUND_KEY: 'chinese_checkers_sound',
  AI_LEVEL_KEY: 'chinese_checkers_ai_level',
  BOARD_VIEW_KEY: 'chinese_checkers_board_view',
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
/** 规则核心输出的坐标空间边长，模型统一归一化到 0~1，渲染层再换算成百分比。 */
const BOARD_SPAN = 320;

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
let boardView = '3d';

const online = {
  active: false, ws: null, room: '', cid: '', token: '', color: '', phase: 'idle',
  host: '', players: [], intent: 'join', nick: '', intentionalClose: false,
  reconnectTimer: null, retryAttempt: 0, retryDelay: 0
};

function $(id) { return document.getElementById ? document.getElementById(id) : null; }
function emptyMoves() { return { steps: [], jumps: [], all: [] }; }

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(doc, name, attrs) {
  const node = doc.createElementNS(SVG_NS, name);
  Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
  return node;
}

/**
 * 棋子的渐变与裁剪全站只注入一份（放在棋子层首位），20 颗棋子按阵营引用。
 * 如果每颗棋子各自带 defs，重复的 id 会让 url(#...) 全部解析到第一个，颜色就串了。
 */
function buildPieceDefs(doc) {
  const svg = svgEl(doc, 'svg', { 'class': 'ck-defs', width: '0', height: '0', 'aria-hidden': 'true' });
  const defs = doc.createElementNS(SVG_NS, 'defs');
  const mkGrad = function (id, cx, cy, r, stops) {
    const grad = doc.createElementNS(SVG_NS, 'radialGradient');
    grad.setAttribute('id', id);
    grad.setAttribute('cx', cx); grad.setAttribute('cy', cy); grad.setAttribute('r', r);
    stops.forEach(function (stop) {
      const s = doc.createElementNS(SVG_NS, 'stop');
      s.setAttribute('offset', stop[0]);
      s.setAttribute('stop-color', stop[1]);
      if (stop.length > 2) s.setAttribute('stop-opacity', String(stop[2]));
      grad.appendChild(s);
    });
    defs.appendChild(grad);
  };
  mkGrad('ckg-red-base', '34%', '26%', '76%', [['0%', '#f2606c'], ['38%', '#d02138'], ['74%', '#9c1124'], ['100%', '#6e0a19']]);
  mkGrad('ckg-blue-base', '34%', '26%', '76%', [['0%', '#63c3f0'], ['38%', '#2b93d6'], ['74%', '#1867a8'], ['100%', '#0d4a80']]);
  mkGrad('ckg-red-shade', '50%', '50%', '50%', [['0%', 'rgba(90,6,20,.46)'], ['100%', 'rgba(90,6,20,0)']]);
  mkGrad('ckg-blue-shade', '50%', '50%', '50%', [['0%', 'rgba(8,48,88,.46)'], ['100%', 'rgba(8,48,88,0)']]);
  mkGrad('ckg-red-rim', '50%', '112%', '58%', [['0%', 'rgba(255,172,152,.96)'], ['45%', 'rgba(255,142,120,.55)'], ['100%', 'rgba(255,142,120,0)']]);
  mkGrad('ckg-blue-rim', '50%', '112%', '58%', [['0%', 'rgba(152,224,255,.96)'], ['45%', 'rgba(122,206,250,.55)'], ['100%', 'rgba(122,206,250,0)']]);
  mkGrad('ckg-hi', '40%', '38%', '64%', [['0%', 'rgba(255,255,255,1)'], ['46%', 'rgba(255,255,255,.72)'], ['100%', 'rgba(255,255,255,0)']]);
  mkGrad('ckg-hi2', '50%', '50%', '50%', [['0%', 'rgba(255,255,255,.88)'], ['100%', 'rgba(255,255,255,0)']]);
  mkGrad('ckg-red-vig', '50%', '50%', '50%', [['0%', 'rgba(70,4,14,0)'], ['60%', 'rgba(70,4,14,0)'], ['100%', 'rgba(70,4,14,.4)']]);
  mkGrad('ckg-blue-vig', '50%', '50%', '50%', [['0%', 'rgba(4,32,60,0)'], ['60%', 'rgba(4,32,60,0)'], ['100%', 'rgba(4,32,60,.4)']]);
  const soft = svgEl(doc, 'filter', { id: 'ckg-soft', x: '-20%', y: '-20%', width: '140%', height: '140%' });
  soft.appendChild(svgEl(doc, 'feGaussianBlur', { stdDeviation: '0.9' }));
  defs.appendChild(soft);
  const clip = svgEl(doc, 'clipPath', { id: 'ckclip-marble' });
  clip.appendChild(svgEl(doc, 'circle', { cx: '50', cy: '50', r: '50' }));
  defs.appendChild(clip);
  svg.appendChild(defs);
  return svg;
}

/**
 * 对照参考图的玻璃弹珠结构，从下到上八层：
 * 底色渐变 → 密集斑纹（红=大小错落的深红斑块群 / 蓝=小圆环+碎点）→ 暗侧收影 → 球面边缘渐暗 → 底缘透光 → 主高光 + 次高光 → 阵营深色描边。
 * 真实感来自三点：斑点数量多且半径 1.9~5.2 错落（大斑太稀会像贴纸）；
 * 整组斑纹套一层轻微高斯模糊（stdDeviation .9），看起来是"嵌在玻璃里"而不是印在表面；
 * 边缘 vignette 模拟球面曲率——靠轮廓处的斑纹和底色一起变暗收进球里。
 * 花纹用实色加透明度，暗侧压在花纹之上让背光处的斑点一起变暗。内层按 0..100 设计，整体缩到 94%。
 */
function buildPieceNode(owner, doc) {
  const tint = owner === 'blue' ? 'blue' : 'red';
  const svg = svgEl(doc, 'svg', { 'class': 'ck-piece__svg', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  const g = svgEl(doc, 'g', { 'clip-path': 'url(#ckclip-marble)', transform: 'translate(3 3) scale(.94)' });
  g.appendChild(svgEl(doc, 'circle', { cx: '50', cy: '50', r: '50', fill: 'url(#ckg-' + tint + '-base)' }));
  const pattern = svgEl(doc, 'g', { filter: 'url(#ckg-soft)' });
  if (tint === 'blue') {
    [[36, 50, 8], [60, 40, 7], [52, 68, 6.5], [28, 34, 6], [70, 60, 6], [42, 82, 5], [74, 32, 4.5]].forEach(function (ring) {
      pattern.appendChild(svgEl(doc, 'circle', {
        cx: String(ring[0]), cy: String(ring[1]), r: String(ring[2]),
        fill: 'none', stroke: '#0f6bb0', 'stroke-width': '3', 'stroke-opacity': '.8'
      }));
    });
    [[46, 30, 3], [64, 54, 3.2], [34, 64, 3], [24, 50, 2.6], [56, 52, 2.2], [70, 74, 2.6]].forEach(function (dot) {
      pattern.appendChild(svgEl(doc, 'circle', {
        cx: String(dot[0]), cy: String(dot[1]), r: String(dot[2]), fill: '#0f6bb0', 'fill-opacity': '.8'
      }));
    });
  } else {
    [[26, 42, 4.8], [38, 58, 3.6], [52, 40, 5.2], [64, 52, 4.4], [46, 70, 4.9], [30, 26, 3.4], [58, 26, 3.8],
     [72, 40, 3.3], [70, 66, 4.6], [36, 80, 3.7], [22, 58, 3.5], [54, 84, 3]].forEach(function (spot) {
      pattern.appendChild(svgEl(doc, 'circle', {
        cx: String(spot[0]), cy: String(spot[1]), r: String(spot[2]), fill: '#a51228', 'fill-opacity': '.85'
      }));
    });
    [[44, 50, 2.4], [62, 72, 2.4], [28, 70, 2.2], [80, 54, 2.6], [50, 62, 1.9], [66, 32, 2.2], [34, 66, 2]].forEach(function (fleck) {
      pattern.appendChild(svgEl(doc, 'circle', {
        cx: String(fleck[0]), cy: String(fleck[1]), r: String(fleck[2]), fill: '#a51228', 'fill-opacity': '.55'
      }));
    });
  }
  g.appendChild(pattern);
  g.appendChild(svgEl(doc, 'ellipse', { cx: '67', cy: '72', rx: '31', ry: '27', fill: 'url(#ckg-' + tint + '-shade)' }));
  g.appendChild(svgEl(doc, 'circle', { cx: '50', cy: '50', r: '50', fill: 'url(#ckg-' + tint + '-vig)' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '50', cy: '98', rx: '42', ry: '20', fill: 'url(#ckg-' + tint + '-rim)' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '35', cy: '31', rx: '19', ry: '12', transform: 'rotate(-26 35 31)', fill: 'url(#ckg-hi)' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '66', cy: '23', rx: '7', ry: '4.5', transform: 'rotate(-20 66 23)', fill: 'url(#ckg-hi2)' }));
  g.appendChild(svgEl(doc, 'circle', {
    cx: '50', cy: '50', r: '49.2', fill: 'none',
    stroke: tint === 'blue' ? 'rgba(10,58,100,.55)' : 'rgba(112,8,24,.55)', 'stroke-width': '1.6'
  }));
  svg.appendChild(g);
  return svg;
}
function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
function playerLabel(player) { return player === 'red' ? '红方' : '蓝方'; }
function opposite(player) { return player === 'red' ? 'blue' : 'red'; }
function normalizeRoom(value) { return String(value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 5); }
function normalizeBoardView(value) { return value === '2d' ? '2d' : '3d'; }
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

/**
 * 棋盘纯数据模型。
 * 渲染层与规则状态在这里解耦：模型输出归一化的 0~1 坐标与语义标记，
 * DOM 渲染器只负责把它映射成样式，因此模型可以直接在 Node 下断言。
 */
function orientedPoint(key) {
  const cell = CELL_BY_KEY.get(key);
  return cell ? Core.orientPoint(cell, viewPlayer) : null;
}

function normalizeFraction(value) {
  return Math.round((value / BOARD_SPAN) * 100000) / 100000;
}

function cellLabel(cell, owner, moveKind) {
  const base = '第 ' + (cell.row + 1) + ' 行';
  if (owner) return base + '，' + playerLabel(owner) + '棋子';
  if (moveKind) return base + '，可' + (moveKind === 'jump' ? '跳跃到达' : '移动到达');
  return base + '，空位';
}

function buildRouteModels() {
  if (!lastMove || !Array.isArray(lastMove.path) || lastMove.path.length < 2) return [];
  const segments = [];
  for (let i = 1; i < lastMove.path.length; i++) {
    const fromCell = CELL_BY_KEY.get(lastMove.path[i - 1]);
    const toCell = CELL_BY_KEY.get(lastMove.path[i]);
    if (!fromCell || !toCell) continue;
    const from = Core.orientPoint(fromCell, viewPlayer);
    const to = Core.orientPoint(toCell, viewPlayer);
    const x1 = normalizeFraction(from.x); const y1 = normalizeFraction(from.y);
    const x2 = normalizeFraction(to.x); const y2 = normalizeFraction(to.y);
    const dx = x2 - x1; const dy = y2 - y1;
    segments.push({
      x: x1, y: y1,
      length: Math.sqrt(dx * dx + dy * dy),
      angle: Math.atan2(dy, dx) * 180 / Math.PI,
      jump: Math.abs(fromCell.row - toCell.row) + Math.abs(fromCell.unit - toCell.unit) > 2,
      player: lastMove.player
    });
  }
  return segments;
}

function buildZoneModels() {
  return [
    { className: 'red-goal-zone', keys: ['16:0', '13:-3', '13:3'] },
    { className: 'blue-goal-zone', keys: ['0:0', '3:-3', '3:3'] }
  ].map(function (zone) {
    const points = zone.keys.map(orientedPoint).filter(Boolean);
    if (points.length !== 3) return null;
    return {
      className: zone.className,
      points: points.map(function (point) { return { x: normalizeFraction(point.x), y: normalizeFraction(point.y) }; })
    };
  }).filter(Boolean);
}

function buildBoardModel() {
  const stepSet = new Set(legalMoves.steps);
  const jumpSet = new Set(legalMoves.jumps);
  const focusKey = selectedKey || Object.keys(pieces).find(function (key) { return pieces[key] === turn; }) || BOARD_CELLS[0].key;
  const cells = BOARD_CELLS.map(function (cell) {
    const point = Core.orientPoint(cell, viewPlayer);
    const owner = pieces[cell.key] || '';
    const moveKind = jumpSet.has(cell.key) ? 'jump' : (stepSet.has(cell.key) ? 'step' : '');
    return {
      key: cell.key,
      x: normalizeFraction(point.x),
      y: normalizeFraction(point.y),
      camp: cell.camp || '',
      owner: owner,
      moveKind: moveKind,
      selected: selectedKey === cell.key,
      lastOrigin: !!lastMove && lastMove.from === cell.key,
      lastDestination: !!lastMove && lastMove.target === cell.key,
      focus: focusKey === cell.key,
      label: cellLabel(cell, owner, moveKind)
    };
  });
  return {
    view: boardView,
    focusKey: focusKey,
    cells: cells,
    pieces: cells.filter(function (cell) { return !!cell.owner; }),
    routes: buildRouteModels(),
    zones: buildZoneModels(),
    move: lastMove ? {
      from: lastMove.from, target: lastMove.target, kind: lastMove.kind,
      id: [lastMove.player, lastMove.from, lastMove.target, lastMove.moveNumber].join('|')
    } : null
  };
}

/* ---------- 单一 DOM 渲染层：节点常驻，只同步状态，走子因此可以做位移动画 ---------- */
const dom = {
  root: null, plane: null, zoneLayer: null, routeLayer: null, holeLayer: null, shadowLayer: null, pieceLayer: null,
  originNode: null, destinationNode: null, zoneNodes: null,
  cells: new Map(), pieceNodes: new Map(), shadowNodes: new Map(), built: false, moveId: ''
};

function percent(value) { return (value * 100).toFixed(3) + '%'; }

function ensureBoard() {
  if (dom.built) return true;
  const root = $('board');
  if (!root || typeof root.appendChild !== 'function') return false;
  root.replaceChildren();
  const plane = document.createElement('div'); plane.className = 'board-plane';
  const zoneLayer = document.createElement('div'); zoneLayer.className = 'board-layer board-zones'; zoneLayer.setAttribute('aria-hidden', 'true');
  const routeLayer = document.createElement('div'); routeLayer.className = 'board-layer board-routes'; routeLayer.setAttribute('aria-hidden', 'true');
  const holeLayer = document.createElement('div'); holeLayer.className = 'board-layer board-holes';
  const shadowLayer = document.createElement('div'); shadowLayer.className = 'board-layer board-shadows'; shadowLayer.setAttribute('aria-hidden', 'true');
  const pieceLayer = document.createElement('div'); pieceLayer.className = 'board-layer board-pieces'; pieceLayer.setAttribute('aria-hidden', 'true');
  pieceLayer.appendChild(buildPieceDefs(document));
  const originNode = document.createElement('span'); originNode.className = 'move-origin'; originNode.hidden = true;
  const destinationNode = document.createElement('span'); destinationNode.className = 'move-destination'; destinationNode.hidden = true;
  routeLayer.appendChild(originNode); routeLayer.appendChild(destinationNode);
  plane.appendChild(zoneLayer); plane.appendChild(routeLayer); plane.appendChild(holeLayer); plane.appendChild(shadowLayer); plane.appendChild(pieceLayer);
  root.appendChild(plane);
  BOARD_CELLS.forEach(function (cell) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'ck-cell';
    node.dataset.key = cell.key;
    const hole = document.createElement('span');
    hole.className = 'ck-hole';
    node.appendChild(hole);
    holeLayer.appendChild(node);
    dom.cells.set(cell.key, node);
  });
  dom.root = root; dom.plane = plane;
  dom.zoneLayer = zoneLayer; dom.routeLayer = routeLayer; dom.holeLayer = holeLayer; dom.shadowLayer = shadowLayer; dom.pieceLayer = pieceLayer;
  dom.originNode = originNode; dom.destinationNode = destinationNode;
  dom.zoneNodes = new Map();
  dom.built = true;
  bindBoardInput();
  return true;
}

function syncZones(model) {
  model.zones.forEach(function (zone) {
    let node = dom.zoneNodes.get(zone.className);
    if (!node) {
      node = document.createElement('div');
      node.className = 'board-zone ' + zone.className;
      dom.zoneLayer.appendChild(node);
      dom.zoneNodes.set(zone.className, node);
    }
    node.style.clipPath = 'polygon(' + zone.points.map(function (point) {
      return percent(point.x) + ' ' + percent(point.y);
    }).join(',') + ')';
  });
}

function syncRoutes(model) {
  const stale = dom.routeLayer.querySelectorAll('.last-move-path');
  for (let i = 0; i < stale.length; i++) stale[i].remove();
  model.routes.forEach(function (segment) {
    const node = document.createElement('span');
    node.className = 'last-move-path ' + segment.player + '-path' + (segment.jump ? ' route-jump' : '');
    node.style.left = percent(segment.x);
    node.style.top = percent(segment.y);
    node.style.width = percent(segment.length);
    node.style.transform = 'translateY(-50%) rotate(' + segment.angle.toFixed(2) + 'deg)';
    dom.routeLayer.appendChild(node);
  });
  if (!model.routes.length || !lastMove) {
    dom.originNode.hidden = true;
    dom.destinationNode.hidden = true;
    return;
  }
  const first = model.routes[0];
  const endPoint = orientedPoint(lastMove.path[lastMove.path.length - 1]);
  const marks = [
    { node: dom.originNode, base: 'move-origin', x: first.x, y: first.y },
    { node: dom.destinationNode, base: 'move-destination', x: normalizeFraction(endPoint.x), y: normalizeFraction(endPoint.y) }
  ];
  marks.forEach(function (mark) {
    mark.node.className = mark.base + ' ' + lastMove.player + '-path';
    mark.node.style.left = percent(mark.x);
    mark.node.style.top = percent(mark.y);
    mark.node.hidden = false;
  });
}

function syncHoles(model, reorient) {
  model.cells.forEach(function (cell) {
    const node = dom.cells.get(cell.key);
    if (!node) return;
    if (reorient) placeNode(node, cell.x, cell.y);
    node.classList.toggle('top-camp', cell.camp === 'top');
    node.classList.toggle('bottom-camp', cell.camp === 'bottom');
    node.classList.toggle('step-target', cell.moveKind === 'step');
    node.classList.toggle('jump-target', cell.moveKind === 'jump');
    node.classList.toggle('selected', cell.selected);
    node.classList.toggle('last-origin', cell.lastOrigin);
    node.classList.toggle('last-destination', cell.lastDestination);
    node.setAttribute('tabindex', cell.focus ? '0' : '-1');
    node.setAttribute('aria-label', cell.label);
  });
}

/** 孔位与棋子共用一种定位方式：归一化坐标 × 100%，再靠 transform 自身居中。 */
function placeNode(node, x, y) {
  node.style.left = percent(x);
  node.style.top = percent(y);
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** 走子落位后补一段抬起动画；跳跃抬得更高，用来区分「移动」与「跳」。 */
function animateHop(node, kind) {
  if (!node || typeof node.animate !== 'function' || prefersReducedMotion()) return;
  // 用独立的 translate 属性（而非 transform）做 Z 向位移：
  // transform 已被用来抵消棋盘倾斜让球保持正圆，两者叠加才不会互相覆盖。
  node.animate(
    [{ translate: '0 0 0px' }, { translate: '0 0 28px', offset: .45 }, { translate: '0 0 0px' }],
    { duration: kind === 'jump' ? 380 : 240, easing: 'cubic-bezier(.35,.9,.4,1)' }
  );
}

/** 阴影与棋子同键、同步位移动画，但始终留在地面，棋子抬起时它才负责「分离」。 */
function syncShadows(model, reorient) {
  const desired = new Map();
  model.pieces.forEach(function (piece) { desired.set(piece.key, true); });

  Array.from(dom.shadowNodes.keys()).forEach(function (key) {
    if (desired.has(key)) return;
    const node = dom.shadowNodes.get(key);
    dom.shadowNodes.delete(key);
    if (node && typeof node.remove === 'function') node.remove();
  });

  model.pieces.forEach(function (piece) {
    let node = dom.shadowNodes.get(piece.key);
    if (!node) {
      node = document.createElement('span');
      node.className = 'ck-shadow';
      dom.shadowLayer.appendChild(node);
      dom.shadowNodes.set(piece.key, node);
      placeNode(node, piece.x, piece.y);
    } else if (reorient) {
      placeNode(node, piece.x, piece.y);
    }
    node.dataset.key = piece.key;
    node.classList.toggle('is-lifted', !!selectedKey && selectedKey === piece.key);
  });
}

function syncPieces(model, reorient) {
  const desired = new Map();
  model.pieces.forEach(function (piece) { desired.set(piece.key, piece.owner); });
  const positionOf = new Map();
  model.cells.forEach(function (cell) { positionOf.set(cell.key, cell); });

  // 复用上一步起点的节点并改键到落点，配合 left/top 过渡就是一次真实位移。
  if (model.move && model.move.id !== dom.moveId) {
    const moving = dom.pieceNodes.get(model.move.from);
    if (moving && !desired.has(model.move.from) && desired.has(model.move.target) && !dom.pieceNodes.has(model.move.target)) {
      dom.pieceNodes.delete(model.move.from);
      dom.pieceNodes.set(model.move.target, moving);
      const spot = positionOf.get(model.move.target);
      placeNode(moving, spot.x, spot.y);
      animateHop(moving, model.move.kind);
      // 阴影跟着改键，否则它会被当成「消失的棋子」删掉重建，接不住位移动画。
      const shadow = dom.shadowNodes.get(model.move.from);
      if (shadow && !dom.shadowNodes.has(model.move.target)) {
        dom.shadowNodes.delete(model.move.from);
        dom.shadowNodes.set(model.move.target, shadow);
        placeNode(shadow, spot.x, spot.y);
      }
    }
  }
  dom.moveId = model.move ? model.move.id : '';

  Array.from(dom.pieceNodes.keys()).forEach(function (key) {
    if (desired.has(key)) return;
    const node = dom.pieceNodes.get(key);
    dom.pieceNodes.delete(key);
    if (node && typeof node.remove === 'function') node.remove();
  });

  model.pieces.forEach(function (piece) {
    let node = dom.pieceNodes.get(piece.key);
    if (!node) {
      node = document.createElement('span');
      node.className = 'ck-piece';
      node.appendChild(buildPieceNode(piece.owner, document));
      dom.pieceLayer.appendChild(node);
      dom.pieceNodes.set(piece.key, node);
      placeNode(node, piece.x, piece.y);
    } else if (reorient) {
      placeNode(node, piece.x, piece.y);
    }
    node.dataset.key = piece.key;
    node.classList.toggle('red-piece', piece.owner === 'red');
    node.classList.toggle('blue-piece', piece.owner === 'blue');
    node.classList.toggle('is-selected', !!selectedKey && selectedKey === piece.key);
    node.classList.toggle('is-last', !!model.move && model.move.target === piece.key);
  });
}

function renderBoard() {
  if (!ensureBoard()) return;
  const model = buildBoardModel();
  // 联机被分配到蓝方时视角会翻转，此时才需要整体重新定位，避免每次渲染都写坐标。
  const reorient = dom.viewPlayer !== viewPlayer;
  dom.viewPlayer = viewPlayer;
  dom.root.dataset.view = model.view;
  dom.plane.dataset.view = model.view;
  syncZones(model);
  syncRoutes(model);
  syncHoles(model, reorient);
  syncShadows(model, reorient);
  syncPieces(model, reorient);
}

function applyBoardModeLayout(view) {
  boardView = normalizeBoardView(view);
  safeSet(CONFIG.BOARD_VIEW_KEY, boardView);
  const select = $('boardModeSelect');
  if (select) select.value = boardView;
  const board = $('board');
  if (board) board.dataset.view = boardView;
  renderBoard();
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
  if ($('board')) $('board').setAttribute('aria-label', '中国跳棋棋盘，' + playerLabel(viewPlayer) + '固定视角，己方位于下方');
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
  if (soundBtnEl) { soundBtnEl.innerHTML = '<i class="ui-icon ' + (soundEnabled ? 'ui-icon--volume-high' : 'ui-icon--volume-xmark') + '" aria-hidden="true"></i>'; soundBtnEl.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); soundBtnEl.setAttribute('aria-label', soundEnabled ? '关闭音效' : '开启音效'); }
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

const ARROW_STEPS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };

/** 方向键在六角星棋盘上找“视觉上最贴近该方向”的孔位，让 roving tabindex 真正可用。 */
function findNeighborKey(fromKey, dirX, dirY) {
  const origin = orientedPoint(fromKey);
  if (!origin) return '';
  let best = ''; let bestScore = Infinity;
  BOARD_CELLS.forEach(function (cell) {
    if (cell.key === fromKey) return;
    const point = Core.orientPoint(cell, viewPlayer);
    const dx = point.x - origin.x; const dy = point.y - origin.y;
    const along = dx * dirX + dy * dirY;
    if (along <= 1) return;
    const across = Math.abs(dx * dirY - dy * dirX);
    const score = along + across * 2.2;
    if (score < bestScore) { bestScore = score; best = cell.key; }
  });
  return best;
}

function onBoardKeydown(event) {
  const node = event.target && event.target.closest ? event.target.closest('[data-key]') : null;
  if (!node || !node.dataset || !node.dataset.key) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleCell(node.dataset.key);
    return;
  }
  const step = ARROW_STEPS[event.key];
  if (!step) return;
  event.preventDefault();
  const nextKey = findNeighborKey(node.dataset.key, step[0], step[1]);
  const nextNode = nextKey ? dom.cells.get(nextKey) : null;
  if (nextNode && typeof nextNode.focus === 'function') nextNode.focus();
}

function onBoardClick(event) {
  const node = event.target && event.target.closest ? event.target.closest('[data-key]') : null;
  if (node && node.dataset && node.dataset.key) handleCell(node.dataset.key);
}

function bindBoardInput() {
  const board = $('board');
  const select = $('boardModeSelect');
  if (board && !board.__checkersListenerBound) {
    board.addEventListener('click', onBoardClick);
    board.addEventListener('keydown', onBoardKeydown);
    board.__checkersListenerBound = true;
  }
  if (select && !select.__checkersListenerBound) {
    select.addEventListener('change', function () { applyBoardModeLayout(select.value); });
    select.__checkersListenerBound = true;
  }
}

function init() {
  soundEnabled = safeGet(CONFIG.SOUND_KEY) !== '0';
  const requestedLevel = launchParams.get('level'); aiLevel = AI_LEVELS.includes(requestedLevel) ? requestedLevel : (AI_LEVELS.includes(safeGet(CONFIG.AI_LEVEL_KEY)) ? safeGet(CONFIG.AI_LEVEL_KEY) : 'normal');
  safeSet(CONFIG.AI_LEVEL_KEY, aiLevel); viewPlayer = 'red';
  if (mode === 'online') resetState(); else if (!loadGame()) { resetState(); saveGame(); }
  boardView = normalizeBoardView(safeGet(CONFIG.BOARD_VIEW_KEY));
  const boardModeSelect = $('boardModeSelect'); if (boardModeSelect) boardModeSelect.value = boardView;
  var soundBtnEl = $('soundBtn');
  if (soundBtnEl) { soundBtnEl.innerHTML = '<i class="ui-icon ' + (soundEnabled ? 'ui-icon--volume-high' : 'ui-icon--volume-xmark') + '" aria-hidden="true"></i>'; soundBtnEl.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); }
  $('onlineRoomBar').hidden = mode !== 'online';
  $('modeBadge').textContent = mode === 'ai' ? '人机对战 · ' + ({ easy:'轻松', normal:'标准', hard:'困难 · 自学习' }[aiLevel]) : (mode === 'local' ? '本地双人' : '好友对战');
  $('saveNote').textContent = mode === 'online' ? '联机棋局由服务器同步与校验，短暂断线会自动恢复。' : '棋局会自动保存在当前浏览器中，刷新后可以继续。';
  if (mode === 'online') $('roomCodeText').textContent = launchRoom || '-----';

  bindBoardInput();
  applyBoardModeLayout(boardView);
  $('undoBtn').addEventListener('click', undoMove); $('newGameBtn').addEventListener('click', function () { resetGame(false); }); $('winnerNewBtn').addEventListener('click', function () { resetGame(true); });
  $('soundBtn').addEventListener('click', toggleSound); $('exitBtn').addEventListener('click', exitToLobby); $('copyInviteBtn').addEventListener('click', copyInvite); $('leaveRoomBtn').addEventListener('click', exitToLobby);
  window.addEventListener('beforeunload', function () { cancelAiSearch(); if (online.active) sendOnline({ t: 'ping' }); });
  render(); if (mode === 'ai' && turn === 'blue' && !gameOver) scheduleAiMove(); if (gameOver) showWinner(gameOver); if (mode === 'online') connectOnline(launchIntent);
}

window.__checkersTest = {
  CONFIG: CONFIG, Core: Core, mode: mode, getViewPlayerForMode: getViewPlayerForMode,
  normalizeRoom: normalizeRoom, sanitizeLocalState: sanitizeLocalState, websocketUrl: websocketUrl,
  reconnectDelayForAttempt: reconnectDelayForAttempt, normalizeBoardView: normalizeBoardView,
  applyBoardModeLayout: applyBoardModeLayout, buildBoardModel: buildBoardModel,
  findNeighborKey: findNeighborKey, BOARD_SPAN: BOARD_SPAN
};
window.addEventListener('DOMContentLoaded', init);
