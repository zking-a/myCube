'use strict';

const { spawn } = require('child_process');
const WebSocket = require('ws');
const path = require('path');
const rootDir = path.join(__dirname, '..');
const Core = require('../public/checkers/checkers_core');

const PORT = 33100 + Math.floor(Math.random() * 500);
const HTTP_URL = 'http://127.0.0.1:' + PORT;
const WS_URL = 'ws://127.0.0.1:' + PORT + '/checkers-ws';
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
  let A, B, A2, extra;
  try {
    await waitForServer();
    const redirect = await fetch(HTTP_URL + '/checkers', { redirect: 'manual' });
    const page = await fetch(HTTP_URL + '/checkers/');
    const coreScript = await fetch(HTTP_URL + '/checkers/checkers_core.js?v=test');
    ok('服务器可访问跳棋页面、规则核心和稳定目录路由',
      redirect.status === 308 && redirect.headers.get('location') === '/checkers/' && page.ok && coreScript.ok);
    const evil = new WebSocket(WS_URL, { origin: 'https://evil.example' });
    const evilClose = await new Promise(function (resolve) {
      evil.once('close', function (code) { resolve(code); });
    });
    ok('跳棋联机拒绝跨站 WebSocket 连接', evilClose === 1008);
    A = client(); B = client();
    await Promise.all([A.open(), B.open()]);

    A.send({ t: 'join', room: 'CHESS', nick: '蓝方房主', cid: 'CHECKERS-A', intent: 'create' });
    const aSession = await A.waitFor(function (m) { return m.t === 'session'; });
    await A.waitFor(function (m) { return m.t === 'state' && m.players.length === 1; });
    A.send({ t: 'start' });
    await A.waitFor(m => m.t === 'err' && m.code === 'PLAYERS_NOT_READY');
    ok('只有房主一人时不能开始', true);

    extra = client(); await extra.open();
    extra.send({ t: 'join', room: 'SHARE', nick: '占房测试', cid: 'CHECKERS-X', intent: 'create' });
    await extra.waitFor(function (m) { return m.t === 'err' && m.code === 'IP_ROOM_LIMIT'; });
    await extra.close(); extra = null;
    ok('同一网络不能批量创建等待房间占满全服容量', true);

    B.send({ t: 'join', room: 'CHESS', nick: '红方好友', cid: 'CHECKERS-B', intent: 'join' });
    const bSession = await B.waitFor(function (m) { return m.t === 'session'; });
    const waiting = await A.waitFor(m => m.t === 'state' && m.players.length === 2);
    ok('双方到齐后仍在等待房主开始', waiting.phase === 'waiting');
    B.send({ t: 'start' });
    await B.waitFor(m => m.t === 'err' && m.code === 'HOST_ONLY');
    ok('客人不能绕过房主启动对局', true);
    A.send({ t: 'start' });
    const openingA = await A.waitFor(m => m.t === 'state' && m.phase === 'opening');
    const openingB = await B.waitFor(m => m.t === 'state' && m.phase === 'opening');
    A.send({ t:'opening_ready', round:openingA.round });
    B.send({ t:'opening_ready', round:openingB.round - 1 });
    B.send({t:'move',from:'3:-3',target:'4:-4',seq:1});
    await B.waitFor(m => m.t === 'err' && m.code === 'ROUND_NOT_STARTED');
    ok('开幕未完成不能落子，过期轮次确认无效', true);
    B.send({ t:'opening_ready', round:openingB.round });
    const readyToRoll = await A.waitFor(m=>m.t==='state'&&m.phase==='rolling');
    await B.waitFor(m=>m.t==='state'&&m.phase==='rolling');
    ok('开幕结束不会自动投骰，双方点数都为空',readyToRoll.initiative.red===null&&readyToRoll.initiative.blue===null);
    A.send({t:'roll',round:readyToRoll.round,attempt:readyToRoll.initiative.attempt,color:'red',value:6});
    const hostRolled = await A.waitFor(m=>m.t==='state'&&m.phase==='rolling'&&m.initiative.blue!==null);
    ok('房主点击只产生自己的蓝方点数，客户端不能替红方投骰',hostRolled.initiative.red===null&&hostRolled.initiative.first===null);
    A.send({t:'roll',round:readyToRoll.round,attempt:readyToRoll.initiative.attempt});
    await A.waitFor(m=>m.t==='err'&&m.code==='ALREADY_ROLLED');
    B.send({t:'roll',round:readyToRoll.round,attempt:readyToRoll.initiative.attempt});
    let outcome=await A.waitFor(m=>m.t==='state'&&(m.phase==='playing'||m.phase==='rolling'&&m.initiative.attempt>1));
    while(outcome.phase==='rolling') {
      const attempt=outcome.initiative.attempt;
      A.send({t:'roll',round:outcome.round,attempt});B.send({t:'roll',round:outcome.round,attempt});
      outcome=await A.waitFor(m=>m.t==='state'&&(m.phase==='playing'||m.phase==='rolling'&&m.initiative.attempt>attempt));
    }
    const stateA = outcome;
    const stateB = await B.waitFor(function (m) { return m.t === 'state' && m.phase === 'playing'; });
    ok('双方开幕结束后才进入对局，由掷骰较大的一方先行', stateA.players.length === 2 && stateB.players.length === 2 && stateA.turn === stateA.initiative.first);
    ok('双方收到相同的有效骰点与先手结果', JSON.stringify(stateA.initiative) === JSON.stringify(stateB.initiative) &&
      stateA.initiative.red >= 1 && stateA.initiative.red <= 6 && stateA.initiative.blue >= 1 && stateA.initiative.blue <= 6 &&
      stateA.initiative.red !== stateA.initiative.blue && stateA.turn === (stateA.initiative.red > stateA.initiative.blue ? 'red' : 'blue'));
    ok('服务器固定分配房主蓝方、客人红方',
      stateA.players.find(p => p.cid === 'CHECKERS-A').color === 'blue' &&
      stateA.players.find(p => p.cid === 'CHECKERS-B').color === 'red');
    ok('私密重连令牌分别签发且不会广播',
      aSession.token && bSession.token && aSession.token !== bSession.token && !stateA.players.some(p => p.token));

    const firstColor = stateA.turn, secondColor = firstColor === 'red' ? 'blue' : 'red';
    const firstClient = firstColor === 'red' ? B : A, secondClient = firstColor === 'red' ? A : B;
    const redMove = Core.listMoves(stateA.pieces, firstColor)[0];
    firstClient.send({ t: 'move', from: redMove.from, target: redMove.target, seq: stateA.moveNumber });
    const afterRedA = await A.waitFor(function (m) { return m.t === 'state' && m.moveNumber === 2; });
    const afterRedB = await B.waitFor(function (m) { return m.t === 'state' && m.moveNumber === 2; });
    ok('先手合法走棋由服务器执行，随后切换另一方',
      afterRedA.turn === secondColor && afterRedB.pieces[redMove.target] === firstColor && !afterRedB.pieces[redMove.from]);
    ok('服务器把上一步来源、落点和路线权威同步给双方',
      afterRedA.lastMove && afterRedB.lastMove &&
      afterRedA.lastMove.from === redMove.from && afterRedB.lastMove.target === redMove.target &&
      Array.isArray(afterRedB.lastMove.path) && afterRedB.lastMove.path[0] === redMove.from &&
      afterRedB.lastMove.path[afterRedB.lastMove.path.length - 1] === redMove.target);

    firstClient.send({ t: 'move', from: redMove.target, target: redMove.from, seq: 2 });
    await firstClient.waitFor(function (m) { return m.t === 'err' && m.code === 'NOT_YOUR_TURN'; });
    ok('服务端拒绝连续抢走和伪造回合', true);
    secondClient.send({ t: 'move', from: '16:0', target: '0:0', seq: 2 });
    await secondClient.waitFor(function (m) { return m.t === 'err' && m.code === 'ILLEGAL_MOVE'; });
    ok('服务端拒绝不符合规则的落点', true);

    await A.close();
    const offline = await B.waitFor(function (m) {
      const red = m.players && m.players.find(p => p.cid === 'CHECKERS-A');
      return m.t === 'state' && red && !red.online;
    });
    ok('掉线后保留原座位并通知对手', offline.phase === 'playing');

    A2 = client(); await A2.open();
    A2.send({ t: 'join', room: 'CHESS', nick: '红方玩家', cid: 'CHECKERS-A', token: aSession.token, intent: 'join' });
    await A2.waitFor(function (m) { return m.t === 'session'; });
    const resumed = await A2.waitFor(function (m) { return m.t === 'state' && m.moveNumber === 2; });
    ok('持有效令牌重连后保留蓝方房主、当前棋盘及轮次',
      resumed.players.find(p => p.cid === 'CHECKERS-A').color === 'blue' && resumed.pieces[redMove.target] === firstColor && resumed.round === stateA.round && resumed.phase === 'playing' && JSON.stringify(resumed.initiative) === JSON.stringify(stateA.initiative));

    const impostor = client(); await impostor.open();
    impostor.send({ t: 'join', room: 'CHESS', nick: '冒用者', cid: 'CHECKERS-A', intent: 'join' });
    await impostor.waitFor(function (m) { return m.t === 'err' && m.code === 'SESSION_INVALID'; });
    await impostor.close();
    ok('仅知道公开 cid 不能接管其他玩家阵营', true);

    const health = await (await fetch(HTTP_URL + '/health')).json();
    ok('健康检查统计跳棋房间与共享席位', health.roomsCheckers === 1 && health.seats === 2);
    A2.send({t:'leave'});
    const promoted = await B.waitFor(m => m.t==='state' && m.players.length===1);
    ok('房主主动退出后，接任房主切换蓝方并回到等待状态', promoted.host==='CHECKERS-B' && promoted.players[0].color==='blue' && promoted.phase==='waiting');
    console.log('\n✅ 中国跳棋联机集成测试全部通过（' + passed + ' 项）');
  } finally {
    if (extra) await extra.close().catch(function () {});
    if (A2) await A2.close().catch(function () {});
    if (B) await B.close().catch(function () {});
    child.kill('SIGTERM');
  }
})().catch(function (error) {
  console.error(error.stack || error);
  if (childLog) console.error(childLog);
  process.exitCode = 1;
});
