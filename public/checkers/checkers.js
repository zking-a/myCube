'use strict';

const Core = window.CheckersCore;
if (!Core) throw new Error('CheckersCore 未加载');

const CONFIG = {
  SAVE_PREFIX: 'chinese_checkers_save_v3_',
  LEGACY_SAVE_PREFIX: 'chinese_checkers_save_v2_',
  LAST_SLOT_PREFIX: 'chinese_checkers_last_slot_v3_',
  BUILD_ID: '20260915stage1',
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

// 生日模式判断：9月19日自动开启，?birthday=1 强制开，?birthday=0 强制关
function resolveBirthdayMode(search, now) {
  const params = new URLSearchParams(search || '');
  const flag = params.get('birthday');
  if (flag === '1') return true;
  if (flag === '0') return false;
  const d = now || new Date();
  return d.getMonth() === 8 && d.getDate() === 19;
}
const birthdayMode = resolveBirthdayMode(location.search, new Date());
if (birthdayMode && document.documentElement) {
  document.documentElement.classList.add('birthday-mode');
}
window.__checkersBirthday = { active: birthdayMode };
function birthdayOpening() { return !!(window.__checkersBirthday && window.__checkersBirthday.opening); }
function presentationEvent(name, detail) {
  if (document.dispatchEvent && typeof window.CustomEvent === 'function') {
    document.dispatchEvent(new window.CustomEvent(name, { detail: detail }));
  }
}
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
let aiWorkerBusy = false;
let aiWatchdog = null;
let lastAiStats = null;
let motionEpoch = 0;
let animating = false;
const activeAnimations = new Set();
const shadowAnimations = new Set();
let saveSlot = '';
let restoredRecentKeys = [];
const localIntent = launchParams.get('intent') === 'new' ? 'new' : 'resume';
let aiRequestId = 0;
let toastTimer = null;
let boardView = '3d';
/** 对局席位：本地多人与 AI 补位共用。2 人默认红蓝双人/人机，行为与旧版完全一致。 */
let seats = [{ color: 'red', isAI: false }, { color: 'blue', isAI: false }];

const online = {
  active: false, ws: null, room: '', cid: '', token: '', color: '', phase: 'idle',
  host: '', seats: [], players: [], intent: 'join', nick: '', intentionalClose: false,
  bots: 0, botLevel: 'normal',
  round: 0, openingRound: 0, readyRound: 0, startPending: false,
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
 * 六色玻璃珠的渐变参数表。红/蓝两色的渐变数据与旧版逐字节一致（测试钉住），
 * 其余四色按同一结构推导：base 四段、暗侧收影、底缘透光、边缘暗角、描边与花纹实色。
 * rings=true 的阵营画圆环纹理（蓝/绿/紫），false 的画斑块纹理（红/黄/橙）。
 */
// 生日主题配色：六方各用清晰不同的糖果色（草莓/蓝莓/抹茶/柠檬/葡萄/香橙），
// 主体本身即可一眼区分阵营；仍保留糖霜高光与彩针的派对质感。
function hexToRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function candyTint(light, mid, deep, edge, outline, pattern) {
  const d = hexToRgb(edge);
  const sr = d[0] + ',' + d[1] + ',' + d[2];
  return {
    base: [['0%', light], ['38%', mid], ['74%', deep], ['100%', edge]],
    shade: [['0%', 'rgba(' + sr + ',.34)'], ['100%', 'rgba(' + sr + ',0)']],
    rim: [['0%', 'rgba(255,255,255,.92)'], ['45%', 'rgba(255,255,255,.5)'], ['100%', 'rgba(255,255,255,0)']],
    vig: [['0%', 'rgba(' + sr + ',0)'], ['60%', 'rgba(' + sr + ',0)'], ['100%', 'rgba(' + sr + ',.28)']],
    outline: outline, pattern: pattern, rings: false, candy: true
  };
}
const BIRTHDAY_TINTS = {
  red: candyTint('#ffd9e0', '#ff9bb0', '#f25877', '#d62f54', '#b81f43', '#f25877'),
  blue: candyTint('#e3e8ff', '#9fb0ff', '#5b74f0', '#344ec9', '#243ba8', '#5b74f0'),
  green: candyTint('#e2f8e6', '#9fe6ad', '#46c46a', '#1f9a47', '#157a37', '#46c46a'),
  yellow: candyTint('#fff7d6', '#ffe486', '#f7c531', '#d99a0c', '#b87f06', '#f7c531'),
  purple: candyTint('#f3e0ff', '#cf9df0', '#9b54d6', '#7430b0', '#5e2393', '#9b54d6'),
  orange: candyTint('#ffe6cc', '#ffb877', '#ff8a32', '#e3620c', '#c44e08', '#ff8a32')
};
// 糖针几何：中心半径 ~30，远小于裁剪圆 r=50
const SPRINKLE_STICKS = [
  [30,32,7,-24], [44,24,6,18], [60,31,7,-40], [70,44,5,10], [27,46,6,52],
  [46,45,7,-8], [63,55,6,30], [37,60,6,-34], [55,66,7,12], [66,70,5,-18],
  [22,60,5,26], [47,76,6,-6], [60,78,5,40], [40,37,5,64], [34,70,6,20], [58,45,5,-52]
];

function activeTints() {
  return window.__checkersBirthday && window.__checkersBirthday.active ? BIRTHDAY_TINTS : PIECE_TINTS;
}

const PIECE_TINTS = {
  red: {
    base: [['0%', '#f2606c'], ['38%', '#d02138'], ['74%', '#9c1124'], ['100%', '#6e0a19']],
    shade: [['0%', 'rgba(90,6,20,.46)'], ['100%', 'rgba(90,6,20,0)']],
    rim: [['0%', 'rgba(255,172,152,.96)'], ['45%', 'rgba(255,142,120,.55)'], ['100%', 'rgba(255,142,120,0)']],
    vig: [['0%', 'rgba(70,4,14,0)'], ['60%', 'rgba(70,4,14,0)'], ['100%', 'rgba(70,4,14,.4)']],
    outline: 'rgba(112,8,24,.42)', pattern: '#a51228', rings: false
  },
  blue: {
    base: [['0%', '#63c3f0'], ['38%', '#2b93d6'], ['74%', '#1867a8'], ['100%', '#0d4a80']],
    shade: [['0%', 'rgba(8,48,88,.46)'], ['100%', 'rgba(8,48,88,0)']],
    rim: [['0%', 'rgba(152,224,255,.96)'], ['45%', 'rgba(122,206,250,.55)'], ['100%', 'rgba(122,206,250,0)']],
    vig: [['0%', 'rgba(4,32,60,0)'], ['60%', 'rgba(4,32,60,0)'], ['100%', 'rgba(4,32,60,.4)']],
    outline: 'rgba(10,58,100,.42)', pattern: '#0f6bb0', rings: true
  },
  green: {
    base: [['0%', '#8fd98a'], ['38%', '#3fae4a'], ['74%', '#1f7a34'], ['100%', '#0f5220']],
    shade: [['0%', 'rgba(10,60,24,.46)'], ['100%', 'rgba(10,60,24,0)']],
    rim: [['0%', 'rgba(190,244,180,.96)'], ['45%', 'rgba(150,232,150,.55)'], ['100%', 'rgba(150,232,150,0)']],
    vig: [['0%', 'rgba(8,52,24,0)'], ['60%', 'rgba(8,52,24,0)'], ['100%', 'rgba(8,52,24,.4)']],
    outline: 'rgba(16,80,36,.42)', pattern: '#166534', rings: true
  },
  yellow: {
    base: [['0%', '#ffe08a'], ['38%', '#f4c542'], ['74%', '#d19a1e'], ['100%', '#8f660c']],
    shade: [['0%', 'rgba(120,84,8,.42)'], ['100%', 'rgba(120,84,8,0)']],
    rim: [['0%', 'rgba(255,240,190,.96)'], ['45%', 'rgba(255,224,150,.55)'], ['100%', 'rgba(255,224,150,0)']],
    vig: [['0%', 'rgba(96,66,6,0)'], ['60%', 'rgba(96,66,6,0)'], ['100%', 'rgba(96,66,6,.4)']],
    outline: 'rgba(122,86,10,.42)', pattern: '#a87708', rings: false
  },
  purple: {
    base: [['0%', '#c8a2f2'], ['38%', '#8f5bd6'], ['74%', '#6a3aa8'], ['100%', '#3f1f6e']],
    shade: [['0%', 'rgba(52,24,96,.46)'], ['100%', 'rgba(52,24,96,0)']],
    rim: [['0%', 'rgba(226,200,255,.96)'], ['45%', 'rgba(196,160,250,.55)'], ['100%', 'rgba(196,160,250,0)']],
    vig: [['0%', 'rgba(40,18,76,0)'], ['60%', 'rgba(40,18,76,0)'], ['100%', 'rgba(40,18,76,.4)']],
    outline: 'rgba(58,30,110,.42)', pattern: '#4c2a8f', rings: true
  },
  orange: {
    base: [['0%', '#ffb87e'], ['38%', '#f08030'], ['74%', '#c85a14'], ['100%', '#7e3406']],
    shade: [['0%', 'rgba(120,48,6,.46)'], ['100%', 'rgba(120,48,6,0)']],
    rim: [['0%', 'rgba(255,214,170,.96)'], ['45%', 'rgba(250,180,120,.55)'], ['100%', 'rgba(250,180,120,0)']],
    vig: [['0%', 'rgba(88,34,4,0)'], ['60%', 'rgba(88,34,4,0)'], ['100%', 'rgba(88,34,4,.4)']],
    outline: 'rgba(124,50,8,.42)', pattern: '#a34708', rings: false
  }
};

/** 斑纹几何全色共用：只换颜色，保证每个阵营的珠子密度一致（真实感来自密集错落）。 */
const MARBLE_SPOTS = [[26, 42, 4.8], [38, 58, 3.6], [52, 40, 5.2], [64, 52, 4.4], [46, 70, 4.9], [30, 26, 3.4], [58, 26, 3.8], [72, 40, 3.3], [70, 66, 4.6], [36, 80, 3.7], [22, 58, 3.5], [54, 84, 3]];
const MARBLE_FLECKS = [[44, 50, 2.4], [62, 72, 2.4], [28, 70, 2.2], [80, 54, 2.6], [50, 62, 1.9], [66, 32, 2.2], [34, 66, 2]];
const MARBLE_RINGS = [[36, 50, 8], [60, 40, 7], [52, 68, 6.5], [28, 34, 6], [70, 60, 6], [42, 82, 5], [74, 32, 4.5]];
const MARBLE_RING_DOTS = [[46, 30, 3], [64, 54, 3.2], [34, 64, 3], [24, 50, 2.6], [56, 52, 2.2], [70, 74, 2.6]];

/**
 * 棋子的渐变与裁剪全站只注入一份（放在棋子层首位），各色棋子按阵营引用。
 * 如果每颗棋子各自带 defs，重复的 id 会让 url(#...) 全部解析到第一个，颜色就串了。
 */
function buildPieceDefs(doc, tints) {
  const table = tints || activeTints();
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
  Object.keys(table).forEach(function (tint) {
    const meta = table[tint];
    mkGrad('ckg-' + tint + '-base', '34%', '26%', '76%', meta.base);
    mkGrad('ckg-' + tint + '-shade', '50%', '50%', '50%', meta.shade);
    mkGrad('ckg-' + tint + '-rim', '50%', '112%', '58%', meta.rim);
    mkGrad('ckg-' + tint + '-vig', '50%', '50%', '50%', meta.vig);
  });
  mkGrad('ckg-hi', '40%', '38%', '64%', [['0%', 'rgba(255,255,255,1)'], ['46%', 'rgba(255,255,255,.72)'], ['100%', 'rgba(255,255,255,0)']]);
  mkGrad('ckg-hi2', '50%', '50%', '50%', [['0%', 'rgba(255,255,255,.88)'], ['100%', 'rgba(255,255,255,0)']]);
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
 * 底色渐变 → 密集斑纹（实色斑块/圆环按阵营区分）→ 暗侧收影 → 球面边缘渐暗 → 底缘透光 → 弱反射 → 主高光 + 次高光 → 阵营深色描边。
 * 真实感三件套全色共用：斑点数量多且半径错落；整组斑纹套轻微高斯模糊像"嵌在玻璃里"；
 * 边缘 vignette 模拟球面曲率。暗侧压在花纹之上，背光处的斑点一起变暗。内层按 0..100 设计，整体缩到 94%。
 */
function buildPieceNode(owner, doc, tints) {
  const table = tints || activeTints();
  const tint = table[owner] ? owner : 'red';
  const meta = table[tint];
  const svg = svgEl(doc, 'svg', { 'class': 'ck-piece__svg', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  const g = svgEl(doc, 'g', { 'clip-path': 'url(#ckclip-marble)', transform: 'translate(3 3) scale(.94)' });
  g.appendChild(svgEl(doc, 'circle', { cx: '50', cy: '50', r: '50', fill: 'url(#ckg-' + tint + '-base)' }));
  if (meta.candy) {
    const sugar = svgEl(doc, 'g', { 'class': 'ck-candy' });
    SPRINKLE_STICKS.forEach(function (s) {
      sugar.appendChild(svgEl(doc, 'rect', {
        x: String(s[0] - s[2] / 2), y: String(s[1] - 1.1),
        width: String(s[2]), height: '2.2', rx: '1.1',
        transform: 'rotate(' + s[3] + ' ' + s[0] + ' ' + s[1] + ')',
        fill: meta.pattern
      }));
    });
    g.appendChild(sugar);
  } else {
    const pattern = svgEl(doc, 'g', { filter: 'url(#ckg-soft)' });
    if (meta.rings) {
      MARBLE_RINGS.forEach(function (ring) {
        pattern.appendChild(svgEl(doc, 'circle', {
          cx: String(ring[0]), cy: String(ring[1]), r: String(ring[2]),
          fill: 'none', stroke: meta.pattern, 'stroke-width': '3', 'stroke-opacity': '.8'
        }));
      });
      MARBLE_RING_DOTS.forEach(function (dot) {
        pattern.appendChild(svgEl(doc, 'circle', {
          cx: String(dot[0]), cy: String(dot[1]), r: String(dot[2]), fill: meta.pattern, 'fill-opacity': '.8'
        }));
      });
    } else {
      MARBLE_SPOTS.forEach(function (spot) {
        pattern.appendChild(svgEl(doc, 'circle', {
          cx: String(spot[0]), cy: String(spot[1]), r: String(spot[2]), fill: meta.pattern, 'fill-opacity': '.85'
        }));
      });
      MARBLE_FLECKS.forEach(function (fleck) {
        pattern.appendChild(svgEl(doc, 'circle', {
          cx: String(fleck[0]), cy: String(fleck[1]), r: String(fleck[2]), fill: meta.pattern, 'fill-opacity': '.55'
        }));
      });
    }
    g.appendChild(pattern);
  }
  g.appendChild(svgEl(doc, 'ellipse', { cx: '67', cy: '72', rx: '31', ry: '27', fill: 'url(#ckg-' + tint + '-shade)' }));
  g.appendChild(svgEl(doc, 'circle', { cx: '50', cy: '50', r: '50', fill: 'url(#ckg-' + tint + '-vig)' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '50', cy: '98', rx: '42', ry: '20', fill: 'url(#ckg-' + tint + '-rim)' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '30', cy: '48', rx: '24', ry: '13', transform: 'rotate(-38 30 48)', fill: 'url(#ckg-hi2)', opacity: '.3' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '35', cy: '31', rx: '19', ry: '12', transform: 'rotate(-26 35 31)', fill: 'url(#ckg-hi)' }));
  g.appendChild(svgEl(doc, 'ellipse', { cx: '66', cy: '23', rx: '7', ry: '4.5', transform: 'rotate(-20 66 23)', fill: 'url(#ckg-hi2)' }));
  if (meta.candy) {
    g.appendChild(svgEl(doc, 'ellipse', { cx: '34', cy: '30', rx: '25', ry: '14', transform: 'rotate(-30 34 30)', fill: '#ffffff', opacity: '.5' }));
  }
  const candy = !!meta.candy;
  g.appendChild(svgEl(doc, 'circle', {
    cx: '50', cy: '50', r: candy ? '48' : '49.2', fill: 'none',
    stroke: meta.outline, 'stroke-width': candy ? '3.6' : '1.5'
  }));
  svg.appendChild(g);
  return svg;
}
function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
const COLOR_LABELS = { red: '红方', blue: '蓝方', green: '绿方', yellow: '黄方', purple: '紫方', orange: '橙方' };
function playerLabel(player) { return COLOR_LABELS[player] || '玩家'; }
function opposite(player) { return player === 'red' ? 'blue' : 'red'; }
function seatByColor(color) { return seats.find(function (seat) { return seat.color === color; }) || null; }
function seatAiCount() { return seats.filter(function (seat) { return seat.isAI; }).length; }
/** 回合顺延到下一位“仍有棋可走”的席位；全员无棋可走的极端僵局保持原序。 */
function advanceTurn(fromColor) {
  const index = seats.findIndex(function (seat) { return seat.color === fromColor; });
  const start = index >= 0 ? index : 0;
  for (let offset = 1; offset <= seats.length; offset++) {
    const candidate = seats[(start + offset) % seats.length];
    if (Core.listMoves(pieces, candidate.color).length) { turn = candidate.color; return; }
  }
  turn = seats[(start + 1) % seats.length].color;
}
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

function slotForCurrentConfig() {
  return CONFIG.SAVE_PREFIX + mode + '_' + seats.map(function (s) { return s.color + (s.isAI ? 'A' : 'H'); }).join('-') + '_' + aiLevel;
}
function saveGame() {
  if (mode === 'online') return;
  if (!saveSlot) saveSlot = slotForCurrentConfig();
  safeSet(saveSlot, JSON.stringify({ schemaVersion: 3, rulesVersion: 'adjacent-jump-v1',
    pieces: pieces, turn: turn, moveNumber: moveNumber, winner: gameOver, lastMove: lastMove,
    seats: seats, aiLevel: aiLevel, recentKeys: recentPositionKeys() }));
  safeSet(CONFIG.LAST_SLOT_PREFIX + mode, saveSlot);
}
function recentPositionKeys() {
  return restoredRecentKeys.concat(history.map(function (x) { return Core.positionKey(x.pieces) + '|' + x.turn; })).slice(-40);
}
function archiveExistingSlot() {
  const previous = safeGet(saveSlot);
  if (previous) safeSet(saveSlot + '_previous', previous); // one bounded backup per config, not a storage leak
}

/** 校验存档里的席位表：每个席位颜色都在盘面上且恰好 10 枚，盘面上也没有席位之外的颜色。 */
function seatsFromSave(savedPieces, rawSeats) {
  if (!Array.isArray(rawSeats) || rawSeats.length < 2) return null;
  const counts = {};
  Object.keys(savedPieces).forEach(function (key) {
    const color = savedPieces[key];
    counts[color] = (counts[color] || 0) + 1;
  });
  const clean = rawSeats.map(function (seat) {
    return seat && Core.COLORS.indexOf(seat.color) >= 0 ? { color: seat.color, isAI: !!seat.isAI } : null;
  }).filter(Boolean);
  if (clean.length !== rawSeats.length || new Set(clean.map(function (x) { return x.color; })).size !== clean.length || clean.length > 6 || clean.every(function (x) { return x.isAI; })) return null;
  const seatColors = clean.map(function (seat) { return seat.color; });
  const presentColors = Object.keys(counts);
  if (presentColors.length !== clean.length) return null;
  const allMatch = presentColors.every(function (color) {
    return seatColors.indexOf(color) >= 0 && counts[color] === 10;
  });
  return allMatch ? clean : null;
}

function loadGame() {
  if (localIntent === 'new') return false;
  try {
    const requestedSlot = launchParams.get('slot');
    const last = safeGet(CONFIG.LAST_SLOT_PREFIX + mode);
    const chosen = [requestedSlot, last, saveSlot].find(function (key) {
      return typeof key === 'string' && key.startsWith(CONFIG.SAVE_PREFIX + mode + '_') && !!safeGet(key);
    });
    const raw = safeGet(chosen || CONFIG.LEGACY_SAVE_PREFIX + mode);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.schemaVersion && parsed.schemaVersion !== 3) return false;
    if (parsed && parsed.rulesVersion && parsed.rulesVersion !== 'adjacent-jump-v1') return false;
    const saved = sanitizeLocalState(parsed);
    if (!saved) return false;
    let restoredSeats = seatsFromSave(saved.pieces, parsed.seats);
    // Migrate only legacy red/blue saves whose seats are unambiguous.
    if (!restoredSeats && !parsed.seats && Object.values(saved.pieces).every(function (c) { return c === 'red' || c === 'blue'; })) {
      restoredSeats = [{color:'red',isAI:false},{color:'blue',isAI:mode === 'ai'}];
    }
    if (!restoredSeats || (mode === 'ai' && (restoredSeats.length !== 2 || restoredSeats[0].color !== 'red' || restoredSeats[0].isAI || restoredSeats[1].color !== 'blue' || !restoredSeats[1].isAI))) return false;
    seats = restoredSeats;
    if (AI_LEVELS.includes(parsed.aiLevel)) aiLevel = parsed.aiLevel;
    pieces = saved.pieces; turn = saved.turn; moveNumber = saved.moveNumber;
    gameOver = saved.gameOver; lastMove = saved.lastMove;
    restoredRecentKeys = Array.isArray(parsed.recentKeys) ? parsed.recentKeys.filter(function (k) { return typeof k === 'string' && k.length < 140; }).slice(-40) : [];
    saveSlot = chosen || slotForCurrentConfig();
    return true;
  } catch (e) { return false; }
}

function resetState() {
  cancelAnimations(); restoredRecentKeys = []; lastAiStats = null;
  pieces = Core.createInitialPiecesForSeats(seats.map(function (seat) { return Core.campOfColor(seat.color); }));
  turn = seats.length ? seats[0].color : 'red';
  selectedKey = ''; legalMoves = emptyMoves();
  history = []; moveNumber = 1; gameOver = ''; lastMove = null; aiThinking = false;
  clearTimeout(aiTimer); aiTimer = null; cancelAiSearch(); closeWinner();
}

function pushHistory() {
  history.push({ pieces: { ...pieces }, turn: turn, moveNumber: moveNumber, gameOver: gameOver, lastMove: lastMove ? { ...lastMove, path: lastMove.path.slice() } : null });
  if (history.length > CONFIG.HISTORY_LIMIT) history.shift();
}

function restoreHistory(snapshot) {
  cancelAnimations(); lastAiStats = null;
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

/* ---------- 音效：复用同一个 AudioContext，短促有层次的提示音 ---------- */
let toneContext = null;
function ensureToneContext() {
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!soundEnabled || !AudioEngine) return null;
  try {
    if (!toneContext) toneContext = new AudioEngine();
    if (toneContext.state === 'suspended' && typeof toneContext.resume === 'function') toneContext.resume();
    return toneContext;
  } catch (e) { return null; }
}
/** 单条短音：可选上滑/下滑、三角波泛音，包络快速起音自然衰减。 */
function scheduleTone(context, options) {
  if (!context) return;
  try {
    const t0 = context.currentTime + (options.at || 0);
    const dur = options.dur || 0.12;
    const vol = options.vol || 0.045;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = options.type || 'sine';
    osc.frequency.setValueAtTime(options.f0, t0);
    if (options.f1) osc.frequency.exponentialRampToValueAtTime(options.f1, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + (options.attack || 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(context.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  } catch (e) {}
}

function playTone(kind) {
  const context = ensureToneContext();
  if (!context) return;
  if (kind === 'win') {
    // 胜利：C5-E5-G5 短琶音，略带回响层次
    [523.25, 659.25, 783.99].forEach(function (freq, index) {
      scheduleTone(context, { f0: freq, at: index * 0.085, dur: index === 2 ? 0.26 : 0.13, vol: 0.05, type: 'triangle' });
    });
    scheduleTone(context, { f0: 1046.5, at: 0.26, dur: 0.2, vol: 0.028, type: 'sine' });
    return;
  }
  if (kind === 'jump') {
    // 跳跃：轻快的上滑（起跳）+ 短低音落地
    scheduleTone(context, { f0: 660, f1: 990, dur: 0.07, vol: 0.05, type: 'triangle', attack: 0.004 });
    scheduleTone(context, { f0: 196, at: 0.07, dur: 0.07, vol: 0.05, type: 'sine', attack: 0.004 });
    scheduleTone(context, { f0: 392, at: 0.11, dur: 0.06, vol: 0.026, type: 'triangle', attack: 0.004 });
    return;
  }
  // 相邻移动：一颗木珠轻轻"嗒"一下
  scheduleTone(context, { f0: 430, f1: 372, dur: 0.06, vol: 0.045, type: 'triangle', attack: 0.004 });
  scheduleTone(context, { f0: 158, at: 0.03, dur: 0.07, vol: 0.05, type: 'sine', attack: 0.004 });
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

/** 各营地目标三角的三个顶点（尖端 + 底边两角），2 人局输出与旧版逐字节一致。 */
const ZONE_TRIANGLE_KEYS = {
  top: ['0:0', '3:-3', '3:3'],
  bottom: ['16:0', '13:-3', '13:3'],
  ul: ['7:-9', '4:-12', '4:-6'],
  ur: ['7:9', '4:12', '4:6'],
  ll: ['9:-9', '12:-12', '12:-6'],
  lr: ['9:9', '12:12', '12:6']
};

function buildZoneModels() {
  return seats.map(function (seat) {
    const goalCamp = Core.CAMP_OPPOSITE[Core.campOfColor(seat.color)] || 'bottom';
    const keys = ZONE_TRIANGLE_KEYS[goalCamp] || [];
    const points = keys.map(orientedPoint).filter(Boolean);
    if (points.length !== 3) return null;
    return {
      className: seat.color + '-goal-zone',
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
      path: lastMove.path.slice(),
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
    node.classList.toggle('ul-camp', cell.camp === 'ul');
    node.classList.toggle('ur-camp', cell.camp === 'ur');
    node.classList.toggle('ll-camp', cell.camp === 'll');
    node.classList.toggle('lr-camp', cell.camp === 'lr');
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

/**
 * FLIP 位移动画：节点已直接落到终点，这里从终点向起点回放一段合成器关键帧。
 * 只动 translate 属性（transform 被 -50% 居中 + 抵消棋盘倾斜占用），位移全程走合成器，
 * 不会逐帧重排/重绘整块木纹棋盘——left/top 过渡正是之前走棋卡顿的元凶。
 * 手感约定：
 *  - 阴影永远贴地走（连跳时不再跟着弹珠一起浮空）；
 *  - 2D 用屏幕 Y 上抛、3D 沿板面法线(translateZ)表现腾空；
 *  - 单步轻跃、跳跃明显，多跳逐段缓动，长连跳读得出“每跳落地”。
 */
function cancelAnimations() {
  motionEpoch++;
  activeAnimations.forEach(function (animation) { animation.cancel(); });
  activeAnimations.clear(); shadowAnimations.forEach(function (a) {a.cancel();}); shadowAnimations.clear(); animating = false;
}
function trackAnimation(animation, shadow) {
  if (!animation) return animation;
  if (shadow) { shadowAnimations.add(animation); Promise.resolve(animation.finished).catch(function () {}).then(function () {shadowAnimations.delete(animation);}); return animation; }
  const epoch = motionEpoch;
  activeAnimations.add(animation); animating = true;
  Promise.resolve(animation.finished).catch(function () {}).then(function () {
    if (epoch !== motionEpoch) return;
    activeAnimations.delete(animation);
    if (!activeAnimations.size) {
      animating = false; updateStatus();
      if (gameOver) showWinner(gameOver); else scheduleAiMove();
    }
  });
  return animation;
}

function animateSlide(node, from, to, kind, isShadow, path) {
  if (!node || !from || !to || typeof node.animate !== 'function' || prefersReducedMotion()) return;
  const width = dom.pieceLayer.offsetWidth;
  const height = dom.pieceLayer.offsetHeight;
  if (!width || !height) return;
  // 模型坐标已归一化到 0..1，直接乘以棋盘尺寸得到完整位移。
  const dx = (from.x - to.x) * width;
  const dy = (from.y - to.y) * height;
  if (!dx && !dy) return;
  const lift = isShadow ? 0 : (kind === 'jump' ? 26 : 12);
  const twoD = boardView === '2d';
  const groundY = function (y) { return y; };
  // 弹珠：2D 抬屏幕 Y、3D 抬法线 Z；阴影：Y/Z 都不抬。
  const bodyY = function (y) { return twoD ? y - lift * .6 : y; };
  const bodyZ = function () { return twoD ? 0 : lift; };
  const shadowY = groundY;
  const shadowZ = function () { return 0; };

  if (kind === 'jump' && path && path.length >= 2 && path.every(Boolean)) {
    const hops = path.length - 1;
    const frame = function (x, y, z, offset) {
      return { translate: x.toFixed(2) + 'px ' + y.toFixed(2) + 'px ' + z + 'px', offset: offset };
    };
    const frames = [frame(dx, dy, 0, 0)];
    const pickY = isShadow ? shadowY : bodyY;
    const pickZ = isShadow ? shadowZ : bodyZ;
    for (let i = 1; i < path.length; i++) {
      const start = path[i - 1], end = path[i];
      const midX = ((start.x + end.x) / 2 - to.x) * width;
      const midY = ((start.y + end.y) / 2 - to.y) * height;
      // 弧线顶点：弹珠腾空，阴影贴地跟随同一水平轨迹。
      frames.push(frame(midX, pickY(midY), pickZ(), (i - .5) / hops));
      // 每跳落点：回到地面（z=0 / y 不抬）。
      frames.push(frame((end.x - to.x) * width, (end.y - to.y) * height, 0, i / hops));
    }
    // 逐跳缓动 + 每跳 240ms 再加一小段停顿，长连跳有“哒哒哒”的落地节奏。
    trackAnimation(node.animate(frames, { duration: Math.min(1400, hops * 240 + 120), easing: 'ease-in-out' }), isShadow);
    return;
  }
  trackAnimation(node.animate(
    [
      { translate: dx.toFixed(2) + 'px ' + dy.toFixed(2) + 'px 0px' },
      { translate: (dx * .5).toFixed(2) + 'px ' + (isShadow ? (dy * .5) : bodyY(dy * .5)).toFixed(2) + 'px ' + (isShadow ? '0px' : (twoD ? '0px' : (lift * .9).toFixed(2) + 'px')), offset: .5 },
      { translate: '0px 0px 0px' }
    ],
    { duration: kind === 'jump' ? 360 : 240, easing: 'cubic-bezier(.33,.5,.22,1)' }
  ), isShadow);
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

  // 复用上一步起点的节点并改键到落点：先落位，再用 animateSlide 做合成器位移动画。
  if (model.move && model.move.id !== dom.moveId) {
    const moving = dom.pieceNodes.get(model.move.from);
    if (moving && !desired.has(model.move.from) && desired.has(model.move.target) && !dom.pieceNodes.has(model.move.target)) {
      dom.pieceNodes.delete(model.move.from);
      dom.pieceNodes.set(model.move.target, moving);
      const spot = positionOf.get(model.move.target);
      const fromSpot = positionOf.get(model.move.from);
      const path = model.move.path.map(function (key) { return positionOf.get(key); });
      placeNode(moving, spot.x, spot.y);
      animateSlide(moving, fromSpot, spot, model.move.kind, false, path);
      // 阴影跟着改键，否则它会被当成「消失的棋子」删掉重建，接不住位移动画。
      const shadow = dom.shadowNodes.get(model.move.from);
      if (shadow && !dom.shadowNodes.has(model.move.target)) {
        dom.shadowNodes.delete(model.move.from);
        dom.shadowNodes.set(model.move.target, shadow);
        placeNode(shadow, spot.x, spot.y);
        animateSlide(shadow, fromSpot, spot, model.move.kind, true, path);
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
      dom.pieceLayer.appendChild(node);
      dom.pieceNodes.set(piece.key, node);
      placeNode(node, piece.x, piece.y);
    } else if (reorient) {
      placeNode(node, piece.x, piece.y);
    }
    // 重开或同步新棋局时，同一孔位可能换了阵营；SVG 的渐变颜色不会随 class 自动更新。
    if (node.dataset.owner !== piece.owner) {
      node.replaceChildren();
      node.appendChild(buildPieceNode(piece.owner, document));
      node.dataset.owner = piece.owner;
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
  syncPieces(model, reorient);
  // 先让移动棋子及其阴影改键，再清理旧孔位，保留阴影节点和动画。
  syncShadows(model, reorient);
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

function onlinePlayer(color) { return online.seats.find(function (seat) { return seat.color === color; }) || null; }
function localSeatLabel(index, seat) {
  const humanNames = ['玩家 A', '玩家 B', '玩家 C', '玩家 D', '玩家 E', '玩家 F'];
  return (seat.isAI ? '电脑' : (humanNames[index] || '玩家')) + ' · ' + playerLabel(seat.color);
}

function updatePlayerNames() {
  if (mode === 'ai') { $('redName').textContent = '你 · 红方'; $('blueName').textContent = '电脑 · 蓝方'; return; }
  if (mode === 'local') {
    seats.forEach(function (seat, index) {
      const nameNode = $(seat.color + 'Name');
      if (nameNode) nameNode.textContent = localSeatLabel(index, seat);
    });
    return;
  }
  online.seats.forEach(function (seat) {
    const nameNode = $(seat.color + 'Name');
    if (!nameNode) return;
    if (seat.isBot) { nameNode.textContent = '电脑 · ' + playerLabel(seat.color); return; }
    nameNode.textContent = (seat.nick || '等待玩家') + ' · ' + playerLabel(seat.color) + (seat.cid === online.cid ? '（你）' : '');
  });
  return;
}

function canAct() {
  if (birthdayOpening()) return false;
  if (gameOver || aiThinking || animating) return false;
  if (mode === 'ai') return turn === 'red';
  if (mode === 'local') { const seat = seatByColor(turn); return !!seat && !seat.isAI; }
  return online.phase === 'playing' && online.seats.length > 0 &&
    online.seats.every(function (seat) { return seat.isBot || seat.online; }) &&
    online.color === turn && online.ws && online.ws.readyState === WebSocket.OPEN;
}

function onlineStatusText() {
  if (!online.active) return '尚未连接房间';
  if (online.phase === 'connecting') return '正在连接服务器…';
  if (online.phase === 'reconnecting') return '连接中断，' + Math.max(1, Math.ceil(online.retryDelay / 1000)) + ' 秒后重连';
  if (online.phase === 'waiting') {
    const humans = online.seats.filter(function (seat) { return !seat.isBot; });
    if (humans.length > 1) {
      const seated = humans.filter(function (seat) { return seat.online; }).length;
      return seated < humans.length ? '等待好友加入（' + seated + '/' + humans.length + '）' :
        (online.host === online.cid ? '双方已到齐，点击开始对局' : '双方已到齐，等待房主开始');
    }
    return '等待另一位玩家加入';
  }
  if (online.phase === 'opening') return birthdayOpening() ? '开幕式进行中' : '等待另一位玩家完成开幕式';
  if (online.phase === 'playing') {
    if (online.seats.some(function (seat) { return !seat.isBot && !seat.online; })) return '对手已离线，等待其自动重连';
    const actor = onlinePlayer(turn);
    if (actor && actor.isBot) return '等待电脑走棋';
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
  if (document.body && document.body.dataset) document.body.dataset.roomPhase = mode === 'online' ? online.phase : '';
  const selfTurn = mode === 'online' && online.color === turn;
  if ($('board')) $('board').setAttribute('aria-label', '中国跳棋棋盘，固定视角');
  $('turnPiece').className = 'turn-piece ' + turn;
  let title = playerLabel(turn) + '回合'; let kicker = playerLabel(viewPlayer) + '固定视角 · 己方在下';
  if (gameOver) { title = playerLabel(gameOver) + '获胜'; kicker = '本局已经结束'; }
  else if (mode === 'ai') { title = aiThinking || turn === 'blue' ? '电脑思考中…' : '你的回合'; kicker = '你的视角 · 红方始终在下'; }
  else if (mode === 'local') kicker = '固定视角 · 换手不翻转棋盘';
  else if (!online.color) { title = onlineStatusText(); kicker = '加入房间后由服务器分配阵营'; }
  else {
    const actor = onlinePlayer(turn);
    title = online.phase === 'playing' ? (selfTurn ? '轮到你走' : (actor && actor.isBot ? '电脑回合' : '对手回合')) : onlineStatusText();
    kicker = '你的视角 · ' + playerLabel(online.color) + (online.color === 'red' ? '始终在下' : (online.color === 'blue' ? '营地已在下' : '营地位置固定'));
  }
  $('turnText').textContent = title; $('turnKicker').textContent = kicker; $('moveCount').textContent = '第 ' + moveNumber + ' 手';
  seats.forEach(function (seat) {
    const progress = $(seat.color + 'Progress');
    if (progress) progress.textContent = Core.countInGoal(pieces, seat.color) + '/10';
    const row = $(seat.color + 'Player');
    if (row) row.classList.toggle('active', !gameOver && turn === seat.color);
  });
  updatePlayerNames(); updateLastMoveBar();
  $('undoBtn').disabled = mode === 'online' || history.length === 0 || aiThinking; $('undoBtn').title = mode === 'online' ? '联机棋局不能撤销' : '';
  if (mode === 'online') {
    const mayRestart = online.phase === 'done' && online.host === online.cid;
    $('newGameBtn').disabled = !mayRestart; $('newGameBtn').innerHTML = mayRestart ? '<span>↻</span> 再来一局' : '<span>↻</span> 房主可重开';
  } else { $('newGameBtn').disabled = false; $('newGameBtn').innerHTML = '<span>↻</span> 重新开局'; }
  const opponentOffline = online.phase === 'playing' && online.seats.some(function (seat) { return !seat.isBot && !seat.online; });
  const showWait = mode === 'online' && online.active && ['connecting','reconnecting','waiting'].includes(online.phase) || (mode === 'online' && opponentOffline);
  $('boardWait').hidden = !showWait;
  if (showWait) {
    const reconnecting = online.phase === 'connecting' || online.phase === 'reconnecting';
    const bothHere = online.seats.filter(function (seat) { return !seat.isBot && seat.online; }).length === 2;
    $('boardWait').querySelector('strong').textContent = reconnecting ? '正在恢复联机' : (opponentOffline ? '对手暂时离线' : (bothHere ? '朋友到齐了' : '等待好友加入'));
    $('boardWait').querySelector('small').textContent = reconnecting ? onlineStatusText() : (opponentOffline ? '已保留其阵营，重连后继续当前棋局' : (bothHere ? onlineStatusText() : '房主执蓝，好友执红；到齐后由房主开始'));
  }
  const start = $('startOnlineBtn');
  if (start) {
    start.hidden = mode !== 'online' || online.phase !== 'waiting' || online.host !== online.cid;
    start.disabled = online.startPending || online.seats.filter(function (seat) { return !seat.isBot && seat.online; }).length !== 2;
    start.textContent = online.startPending ? '正在开始…' : '开始对局';
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
  if (!alreadyOpen) setTimeout(function () {
    const blow = $('birthdayBlowBtn');
    (birthdayMode && blow && !blow.hidden ? blow : $('winnerNewBtn')).focus();
  }, 0);
  presentationEvent('checkers:winner', { player: player, label: playerLabel(player) });
}
function closeWinner() { const overlay = $('winnerOverlay'); if (!overlay) return; overlay.classList.remove('active'); overlay.setAttribute('aria-hidden', 'true'); presentationEvent('checkers:winner-close'); }

function applyLocalMove(fromKey, targetKey, actor) {
  if (birthdayOpening() || animating || gameOver || actor !== turn) return false;
  const result = Core.applyMove(pieces, actor, fromKey, targetKey); if (!result) return false;
  pushHistory(); pieces = result.pieces;
  lastMove = { player: actor, from: fromKey, target: targetKey, kind: result.kind, path: result.path.slice(), moveNumber: moveNumber };
  selectedKey = ''; legalMoves = emptyMoves();
  if (result.winner) { gameOver = result.winner; playTone('win'); }
  else { advanceTurn(actor); moveNumber++; playTone(result.kind); }
  saveGame(); render();
  if (gameOver && !animating) showWinner(gameOver);
  scheduleAiMove();
  return true;
}

/** Invalidate outstanding callbacks; keep an idle worker warm between turns. */
function cancelAiSearch(force) {
  aiRequestId++; clearTimeout(aiWatchdog); aiWatchdog = null;
  if (aiWorker && (aiWorkerBusy || force)) { aiWorker.terminate(); aiWorker = null; }
  aiWorkerBusy = false;
}
function showAiDiagnostics(stats) {
  lastAiStats = stats || null;
  const node = $('aiEngineNote');
  if (!node || !stats) return;
  const stage = stats.stage && ({opening:'开局规划',contact:'对抗搜索',endgame:'收官搜索'}[stats.stage.name]);
  node.textContent = (stage || stats.algorithm || 'AI') + ' · ' +
    (stats.simulations !== undefined ? stats.simulations + ' 次模拟' : '完成 ' + (stats.completedDepth || 0) + ' 层') +
    ' · ' + Math.round(stats.elapsedMs || 0) + ' ms' + (stats.modelUsed ? ' · 冻结模型' : ' · 规则搜索');
  node.title = JSON.stringify(stats);
}
function requestAiMove(player, recentPositions, callback) {
  const requestId = ++aiRequestId, snapshot = { ...pieces };
  let settled = false;
  const finish = function (move, stats) {
    if (settled || requestId !== aiRequestId) return;
    settled = true; clearTimeout(aiWatchdog); aiWatchdog = null; aiWorkerBusy = false;
    // Don't trust a worker payload without a rule-engine check at the UI boundary.
    if (move && !Core.applyMove(snapshot, player, move.from, move.target)) move = null;
    showAiDiagnostics(stats); callback(move);
  };
  const fallback = function (reason) {
    if (settled || requestId !== aiRequestId) return;
    if (aiWorker) { aiWorker.terminate(); aiWorker = null; } aiWorkerBusy = false;
    // Deliberately bounded main-thread fallback, never the legacy deep synchronous search.
    const result = window.CheckersAI.chooseMove(snapshot, player, {
      seats:seats.map(function (s) { return s.color; }), level:'easy', timeLimitMs:8,
      maxNodes:100, seed:moveNumber, useModel:false, recentPositions:recentPositions
    });
    result.stats.fallbackReason = reason;
    finish(result.move, result.stats);
  };
  if (typeof window.Worker !== 'function') { fallback('Worker unavailable'); return; }
  try {
    if (!aiWorker) aiWorker = new window.Worker('checkers_ai_worker.js?v=' + CONFIG.BUILD_ID);
    aiWorkerBusy = true;
    aiWorker.onmessage = function (event) {
      const response = event && event.data || {};
      if (Number(response.requestId) !== requestId) return;
      if (response.error || (response.move && !Core.applyMove(snapshot,player,response.move.from,response.move.target)) || (!response.move && Core.listMoves(snapshot,player).length && !Core.COLORS.some(function(c){return Core.hasWon(snapshot,c);}))) fallback(response.error || 'Invalid worker move');
      else finish(response.move || null, response.stats);
    };
    aiWorker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault(); fallback('Worker load/runtime error');
    };
    aiWatchdog = setTimeout(function () { fallback('Worker watchdog'); }, 3000);
    aiWorker.postMessage({requestId:requestId,pieces:snapshot,player:player,level:aiLevel,
      seats:seats.map(function (s) { return s.color; }), moveNumber:moveNumber,
      recentPositions:recentPositions,seed:moveNumber * 104729 + seats.length});
  } catch (error) { fallback(String(error && error.message || error)); }
}

function scheduleAiMove() {
  if (birthdayOpening() || mode === 'online' || gameOver || animating || aiThinking) return;
  const seat = seatByColor(turn);
  if (!seat || !seat.isAI) return;
  clearTimeout(aiTimer); cancelAiSearch(); aiThinking = true; render();
  aiTimer = setTimeout(function () {
    aiTimer = null;
    const current = seatByColor(turn);
    if (mode === 'online' || gameOver || !current || !current.isAI || current.color !== seat.color) { aiThinking = false; render(); return; }
    const finish = function (move) {
      if (gameOver || seatByColor(turn) !== current) { aiThinking = false; render(); return; }
      aiThinking = false;
      if (!move) {
        // 该电脑席位无棋可走：顺延回合，避免整局卡死。
        advanceTurn(seat.color); moveNumber++; saveGame(); render(); scheduleAiMove();
        return;
      }
      applyLocalMove(move.from, move.target, seat.color);
    };
    requestAiMove(seat.color, recentPositionKeys(), finish);
  }, CONFIG.AI_DELAY);
}

function movePiece(targetKey) {
  if (mode === 'online') {
    if (!sendOnline({ t: 'move', from: selectedKey, target: targetKey, seq: moveNumber })) showToast('连接尚未恢复，请稍后再试');
    else { selectedKey = ''; legalMoves = emptyMoves(); render(); }
    return;
  }
  applyLocalMove(selectedKey, targetKey, turn);
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
  if (mode === 'online' || !history.length) return;
  cancelAnimations();
  clearTimeout(aiTimer); aiTimer = null; cancelAiSearch(); aiThinking = false;
  let previous = history.pop(); if (!previous) return;
  if (mode === 'ai' && previous.turn === 'blue' && history.length) previous = history.pop();
  else if (mode === 'local') {
    // 本地多人：连着撤销电脑席位的着法，一直退回到人类席位的回合。
    while (previous && seatByColor(previous.turn) && seatByColor(previous.turn).isAI && history.length) previous = history.pop();
  }
  restoreHistory(previous); saveGame(); render(); scheduleAiMove();
}

function resetGame(skipConfirm) {
  if (mode === 'online') {
    if (online.phase === 'done' && online.host === online.cid) sendOnline({ t: 'again' }); else closeWinner();
    return;
  }
  if (!skipConfirm && moveNumber > 1 && typeof window.confirm === 'function' && !window.confirm('确定重新开始当前棋局吗？')) return;
  archiveExistingSlot(); resetState(); saveGame();
  presentationEvent('checkers:newgame'); render(); scheduleAiMove();
}

function toggleSound() {
  soundEnabled = !soundEnabled; safeSet(CONFIG.SOUND_KEY, soundEnabled ? '1' : '0');
  var soundBtnEl = $('soundBtn');
  if (soundBtnEl) { soundBtnEl.innerHTML = '<i class="ui-icon ' + (soundEnabled ? 'ui-icon--volume-high' : 'ui-icon--volume-xmark') + '" aria-hidden="true"></i>'; soundBtnEl.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); soundBtnEl.setAttribute('aria-label', soundEnabled ? '关闭音效' : '开启音效'); }
}

function websocketUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/checkers-ws'; }
function sendOnline(message) { if (!online.ws || online.ws.readyState !== WebSocket.OPEN) return false; try { online.ws.send(JSON.stringify(message)); return true; } catch (e) { return false; } }
function acknowledgeOpening() {
  if (online.phase !== 'opening' || birthdayOpening() || online.readyRound === online.round) return;
  if (sendOnline({ t: 'opening_ready', round: online.round })) online.readyRound = online.round;
}
function startOnlineGame() {
  if (mode !== 'online' || online.phase !== 'waiting' || online.host !== online.cid || online.startPending) return;
  online.startPending = sendOnline({ t: 'start' });
  updateStatus();
}

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
    online.color = ''; online.seats = []; online.players = []; online.host = ''; online.nick = safeGet(CONFIG.NICK_KEY) || '玩家'; online.intent = intent;
    if (intent === 'create') {
      const requestedBots = Math.floor(Number(launchParams.get('bots')) || 0);
      online.bots = Math.max(0, Math.min(4, requestedBots));
      const requestedBotLevel = launchParams.get('level');
      online.botLevel = AI_LEVELS.includes(requestedBotLevel) ? requestedBotLevel : 'normal';
    }
  }
  clearTimeout(online.reconnectTimer); online.reconnectTimer = null;
  if (online.ws) { online.intentionalClose = true; try { online.ws.close(1000, 'replace'); } catch (e) {} }
  online.phase = online.retryAttempt ? 'reconnecting' : 'connecting'; online.intentionalClose = false; render();
  let ws;
  try { ws = new WebSocket(websocketUrl()); } catch (e) { showToast('无法创建联机连接'); scheduleReconnect(); return; }
  online.ws = ws;
  ws.addEventListener('open', function () {
    if (online.ws !== ws) return;
    online.readyRound = 0;
    const payload = { t: 'join', room: online.room, nick: online.nick, cid: online.cid, token: online.token, intent: online.intent };
    if (online.intent === 'create' && online.bots > 0) { payload.bots = online.bots; payload.level = online.botLevel; }
    sendOnline(payload);
  });
  ws.addEventListener('message', function (event) {
    if (online.ws !== ws) return;
    let message; try { message = JSON.parse(event.data); } catch (e) { return; }
    if (message.t === 'session') {
      if (message.cid === online.cid && typeof message.token === 'string') { online.token = message.token; online.intent = 'join'; safeSet(CONFIG.TOKEN_PREFIX + online.room, online.token); }
      return;
    }
    if (message.t === 'state') {
      const clean = Core.sanitizeState(message);
      const rawSeats = Array.isArray(message.seats) && message.seats.length ? message.seats
        : (Array.isArray(message.players) ? message.players : null);
      if (!clean || message.room !== online.room || !rawSeats) return;
      if (clean.moveNumber !== moveNumber || Core.positionKey(clean.pieces) !== Core.positionKey(pieces)) cancelAnimations();
      pieces = clean.pieces; turn = clean.turn; moveNumber = clean.moveNumber; gameOver = clean.winner; lastMove = clean.lastMove;
      online.phase = ['waiting','opening','playing','done'].includes(message.phase) ? message.phase : 'waiting'; online.host = typeof message.host === 'string' ? message.host : '';
      online.round = Math.max(0, Math.floor(Number(message.round) || 0)); online.startPending = false;
      online.seats = rawSeats.map(function (seat) {
        const color = Core.COLORS.indexOf(seat.color) >= 0 ? seat.color : 'red';
        return { cid: String(seat.cid || '').slice(0, 32), nick: String(seat.nick || '').slice(0, 16), color: color, online: !!seat.online, isBot: !!seat.isBot };
      });
      online.players = online.seats.filter(function (seat) { return !seat.isBot; }).map(function (seat) {
        return { cid: seat.cid, nick: seat.nick, color: seat.color, online: seat.online };
      });
      const self = online.seats.find(function (seat) { return seat.cid === online.cid; }); if (self) online.color = self.color;
      viewPlayer = getViewPlayerForMode('online', online.color); selectedKey = ''; legalMoves = emptyMoves(); history = [];
      seats = online.seats.map(function (seat) { return { color: seat.color, isAI: seat.isBot }; });
      ensurePlayerRows();
      const botCount = online.seats.filter(function (seat) { return seat.isBot; }).length;
      const badge = $('modeBadge'); if (badge) badge.textContent = '好友对战' + (botCount ? ' · ' + botCount + ' 电脑' : '');
      online.retryAttempt = 0; online.retryDelay = 0; online.intent = 'join';
      if (!gameOver) closeWinner();
      if (online.phase === 'opening') {
        if (online.openingRound !== online.round) {
          online.openingRound = online.round;
          presentationEvent('checkers:room-opening', { round: online.round });
        }
        acknowledgeOpening();
      }
      render();
      if (gameOver && !animating) showWinner(gameOver);
      return;
    }
    if (message.t === 'err') {
      online.startPending = false; updateStatus();
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
  online.active = false; online.ws = null; online.room = ''; online.color = ''; online.seats = []; online.players = []; online.host = ''; online.phase = 'idle'; online.retryAttempt = 0; online.retryDelay = 0;
}

function copyInvite() {
  if (!online.room) return;
  const url = new URL('index.html', location.href); url.searchParams.set('room', online.room);
  const text = '来和我下中国跳棋：' + url.toString();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { showToast('邀请链接已复制'); }, function () { showToast('房间码：' + online.room); });
  else showToast('房间码：' + online.room);
}

function exitToLobby() {
  cancelAnimations(); cancelAiSearch(true);
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
  // 3D 球体与孔位处于不同平面，浏览器可能把可见球面命中到后方孔位。
  // 按球体当前屏幕位置选取最近的圆形热区，也覆盖选中后的浮起位置。
  let pieceKey = ''; let nearest = Infinity;
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    dom.pieceNodes.forEach(function (piece, key) {
      const rect = piece.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
      const dy = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance <= 1 && distance < nearest) { nearest = distance; pieceKey = key; }
    });
  }
  if (pieceKey) { handleCell(pieceKey); return; }
  // 落点使用同样的屏幕坐标命中，保留孔位的扩大热区，并取最近合法落点。
  let targetKey = ''; let targetDistance = Infinity;
  if (selectedKey && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    legalMoves.all.forEach(function (key) {
      const cell = dom.cells.get(key);
      if (!cell) return;
      const rect = cell.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dx = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
      const dy = (event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
      const distance = dx * dx + dy * dy;
      if (distance <= 1 && distance < targetDistance) { targetDistance = distance; targetKey = key; }
    });
  }
  if (targetKey) { handleCell(targetKey); return; }
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

/** 多于 2 席时补齐玩家面板行并把面板切成纵向布局；2 席保持旧版结构。 */
function ensurePlayerRows() {
  const card = document.querySelector('.players-card'); if (!card) return;
  card.replaceChildren(); card.classList.toggle('multi', seats.length > 2);
  seats.forEach(function (seat, index) {
    if (index === 1 && seats.length === 2) {
      const vs = document.createElement('div'); vs.className = 'versus'; vs.textContent = 'VS'; card.appendChild(vs);
    }
    const row = document.createElement('div'); row.className = 'player-row'; row.id = seat.color + 'Player';
    const piece = document.createElement('span'); piece.className = 'player-piece ' + seat.color; piece.setAttribute('aria-hidden','true');
    const info = document.createElement('div'), name = document.createElement('strong'), hint = document.createElement('small');
    name.id = seat.color + 'Name'; hint.textContent = '目标：对家营地'; info.append(name,hint);
    const progress = document.createElement('b'); progress.id = seat.color + 'Progress'; progress.textContent = '0/10';
    row.append(piece,info,progress); card.appendChild(row);
  });
}

function init() {
  soundEnabled = safeGet(CONFIG.SOUND_KEY) !== '0';
  const requestedLevel = launchParams.get('level'); aiLevel = AI_LEVELS.includes(requestedLevel) ? requestedLevel : (AI_LEVELS.includes(safeGet(CONFIG.AI_LEVEL_KEY)) ? safeGet(CONFIG.AI_LEVEL_KEY) : 'normal');
  safeSet(CONFIG.AI_LEVEL_KEY, aiLevel); viewPlayer = 'red';
  if (mode === 'local') {
    const requestedPlayers = Math.floor(Number(launchParams.get('players')) || 2);
    const requestedAi = Math.floor(Number(launchParams.get('ai')) || 0);
    const playerCount = Math.max(2, Math.min(6, requestedPlayers));
    const aiCount = Math.max(0, Math.min(5, Math.min(playerCount - 1, requestedAi)));
    seats = Core.seatColorsFor(Core.SEAT_LAYOUTS[playerCount] || Core.SEAT_LAYOUTS[2])
      .map(function (color, index) { return { color: color, isAI: index >= playerCount - aiCount }; });
  } else if (mode === 'ai') {
    seats = [{ color: 'red', isAI: false }, { color: 'blue', isAI: true }];
  } else {
    seats = [{ color: 'red', isAI: false }, { color: 'blue', isAI: false }];
  }
  saveSlot = slotForCurrentConfig();
  if (mode === 'online') resetState();
  else {
    if (!loadGame()) { if (localIntent === 'new') archiveExistingSlot(); resetState(); }
    saveGame();
    // A reload resumes the just-created game, instead of replaying the 'new' intent.
    const url = new URL(location.href); url.searchParams.set('intent','resume'); url.searchParams.set('slot',saveSlot);
    window.history.replaceState(null,'',url.toString());
  }
  ensurePlayerRows();
  boardView = normalizeBoardView(safeGet(CONFIG.BOARD_VIEW_KEY));
  const boardModeSelect = $('boardModeSelect'); if (boardModeSelect) boardModeSelect.value = boardView;
  var soundBtnEl = $('soundBtn');
  if (soundBtnEl) { soundBtnEl.innerHTML = '<i class="ui-icon ' + (soundEnabled ? 'ui-icon--volume-high' : 'ui-icon--volume-xmark') + '" aria-hidden="true"></i>'; soundBtnEl.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); }
  $('onlineRoomBar').hidden = mode !== 'online';
  const aiSeatCount = seatAiCount();
  $('modeBadge').textContent = mode === 'ai' ? '人机对战 · ' + ({ easy:'轻松', normal:'标准', hard:'困难 · 分阶段' }[aiLevel]) : (mode === 'local' ? '本地 ' + seats.length + ' 人' + (aiSeatCount ? ' · ' + aiSeatCount + ' 电脑' : '') : (mode === 'online' && online.bots ? '好友对战 · ' + online.bots + ' 电脑' : '好友对战'));
  $('saveNote').textContent = mode === 'online' ? '联机棋局由服务器同步与校验，短暂断线会自动恢复。' : '棋局会自动保存在当前浏览器中，刷新后可以继续。';
  if (mode === 'online') $('roomCodeText').textContent = launchRoom || '-----';

  bindBoardInput();
  applyBoardModeLayout(boardView);
  if (document.addEventListener) document.addEventListener('checkers:opening-end', function () { acknowledgeOpening(); updateStatus(); scheduleAiMove(); });
  if ($('startOnlineBtn')) $('startOnlineBtn').addEventListener('click', startOnlineGame);
  $('undoBtn').addEventListener('click', undoMove); $('newGameBtn').addEventListener('click', function () { resetGame(false); }); $('winnerNewBtn').addEventListener('click', function () { resetGame(true); });
  $('soundBtn').addEventListener('click', toggleSound); $('exitBtn').addEventListener('click', exitToLobby); $('copyInviteBtn').addEventListener('click', copyInvite); $('leaveRoomBtn').addEventListener('click', exitToLobby);
  window.addEventListener('beforeunload', function () { cancelAiSearch(true); cancelAnimations(); if (online.active) sendOnline({ t: 'ping' }); });
  render(); scheduleAiMove();
  if (gameOver) showWinner(gameOver); if (mode === 'online') connectOnline(launchIntent);
}

window.__checkersTest = {
  CONFIG: CONFIG, Core: Core, mode: mode, getViewPlayerForMode: getViewPlayerForMode,
  normalizeRoom: normalizeRoom, sanitizeLocalState: sanitizeLocalState, websocketUrl: websocketUrl,
  reconnectDelayForAttempt: reconnectDelayForAttempt, normalizeBoardView: normalizeBoardView,
  applyBoardModeLayout: applyBoardModeLayout, buildBoardModel: buildBoardModel,
  findNeighborKey: findNeighborKey, BOARD_SPAN: BOARD_SPAN,
  state: function () { return {pieces:{...pieces},turn:turn,seats:seats.map(function (s) {return {...s};}),moveNumber:moveNumber,
    gameOver:gameOver,animating:animating,aiThinking:aiThinking,aiWorkerBusy:aiWorkerBusy,saveSlot:saveSlot,lastAiStats:lastAiStats}; },
  canAct:canAct,handleCell:handleCell,applyLocalMove:applyLocalMove,undoMove:undoMove,resetGame:resetGame,
  PIECE_TINTS: PIECE_TINTS, BIRTHDAY_TINTS: BIRTHDAY_TINTS,
  SPRINKLE_STICKS: SPRINKLE_STICKS, activeTints: activeTints, resolveBirthdayMode: resolveBirthdayMode,
  buildPieceDefs: buildPieceDefs, buildPieceNode: buildPieceNode, birthdayMode: birthdayMode
};
window.addEventListener('DOMContentLoaded', init);
