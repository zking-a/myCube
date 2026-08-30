'use strict';

/*
 * 五子棋联机前端端到端测试。
 *
 * 用最小 DOM 桩在 Node 里加载真实的 gomoku_core.js / gomoku_net.js / gomoku.js，
 * 连接真实服务端，模拟两个玩家各点两次棋盘（预览 + 确认）完成落子。
 * 目的是覆盖联机接入层的渲染与回合同步，补上纯服务端测试看不到的部分。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const rootDir = path.join(__dirname, '..');

const PORT = 34600 + Math.floor(Math.random() * 300);
const HTTP_URL = 'http://127.0.0.1:' + PORT;
const child = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), MAX_ROOMS: '4', MAX_ROOMS_PER_IP: '2',
    MAX_CONNECTIONS: '8', MAX_CONNECTIONS_PER_IP: '8', MAX_SOCKET_CONNECTIONS_PER_IP: '10'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let childLog = '';
child.stdout.on('data', function (chunk) { childLog += chunk.toString(); });
child.stderr.on('data', function (chunk) { childLog += chunk.toString(); });

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(HTTP_URL + '/health');
      if (response.ok) return;
    } catch (e) {}
    await wait(80);
  }
  throw new Error('服务器启动超时\n' + childLog);
}

async function waitUntil(label, predicate, timeout, diagnose) {
  const deadline = Date.now() + (timeout || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(40);
  }
  let extra = '';
  if (typeof diagnose === 'function') {
    try { extra = '\n  诊断：' + diagnose(); } catch (error) { extra = '\n  诊断失败：' + error.message; }
  }
  throw new Error('等待超时：' + label + extra);
}

const ELEMENT_IDS = [
  'gameTitle', 'modeBadge', 'netBadge', 'turnText', 'turnSub', 'moveText',
  'boardWrap', 'gomokuBoard', 'boardAssist', 'hintText',
  'blackRow', 'whiteRow', 'blackName', 'blackSub', 'blackCount',
  'whiteName', 'whiteSub', 'whiteCount',
  'roomPanel', 'roomCode', 'roomPlayers', 'leaveRoomBtn', 'copyInviteBtn',
  'undoBtn', 'resetBtn', 'resultOverlay', 'resultTitle', 'resultText', 'resultRestart'
];

function createElement(tag) {
  const classes = new Set();
  const el = {
    tagName: tag,
    children: [],
    textContent: '',
    innerHTML: '',
    className: '',
    hidden: false,
    disabled: false,
    tabIndex: -1,
    type: '',
    dataset: {},
    firstElementChild: null,
    style: { display: '', setProperty: function () {} },
    _listeners: {},
    classList: {
      add: function () { Array.prototype.forEach.call(arguments, function (c) { classes.add(c); }); },
      remove: function () { Array.prototype.forEach.call(arguments, function (c) { classes.delete(c); }); },
      contains: function (c) { return classes.has(c); },
      toggle: function (c, on) {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      }
    },
    appendChild: function (node) {
      el.children.push(node);
      if (!el.firstElementChild) el.firstElementChild = node;
      return node;
    },
    setAttribute: function (key, value) {
      el['attr:' + key] = String(value);
      if (String(key).indexOf('data-') === 0) {
        const camel = String(key).slice(5).replace(/-([a-z])/g, function (m, letter) { return letter.toUpperCase(); });
        el.dataset[camel] = String(value);
      }
    },
    getAttribute: function (key) { return el['attr:' + key] === undefined ? null : el['attr:' + key]; },
    addEventListener: function (type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    focus: function () {},
    remove: function () {},
    dispatch: function (type, event) {
      (el._listeners[type] || []).forEach(function (fn) { fn(event); });
    }
  };
  return el;
}

function createStorage(seed) {
  const data = Object.assign({}, seed || {});
  return {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem: function (key, value) { data[key] = String(value); },
    removeItem: function (key) { delete data[key]; }
  };
}

function createPlayer(options) {
  const byId = new Map();
  ELEMENT_IDS.forEach(function (id) { byId.set(id, createElement('div')); });
  const caption = createElement('p');
  const domReady = [];
  const unload = [];

  const document = {
    body: createElement('body'),
    getElementById: function (id) { return byId.get(id) || null; },
    createElement: createElement,
    querySelector: function (selector) { return selector === '.status-caption' ? caption : null; },
    addEventListener: function () {}
  };
  const parsed = new URL(options.url);
  const win = {
    location: {
      href: options.url,
      search: parsed.search,
      protocol: parsed.protocol,
      host: parsed.host,
      hostname: parsed.hostname,
      port: parsed.port,
      origin: parsed.origin,
      pathname: parsed.pathname
    },
    addEventListener: function (type, fn) {
      if (type === 'DOMContentLoaded') domReady.push(fn);
      if (type === 'beforeunload') unload.push(fn);
    },
    removeEventListener: function () {}
  };

  // 包装一层只为在失败时能看到真实的连接地址与关闭码。
  function DebugWebSocket(url) {
    const socket = new WebSocket(url);
    socket.addEventListener('open', function () { if (process.env.GOMOKU_UI_DEBUG) console.error('  [ws] open ' + url); });
    socket.addEventListener('error', function (event) {
      if (process.env.GOMOKU_UI_DEBUG) console.error('  [ws] error ' + url + ' :: ' + ((event && event.message) || 'unknown'));
    });
    socket.addEventListener('close', function (code) {
      if (process.env.GOMOKU_UI_DEBUG) console.error('  [ws] close ' + url + ' :: ' + code);
    });
    return socket;
  }
  DebugWebSocket.OPEN = WebSocket.OPEN;
  DebugWebSocket.CONNECTING = WebSocket.CONNECTING;
  DebugWebSocket.CLOSING = WebSocket.CLOSING;
  DebugWebSocket.CLOSED = WebSocket.CLOSED;

  const sandbox = {
    document: document,
    window: win,
    location: win.location,
    localStorage: createStorage(options.storage || {}),
    WebSocket: DebugWebSocket,
    navigator: {},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    URLSearchParams: URLSearchParams
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  ['gomoku_core.js', 'gomoku_net.js', 'gomoku.js'].forEach(function (file) {
    const code = fs.readFileSync(path.join(rootDir, 'public', 'gomoku', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  });

  domReady.forEach(function (fn) { fn(); });

  return {
    sandbox: sandbox,
    byId: byId,
    caption: caption,
    board: byId.get('gomokuBoard'),
    cell: function (r, c) {
      const row = this.board.children[r];
      return row ? row.children[c] : null;
    },
    click: function (r, c) {
      const target = this.cell(r, c);
      if (!target) throw new Error('棋盘上没有这个位置：' + r + ',' + c);
      target.dispatch('click', { currentTarget: target, preventDefault: function () {} });
    },
    dispose: function () {
      unload.forEach(function (fn) { try { fn(); } catch (error) {} });
    }
  };
}

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

(async function () {
  let A, B;
  try {
    await waitForServer();
    const base = HTTP_URL + '/gomoku/play.html';
    A = createPlayer({
      url: base + '?mode=online&intent=create&room=ABCDE',
      storage: { light_games_nickname: '甲' }
    });
    B = createPlayer({
      url: base + '?mode=online&intent=join&room=ABCDE',
      storage: { light_games_nickname: '乙' }
    });

    const dumpA = function () {
      return 'netBadge=' + A.byId.get('netBadge').textContent +
        ' | hint=' + A.byId.get('hintText').textContent +
        ' | GomokuNet=' + (typeof A.sandbox.GomokuNet) +
        ' | GomokuCore=' + (typeof A.sandbox.GomokuCore) +
        ' | test hook=' + (typeof A.sandbox.window.__gomokuTest);
    };
    await waitUntil('A 建立联机连接', function () { return A.byId.get('netBadge').textContent === '已连接'; }, 5000, dumpA);
    await waitUntil('B 建立联机连接', function () { return B.byId.get('netBadge').textContent === '已连接'; });
    ok('两位玩家都完成联机握手', true);

    await waitUntil('房间面板显示房间码', function () {
      return A.byId.get('roomCode').textContent === 'ABCDE' && A.byId.get('roomPanel').hidden === false;
    });
    const roster = A.byId.get('roomPlayers').textContent;
    ok('联机面板展示房间码并列出双方', roster.indexOf('黑方 甲') >= 0 && roster.indexOf('白方 乙') >= 0);
    ok('模式徽标切换为好友联机', A.byId.get('modeBadge').textContent === '好友联机');
    ok('联机模式隐藏本地悔棋与重开',
      A.byId.get('undoBtn').hidden === true && A.byId.get('resetBtn').hidden === true);

    await waitUntil('A 拿到黑方先手', function () { return A.byId.get('blackName').textContent === '甲'; });
    ok('服务端昵称回填到黑白双方', B.byId.get('blackName').textContent === '甲' && B.byId.get('whiteName').textContent === '乙');

    A.click(7, 7);
    ok('首次点击只显示预览不落子', A.cell(7, 7).classList.contains('is-preview'));
    A.click(7, 7);
    await waitUntil('A 的落子被服务端确认', function () { return A.cell(7, 7).classList.contains('is-black'); });
    await waitUntil('B 同步到 A 的落子', function () { return B.cell(7, 7).classList.contains('is-black'); });
    ok('黑方落子经服务端确认后渲染到双方棋盘', true);
    ok('子数统计由服务端盘面同步', A.byId.get('blackCount').textContent === '1');

    A.click(1, 1);
    ok('非本人回合的落子被本地拦截', A.byId.get('hintText').textContent === '对手回合，请等待对方落子');

    B.click(0, 0);
    B.click(0, 0);
    await waitUntil('B 的落子被服务端确认', function () { return B.cell(0, 0).classList.contains('is-white'); });
    await waitUntil('A 同步到 B 的落子', function () { return A.cell(0, 0).classList.contains('is-white'); });
    ok('白方落子同样双向同步并渲染', A.byId.get('whiteCount').textContent === '1');
    ok('轮次提示交还给黑方', A.byId.get('hintText').textContent === '轮到你落子');

    console.log('\n✅ 五子棋联机前端端到端测试全部通过（' + passed + ' 项）');
  } finally {
    if (A) A.dispose();
    if (B) B.dispose();
    child.kill('SIGTERM');
  }
})().catch(function (error) {
  console.error(error.stack || error);
  if (childLog) console.error(childLog);
  process.exitCode = 1;
});
