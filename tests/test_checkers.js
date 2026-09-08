'use strict';

const fs = require('fs');
const vm = require('vm');

function makeSimpleStorage() {
  const store = Object.create(null);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
    __store: store
  };
}

const sandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error, RegExp,
  Uint8Array, URL, URLSearchParams,
  setTimeout, clearTimeout,
  document: {},
  location: { protocol: 'https:', host: 'game.test', href: 'https://game.test/checkers/play.html?mode=ai', search: '?mode=ai' },
  navigator: {},
  localStorage: makeSimpleStorage(),
  WebSocket: { OPEN: 1 }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {};
vm.createContext(sandbox);

const coreSource = fs.readFileSync('public/checkers/checkers_core.js', 'utf8');
const modelSource = fs.readFileSync('public/checkers/checkers_ai_model.js', 'utf8');
const source = fs.readFileSync('public/checkers/checkers.js', 'utf8');
const workerSource = fs.readFileSync('public/checkers/checkers_ai_worker.js', 'utf8');
const lobbyHtml = fs.readFileSync('public/checkers/index.html', 'utf8');
const lobbySource = fs.readFileSync('public/checkers/lobby.js', 'utf8');
const playHtml = fs.readFileSync('public/checkers/play.html', 'utf8');
const css = fs.readFileSync('public/checkers/checkers.css', 'utf8');
const labHtml = fs.readFileSync('public/checkers/lab.html', 'utf8');
const labSource = fs.readFileSync('public/checkers/lab.js', 'utf8');
const labRun = JSON.parse(fs.readFileSync('public/checkers/training/latest.json', 'utf8'));
const platformHtml = fs.readFileSync('public/index.html', 'utf8');
const serverSource = fs.readFileSync('server.js', 'utf8');
vm.runInContext(coreSource, sandbox, { filename: 'checkers_core.js' });
vm.runInContext(modelSource, sandbox, { filename: 'checkers_ai_model.js' });
vm.runInContext(source, sandbox, { filename: 'checkers.js' });

const T = sandbox.__checkersTest;
const C = T.Core;
const M = sandbox.CheckersAiModel;
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

ok('棋盘生成完整的 121 个唯一孔位',
  C.BOARD_CELLS.length === 121 && new Set(C.BOARD_CELLS.map(cell => cell.key)).size === 121);
ok('17 行孔位数量符合六角星棋盘结构',
  C.ROW_COUNTS.join(',') === '1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1');
ok('上下双方营地各有 10 个孔位', C.TOP_CAMP.length === 10 && C.BOTTOM_CAMP.length === 10);

const topCell = C.BOARD_CELLS.find(cell => cell.row === 0);
const bottomCell = C.BOARD_CELLS.find(cell => cell.row === 16);
ok('红方视角把红方逻辑营地映射到屏幕下方', C.orientPoint(topCell, 'red').y > 280);
ok('蓝方视角把蓝方逻辑营地保持在屏幕下方', C.orientPoint(bottomCell, 'blue').y > 280);
ok('本地与人机视角固定为红方，不会跟随回合改变',
  T.getViewPlayerForMode('ai', '') === 'red' && T.getViewPlayerForMode('local', 'blue') === 'red');
ok('联机视角只由服务器分配的本机阵营决定',
  T.getViewPlayerForMode('online', 'red') === 'red' && T.getViewPlayerForMode('online', 'blue') === 'blue');
ok('棋盘不再通过 CSS 旋转或按回合切换视角',
  !/checker-board\.view-(red|blue)/.test(css) && !/\.checker-board[^}]*rotate/.test(css) && !/viewPlayer\s*=\s*turn/.test(source));
ok('棋盘页支持 2D/3D 切换控件与持久化配置键',
  /boardModeSelect/.test(playHtml) && /data-view="3d"/.test(playHtml) && /BOARD_VIEW_KEY/.test(source));
ok('棋盘只保留单一渲染层，不再出现第二块 board3d 容器',
  !/board3d/.test(playHtml) && !/board3d/.test(source) && !/renderBoard2D|renderBoard3D/.test(source));

vm.runInContext(`
  selectedKey = '3:-3';
  legalMoves = Core.getLegalMoves(pieces, '3:-3');
  lastMove = null;
`, sandbox);
const baseModel = T.buildBoardModel();
const campCells = baseModel.cells.filter(function (cell) { return cell.camp; });
const legalTargets = C.getLegalMoves(C.createInitialPieces(), '3:-3').all.length;
const markedTargets = baseModel.cells.filter(function (cell) { return cell.moveKind; });
ok('棋盘模型输出 121 个孔位，并把坐标归一化到 0~1',
  baseModel.cells.length === 121 &&
  baseModel.cells.every(function (cell) {
    return cell.x >= 0 && cell.x <= 1 && cell.y >= 0 && cell.y <= 1;
  }));
ok('棋盘模型同时给出六色营地、选中、落点与键盘焦点标记',
  campCells.length === 60 && C.CAMP_IDS.every(function (camp) {
    return campCells.filter(function (cell) { return cell.camp === camp; }).length === 10;
  }) &&
  baseModel.cells.some(function (cell) { return cell.key === '3:-3' && cell.selected && !cell.moveKind; }) &&
  markedTargets.length === legalTargets &&
  markedTargets.every(function (cell) { return cell.moveKind === 'step' || cell.moveKind === 'jump'; }) &&
  baseModel.cells.filter(function (cell) { return cell.focus; }).length === 1);
ok('棋盘模型把双方目标营地输出为三角形区域',
  baseModel.zones.length === 2 &&
  baseModel.zones.every(function (zone) {
    return zone.points.length === 3 && /-zone$/.test(zone.className);
  }));

vm.runInContext(`
  lastMove = {
    player: 'red', from: '3:-3', target: '6:-6', kind: 'jump',
    path: ['3:-3', '4:-4', '6:-6'], moveNumber: 1
  };
`, sandbox);
const jumpModel = T.buildBoardModel();
ok('棋盘模型按段区分相邻段与跳跃段，并保留行动方',
  jumpModel.routes.length === 2 && jumpModel.routes[0].jump === false && jumpModel.routes[1].jump === true &&
  jumpModel.routes.every(function (segment) {
    return segment.player === 'red' && segment.length > 0 && Number.isFinite(segment.angle);
  }));
function oriented(key) { const cell = C.BOARD_CELLS.find(function (item) { return item.key === key; }); return C.orientPoint(cell, 'red'); }
const originPoint = oriented('8:0');
const navChecks = [[0, -1, 'y', -1], [0, 1, 'y', 1], [-1, 0, 'x', -1], [1, 0, 'x', 1]].map(function (probe) {
  const nextKey = T.findNeighborKey('8:0', probe[0], probe[1]);
  if (!nextKey || nextKey === '8:0') return false;
  const next = oriented(nextKey);
  return (next[probe[2]] - originPoint[probe[2]]) * probe[3] > 0;
});
ok('方向键能在六角星棋盘上找到对应方向的下一个孔位', navChecks.every(Boolean));
ok('3D 模式用 rotateX 形成真实透视，2D 保持平面',
  /rotateX\(var\(--board-tilt/.test(css) && /--board-tilt:17deg/.test(css) && /--board-tilt:0deg/.test(css) &&
  !/\.checker-board[^}]*rotate/.test(css));
ok('棋盘热区不小于 7% 宽度，避免回退成过小的点击区域',
  /\.ck-cell\{[^}]*width:7\.4%/.test(css) && /\.ck-piece\{[^}]*width:4\.94%/.test(css));

const boardStorage = makeSimpleStorage();
const boardNodes = Object.create(null);
function hasClass(node, name) { return String(node.className).split(/\s+/).indexOf(name) >= 0; }
function addClass(node, name) { if (!hasClass(node, name)) node.className = (node.className ? node.className + ' ' : '') + name; }
function removeClass(node, name) {
  node.className = String(node.className).split(/\s+/).filter(function (item) { return item && item !== name; }).join(' ');
}
function createNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', hidden: false, style: {}, dataset: {}, children: [], __attrs: {},
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    replaceChildren() { this.children.length = 0; },
    remove() {
      const parent = this.parentNode;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index >= 0) parent.children.splice(index, 1);
      this.parentNode = null;
    },
    setAttribute(name, value) {
      this.__attrs[name] = String(value);
      if (name === 'class') this.className = String(value);
    },
    getAttribute(name) { return this.__attrs[name]; },
    addEventListener() {},
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const wanted = String(selector).replace(/^\./, '');
      const found = [];
      (function walk(current) {
        current.children.forEach(function (child) {
          if (hasClass(child, wanted)) found.push(child);
          if (child.tagName === selector) found.push(child);
          walk(child);
        });
      })(this);
      return found;
    },
    focus() {}
  };
  node.classList = {
    add(name) { addClass(node, name); },
    remove(name) { removeClass(node, name); },
    contains(name) { return hasClass(node, name); },
    toggle(name, force) {
      const on = force === undefined ? !hasClass(node, name) : !!force;
      if (on) addClass(node, name); else removeClass(node, name);
      return on;
    }
  };
  return node;
}
function findByClass(root, className) {
  let found = null;
  (function walk(current) {
    if (found) return;
    if (hasClass(current, className)) { found = current; return; }
    current.children.forEach(walk);
  })(root);
  return found;
}
['board', 'boardModeSelect', 'soundBtn', 'onlineRoomBar', 'modeBadge', 'saveNote', 'roomCodeText',
  'undoBtn', 'newGameBtn', 'winnerNewBtn', 'exitBtn', 'copyInviteBtn', 'leaveRoomBtn',
  'turnPiece', 'turnText', 'turnKicker', 'moveCount', 'redProgress', 'blueProgress',
  'redPlayer', 'bluePlayer', 'redName', 'blueName', 'lastMoveBar', 'lastMovePiece',
  'lastMoveText', 'lastMoveKind', 'boardWait', 'onlineStatus', 'boardTip',
  'winnerOverlay', 'winnerPiece', 'winnerTitle', 'winnerText', 'toast'
].forEach(function (id) { boardNodes[id] = createNode('div'); boardNodes[id].id = id; });
boardNodes.boardWait.appendChild(createNode('strong'));
boardNodes.boardWait.appendChild(createNode('small'));
const readyHandlers = Object.create(null);
const boardSandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error, RegExp,
  Uint8Array, URL, URLSearchParams,
  setTimeout, clearTimeout,
  document: {
    createElement: createNode,
    createElementNS: function (_ns, tag) { return createNode(tag); },
    getElementById: function (id) { return boardNodes[id] || null; },
    querySelector: function () { return null; }
  },
  location: { protocol: 'https:', host: 'game.test', href: 'https://game.test/checkers/play.html?mode=ai', search: '?mode=ai' },
  navigator: {},
  localStorage: boardStorage,
  WebSocket: { OPEN: 1 }
};
boardSandbox.window = boardSandbox;
boardSandbox.globalThis = boardSandbox;
boardSandbox.addEventListener = function (type, handler) {
  (readyHandlers[type] = readyHandlers[type] || []).push(handler);
};
vm.createContext(boardSandbox);
vm.runInContext(coreSource, boardSandbox, { filename: 'checkers_core.js' });
vm.runInContext(source, boardSandbox, { filename: 'checkers.js' });
const boardTest = boardSandbox.__checkersTest;
boardTest.applyBoardModeLayout('2d');
ok('2D 模式写入 data-view 并持久化配置',
  boardNodes.board.dataset.view === '2d' && boardNodes.boardModeSelect.value === '2d' &&
  boardStorage.getItem(boardTest.CONFIG.BOARD_VIEW_KEY) === '2d');
boardTest.applyBoardModeLayout('3d');
ok('3D 模式写入 data-view 并持久化配置',
  boardNodes.board.dataset.view === '3d' && boardStorage.getItem(boardTest.CONFIG.BOARD_VIEW_KEY) === '3d');

const holeLayer = findByClass(boardNodes.board, 'board-holes');
const pieceLayer = findByClass(boardNodes.board, 'board-pieces');
const shadowLayer = findByClass(boardNodes.board, 'board-shadows');
const pieceNodes = pieceLayer.children.filter(function (node) { return hasClass(node, 'ck-piece'); });
ok('棋盘一次建成 121 个常驻孔位与 20 枚棋子节点',
  holeLayer && pieceLayer && holeLayer.children.length === 121 && pieceNodes.length === 20);
ok('孔位与棋子按归一化坐标定位，不会全部堆在棋盘角落',
  holeLayer.children.every(function (node) { return /%$/.test(node.style.left) && /%$/.test(node.style.top); }) &&
  new Set(holeLayer.children.map(function (node) { return node.style.left + ',' + node.style.top; })).size === 121 &&
  pieceNodes.every(function (node) { return /%$/.test(node.style.left) && /%$/.test(node.style.top); }));

const pieceBefore = pieceNodes.find(function (node) { return node.dataset.key === '3:-3'; });
const shadowBefore = shadowLayer.children.find(function (node) { return node.dataset.key === '3:-3'; });
pieceLayer.offsetWidth = 640;
pieceLayer.offsetHeight = 640;
pieceBefore.animate = function (frames) { this.moveFrames = frames; };
shadowBefore.animate = function (frames) { this.moveFrames = frames; };
vm.runInContext(`
  const moved = Core.applyMove(pieces, 'red', '3:-3', '4:-4');
  pieces = moved.pieces;
  lastMove = { player: 'red', from: '3:-3', target: '4:-4', kind: 'step', path: ['3:-3', '4:-4'], moveNumber: 1 };
  renderBoard();
`, boardSandbox);
ok('走子复用棋子节点而不是重建，位移动画才有意义',
  pieceNodes.length === 20 && pieceNodes.indexOf(pieceBefore) >= 0 &&
  pieceBefore.dataset.key === '4:-4' && holeLayer.children.length === 121);
ok('走子动画从原孔位开始，比例坐标直接换算为像素',
  pieceBefore.moveFrames && pieceBefore.moveFrames[0].translate === '-21.60px 36.00px 0px');
ok('移动阴影复用原节点并与棋子播放相同平面位移',
  shadowLayer.children.includes(shadowBefore) && shadowBefore.dataset.key === '4:-4' &&
  shadowBefore.moveFrames && shadowBefore.moveFrames[0].translate === '-21.60px 36.00px 0px');
ok('接触阴影独立成层，与棋子同键同步且初始不抬起',
  shadowLayer && shadowLayer.children.length === 20 &&
  pieceNodes.every(function (node) {
    return node.children.length === 1 && String(node.children[0].tagName || '').toUpperCase() === 'SVG' &&
      node.children[0].children.length > 0;
  }) &&
  shadowLayer.children.every(function (node) { return hasClass(node, 'ck-shadow') && /%$/.test(node.style.left); }) &&
  shadowLayer.children.every(function (node) { return !hasClass(node, 'is-lifted'); }));
vm.runInContext("selectedKey = '0:0'; renderBoard();", boardSandbox);
const liftedShadow = shadowLayer.children.find(function (node) { return node.dataset.key === '0:0'; });
ok('选中棋子时只有它的接触阴影缩小分离，其余保持贴地',
  liftedShadow && hasClass(liftedShadow, 'is-lifted') &&
  shadowLayer.children.filter(function (node) { return hasClass(node, 'is-lifted'); }).length === 1);
vm.runInContext("selectedKey = ''; renderBoard();", boardSandbox);

function collectAttrs(node, names) {
  const found = [];
  (function walk(current) {
    names.forEach(function (name) { const value = current.getAttribute(name); if (value) found.push(String(value)); });
    current.children.forEach(walk);
  })(node);
  return found;
}
const defNodes = pieceLayer.children.filter(function (node) { return hasClass(node, 'ck-defs'); });
const allIds = defNodes.length === 1 ? collectAttrs(defNodes[0], ['id']) : [];
const pieceSample = pieceNodes.find(function (node) { return hasClass(node, 'red-piece'); });
const pieceSvg = pieceSample ? pieceSample.children[0] : null;
ok('六色棋子渐变、暗角与裁剪滤镜全站只注入一份 defs，棋子之间不会互相串色',
  defNodes.length === 1 && allIds.length === 28 && new Set(allIds).size === allIds.length &&
  allIds.indexOf('ckclip-marble') >= 0 && allIds.indexOf('ckg-soft') >= 0);
ok('棋子内嵌 SVG 正确创建，颜色写死在渐变里而不是依赖属性中的 var()',
  pieceSvg && pieceSvg.getAttribute('viewBox') === '0 0 100 100' &&
  collectAttrs(pieceSvg, ['fill']).some(function (value) { return value.indexOf('url(#ckg-red-base)') === 0; }) &&
  collectAttrs(pieceSvg, ['fill']).some(function (value) { return value.indexOf('#a51228') === 0; }) &&
  collectAttrs(pieceSvg, ['filter']).some(function (value) { return value.indexOf('url(#ckg-soft)') === 0; }) &&
  collectAttrs(pieceSvg, ['stop-color']).every(function (value) { return value.indexOf('var(') !== 0; }) &&
  collectAttrs(pieceSvg, ['stroke']).some(function (value) { return value.indexOf('rgba(112,8,24') === 0; }) &&
  collectAttrs(pieceSvg, ['stroke']).every(function (value) { return value.indexOf('rgba(30,10,4') !== 0; }));

(readyHandlers.DOMContentLoaded || []).forEach(function (handler) { handler(); });
const firstCell = holeLayer.children[0];
ok('页面初始化走通整条渲染链路并写入无障碍标签',
  boardNodes.board.dataset.view === '3d' && holeLayer.children.length === 121 &&
  pieceNodes.length === 20 &&
  /中国跳棋棋盘/.test(boardNodes.board.getAttribute('aria-label')) &&
  /第 \d+ 行/.test(firstCell.getAttribute('aria-label')) &&
  boardNodes.turnText.textContent.length > 0 && boardNodes.redName.textContent === '你 · 红方');
ok('初始化后只有一个孔位进入 Tab 序列，配合方向键完成键盘导航',
  holeLayer.children.filter(function (node) { return node.getAttribute('tabindex') === '0'; }).length === 1);

const initial = C.createInitialPieces();
const owners = Object.values(initial);
ok('初始棋局为红蓝双方各 10 枚棋子',
  owners.length === 20 && owners.filter(v => v === 'red').length === 10 && owners.filter(v => v === 'blue').length === 10);

const opening = C.getLegalMoves(initial, '3:-3');
ok('红方前排棋子开局可以走向中央空位',
  opening.steps.includes('4:-4') && opening.steps.includes('4:-2'));
const applied = C.applyMove(initial, 'red', '3:-3', '4:-4');
ok('共用规则核心能执行合法走棋且不修改原棋盘',
  applied && applied.pieces['4:-4'] === 'red' && initial['3:-3'] === 'red');
ok('规则核心返回完整路径，供双方准确还原上一步',
  applied.kind === 'step' && applied.path.join(',') === '3:-3,4:-4');
ok('共用规则核心拒绝越权阵营和非法落点',
  C.applyMove(initial, 'blue', '3:-3', '4:-4') === null && C.applyMove(initial, 'red', '3:-3', '8:0') === null);

const chainPieces = { '8:0': 'red', '8:2': 'blue', '8:6': 'red' };
const chainMoves = C.getLegalMoves(chainPieces, '8:0');
ok('连续跳跃会一次标出全部可达落点',
  chainMoves.jumps.includes('8:4') && chainMoves.jumps.includes('8:8'));
const chainPath = C.findMovePath(chainPieces, '8:0', '8:8');
ok('连续跳跃会保留每一段经过的孔位',
  chainPath && chainPath.join(',') === '8:0,8:4,8:8');

const farPieces = { '8:0': 'red', '8:4': 'blue' };
const nearPieces = { '8:0': 'red', '8:2': 'blue' };
ok('经典相邻跳：只能越过紧邻棋子，隔空远跳与远距落点都被拒绝',
  !C.getLegalMoves(farPieces, '8:0').jumps.includes('8:8') &&
  C.getLegalMoves(nearPieces, '8:0').jumps.includes('8:4') &&
  C.applyMove(farPieces, 'red', '8:0', '8:8') === null &&
  !!C.applyMove(nearPieces, 'red', '8:0', '8:4'));

const twoSeatPieces = C.createInitialPiecesForSeats(['top', 'bottom']);
const classicPieces = C.createInitialPieces();
const seatPieces3 = C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[3]);
const seatPieces6 = C.createInitialPiecesForSeats(C.SEAT_LAYOUTS[6]);
const seatColors6 = C.seatColorsFor(C.SEAT_LAYOUTS[6]);
ok('多席位初始局面按营地铺子，2 人布局与经典红蓝完全等价',
  Object.keys(twoSeatPieces).length === 20 &&
  Object.keys(classicPieces).every(function (key) { return twoSeatPieces[key] === classicPieces[key]; }));
ok('3-6 席位各领 10 枚同色棋子，目标营地互为对面',
  Object.keys(seatPieces3).length === 30 && Object.keys(seatPieces6).length === 60 &&
  seatColors6.length === 6 && new Set(seatColors6).size === 6 &&
  C.CAMP_OPPOSITE[C.campOfColor('green')] === 'll' && C.campOfColor('orange') === 'ul' &&
  C.seatColorsFor(C.SEAT_LAYOUTS[3]).length === 3);
ok('状态净化接受 3 色棋局并保持回合与手数有效',
  (function () {
    const state = C.sanitizeState({ pieces: seatPieces3, turn: 'yellow', moveNumber: 5, winner: '' });
    return !!state && state.turn === 'yellow' && state.moveNumber === 5;
  })());

const aiMove = C.chooseAiMove(initial, 'blue', 'hard', () => 0);
ok('电脑可以从初始棋局选择一条合法蓝方走法',
  aiMove && C.getLegalMoves(initial, aiMove.from).all.includes(aiMove.target) && initial[aiMove.from] === 'blue');
const aiApplied = C.applyMove(initial, 'blue', aiMove.from, aiMove.target);
ok('困难电脑使用受预算保护的 DFS 搜索并优先改善局面',
  /function dfsSearch/.test(coreSource) && /maxNodes/.test(coreSource) && /tailProgress/.test(coreSource) && /axisOffset/.test(coreSource) && aiApplied &&
  C.evaluatePosition(aiApplied.pieces, 'blue') > C.evaluatePosition(initial, 'blue'));
const workerReplies = [];
const workerSandbox = {
  console, Math, JSON, Number, String, Array, Object, Set, Map, Error,
  CheckersCore: C, CheckersAiModel: M,
  importScripts() {}, postMessage(message) { workerReplies.push(message); }
};
workerSandbox.self = workerSandbox;
vm.createContext(workerSandbox);
vm.runInContext(workerSource, workerSandbox, { filename: 'checkers_ai_worker.js' });
workerSandbox.onmessage({ data: { requestId: 17, pieces: initial, player: 'blue', level: 'hard', recentPositions: [] } });
const workerMove = workerReplies[0] && workerReplies[0].move;
ok('Worker 消息协议能返回与请求匹配的合法困难走法',
  workerReplies[0] && workerReplies[0].requestId === 17 && !workerReplies[0].error && workerMove &&
  initial[workerMove.from] === 'blue' && C.getLegalMoves(initial, workerMove.from).all.includes(workerMove.target));
ok('本地训练模型的输入维度、权重形状和特征版本与规则核心一致',
  M && M.featureVersion === C.VALUE_FEATURE_VERSION && C.extractValueFeatures(initial, 'red').length === M.inputSize &&
  M.weights.input.length === M.inputSize * M.hiddenSize && M.training.games === 96);
const learnedValue = C.predictValueModel(aiApplied.pieces, 'blue', M);
ok('轻量价值网络可以直接在浏览器规则核心中推理',
  Number.isFinite(learnedValue) && learnedValue >= -1 && learnedValue <= 1 &&
  C.evaluateHybridPosition(aiApplied.pieces, 'blue', M) !== C.evaluatePosition(aiApplied.pieces, 'blue'));
const learnedMove = C.chooseAiMove(initial, 'blue', 'hard', () => 0, { model: M });
const learnedResult = C.applyMove(initial, 'blue', learnedMove.from, learnedMove.target);
const antiRepeatMove = C.chooseAiMove(initial, 'blue', 'hard', () => 0, {
  model: M, recentPositions: [C.positionKey(learnedResult.pieces)]
});
ok('困难电脑混合 DFS 与价值模型，并避开近期已经出现的局面',
  learnedMove && antiRepeatMove && (learnedMove.from !== antiRepeatMove.from || learnedMove.target !== antiRepeatMove.target));
const finishState = {};
C.BOTTOM_CAMP.filter(key => key !== '14:0').forEach(key => { finishState[key] = 'red'; });
finishState['12:2'] = 'red';
C.TOP_CAMP.forEach(key => { finishState[key] = 'blue'; });
const finishMove = C.chooseAiMove(finishState, 'red', 'hard', () => 0, { model: M });
const finishResult = C.applyMove(finishState, 'red', finishMove.from, finishMove.target);
ok('搜索会在分配节点预算前发现直接获胜走法，不再在 9/10 时搬动营内棋子',
  finishMove.from === '12:2' && finishMove.target === '14:0' && finishResult && finishResult.winner === 'red');

const ttSideKey = C.transpositionKey(initial, 'red', 'red', 'test-evaluator');
ok('TT key 同时隔离行动方、评估视角与 evaluator 版本',
  ttSideKey !== C.transpositionKey(initial, 'blue', 'red', 'test-evaluator') &&
  ttSideKey !== C.transpositionKey(initial, 'red', 'blue', 'test-evaluator') &&
  ttSideKey !== C.transpositionKey(initial, 'red', 'red', 'other-evaluator'));
const completeWithoutTt = C.analyzeAiMoves(initial, 'red', 'hard', { maxNodes: 100000 });
const completeWithTt = C.analyzeAiMoves(initial, 'red', 'hard', {
  maxNodes: 100000, enableTranspositionTable: true
});
const withoutTtScores = new Map(completeWithoutTt.candidates.map(function (candidate) {
  return [candidate.action.from + '>' + candidate.action.target, candidate.baseDfsScore];
}));
ok('完整 depth-3 搜索启用 TT 前后保持每个根候选分数与最终走法一致',
  completeWithoutTt.searchComplete && completeWithTt.searchComplete &&
  completeWithTt.candidates.every(function (candidate) {
    return withoutTtScores.get(candidate.action.from + '>' + candidate.action.target) === candidate.baseDfsScore;
  }) && completeWithTt.totalNodes <= completeWithoutTt.totalNodes);
const boundedWithTt = C.analyzeAiMoves(initial, 'red', 'hard', {
  candidateNodeBudget: 2, enableTranspositionTable: true
});
ok('节点预算截断的根结果不会伪装成 EXACT 或写成完整搜索',
  !boundedWithTt.searchComplete && boundedWithTt.budgetCutoffs > 0 &&
  boundedWithTt.candidates.some(function (candidate) {
    return !candidate.searchComplete && candidate.boundType === null;
  }));

const validState = C.sanitizeState({ pieces: initial, turn: 'blue', moveNumber: 12, winner: '' });
ok('合法棋局状态可恢复且保留回合信息', validState && validState.turn === 'blue' && validState.moveNumber === 12);
const stateWithMove = C.sanitizeState({ pieces: applied.pieces, turn: 'blue', moveNumber: 2, winner: '', lastMove: {
  player: 'red', from: '3:-3', target: '4:-4', kind: 'step', path: ['3:-3', '4:-4'], moveNumber: 1
} });
ok('上一步来源、落点和路线会随棋局状态安全恢复',
  stateWithMove && stateWithMove.lastMove && stateWithMove.lastMove.path.length === 2);
ok('棋子数量不完整或位置越界的状态会被拒绝',
  C.sanitizeState({ pieces: { '99:99': 'red' }, turn: 'red' }) === null);

ok('大厅提供人机、本地多人、联机三种入口且不再混放棋盘',
  /id="startAiBtn"/.test(lobbyHtml) && /id="startLocalBtn"/.test(lobbyHtml) &&
  /id="createRoomBtn"/.test(lobbyHtml) && !/id="checkerBoard"/.test(lobbyHtml));
ok('本地对战支持 2-6 人选择与 0-4 电脑补位',
  /data-players="6"/.test(lobbyHtml) && /data-ai="4"/.test(lobbyHtml) &&
  /id="localSeatHint"/.test(lobbyHtml) &&
  /SEAT_LAYOUTS\[playerCount\]/.test(source) && /chooseSeatMove/.test(source) &&
  /ensurePlayerRows\(\)/.test(source) && /seatsFromSave/.test(source));
ok('联机建房可选 0-4 个电脑并自选强度，好友加入即开局',
  /data-bots="4"/.test(lobbyHtml) && /data-bot-level="hard"/.test(lobbyHtml) &&
  /id="onlineBotHint"/.test(lobbyHtml) &&
  /selectOnlineBots/.test(lobbySource) && /params\.bots = onlineBots/.test(lobbySource) &&
  /BOT_LEVEL_KEY/.test(lobbySource));
ok('联机建房把电脑个数与强度带到 join 消息，房间席位由服务器广播',
  /payload\.bots = online\.bots/.test(source) && /launchParams\.get\('bots'\)/.test(source) &&
  /message\.seats/.test(source) && /seats = online\.seats\.map/.test(source) &&
  /function onlinePlayer\(color\) \{ return online\.seats\.find/.test(source) &&
  /online\.seats\.every\(function \(seat\) \{ return seat\.isBot \|\| seat\.online; \}\)/.test(source));
ok('服务器按 2 真人 + N 电脑规划席位，真人固定红蓝对家',
  (function () {
    const planMatch = serverSource.match(/function planCheckersSeats[\s\S]*?\n\}/);
    if (!planMatch) return false;
    const planFn = vm.runInNewContext('(' + planMatch[0] + ')', { CheckersCore: C, Math: Math });
    for (let bots = 0; bots <= 4; bots++) {
      const planned = planFn(bots);
      if (planned.length !== 2 + bots) return false;
      if (planned[0].isBot || planned[0].color !== 'red') return false;
      const humans = planned.filter(function (seat) { return !seat.isBot; });
      if (humans.length !== 2) return false;
      if (bots !== 1 && humans[1].color !== 'blue') return false;
    }
    return planFn(1).every(function (seat) {
      return !seat.isBot || (seat.color !== 'red' && seat.color !== 'blue');
    });
  })());
ok('服务器托管电脑走子：join 解析 bots/level，落子与真人共用校验链并按席位轮转',
  /createCheckersRoom\(code, clientIp, botCount, /.test(serverSource) &&
  /Number\(m\.bots\)/.test(serverSource) &&
  /function nextCheckersTurn/.test(serverSource) &&
  /function scheduleCheckersBotMove/.test(serverSource) &&
  /function runCheckersBotMove/.test(serverSource) &&
  /CheckersCore\.chooseAiMove\(room\.pieces, seat\.color, room\.botLevel/.test(serverSource) &&
  /clearCheckersBotTimer\(room\)/.test(serverSource));
ok('对称长跳已整体移除：服务器、客户端与 Worker 均无规则开关残留',
  !/symmetricJump/.test(serverSource) && !/applyCheckersRules/.test(serverSource) &&
  !/setRules|getRules/.test(source) && !/ruleSymJump/.test(playHtml) &&
  !/对称长跳/.test(playHtml) && !/symmetricJump/.test(workerSource) &&
  !/setRules/.test(workerSource));
ok('大厅不再有跳跃规则开关，页面版本号随本次更新递增',
  !/data-jump/.test(lobbyHtml) && !/selectJump/.test(lobbySource) &&
  !/JUMP_KEY/.test(lobbySource) &&
  /checkers_core\.js\?v=20260906c/.test(playHtml) &&
  /checkers\.js\?v=20260908a/.test(playHtml) &&
  /checkers\.css\?v=20260906k/.test(playHtml) &&
  /checkers\.css\?v=20260906k/.test(lobbyHtml) &&
  /lobby\.js\?v=20260906l/.test(lobbyHtml));
ok('联机状态广播携带席位列表，电脑席位由服务端直发',
  /seats: checkersSeatList\(room\)/.test(serverSource) &&
  /nick: seat\.isBot \? '电脑'/.test(serverSource) &&
  /online: seat\.isBot \? true/.test(serverSource) &&
  /scheduleCheckersBotMove\(room\);\n\}/.test(serverSource.replace(/\r\n/g, '\n')));
ok('AI 训练实验室保持为未展示的开发工具而不进入玩家大厅',
  !/href="lab\.html"/.test(lobbyHtml) && /id="labBoard"/.test(labHtml) &&
  /\/ai-lab\/live/.test(labSource) && /setInterval\(pollLiveTraining, 800\)/.test(labSource) &&
  Array.isArray(labRun.replays) && labRun.replays.length >= 4 &&
  labRun.numericalBackend && labRun.numpyArena && labRun.v11 && labRun.v11.split.overlap === false);
ok('游戏页只承载棋局，并先加载规则核心再加载交互脚本',
  /id="board"/.test(playHtml) && !/id="createRoomBtn"/.test(playHtml) &&
  playHtml.indexOf('checkers_core.js') >= 0 && playHtml.indexOf('checkers_core.js') < playHtml.indexOf('checkers_ai_model.js') &&
  playHtml.indexOf('checkers_ai_model.js') < playHtml.indexOf('checkers.js'));
ok('困难模式向搜索传入训练模型和近期局面',
  /aiLevel === 'hard'/.test(source) && /CheckersAiModel/.test(source) && /recentPositions/.test(source));
ok('大厅仅展示通过稳定性验证的三档难度',
  !/data-level="expert"/.test(lobbyHtml) && /difficulty-picker\{[^}]*grid-template-columns:repeat\(3,1fr\)/.test(css));
ok('困难搜索在独立 Worker 中执行，失败时仍有同步规则核心回退',
  /new window\.Worker\('checkers_ai_worker\.js'\)/.test(source) && /const fallback = function/.test(source) &&
  /importScripts\('checkers_core\.js', 'checkers_ai_model\.js'\)/.test(workerSource) &&
  /Core\.chooseAiMove/.test(workerSource) && /cancelAiSearch\(\)/.test(source));
ok('游戏页提供上一步说明，棋盘能绘制来源、落点和完整路线',
  /id="lastMoveBar"/.test(playHtml) && /last-move-path/.test(source) &&
  /move-origin/.test(source) && /move-destination/.test(source));
ok('相邻落点与跳跃落点使用不同提示，不再共用简陋圆点',
  /step-target/.test(css) && /jump-target/.test(css) && /step-dot/.test(playHtml) && /jump-dot/.test(playHtml));
ok('手机布局保持单列与正方形棋盘', /@media\s*\(max-width:\s*820px\)/.test(css) && /aspect-ratio:\s*1(?:\s*\/\s*1)?/.test(css));
ok('六色目标营地与多席位面板样式就位',
  /\.green-goal-zone/.test(css) && /\.yellow-goal-zone/.test(css) &&
  /\.purple-goal-zone/.test(css) && /\.orange-goal-zone/.test(css) &&
  /\.players-card\.multi/.test(css) && /\.difficulty-picker button:disabled/.test(css) &&
  /\.field-note\{/.test(css));
ok('邀请链接和联机地址使用跳棋专属入口',
  /new URL\('index\.html'/.test(source) && /searchParams\.set\('room'/.test(source) &&
  T.websocketUrl() === 'wss://game.test/checkers-ws');
const reconnectDelays = [1, 2, 4, 12].map(function (attempt) { return T.reconnectDelayForAttempt(attempt, .5); });
ok('断线重连使用有上限的指数退避，而不是固定频率重试',
  reconnectDelays[0] === 800 && reconnectDelays[1] === 1360 &&
  reconnectDelays[2] > reconnectDelays[1] && reconnectDelays[3] === 10000);
ok('游戏平台卡片已展示人机与好友对战能力',
  /href="checkers\/index\.html"/.test(platformHtml) && /人机对战/.test(platformHtml) && /好友对战/.test(platformHtml));
ok('服务器加载同一规则核心并提供权威跳棋 WebSocket',
  /require\('\.\/public\/checkers\/checkers_core'\)/.test(serverSource) &&
  /pathname === '\/checkers-ws'/.test(serverSource) &&
  /CheckersCore\.applyMove\(room\.pieces/.test(serverSource));
ok('服务器限制单一来源建房并为未匹配房间设置不可续期寿命',
  /MAX_ROOMS_PER_IP/.test(serverSource) && /countRoomsForIp\(clientIp\)/.test(serverSource) &&
  /now - room\.createdAt > UNMATCHED_ROOM_TTL_MS/.test(serverSource));
ok('服务器为无尾斜杠跳棋地址提供稳定重定向', /'\/checkers': '\/checkers\/'/.test(serverSource));

const freshSeatCounts = vm.runInContext(`
  [2, 3, 4, 5, 6].map(function (count) {
    seats = Core.seatColorsFor(Core.SEAT_LAYOUTS[count]).map(function (color) {
      return { color: color, isAI: false };
    });
    resetState();
    return Object.keys(pieces).length;
  });
`, boardSandbox);
ok('全新二至六人棋局按席位营地各放置十枚棋子',
  JSON.stringify(freshSeatCounts) === '[20,30,40,50,60]');

console.log('\n✅ 中国跳棋核心测试全部通过（' + passed + ' 项）');
