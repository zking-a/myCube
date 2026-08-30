'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const rootDir = path.join(__dirname, '..');

const BLACK = 1;
const WHITE = 2;
const PORT = 34100 + Math.floor(Math.random() * 400);
const HTTP_URL = 'http://127.0.0.1:' + PORT;
const WS_URL = 'ws://127.0.0.1:' + PORT + '/gomoku-ws';
const child = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), MAX_ROOMS: '4', MAX_ROOMS_PER_IP: '1',
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

function client() {
  const ws = new WebSocket(WS_URL);
  const handlers = [];
  const queued = [];
  ws.on('message', function (data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch (e) { return; }
    const index = handlers.findIndex(function (handler) { return handler.predicate(message); });
    if (index >= 0) {
      const handler = handlers.splice(index, 1)[0];
      clearTimeout(handler.timer);
      handler.resolve(message);
    } else queued.push(message);
  });
  return {
    ws: ws,
    open: function () {
      return new Promise(function (resolve, reject) {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
    },
    send: function (message) { ws.send(JSON.stringify(message)); },
    waitFor: function (predicate, timeout) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      return new Promise(function (resolve, reject) {
        const handler = { predicate: predicate, resolve: resolve, timer: null };
        handler.timer = setTimeout(function () {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
          reject(new Error('等待 WebSocket 消息超时'));
        }, timeout || 4000);
        handlers.push(handler);
      });
    },
    close: function () {
      return new Promise(function (resolve) {
        if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.once('close', resolve);
        ws.close();
      });
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
  let A, B, A2, extra, impostor;
  try {
    await waitForServer();
    const redirect = await fetch(HTTP_URL + '/gomoku', { redirect: 'manual' });
    const page = await fetch(HTTP_URL + '/gomoku/');
    const coreScript = await fetch(HTTP_URL + '/gomoku/gomoku_core.js?v=test');
    const netScript = await fetch(HTTP_URL + '/gomoku/gomoku_net.js?v=test');
    ok('服务器可访问五子棋页面、规则核心、联机模块与目录路由',
      redirect.status === 308 && redirect.headers.get('location') === '/gomoku/' &&
      page.ok && coreScript.ok && netScript.ok);

    const evil = new WebSocket(WS_URL, { origin: 'https://evil.example' });
    const evilClose = await new Promise(function (resolve) {
      evil.once('close', function (code) { resolve(code); });
    });
    ok('五子棋联机拒绝跨站 WebSocket 连接', evilClose === 1008);

    A = client(); B = client();
    await Promise.all([A.open(), B.open()]);

    A.send({ t: 'join', room: 'ABCDE', nick: '黑方玩家', cid: 'GOMOKU-A', intent: 'create' });
    const aSession = await A.waitFor(function (m) { return m.t === 'session'; });
    await A.waitFor(function (m) { return m.t === 'state' && m.players.length === 1; });
    ok('创建房间后下发私密重连令牌', !!aSession.token && aSession.seat === 0);

    extra = client(); await extra.open();
    extra.send({ t: 'join', room: 'FGHJK', nick: '占房测试', cid: 'GOMOKU-X', intent: 'create' });
    await extra.waitFor(function (m) { return m.t === 'err' && m.code === 'IP_ROOM_LIMIT'; });
    await extra.close(); extra = null;
    ok('同一网络不能批量创建等待房间占满全服容量', true);

    B.send({ t: 'join', room: 'ABCDE', nick: '白方玩家', cid: 'GOMOKU-B', intent: 'join' });
    const bSession = await B.waitFor(function (m) { return m.t === 'session'; });
    const stateA = await A.waitFor(function (m) { return m.t === 'state' && m.phase === 'playing'; });
    const stateB = await B.waitFor(function (m) { return m.t === 'state' && m.phase === 'playing'; });
    ok('第二位玩家加入后双方自动进入对局',
      stateA.players.length === 2 && stateB.players.length === 2 && !!stateA.game);
    ok('服务端按座位分配黑白双方',
      stateA.players.find(p => p.cid === 'GOMOKU-A').color === BLACK &&
      stateA.players.find(p => p.cid === 'GOMOKU-B').color === WHITE);
    ok('私密重连令牌分别签发且不会广播',
      aSession.token && bSession.token && aSession.token !== bSession.token &&
      !stateA.players.some(p => p.token));

    let rev = stateA.revision;
    A.send({ t: 'move', r: 7, c: 3, rev: rev });
    const afterA = await A.waitFor(function (m) { return m.t === 'state' && m.game && m.game.moveNumber === 1; });
    const afterB = await B.waitFor(function (m) { return m.t === 'state' && m.game && m.game.moveNumber === 1; });
    rev = afterA.revision;
    ok('黑方落子由服务端执行并同步给双方',
      afterA.game.turn === WHITE && afterB.game.board[7][3] === BLACK);
    ok('服务端权威同步手数与最后一手',
      afterA.game.moveNumber === 1 && afterA.game.lastMove.r === 7 &&
      afterA.game.lastMove.c === 3 && afterA.game.lastMove.player === BLACK);

    A.send({ t: 'move', r: 7, c: 4, rev: rev });
    await A.waitFor(function (m) { return m.t === 'err' && m.code === 'NOT_YOUR_TURN'; });
    ok('服务端拒绝抢落子与伪造回合', true);

    B.send({ t: 'move', r: 7, c: 3, rev: rev });
    await B.waitFor(function (m) { return m.t === 'err' && m.code === 'OCCUPIED'; });
    ok('服务端拒绝落在已有棋子的位置', true);

    B.send({ t: 'move', r: 99, c: 99, rev: rev });
    await B.waitFor(function (m) { return m.t === 'err' && m.code === 'MOVE_INVALID'; });
    ok('服务端拒绝超出棋盘的落子', true);

    B.send({ t: 'move', r: 0, c: 0, rev: rev - 1 });
    await B.waitFor(function (m) { return m.t === 'err' && m.code === 'STATE_OUTDATED'; });
    ok('服务端拒绝基于过期状态的落子', true);

    const rest = [[0, 0], [7, 4], [1, 0], [7, 5], [2, 0], [7, 6], [3, 0], [7, 7]];
    for (let i = 0; i < rest.length; i++) {
      const target = rest[i];
      const actor = i % 2 === 0 ? B : A;
      const observer = i % 2 === 0 ? A : B;
      actor.send({ t: 'move', r: target[0], c: target[1], rev: rev });
      const moved = await actor.waitFor(function (m) {
        return m.t === 'state' && m.game && m.game.moveNumber === i + 2;
      });
      rev = moved.revision;
      if (i === rest.length - 1) {
        ok('黑方五子连珠由服务端判定胜负并结束本局',
          moved.game.finished === true && moved.game.winner === BLACK &&
          moved.game.endReason === 'five' && moved.phase === 'done');
      } else {
        await observer.waitFor(function (m) {
          return m.t === 'state' && m.game && m.game.moveNumber === i + 2;
        });
      }
    }

    const finalState = await B.waitFor(function (m) { return m.t === 'state' && m.phase === 'done'; });
    ok('胜负结果同步给对手', finalState.game.winner === BLACK && finalState.game.board[7][7] === BLACK);

    await A.close();
    const offline = await B.waitFor(function (m) {
      const black = m.players && m.players.find(p => p.cid === 'GOMOKU-A');
      return m.t === 'state' && black && !black.online;
    });
    ok('掉线后保留原座位并通知对手', offline.phase === 'done');

    A2 = client(); await A2.open();
    A2.send({ t: 'join', room: 'ABCDE', nick: '黑方玩家', cid: 'GOMOKU-A', token: aSession.token, intent: 'join' });
    await A2.waitFor(function (m) { return m.t === 'session'; });
    const resumed = await A2.waitFor(function (m) { return m.t === 'state' && m.game && m.game.moveNumber === 9; });
    ok('持有效令牌重连后恢复原阵营与棋盘',
      resumed.players.find(p => p.cid === 'GOMOKU-A').color === BLACK && resumed.game.board[7][7] === BLACK);

    impostor = client(); await impostor.open();
    impostor.send({ t: 'join', room: 'ABCDE', nick: '冒用者', cid: 'GOMOKU-A', intent: 'join' });
    await impostor.waitFor(function (m) { return m.t === 'err' && m.code === 'SESSION_INVALID'; });
    await impostor.close(); impostor = null;
    ok('仅知道公开 cid 不能接管其他玩家阵营', true);

    const health = await (await fetch(HTTP_URL + '/health')).json();
    ok('健康检查统计五子棋房间与共享席位', health.roomsGomoku === 1 && health.seats === 2);
    console.log('\n✅ 五子棋联机集成测试全部通过（' + passed + ' 项）');
  } finally {
    if (extra) await extra.close().catch(function () {});
    if (impostor) await impostor.close().catch(function () {});
    if (A2) await A2.close().catch(function () {});
    if (B) await B.close().catch(function () {});
    child.kill('SIGTERM');
  }
})().catch(function (error) {
  console.error(error.stack || error);
  if (childLog) console.error(childLog);
  process.exitCode = 1;
});
