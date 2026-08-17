'use strict';
/*
 * server.js —— 24点大挑战·联机对战 WebSocket 中转服务器
 *
 * 作用：只做「房间内消息中转」，不存题、不算答案、不托管游戏前端。
 *   - 房间码就是随机种子（见 html/net.js），双方题目天然一致、确定性可复现，
 *     因此服务器无需下发题目，只负责把「进度 / 完成情况 / 开局」广播给同房间的其他人。
 *   - 这样服务器极轻量：单文件、无数据库、任意支持 WebSocket 的 Node 平台（Render / Railway /
 *     Fly / 本地）都能跑。
 *
 * 协议（JSON，UTF-8）
 *   客户端 → 服务端：
 *     {t:'join', room, nick, cid}        // 加入房间（cid 为客户端持久唯一 id）
 *     {t:'ready', v:true|false}
 *     {t:'start'}                        // 仅房主有效：开始本局
 *     {t:'prog', i, ok, ms}              // 第 i 题完成（0 基），ok=是否答对（仅用于统计，不中转对错）
 *     {t:'done', finalMs, actualMs, correct, wrong, skip}
 *     {t:'again'}                        // 再来一局（房主有效，round+1 换题但双方一致）
 *     {t:'ping'}
 *   服务端 → 客户端：
 *     {t:'state', round, phase, host, players:[{cid,nick,ready,online,prog,done,finalMs,actualMs,correct,wrong,skip}]}
 *     {t:'start', round, at}             // at=服务器时间戳(ms)，客户端据此倒计时同步开局
 *     {t:'pong'}
 *     {t:'err', msg}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SYNC_DELAY = 2000;     // 开局同步缓冲(ms)，给两端网络延迟留余量
const ROOM_TTL = 5 * 60 * 1000; // 房间内全员离线后保留时长，超时回收

// ===================== 安全加固配置 =====================
const MAX_ROOMS = 2;                 // 全服最多同时存在的房间数
const MAX_PLAYERS_PER_ROOM = 4;      // 单房间最多人数
const MAX_WS_PAYLOAD = 4096;         // 单条 WebSocket 消息最大字节数
const RATE_LIMIT = 20;               // 每连接每秒最多消息条数
const RATE_BURST = 40;               // 令牌桶初始容量（允许短时突发）
const MAX_CONNECTIONS = 16;          // 全服最多同时挂着的 WebSocket 连接
const JOIN_IDLE_MS = 15000;          // 连接后多久不 join 就断开（防空连接占额度）
// 房间码字母表须与 public/net.js 完全一致：5 位，去掉易混的 I/O/0/1
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
// 允许的浏览器来源（本地调试放行 localhost / 无 Origin 的非浏览器客户端）
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://g24-vs.onrender.com';

/** roomCode -> room */
const rooms = new Map();

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = {
      code: code,
      round: 1,
      phase: 'lobby',        // lobby | playing | done
      hostCid: null,
      players: new Map(),    // cid -> player
      _gc: null
    };
    rooms.set(code, r);
  }
  return r;
}

function resetProgress(room) {
  room.players.forEach(function (p) {
    p.prog = 0;
    p.done = false;
    p.finalMs = null;
    p.actualMs = null;
    p.correct = 0;
    p.wrong = 0;
    p.skip = 0;
    p.results = null;   // 逐题对错（新一局重置，避免上一局残留误导战报）
    p.qms = null;       // 逐题耗时
  });
}

function playerList(room) {
  return Array.from(room.players.values()).map(function (p) {
    return {
      cid: p.cid, nick: p.nick, ready: p.ready, online: p.online,
      prog: p.prog, done: p.done,
      finalMs: p.finalMs, actualMs: p.actualMs,
      correct: p.correct, wrong: p.wrong, skip: p.skip,
      results: p.results || null,   // 逐题对错（0/1 数组），供「逐题对决」展示
      qms: p.qms || null           // 逐题耗时（ms 数组），供战报「最卡一题」
    };
  });
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      // obj 既可能是对象（send 负责序列化），也可能是已序列化的字符串
      // （broadcastState/broadcastStart 已先 JSON.stringify），避免双重编码。
      ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
      return true;
    } catch (e) {}
  }
  return false;
}

function broadcastState(room) {
  const msg = JSON.stringify({
    t: 'state',
    round: room.round,
    phase: room.phase,
    host: room.hostCid,
    players: playerList(room)
  });
  room.players.forEach(function (p) { send(p.ws, msg); });
}

function broadcastStart(room) {
  const at = Date.now() + SYNC_DELAY;
  const msg = JSON.stringify({ t: 'start', round: room.round, at: at });
  room.players.forEach(function (p) { send(p.ws, msg); });
}

function scheduleGC(room) {
  if (room._gc) clearTimeout(room._gc);
  room._gc = setTimeout(function () {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    if (!anyOnline) rooms.delete(room.code);
  }, ROOM_TTL);
}

function pickNewHost(room) {
  const next = Array.from(room.players.values()).find(function (p) { return p.online; });
  room.hostCid = next ? next.cid : null;
}

// ===================== HTTP（静态托管前端 + 健康检查） =====================
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json'
};

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('Bad Request'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  // 规范化并防目录穿越：只允许访问 PUBLIC_DIR 内
  const rel = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(function (req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/health' || urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: '24vs', rooms: rooms.size, ts: Date.now() }));
    return;
  }
  serveStatic(req, res);
});

// ===================== WebSocket =====================
const wss = new WebSocket.Server({ server, maxPayload: MAX_WS_PAYLOAD });

let liveConnections = 0;

wss.on('connection', function (ws, req) {
  // ---- 全服连接数上限：防连接洪泛 ----
  if (liveConnections >= MAX_CONNECTIONS) {
    ws.close(1013, 'too many connections');
    return;
  }
  liveConnections++;

  // ---- Origin 校验：只允许本站与本地调试（CSWSH 防护）----
  const origin = req && req.headers && req.headers.origin;
  if (origin) {
    const ok = origin === ALLOWED_ORIGIN ||
               /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!ok) { ws.close(1008, 'origin not allowed'); liveConnections--; return; }
  }

  // ---- 每连接速率限制（令牌桶）----
  let tokens = RATE_BURST;
  let lastRefill = Date.now();

  let player = null; // 该连接归属的玩家对象（join 后赋值）

  // ---- 未加入超时：防止空连接（只过 Origin 校验却从不 join）占满连接额度，导致拒服 ----
  const joinTimer = setTimeout(function () {
    if (!player) { try { ws.close(1000, 'join timeout'); } catch (e) {} }
  }, JOIN_IDLE_MS);

  ws.on('message', function (data) {
    const now = Date.now();
    tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_LIMIT);
    lastRefill = now;
    if (tokens < 1) { ws.close(1008, 'rate limit'); return; }
    tokens -= 1;

    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      // ---- 入参校验：格式不对直接丢弃，不给攻击者撑大内存的机会 ----
      if (player) return; // 已加入过，忽略重复 join
      const code = String(m.room || '').toUpperCase();
      if (!ROOM_CODE_RE.test(code)) return;
      const cid = typeof m.cid === 'string' ? m.cid.slice(0, 32) : '';
      if (!cid || cid.length < 4) return;
      const nick = typeof m.nick === 'string' && m.nick.trim()
        ? m.nick.trim().slice(0, 16) : '玩家';

      const existing = rooms.get(code);
      // ---- 全服房间数上限 ----
      if (!existing && rooms.size >= MAX_ROOMS) {
        send(ws, { t: 'err', msg: '服务器房间已满，请稍后再试' });
        return;
      }
      const room = getRoom(code);

      let p = room.players.get(cid);
      if (p) {
        // ---- 防座位劫持：同 cid 已在线时拒绝新连接接管 ----
        if (p.online && p.ws && p.ws !== ws) {
          send(ws, { t: 'err', msg: '该身份已在线，请勿重复加入' });
          return;
        }
        p.ws = ws;
        p.nick = nick;
        p.online = true;
        p._room = room;
      } else {
        // ---- 单房间人数上限 ----
        if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
          send(ws, { t: 'err', msg: '该房间人数已满（最多' + MAX_PLAYERS_PER_ROOM + '人）' });
          if (room.players.size === 0) rooms.delete(code); // 容错：空房间不占额度
          return;
        }
        p = {
          cid: cid, nick: nick, ws: ws, ready: false, online: true,
          prog: 0, done: false, finalMs: null, actualMs: null,
          correct: 0, wrong: 0, skip: 0, _room: room
        };
        room.players.set(cid, p);
        if (!room.hostCid) room.hostCid = cid;
      }
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = p;
      clearTimeout(joinTimer); // 已加入，取消空连接超时
      broadcastState(room);
      return;
    }

    if (!player) return; // 其余指令需先 join
    const room = player._room;

    if (m.t === 'ready') {
      player.ready = !!m.v;
      broadcastState(room);
    } else if (m.t === 'start') {
      if (room.hostCid !== player.cid) {
        send(ws, { t: 'err', msg: '只有房主可以开始对战' });
        return;
      }
      room.phase = 'playing';
      resetProgress(room);
      broadcastState(room);
      broadcastStart(room);
    } else if (m.t === 'prog') {
      player.prog = Math.max(player.prog || 0, (parseInt(m.i, 10) || 0) + 1);
      broadcastState(room);
    } else if (m.t === 'done') {
      player.done = true;
      player.finalMs = parseInt(m.finalMs, 10) || 0;
      player.actualMs = parseInt(m.actualMs, 10) || 0;
      player.correct = parseInt(m.correct, 10) || 0;
      player.wrong = parseInt(m.wrong, 10) || 0;
      player.skip = parseInt(m.skip, 10) || 0;
      // 逐题对错 / 逐题耗时：校验后存储并下发，供结果页「逐题对决」与战报
      player.results = Array.isArray(m.results)
        ? m.results.slice(0, 64).map(function (v) { return v ? 1 : 0; })
        : null;
      player.qms = Array.isArray(m.qms)
        ? m.qms.slice(0, 64).map(function (v) {
            var n = parseInt(v, 10); return (n >= 0 && n <= 600000) ? n : 0;
          })
        : null;
      broadcastState(room);
      const onlines = Array.from(room.players.values()).filter(function (p) { return p.online; });
      if (onlines.length && onlines.every(function (p) { return p.done; })) {
        room.phase = 'done';
        broadcastState(room);
      }
    } else if (m.t === 'again') {
      if (room.hostCid !== player.cid) {
        send(ws, { t: 'err', msg: '只有房主可以开始下一局' });
        return;
      }
      room.round = (room.round || 1) + 1;
      room.phase = 'playing';
      resetProgress(room);
      broadcastState(room);
      broadcastStart(room);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong' });
    }
  });

  ws.on('close', function () {
    clearTimeout(joinTimer);
    liveConnections--;
    if (!player) return;
    player.online = false;
    player.ws = null;
    const room = player._room;
    if (room) {
      if (room.hostCid === player.cid) pickNewHost(room);
      broadcastState(room);
      scheduleGC(room);
    }
  });

  ws.on('error', function () { /* close 会紧随处理 */ });
});

server.listen(PORT, function () {
  console.log('[24vs] relay listening on :' + PORT + '  (wss 与 http 同端口)');
});
