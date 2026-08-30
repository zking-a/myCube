'use strict';
/*
 * test_local.js —— 本地端到端验证「实时看对手进度」
 * 模拟房主 A 与客人 B 两个 WebSocket 客户端，断言：
 *   1) 互见对方加入、房主为 A
 *   2) B 准备、A 开始 → 双方同步收到 start
 *   3) A 答 1 题 → B 实时看到 A 进度=1
 *   4) B 答 2 题 → A 实时看到 B 进度=2
 *   5) A 完成 → 双方看到 A.done
 *   6) B 完成 → 双方看到 phase=done
 *   7) A 再来一局 → 双方收到 start.round=2
 *
 * 运行：先把服务器起在本地（PORT=3000），再 NODE_PATH=xxx node tests/test_local.js
*/
const WebSocket = require('ws');
const Questions = require('../server_questions');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const URL = 'ws://127.0.0.1:' + PORT + '/ws';

function client() {
  const ws = new WebSocket(URL);
  const handlers = [];
  const queued = [];
  ws.on('message', function (d) {
    let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
    let matched = false;
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i].pred(m)) { const h = handlers.splice(i, 1)[0]; clearTimeout(h.timer); h.resolve(m); matched = true; break; }
    }
    if (!matched) queued.push(m);
  });
  return {
    send: function (o) { ws.send(JSON.stringify(o)); },
    close: function () {
      return new Promise(function (resolve) {
        if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
        ws.once('close', resolve);
        ws.close();
      });
    },
    open: function () { return new Promise(function (res) { ws.on('open', res); }); },
    waitFor: function (pred, timeout) {
      timeout = timeout || 5000;
      const queuedIndex = queued.findIndex(pred);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      return new Promise(function (resolve, reject) {
        const h = { pred: pred, resolve: resolve, timer: null };
        h.timer = setTimeout(function () {
          const idx = handlers.indexOf(h); if (idx >= 0) handlers.splice(idx, 1);
          reject(new Error('waitFor timeout'));
        }, timeout);
        handlers.push(h);
      });
    }
  };
}

function findP(state, cid) {
  return (state.players || []).find(function (p) { return p.cid === cid; });
}

let passed = 0;
function ok(name) { passed++; console.log('  PASS  ' + name); }
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

(async function () {
  const C = client();
  await C.open();
  C.send({ t: 'join', room: 'MSSNN', nick: '误入者', cid: 'CID-C1', intent: 'join' });
  await C.waitFor(function (m) { return m.t === 'err' && m.code === 'ROOM_NOT_FOUND'; });
  await C.close();
  ok('加入不存在的房间 → 明确报错，不会静默创建平行房间');

  const A = client(); let B = client();
  await A.open(); await B.open();
  console.log('connected A & B');

  A.send({ t: 'join', room: 'TESTT', nick: '小红', cid: 'CID-A1', intent: 'create' });
  const aSession = await A.waitFor(function (m) { return m.t === 'session'; });
  await A.waitFor(function (m) { return m.t === 'state' && m.players && m.players.length === 1; });
  B.send({ t: 'join', room: 'TESTT', nick: '小蓝', cid: 'CID-B1', intent: 'join' });
  const bSession = await B.waitFor(function (m) { return m.t === 'session'; });

  // 1) 互见 + 房主
  const aState = await A.waitFor(function (m) {
    return m.t === 'state' && m.players && m.players.length === 2 && m.host === 'CID-A1';
  });
  ok('双方互见、房主=A1');
  if (!findP(aState, 'CID-B1')) throw new Error('A 看不到 B1');
  if (!aSession.token || !bSession.token || aSession.token === bSession.token) throw new Error('重连令牌未独立签发');
  if (aState.players.some(function (p) { return p.token || p.reconnectToken; })) throw new Error('私密令牌被广播');
  ok('重连令牌独立签发且未向房间广播');

  // 冒用公开 cid 但没有私密令牌时必须失败。
  const impostor = client(); await impostor.open();
  impostor.send({ t: 'join', room: 'TESTT', nick: '冒用者', cid: 'CID-A1', intent: 'join' });
  await impostor.waitFor(function (m) { return m.t === 'err' && m.code === 'SESSION_INVALID'; });
  await impostor.close();
  ok('仅冒用 cid 无法接管其他玩家座位');

  // 2) 准备 + 开始同步
  B.send({ t: 'ready', v: true });
  await A.waitFor(function (m) { const p = findP(m, 'CID-B1'); return m.t === 'state' && p && p.ready; });
  A.send({ t: 'start' });
  const aStart = await A.waitFor(function (m) { return m.t === 'start' && m.round === 1; });
  const bStart = await B.waitFor(function (m) { return m.t === 'start' && m.round === 1; });
  ok('B 准备、A 开始 → A/B 同步收到 start(round=1)');
  await wait(Math.max(0, Math.max(aStart.at, bStart.at) - Date.now()) + 30);

  const questions = Questions.buildRoomQuestions('TESTT#1', 10);

  // 3) A 答 1 题，B 实时看到 A 进度=1
  A.send({ t: 'prog', i: 0, outcome: 'correct', proof: questions[0].answer });
  const bSeeA = await B.waitFor(function (m) {
    const p = findP(m, 'CID-A1'); return m.t === 'state' && p && p.prog === 1;
  });
  ok('A 答 1 题 → B 实时看到 A 进度=1');

  // 4) B 答 2 题，A 实时看到 B 进度=2
  B.send({ t: 'prog', i: 0, outcome: 'correct', proof: questions[0].answer });
  B.send({ t: 'prog', i: 1, outcome: 'correct', proof: questions[1].answer });
  const aSeeB = await A.waitFor(function (m) {
    const p = findP(m, 'CID-B1'); return m.t === 'state' && p && p.prog === 2;
  });
  ok('B 答 2 题 → A 实时看到 B 进度=2');

  // 4.5) B 短暂掉线后用同一 cid 回来，服务器应保留轮次、开局时间和进度
  const seesOffline = A.waitFor(function (m) { const p = findP(m, 'CID-B1'); return m.t === 'state' && p && !p.online; });
  B.close();
  await seesOffline;
  B = client();
  await B.open();
  B.send({ t: 'join', room: 'TESTT', nick: '小蓝', cid: 'CID-B1', token: bSession.token, intent: 'join' });
  await B.waitFor(function (m) { return m.t === 'session' && m.token === bSession.token; });
  const resumed = await B.waitFor(function (m) {
    const p = findP(m, 'CID-B1');
    return m.t === 'state' && m.phase === 'playing' && !!m.startedAt && p && p.online && p.prog === 2;
  });
  ok('B 掉线重连 → 恢复 playing、startedAt 与进度=2');

  // 模拟移动网络半开：旧连接尚未触发 close，新连接持令牌应立即接管同一座位。
  const replacement = client();
  await replacement.open();
  replacement.send({ t: 'join', room: 'TESTT', nick: '小蓝', cid: 'CID-B1', token: bSession.token, intent: 'join' });
  await replacement.waitFor(function (m) { return m.t === 'session' && m.token === bSession.token; });
  await replacement.waitFor(function (m) {
    const p = findP(m, 'CID-B1');
    return m.t === 'state' && m.phase === 'playing' && p && p.online && p.prog === 2;
  });
  await B.close();
  B = replacement;
  ok('有效令牌可立即替换旧半开连接，无需等待心跳回收');

  // 未完成 10 题时伪造 done 必须被拒绝。
  A.send({ t: 'done', actualMs: 0, correct: 10 });
  await A.waitFor(function (m) { return m.t === 'err' && m.code === 'ROUND_INCOMPLETE'; });
  ok('服务端拒绝提前交卷和客户端伪造成绩');

  // 5) A 完成：服务器逐题验证表达式并自行累计成绩。
  for (let i = 1; i < 10; i++) A.send({ t: 'prog', i: i, outcome: 'correct', proof: questions[i].answer });
  await A.waitFor(function (m) { const p = findP(m, 'CID-A1'); return m.t === 'state' && p && p.prog === 10; });
  A.send({ t: 'done', actualMs: 0, correct: 0, wrong: 10, skip: 10 });
  const bothSeeADone = await Promise.all([
    A.waitFor(function (m) { const p = findP(m, 'CID-A1'); return p && p.done; }),
    B.waitFor(function (m) { const p = findP(m, 'CID-A1'); return p && p.done; })
  ]);
  const authoritativeA = findP(bothSeeADone[0], 'CID-A1');
  if (!(authoritativeA.actualMs > 0) || authoritativeA.correct !== 10 || authoritativeA.wrong !== 0 || authoritativeA.skip !== 0 || authoritativeA.finalMs !== authoritativeA.actualMs) {
    throw new Error('A 的权威成绩计算错误');
  }
  ok('A 完成 → 双方看到 A.done');

  // 6) B 完成 → phase=done（后 8 题选择跳过，罚时由服务器累计）
  for (let i = 2; i < 10; i++) B.send({ t: 'prog', i: i, outcome: 'skip', proof: '' });
  await B.waitFor(function (m) { const p = findP(m, 'CID-B1'); return m.t === 'state' && p && p.prog === 10; });
  B.send({ t: 'done', actualMs: 1, correct: 10, wrong: 0, skip: 0 });
  const donePhase = await Promise.all([
    A.waitFor(function (m) { return m.t === 'state' && m.phase === 'done'; }),
    B.waitFor(function (m) { return m.t === 'state' && m.phase === 'done'; })
  ]);
  const authoritativeB = findP(donePhase[0], 'CID-B1');
  if (authoritativeB.correct !== 2 || authoritativeB.skip !== 8 || authoritativeB.finalMs !== authoritativeB.actualMs + 8 * 15000) {
    throw new Error('B 的服务端罚时累计错误');
  }
  ok('B 完成 → 双方看到 phase=done');

  // 7) 再来一局回到准备大厅（不再突然自动开局）
  A.send({ t: 'again' });
  const aAgain = await A.waitFor(function (m) { return m.t === 'state' && m.round === 2 && m.phase === 'lobby'; });
  const bAgain = await B.waitFor(function (m) { return m.t === 'state' && m.round === 2 && m.phase === 'lobby'; });
  ok('A 发起下一局 → 双方回到 round=2 准备大厅');

  A.send({ t: 'leave' });
  B.send({ t: 'leave' });
  await wait(100);

  console.log('\n✅ 全部 ' + passed + ' 项端到端断言通过：实时进度同步工作正常。');
  process.exit(0);
})().catch(function (e) {
  console.error('\n❌ 验证失败：' + e.message);
  process.exit(1);
});
