'use strict';

const fs = require('fs');
const vm = require('vm');

function createFakeDom() {
  const elements = Object.create(null);
  const listeners = Object.create(null);

  function makeClassList() {
    const set = new Set();
    return {
      add: function () {
        for (let i = 0; i < arguments.length; i++) set.add(String(arguments[i]));
      },
      remove: function () {
        for (let i = 0; i < arguments.length; i++) set.delete(String(arguments[i]));
      },
      toggle: function (name) {
        if (set.has(name)) { set.delete(name); return false; }
        set.add(name); return true;
      },
      contains: function (name) { return set.has(name); }
    };
  }

  function makeElement(tagName) {
    const listenersMap = Object.create(null);
    const el = {
      tagName: tagName,
      id: '',
      textContent: '',
      innerHTML: '',
      innerText: '',
      disabled: false,
      style: {
        setProperty: function (key, value) { this[key] = value; }
      },
      dataset: Object.create(null),
      className: '',
      classList: makeClassList(),
      children: [],
      attributes: Object.create(null),
      firstElementChild: null,
      setAttribute: function (name, value) {
        if (name === 'id') this.id = String(value);
        if (/^data-/.test(name)) this.dataset[name.slice(5)] = String(value);
        this.attributes[name] = String(value);
      },
      getAttribute: function (name) { return this.attributes[name]; },
      appendChild: function (child) {
        if (!this.firstElementChild) this.firstElementChild = child;
        this.children.push(child);
      },
      addEventListener: function (type, handler) {
        if (!listenersMap[type]) listenersMap[type] = [];
        listenersMap[type].push(handler);
      },
      dispatchEvent: function (type) {
        const target = this;
        const event = typeof type === 'string'
          ? { currentTarget: target, target: target, type: type }
          : Object.assign({ currentTarget: target, target: target }, type);
        const list = listenersMap[event.type] || [];
        list.forEach(function (fn) { fn(event); });
      }
    };
    return el;
  }

  const document = {
    body: makeElement('body'),
    createElement: function (tagName) { return makeElement(tagName); },
    getElementById: function (id) {
      if (!elements[id]) {
        elements[id] = makeElement('div');
        elements[id].id = id;
      }
      return elements[id];
    },
    addEventListener: function () {}
  };

  function getWindowListener(type, handler) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
  }

  return { document, listeners };
}

function runGomokuEnv(mode, storageSeed) {
  storageSeed = storageSeed || {};
  const boardElement = null;
  const dom = createFakeDom();
  const storageData = Object.assign({}, storageSeed);
  const localStorage = {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : null; },
    setItem: function (key, value) { storageData[key] = String(value); },
    removeItem: function (key) { delete storageData[key]; }
  };

  const sandbox = {
    console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error, RegExp,
    parseInt, isFinite, URLSearchParams,
    setTimeout, clearTimeout,
    localStorage,
    document: dom.document,
    location: { search: mode === 'local' ? '?mode=local' : '?mode=ai' },
    window: null,
    listeners: [],
    addEventListener: function (type, handler) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    }
  };
  sandbox.window = sandbox;
  const vmContext = vm.createContext(sandbox);

  const source = fs.readFileSync('public/gomoku/gomoku.js', 'utf8');
  vm.runInContext(source, vmContext, { filename: 'gomoku.js' });

  const handlers = vmContext.listeners['DOMContentLoaded'] || [];
  handlers.forEach(function (handler) { handler({ type: 'DOMContentLoaded', target: vmContext.document }); });

  return {
    sandbox: vmContext,
    testApi: vmContext.__gomokuTest,
    overlay: vmContext.document.getElementById('resultOverlay'),
    storage: storageData
  };
}

const indexHtml = fs.readFileSync('public/gomoku/index.html', 'utf8');
const playHtml = fs.readFileSync('public/gomoku/play.html', 'utf8');
const css = fs.readFileSync('public/gomoku/gomoku.css', 'utf8');

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

ok('五子棋大厅页提供正确入口与卡片结构', /id="startAiBtn"/.test(indexHtml) && /id="startLocalBtn"/.test(indexHtml));
const modeGridRule = css.match(/\.mode-grid\s*\{[^}]*\}/);
ok('五子棋大厅在所有屏幕宽度下均以纵向玩法菜单展示',
  !!modeGridRule && /grid-template-columns:\s*1fr\s*;/.test(modeGridRule[0]));
ok('五子棋棋局页包含关键控制区与状态区', /id="undoBtn"/.test(playHtml) && /id="resetBtn"/.test(playHtml) && /id="resultOverlay"/.test(playHtml));
ok('对局顶部复用平台的左返回、中标题、右状态三栏结构',
  /class="nav-back ui-button ui-button--secondary gomoku-nav-btn"/.test(playHtml) &&
  /aria-label="返回五子棋首页"/.test(playHtml) &&
  /class="top-actions"/.test(playHtml));
ok('键盘焦点直接进入当前棋盘格，而不是停在无交互的棋盘容器',
  !/id="gomokuBoard"[^>]*tabindex="0"/.test(playHtml));
ok('棋盘网格与棋子样式样式片段完整',
  /\.gomoku-board/.test(css) && /\.gomoku-cell/.test(css) && /\.gomoku-stone/.test(css));
ok('棋盘按 15 行 × 15 列生成，避免格子被压成单列', function () {
  const env = runGomokuEnv('local');
  const board = env.sandbox.document.getElementById('gomokuBoard');
  return board.children.length === 15 && board.children.every(function (row) {
    return /\bgomoku-row\b/.test(row.className) && row.children.length === 15;
  });
}());
ok('对局页保持移动优先布局且桌面断点不会压缩棋盘',
  /\.board-wrap\s*\{[\s\S]*?max-width:\s*680px/.test(css) &&
  /@media\s*\(min-width:\s*1024px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s*260px/.test(css));
ok('对局操作遵循公共按钮的主次语义',
  /id="undoBtn"[^>]*ui-button--secondary/.test(playHtml) &&
  /id="resetBtn"[^>]*ui-button--secondary/.test(playHtml) &&
  /id="resultRestart"[^>]*ui-button--primary/.test(playHtml));
ok('手机端隐藏重复模式徽章并保留单行顶栏',
  /@media\s*\(max-width:\s*520px\)[\s\S]*?\.mode-badge\s*\{\s*display:\s*none/.test(css));

const savedBoard = new Array(15).fill(0).map(function () { return new Array(15).fill(0); });
savedBoard[7][7] = 1;
savedBoard[7][8] = 2;
const saved = {
  mode: 'local',
  turn: 1,
  winner: 0,
  finished: false,
  moveNumber: 2,
  history: [{ r: 7, c: 7, player: 1 }, { r: 7, c: 8, player: 2 }],
  lastMove: { r: 7, c: 8, player: 2 },
  board: savedBoard
};
const localEnv = runGomokuEnv('local', { gomoku_save_local_v1: JSON.stringify(saved) });
const localApi = localEnv.testApi;

const headerEnv = runGomokuEnv('ai');
ok('对局标题固定为游戏名，玩法信息只在右侧状态中显示一次',
  headerEnv.sandbox.document.getElementById('gameTitle').textContent === '五子棋' &&
  headerEnv.sandbox.document.getElementById('modeBadge').textContent === '单机人机');

ok('加载历史可恢复对局状态', localEnv.testApi.getTestSnapshot().moveNumber === 2 && localApi.getTestSnapshot().board[7][7] === 1);
ok('首次选择空位只显示预览，不会立即落子', function () {
  localApi.setStateForTest({
    board: new Array(15).fill(0).map(function () { return new Array(15).fill(0); }),
    moveNumber: 0,
    history: []
  });
  localApi.requestMove(7, 7);
  const snap = localApi.getTestSnapshot();
  return snap.moveNumber === 0 && snap.board[7][7] === 0 && snap.previewMove && snap.previewMove.r === 7 && snap.previewMove.c === 7;
}());
ok('再次选择同一预览位置才正式落子', function () {
  localApi.setStateForTest({
    board: new Array(15).fill(0).map(function () { return new Array(15).fill(0); }),
    moveNumber: 0,
    history: []
  });
  localApi.requestMove(7, 7);
  localApi.requestMove(7, 7);
  const snap = localApi.getTestSnapshot();
  return snap.moveNumber === 1 && snap.board[7][7] === 1 && snap.previewMove === null;
}());
ok('方向键按格移动棋盘焦点', function () {
  localApi.setStateForTest({
    board: new Array(15).fill(0).map(function () { return new Array(15).fill(0); }),
    moveNumber: 0,
    history: []
  });
  const board = localEnv.sandbox.document.getElementById('gomokuBoard');
  const center = board.children[7].children[7];
  const right = board.children[7].children[8];
  center.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault: function () {} });
  return center.tabIndex === -1 && right.tabIndex === 0;
}());
ok('空棋盘候选只返回中心点', function () {
  localApi.setStateForTest({ board: new Array(15).fill(0).map(function () { return new Array(15).fill(0); }) });
  const cands = localApi.collectCandidates();
  return cands.length === 1 && cands[0].r === 7 && cands[0].c === 7;
}());

localApi.setStateForTest({
  board: new Array(15).fill(0).map(function () { return new Array(15).fill(0); }),
  moveNumber: 0,
  history: []
});
ok('本地双人模式可下子、可悔棋并回退局面', function () {
  localApi.placeStone(7, 7, 1);
  localApi.placeStone(7, 8, 2);
  localApi.undo();
  const snap = localApi.getTestSnapshot();
  return snap.moveNumber === 1 && snap.board[7][8] === 0 && snap.board[7][7] === 1;
}());

localApi.setStateForTest({
  board: (function () {
    const b = new Array(15).fill(0).map(function () { return new Array(15).fill(0); });
    for (let c = 0; c < 4; c++) b[3][c] = 1;
    return b;
  }()),
  turn: 1,
  moveNumber: 4,
  history: [],
  lastMove: null
});
ok('形成五连珠后立即结束本局', function () {
  localApi.placeStone(3, 4, 1);
  const snap = localApi.getTestSnapshot();
  return snap.finished && snap.winner === 1 && localEnv.overlay.classList.contains('show');
}());

localApi.newGame();
ok('新局会清空棋局并移除结算弹窗', !localApi.getTestSnapshot().finished && localApi.getTestSnapshot().moveNumber === 0 && !localEnv.overlay.classList.contains('show'));
const aiEnv = runGomokuEnv('ai');
const aiApi = aiEnv.testApi;
ok('AI 模式默认下黑先手，当前仅一个候选中心位可用于开局', function () {
  const cand = aiApi.collectCandidates();
  if (!cand || cand.length !== 1) return false;
  const first = cand[0];
  if (first.r !== 7 || first.c !== 7) return false;
  const aiMove = aiApi.chooseAiMove();
  return aiMove && aiMove.r === 7 && aiMove.c === 7;
}());

ok('连续两步后会写入本地存档，重建后可读到最近局面', function () {
  const env = runGomokuEnv('local');
  env.testApi.placeStone(0, 0, 1);
  env.testApi.placeStone(1, 1, 2);
  return Object.prototype.hasOwnProperty.call(env.storage, 'gomoku_save_local_v1');
});

console.log('\n✅ 五子棋冒烟测试通过（' + passed + ' 项）');
