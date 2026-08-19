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
 * 运行：先把服务器起在本地（PORT=3000），再 NODE_PATH=xxx node server/test_local.js
 */
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const URL = 'ws://127.0.0.1:' + PORT + '/ws';

function client() {
  const ws = new WebSocket(URL);
  const handlers = [];
  ws.on('message', function (d) {
    let m; try { m = JSON.parse(d.toString()); } catch (e) { return; }
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i].pred(m)) { const h = handlers.splice(i, 1)[0]; clearTimeout(h.timer); h.resolve(m); }
    }
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
  await A.waitFor(function (m) { return m.t === 'state' && m.players && m.players.length === 1; });
  B.send({ t: 'join', room: 'TESTT', nick: '小蓝', cid: 'CID-B1', intent: 'join' });

  // 1) 互见 + 房主
  const aState = await A.waitFor(function (m) {
    return m.t === 'state' && m.players && m.players.length === 2 && m.host === 'CID-A1';
  });
  ok('双方互见、房主=A1');
  if (!findP(aState, 'CID-B1')) throw new Error('A 看不到 B1');

  // 2) 准备 + 开始同步
  B.send({ t: 'ready', v: true });
  await A.waitFor(function (m) { const p = findP(m, 'CID-B1'); return m.t === 'state' && p && p.ready; });
  A.send({ t: 'start' });
  const aStart = await A.waitFor(function (m) { return m.t === 'start' && m.round === 1; });
  const bStart = await B.waitFor(function (m) { return m.t === 'start' && m.round === 1; });
  ok('B 准备、A 开始 → A/B 同步收到 start(round=1)');

  // 3) A 答 1 题，B 实时看到 A 进度=1
  A.send({ t: 'prog', i: 0, ok: true, ms: 1200, elapsedMs: 1200, correct: 1, wrong: 0, skip: 0 });
  const bSeeA = await B.waitFor(function (m) {
    const p = findP(m, 'CID-A1'); return m.t === 'state' && p && p.prog === 1;
  });
  ok('A 答 1 题 → B 实时看到 A 进度=1');

  // 4) B 答 2 题，A 实时看到 B 进度=2
  B.send({ t: 'prog', i: 0, ok: true, ms: 1500, elapsedMs: 1500, correct: 1, wrong: 0, skip: 0 });
  B.send({ t: 'prog', i: 1, ok: true, ms: 1700, elapsedMs: 3200, correct: 2, wrong: 0, skip: 0 });
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
  B.send({ t: 'join', room: 'TESTT', nick: '小蓝', cid: 'CID-B1', intent: 'join' });
  const resumed = await B.waitFor(function (m) {
    const p = findP(m, 'CID-B1');
    return m.t === 'state' && m.phase === 'playing' && !!m.startedAt && p && p.online && p.prog === 2;
  });
  ok('B 掉线重连 → 恢复 playing、startedAt 与进度=2');

  // 5) A 完成
  A.send({ t: 'done', finalMs: 42000, actualMs: 40000, correct: 10, wrong: 0, skip: 0 });
  const bothSeeADone = await Promise.all([
    A.waitFor(function (m) { const p = findP(m, 'CID-A1'); return p && p.done; }),
    B.waitFor(function (m) { const p = findP(m, 'CID-A1'); return p && p.done; })
  ]);
  ok('A 完成 → 双方看到 A.done');

  // 6) B 完成 → phase=done
  B.send({ t: 'done', finalMs: 51000, actualMs: 50000, correct: 9, wrong: 1, skip: 0 });
  const donePhase = await Promise.all([
    A.waitFor(function (m) { return m.t === 'state' && m.phase === 'done'; }),
    B.waitFor(function (m) { return m.t === 'state' && m.phase === 'done'; })
  ]);
  ok('B 完成 → 双方看到 phase=done');

  // 7) 再来一局回到准备大厅（不再突然自动开局）
  A.send({ t: 'again' });
  const aAgain = await A.waitFor(function (m) { return m.t === 'state' && m.round === 2 && m.phase === 'lobby'; });
  const bAgain = await B.waitFor(function (m) { return m.t === 'state' && m.round === 2 && m.phase === 'lobby'; });
  ok('A 发起下一局 → 双方回到 round=2 准备大厅');

  console.log('\n✅ 全部 ' + passed + ' 项端到端断言通过：实时进度同步工作正常。');
  process.exit(0);
})().catch(function (e) {
  console.error('\n❌ 验证失败：' + e.message);
  process.exit(1);
});
