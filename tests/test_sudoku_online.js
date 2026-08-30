'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const rootDir = path.join(__dirname, '..');

const PORT = 33600 + Math.floor(Math.random() * 400);
const HTTP_URL = 'http://127.0.0.1:' + PORT;
const WS_URL = 'ws://127.0.0.1:' + PORT + '/sudoku-ws';
const child = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), MAX_ROOMS: '4', MAX_ROOMS_PER_IP: '1',
    MAX_CONNECTIONS: '8', MAX_CONNECTIONS_PER_IP: '8', MAX_SOCKET_CONNECTIONS_PER_IP: '10'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let childLog = '';
child.stdout.on('data', chunk => { childLog += chunk.toString(); });
child.stderr.on('data', chunk => { childLog += chunk.toString(); });

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(HTTP_URL + '/health')).ok) return; } catch (e) {}
    await wait(80);
  }
  throw new Error('服务器启动超时\n' + childLog);
}

function client() {
  const ws = new WebSocket(WS_URL);
  const handlers = [], queued = [];
  ws.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch (e) { return; }
    const index = handlers.findIndex(handler => handler.predicate(message));
    if (index >= 0) {
      const handler = handlers.splice(index, 1)[0];
      clearTimeout(handler.timer);
      handler.resolve(message);
    } else queued.push(message);
  });
  return {
    ws,
    open() { return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); },
    send(message) { ws.send(JSON.stringify(message)); },
    waitFor(predicate, timeout) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const handler = { predicate, resolve, timer: null };
        handler.timer = setTimeout(() => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
          reject(new Error('等待 WebSocket 消息超时'));
        }, timeout || 4000);
        handlers.push(handler);
      });
    },
    close() { return new Promise(resolve => { if (ws.readyState === WebSocket.CLOSED) { resolve(); return; } ws.once('close', resolve); ws.close(); }); }
  };
}

const solution = [
  5,3,4,6,7,8,9,1,2, 6,7,2,1,9,5,3,4,8, 1,9,8,3,4,2,5,6,7,
  8,5,9,7,6,1,4,2,3, 4,2,6,8,5,3,7,9,1, 7,1,3,9,2,4,8,5,6,
  9,6,1,5,3,7,2,8,4, 2,8,7,4,1,9,6,3,5, 3,4,5,2,8,6,1,7,9
];
const givens = solution.map((value, index) => index < 40 ? value : 0);
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

(async function () {
  let A, B, A2;
  try {
    await waitForServer();
    const page = await fetch(HTTP_URL + '/sudoku/');
    ok('服务器可访问数独大厅', page.ok);
    const evil = new WebSocket(WS_URL, { origin: 'https://evil.example' });
    const evilClose = await new Promise(resolve => evil.once('close', code => resolve(code)));
    ok('数独协作拒绝跨站 WebSocket 连接', evilClose === 1008);

    A = client(); B = client();
    await Promise.all([A.open(), B.open()]);
    A.send({ t: 'join', room: 'SUD2K', cid: 'SUDOKU-A', intent: 'create', difficulty: 1, solution, givens });
    const sessionA = await A.waitFor(m => m.t === 'session');
    const waiting = await A.waitFor(m => m.t === 'state' && m.phase === 'waiting');
    ok('创建协作房间后保留同一份题面并等待朋友', waiting.board.join('') === givens.join('') && waiting.players.length === 1);

    B.send({ t: 'join', room: 'SUD2K', cid: 'SUDOKU-B', intent: 'join' });
    const sessionB = await B.waitFor(m => m.t === 'session');
    const playingA = await A.waitFor(m => m.t === 'state' && m.phase === 'playing');
    const playingB = await B.waitFor(m => m.t === 'state' && m.phase === 'playing');
    ok('第二位协作者加入后双方进入同一盘实时协作', playingA.startedAt && playingB.players.length === 2 && playingB.board.join('') === givens.join(''));
    ok('协作重连令牌仅发给本人而不广播', sessionA.token && sessionB.token && sessionA.token !== sessionB.token && !playingA.players.some(p => p.token));

    A.send({ t: 'set', changes: [{ index: 40, value: solution[40] }] });
    const afterA = await A.waitFor(m => m.t === 'state' && m.board[40] === solution[40]);
    const afterB = await B.waitFor(m => m.t === 'state' && m.board[40] === solution[40]);
    ok('一位协作者填写后另一端立即收到同一格更新', afterA.lastEditor === 'SUDOKU-A' && afterB.lastEditor === 'SUDOKU-A');

    const alternate = solution[41] === 1 ? 2 : 1;
    B.send({ t: 'set', changes: [{ index: 41, value: alternate }] });
    const afterBEdit = await A.waitFor(m => m.t === 'state' && m.board[41] === alternate);
    ok('协作盘允许共同试填，错误数字也会按服务器状态同步', afterBEdit.lastEditor === 'SUDOKU-B');

    await A.close();
    const offline = await B.waitFor(m => m.t === 'state' && m.players.some(p => p.cid === 'SUDOKU-A' && !p.online));
    ok('掉线协作者保留座位以便凭令牌返回同一盘', offline.phase === 'playing');

    A2 = client(); await A2.open();
    A2.send({ t: 'join', room: 'SUD2K', cid: 'SUDOKU-A', token: sessionA.token, intent: 'join' });
    await A2.waitFor(m => m.t === 'session');
    const resumed = await A2.waitFor(m => m.t === 'state' && m.board[41] === alternate);
    ok('持有效令牌重连后恢复原协作者与共享盘面', resumed.players.some(p => p.cid === 'SUDOKU-A' && p.online));

    const health = await (await fetch(HTTP_URL + '/health')).json();
    ok('健康检查统计数独协作房间与共享席位', health.roomsSudoku === 1 && health.seats === 2);
    console.log('\n✅ 数独好友协作集成测试全部通过（' + passed + ' 项）');
  } finally {
    if (A2) await A2.close().catch(() => {});
    if (B) await B.close().catch(() => {});
    child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error.stack || error);
  if (childLog) console.error(childLog);
  process.exitCode = 1;
});
