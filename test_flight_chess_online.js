'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');
const Core = require('./public/flight-chess/flight_chess_core');

const PORT = 34600 + Math.floor(Math.random() * 500);
const HTTP_URL = 'http://127.0.0.1:' + PORT;
const WS_URL = 'ws://127.0.0.1:' + PORT + '/flight-chess-ws';
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), MAX_ROOMS: '4', MAX_ROOMS_PER_IP: '4',
    MAX_CONNECTIONS: '12', MAX_CONNECTIONS_PER_IP: '12', MAX_SOCKET_CONNECTIONS_PER_IP: '16',
    CONNECTION_ATTEMPT_LIMIT: '60'
  }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let childLog = '';
child.stdout.on('data', function (chunk) { childLog += chunk.toString(); });
child.stderr.on('data', function (chunk) { childLog += chunk.toString(); });

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(HTTP_URL + '/health');
      if (response.ok) return;
    } catch (error) {}
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
    try { message = JSON.parse(data.toString()); } catch (error) { return; }
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
          reject(new Error('等待飞行棋 WebSocket 消息超时'));
        }, timeout || 5000);
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
  let A, B, C, A2, extra, impostor;
  try {
    await waitForServer();
    const redirect = await fetch(HTTP_URL + '/flight-chess', { redirect: 'manual' });
    const page = await fetch(HTTP_URL + '/flight-chess/');
    const play = await fetch(HTTP_URL + '/flight-chess/play.html');
    const core = await fetch(HTTP_URL + '/flight-chess/flight_chess_core.js?v=test');
    const net = await fetch(HTTP_URL + '/flight-chess/flight_chess_net.js?v=test');
    ok('服务器可访问飞行棋大厅、对局页、规则核心和联机客户端',
      redirect.status === 308 && redirect.headers.get('location') === '/flight-chess/' &&
      page.ok && play.ok && core.ok && net.ok);

    const evil = new WebSocket(WS_URL, { origin: 'https://evil.example' });
    const evilClose = await new Promise(function (resolve) { evil.once('close', function (code) { resolve(code); }); });
    ok('飞行棋联机拒绝跨站 WebSocket 连接', evilClose === 1008);

    A = client(); B = client(); C = client();
    await Promise.all([A.open(), B.open(), C.open()]);
    A.send({ t: 'join', room: 'FLY24', nick: '红方机长', cid: 'FLIGHT-A', intent: 'create', capacity: 3 });
    const aSession = await A.waitFor(function (message) { return message.t === 'session'; });
    await A.waitFor(function (message) { return message.t === 'state' && message.players.length === 1; });
    A.send({ t: 'start' });
    await A.waitFor(function (message) { return message.t === 'err' && message.code === 'ROOM_NOT_READY'; });
    ok('房主可选择三人房，人数未齐时不能提前开始', aSession.seat === 0);

    B.send({ t: 'join', room: 'FLY24', nick: '黄方机长', cid: 'FLIGHT-B', intent: 'join' });
    const bSession = await B.waitFor(function (message) { return message.t === 'session'; });
    await B.waitFor(function (message) { return message.t === 'state' && message.players.length === 2; });
    B.send({ t: 'start' });
    await B.waitFor(function (message) { return message.t === 'err' && message.code === 'HOST_ONLY'; });
    ok('非房主不能启动房间', bSession.seat === 1);

    C.send({ t: 'join', room: 'FLY24', nick: '蓝方机长', cid: 'FLIGHT-C', intent: 'join' });
    const cSession = await C.waitFor(function (message) { return message.t === 'session'; });
    const readyA = await A.waitFor(function (message) { return message.t === 'state' && message.players.length === 3; });
    await Promise.all([
      B.waitFor(function (message) { return message.t === 'state' && message.players.length === 3; }),
      C.waitFor(function (message) { return message.t === 'state' && message.players.length === 3; })
    ]);
    ok('三位玩家分配唯一席位且私密令牌不会出现在广播状态',
      [aSession.seat, bSession.seat, cSession.seat].join(',') === '0,1,2' &&
      aSession.token && bSession.token && cSession.token && !readyA.players.some(function (player) { return player.token; }));

    A.send({ t: 'start' });
    const started = await A.waitFor(function (message) { return message.t === 'state' && message.phase === 'playing'; });
    await Promise.all([
      B.waitFor(function (message) { return message.t === 'state' && message.phase === 'playing'; }),
      C.waitFor(function (message) { return message.t === 'state' && message.phase === 'playing'; })
    ]);
    ok('玩家到齐后由房主开始并同步同一盘三人棋局',
      started.game && started.game.playerCount === 3 && started.game.currentPlayer === 0 &&
      started.game.players.map(function (player) { return player.name; }).join(',') === '红方机长,黄方机长,蓝方机长');

    B.send({ t: 'roll', rev: started.revision, die: 6 });
    await B.waitFor(function (message) { return message.t === 'err' && message.code === 'NOT_YOUR_TURN'; });
    ok('服务端拒绝非当前玩家抢掷骰子', true);

    A.send({ t: 'roll', rev: started.revision, die: 6 });
    let latest = await A.waitFor(function (message) { return message.t === 'state' && message.revision === started.revision + 1; });
    ok('骰点由服务端生成并作为唯一状态广播',
      Number.isInteger(latest.game.lastRoll) && latest.game.lastRoll >= 1 && latest.game.lastRoll <= 6);

    A.send({ t: 'roll', rev: started.revision });
    await A.waitFor(function (message) { return message.t === 'err' && message.code === 'STATE_OUTDATED'; });
    ok('过期版本操作会被拒绝并补发最新状态', true);

    const playersBySeat = [A, B, C];
    let moved = null;
    for (let attempt = 0; attempt < 60 && !moved; attempt++) {
      if (latest.game.phase === 'move') {
        const legal = Core.getMovablePlanes(latest.game, latest.game.currentPlayer, latest.game.dice);
        playersBySeat[latest.game.currentPlayer].send({ t: 'move', plane: legal[0], rev: latest.revision });
        moved = await A.waitFor(function (message) {
          return message.t === 'state' && message.revision > latest.revision && message.game.lastMove && message.game.lastMove.type === 'move';
        });
        latest = moved;
      } else {
        playersBySeat[latest.game.currentPlayer].send({ t: 'roll', rev: latest.revision, die: 6 });
        const priorRevision = latest.revision;
        latest = await A.waitFor(function (message) { return message.t === 'state' && message.revision > priorRevision; });
      }
    }
    ok('合法飞机编号由服务端规则核心执行并同步',
      moved && moved.game.lastMove.type === 'move' && moved.game.players[moved.game.lastMove.player].planes[moved.game.lastMove.plane] >= 0);

    extra = client(); await extra.open();
    extra.send({ t: 'join', room: 'FLY24', nick: '迟到玩家', cid: 'FLIGHT-D', intent: 'join' });
    await extra.waitFor(function (message) { return message.t === 'err' && message.code === 'ROUND_IN_PROGRESS'; });
    await extra.close(); extra = null;
    ok('开局后拒绝新玩家插入，但保留原玩家重连通道', true);

    await A.close(); A = null;
    const offline = await B.waitFor(function (message) {
      const member = message.players && message.players.find(function (player) { return player.cid === 'FLIGHT-A'; });
      return message.t === 'state' && member && !member.online;
    });
    ok('掉线后保留原席位并暂停操作', offline.phase === 'playing');

    A2 = client(); await A2.open();
    A2.send({ t: 'join', room: 'FLY24', nick: '红方机长', cid: 'FLIGHT-A', token: aSession.token, intent: 'join' });
    const resumedSession = await A2.waitFor(function (message) { return message.t === 'session'; });
    const resumed = await A2.waitFor(function (message) { return message.t === 'state' && message.players.length === 3; });
    ok('使用私密令牌重连后恢复原席位和当前棋局',
      resumedSession.seat === 0 && resumed.revision === moved.revision && resumed.game.lastMove.type === 'move');

    impostor = client(); await impostor.open();
    impostor.send({ t: 'join', room: 'FLY24', nick: '冒用者', cid: 'FLIGHT-A', intent: 'join' });
    await impostor.waitFor(function (message) { return message.t === 'err' && message.code === 'SESSION_INVALID'; });
    await impostor.close(); impostor = null;
    ok('只知道公开 cid 不能接管其他玩家席位', true);

    const health = await (await fetch(HTTP_URL + '/health')).json();
    ok('健康检查统计飞行棋房间和共享玩家席位', health.roomsFlightChess === 1 && health.seats === 3);
    console.log('\n✅ 飞行棋联机集成测试全部通过（' + passed + ' 项）');
  } finally {
    if (extra) await extra.close().catch(function () {});
    if (impostor) await impostor.close().catch(function () {});
    if (A) await A.close().catch(function () {});
    if (A2) await A2.close().catch(function () {});
    if (B) await B.close().catch(function () {});
    if (C) await C.close().catch(function () {});
    child.kill('SIGTERM');
  }
})().catch(function (error) {
  console.error(error.stack || error);
  if (childLog) console.error(childLog);
  process.exitCode = 1;
});
