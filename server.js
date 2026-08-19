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
 *     {t:'join', room, nick, cid, intent:'create'|'join'}
 *     {t:'ready', v:true|false}
 *     {t:'start'}                        // 仅房主有效：开始本局
 *     {t:'prog', i, ok, ms}              // 第 i 题完成（0 基），ok=是否答对（仅用于统计，不中转对错）
 *     {t:'done', finalMs, actualMs, correct, wrong, skip}
 *     {t:'again'}                        // 房主发起下一局：round+1 并回到准备大厅
 *     {t:'ping'}
 *   服务端 → 客户端：
 *     {t:'state', round, phase, startedAt, serverNow, host, players:[...]}
 *     {t:'start', round, at}             // at=服务器时间戳(ms)，客户端据此倒计时同步开局
 *     {t:'pong'}
 *     {t:'err', msg}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SYNC_DELAY = 2000;     // 开局同步缓冲(ms)，给两端网络延迟留余量
const ROOM_TTL = 5 * 60 * 1000; // 房间内全员离线后保留时长，超时回收
const LOBBY_IDLE_MS = Math.max(60 * 1000, parseInt(process.env.LOBBY_IDLE_MS, 10) || 5 * 60 * 1000);
const ONLINE_ROOM_IDLE_MS = Math.max(5 * 60 * 1000, parseInt(process.env.ONLINE_ROOM_IDLE_MS, 10) || 15 * 60 * 1000);
const DISCONNECT_GRACE_MS = 30 * 1000; // 对局中掉线后保留座位，给移动网络重连留时间
const TOTAL_QUESTIONS = 10;
const WRONG_PENALTY = 5000;
const SKIP_PENALTY = 15000;

// ===================== 安全加固配置 =====================
const MAX_ROOMS = Math.max(1, parseInt(process.env.MAX_ROOMS, 10) || 2); // 默认 2，可按实例规格调整
const MAX_PLAYERS_PER_ROOM = Math.max(2, parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 4);
const MAX_WS_PAYLOAD = 4096;         // 单条 WebSocket 消息最大字节数
const RATE_LIMIT = 20;               // 每连接每秒最多消息条数
const RATE_BURST = 40;               // 令牌桶初始容量（允许短时突发）
const MAX_CONNECTIONS = Math.max(1, parseInt(process.env.MAX_CONNECTIONS, 10) || 4); // 默认 4，可通过环境变量覆盖
const MAX_CONNECTIONS_PER_IP = Math.max(1, parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 2);
const JOIN_IDLE_MS = 8000;           // 未 join 的连接尽快释放，避免占满全局名额
const CONNECTION_ATTEMPT_LIMIT = Math.max(4, parseInt(process.env.CONNECTION_ATTEMPT_LIMIT, 10) || 12);
const CONNECTION_ATTEMPT_WINDOW = 60 * 1000;
// 房间码字母表须与 public/net.js 完全一致：5 位，去掉易混的 I/O/0/1
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
// 允许的浏览器来源：默认「域名无关」——接受请求自身的 Host（任何 *.onrender.com 子域均放行，无需随域名改代码）
// 如需强制限定单一来源，设置环境变量 ALLOWED_ORIGIN=https://your-domain
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

// 单 IP 建房限速：防单 IP 占满全部房间导致所有正常用户被拒
const ROOM_CREATE_LIMIT = 10;         // 窗口内单 IP 最多创建房间数
const ROOM_CREATE_WINDOW = 60 * 1000; // 限速窗口(ms)
const roomCreateLog = new Map();      // ip -> [创建时间戳,...]
const connectionAttemptLog = new Map(); // ip -> [连接时间戳,...]
const liveConnectionsByIp = new Map();  // ip -> 当前 WebSocket 数

function allowedConnectSources(raw) {
  const out = ["'self'"];
  String(raw || '').split(',').forEach(function (item) {
    const value = item.trim();
    if (!value) return;
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === 'ws:' || parsed.protocol === 'wss:') && (!parsed.pathname || parsed.pathname === '/')) {
        out.push(parsed.origin);
      }
    } catch (e) {}
  });
  return Array.from(new Set(out)).join(' ');
}
const CSP_CONNECT_SRC = allowedConnectSources(process.env.ALLOWED_CONNECT_SRC);

// 安全响应头：脚本仅同源；跨域 WebSocket 必须通过 ALLOWED_CONNECT_SRC 显式放行。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';" +
    " img-src 'self' data:; font-src 'self'; connect-src " + CSP_CONNECT_SRC + ";" +
    " object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; manifest-src 'self'"
};

/** roomCode -> room */
const rooms = new Map();

function createRoom(code) {
  const room = {
    code: code,
    round: 1,
    phase: 'lobby',        // lobby | playing | done
    startedAt: null,
    hostCid: null,
    players: new Map(),    // cid -> player
    _gc: null,
    _finishTimer: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastLobbyActivityAt: Date.now()
  };
  rooms.set(code, room);
  return room;
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
    p.lastProgressMs = 0;
    p.participant = false;
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
      qms: p.qms || null,          // 逐题耗时（ms 数组），供战报「最卡一题」
      lastProgressMs: p.lastProgressMs || 0,
      participant: !!p.participant
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
    startedAt: room.startedAt,
    serverNow: Date.now(),
    host: room.hostCid,
    players: playerList(room)
  });
  room.players.forEach(function (p) { send(p.ws, msg); });
}

function broadcastStart(room) {
  const msg = JSON.stringify({ t: 'start', round: room.round, at: room.startedAt });
  room.players.forEach(function (p) { send(p.ws, msg); });
}

function scheduleGC(room) {
  if (room._gc) clearTimeout(room._gc);
  room._gc = setTimeout(function () {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    if (!anyOnline && rooms.get(room.code) === room) rooms.delete(room.code);
  }, ROOM_TTL);
}

function expireRoom(room, reason) {
  if (!room || rooms.get(room.code) !== room) return;
  rooms.delete(room.code);
  if (room._gc) { clearTimeout(room._gc); room._gc = null; }
  if (room._finishTimer) { clearTimeout(room._finishTimer); room._finishTimer = null; }
  room.players.forEach(function (p) {
    send(p.ws, { t: 'err', code: 'ROOM_EXPIRED', msg: reason });
    if (p.ws) { try { p.ws.close(1000, 'room expired'); } catch (e) {} }
    p.online = false;
    p.ws = null;
  });
}

function maybeFinishRound(room) {
  if (!room || room.phase !== 'playing') return;
  const participants = Array.from(room.players.values()).filter(function (p) { return p.participant; });
  if (!participants.length) return;
  const now = Date.now();
  const settled = participants.every(function (p) {
    return p.done || (!p.online && p.disconnectedAt && now - p.disconnectedAt >= DISCONNECT_GRACE_MS);
  });
  if (settled) {
    room.phase = 'done';
    room.startedAt = null;
    if (room._finishTimer) { clearTimeout(room._finishTimer); room._finishTimer = null; }
    broadcastState(room);
  }
}

function scheduleFinishCheck(room) {
  if (!room || room.phase !== 'playing') return;
  if (room._finishTimer) clearTimeout(room._finishTimer);
  room._finishTimer = setTimeout(function () {
    room._finishTimer = null;
    maybeFinishRound(room);
  }, DISCONNECT_GRACE_MS + 100);
}

// 单 IP 建房限速：滑动窗口内超过上限则拒绝（防单 IP 占满全部房间）
function checkRoomCreateLimit(ip) {
  if (!ip) return true; // 取不到 IP 时保守放行（不误伤）
  const now = Date.now();
  let arr = roomCreateLog.get(ip) || [];
  arr = arr.filter(function (t) { return now - t < ROOM_CREATE_WINDOW; });
  if (arr.length >= ROOM_CREATE_LIMIT) { roomCreateLog.set(ip, arr); return false; }
  arr.push(now);
  roomCreateLog.set(ip, arr);
  return true;
}

function checkConnectionAttemptLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  let arr = connectionAttemptLog.get(ip) || [];
  arr = arr.filter(function (t) { return now - t < CONNECTION_ATTEMPT_WINDOW; });
  if (arr.length >= CONNECTION_ATTEMPT_LIMIT) { connectionAttemptLog.set(ip, arr); return false; }
  arr.push(now);
  connectionAttemptLog.set(ip, arr);
  return true;
}

// 全服周期扫描：只回收全员离线且已超过保留期的房间。
// 在线大厅绝不能按创建时间删除，否则迟到玩家会进入同码但不同实例的“平行房间”。
setInterval(function () {
  const now = Date.now();
  rooms.forEach(function (room, code) {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    if (anyOnline && room.phase === 'lobby' && now - (room.lastLobbyActivityAt || room.createdAt) > LOBBY_IDLE_MS) {
      expireRoom(room, '房间等待超时，请重新创建房间');
      return;
    }
    if (anyOnline && room.phase !== 'lobby' && now - (room.lastActivityAt || room.createdAt) > ONLINE_ROOM_IDLE_MS) {
      expireRoom(room, '房间长时间没有操作，已自动释放');
      return;
    }
    if (!anyOnline && now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL) {
      rooms.delete(code);
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
    }
  });
  roomCreateLog.forEach(function (timestamps, ip) {
    const recent = timestamps.filter(function (t) { return now - t < ROOM_CREATE_WINDOW; });
    if (recent.length) roomCreateLog.set(ip, recent);
    else roomCreateLog.delete(ip);
  });
  connectionAttemptLog.forEach(function (timestamps, ip) {
    const recent = timestamps.filter(function (t) { return now - t < CONNECTION_ATTEMPT_WINDOW; });
    if (recent.length) connectionAttemptLog.set(ip, recent);
    else connectionAttemptLog.delete(ip);
  });
}, 30 * 1000);

function pickNewHost(room) {
  const next = Array.from(room.players.values()).find(function (p) { return p.online; });
  room.hostCid = next ? next.cid : null;
}

// ===================== HTTP（静态托管前端 + 健康检查） =====================
// 统一下发安全响应头
function writeHead(res, status, extra) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, extra || {}));
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const staticCache = new Map();

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
  catch (e) { writeHead(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Request'); return; }
  if (urlPath === '/') urlPath = '/index.html';
  // 规范化并防目录穿越：只允许访问 PUBLIC_DIR 内
  const rel = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    writeHead(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  function respond(data) {
    const ext = path.extname(filePath).toLowerCase();
    const etag = '"' + crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16) + '"';
    if (req.headers['if-none-match'] === etag) {
      writeHead(res, 304, { ETag: etag, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300, must-revalidate' });
      res.end();
      return;
    }
    const canGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) &&
      data.length > 1024 && /^(\.html|\.js|\.css|\.json|\.svg)$/.test(ext);
    const body = canGzip ? zlib.gzipSync(data, { level: 6 }) : data;
    writeHead(res, 200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300, must-revalidate',
      ETag: etag,
      Vary: 'Accept-Encoding',
      ...(canGzip ? { 'Content-Encoding': 'gzip' } : {})
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }
  const cached = staticCache.get(filePath);
  if (cached) { respond(cached); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      writeHead(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    staticCache.set(filePath, data);
    respond(data);
  });
}

const server = http.createServer(function (req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeHead(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  if (urlPath === '/health' || urlPath === '/healthz') {
    writeHead(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: '24vs', rooms: rooms.size, connections: liveConnections, ts: Date.now() }));
    return;
  }
  serveStatic(req, res);
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

// ===================== WebSocket =====================
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD });

let liveConnections = 0;

wss.on('connection', function (ws, req) {
  // 取客户端真实 IP（兼容反向代理 X-Forwarded-For，如 Render）
  const forwarded = req.headers && req.headers['x-forwarded-for']
    ? String(req.headers['x-forwarded-for']).split(',').map(function (x) { return x.trim(); }).filter(Boolean)
    : [];
  const clientIp = (req.headers && String(req.headers['cf-connecting-ip'] || '').trim()) ||
    (forwarded.length ? forwarded[forwarded.length - 1] : '') ||
    (req.socket && req.socket.remoteAddress) || '';

  // ---- Origin 校验：只允许本站与本地调试（CSWSH 防护）----
  // 同时接受「请求自身的 Host」，做到域名无关：换 onrender 子域也不会断
  const origin = req && req.headers && req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const ok = origin === ALLOWED_ORIGIN ||
               (host && (origin === 'https://' + host || origin === 'http://' + host)) ||
               /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!ok) { ws.close(1008, 'origin not allowed'); return; }
  }

  // ---- 连接尝试 / 单 IP / 全服三层限额 ----
  if (!checkConnectionAttemptLimit(clientIp)) {
    ws.close(1013, 'too many connection attempts');
    return;
  }
  const ipConnections = liveConnectionsByIp.get(clientIp) || 0;
  if (ipConnections >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'too many connections from this ip');
    return;
  }
  if (liveConnections >= MAX_CONNECTIONS) {
    ws.close(1013, 'too many connections');
    return;
  }
  liveConnections++;
  liveConnectionsByIp.set(clientIp, ipConnections + 1);
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });

  // ---- 每连接速率限制（令牌桶）----
  let tokens = RATE_BURST;
  let lastRefill = Date.now();

  let player = null; // 该连接归属的玩家对象（join 后赋值）

  function fail(code, msg) {
    send(ws, { t: 'err', code: code, msg: msg });
  }

  function asInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

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
      const intent = m.intent === 'create' || m.intent === 'join' ? m.intent : 'legacy';

      let room = rooms.get(code);
      if (!room) {
        if (intent === 'join') {
          fail('ROOM_NOT_FOUND', '房间不存在或已失效，请向房主确认房间码');
          return;
        }
        // ---- 单 IP 建房限速：防单 IP 占满全部房间导致所有正常用户被拒 ----
        if (!checkRoomCreateLimit(clientIp)) {
          fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试');
          return;
        }
        // ---- 全服房间数上限 ----
        if (rooms.size >= MAX_ROOMS) {
          fail('SERVER_FULL', '服务器房间已满，请稍后再试');
          return;
        }
        room = createRoom(code);
      } else if (intent === 'create') {
        // 建房成功后的首个 state 可能在弱网中丢失；同一 cid 的离线座位仍按重连处理。
        const ownSeat = room.players.get(cid);
        if (!ownSeat || ownSeat.online) {
          fail('ROOM_EXISTS', '房间码碰巧重复，正在换一个新房间码');
          return;
        }
      }

      let p = room.players.get(cid);
      if (p) {
        // ---- 防座位劫持：同 cid 已在线时拒绝新连接接管 ----
        if (p.online && p.ws && p.ws !== ws) {
          fail('DUPLICATE_ID', '该身份已在线，请勿重复加入');
          return;
        }
        p.ws = ws;
        p.nick = nick;
        p.online = true;
        p.disconnectedAt = null;
        p._room = room;
      } else {
        if (room.phase === 'playing') {
          fail('ROUND_IN_PROGRESS', '这局已经开始了，请等房主发起下一局');
          return;
        }
        if (room.phase === 'done') {
          fail('ROUND_FINISHED', '上一局刚结束，请让房主发起下一局后再加入');
          return;
        }
        // ---- 单房间人数上限 ----
        if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
          fail('ROOM_FULL', '该房间人数已满（最多' + MAX_PLAYERS_PER_ROOM + '人）');
          return;
        }
        p = {
          cid: cid, nick: nick, ws: ws, ready: false, online: true,
          prog: 0, done: false, finalMs: null, actualMs: null,
          correct: 0, wrong: 0, skip: 0, results: null, qms: null,
          lastProgressMs: 0, participant: false, disconnectedAt: null, _room: room
        };
        room.players.set(cid, p);
        if (!room.hostCid) room.hostCid = cid;
      }
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = p;
      room.lastActivityAt = Date.now();
      if (room.phase === 'lobby') room.lastLobbyActivityAt = room.lastActivityAt;
      clearTimeout(joinTimer); // 已加入，取消空连接超时
      if (room.phase === 'playing') scheduleFinishCheck(room);
      broadcastState(room);
      return;
    }

    if (!player) return; // 其余指令需先 join
    const room = player._room;

    if (m.t !== 'ping') room.lastActivityAt = Date.now();

    if (m.t === 'ready') {
      if (room.phase !== 'lobby') return;
      room.lastLobbyActivityAt = Date.now();
      player.ready = !!m.v;
      broadcastState(room);
    } else if (m.t === 'start') {
      if (room.hostCid !== player.cid) {
        fail('HOST_ONLY', '只有房主可以开始对战');
        return;
      }
      if (room.phase !== 'lobby') return;
      const onlinePlayers = Array.from(room.players.values()).filter(function (p) { return p.online; });
      if (onlinePlayers.length < 2) {
        fail('NOT_ENOUGH_PLAYERS', '至少需要两位在线玩家才能开始');
        return;
      }
      const unready = onlinePlayers.filter(function (p) { return p.cid !== room.hostCid && !p.ready; });
      if (unready.length) {
        fail('PLAYERS_NOT_READY', '还有 ' + unready.length + ' 位玩家没有准备');
        return;
      }
      room.phase = 'playing';
      room.startedAt = Date.now() + SYNC_DELAY;
      resetProgress(room);
      room.players.forEach(function (p) {
        p.participant = p.online;
        p.ready = false;
      });
      broadcastState(room);
      broadcastStart(room);
    } else if (m.t === 'prog') {
      if (room.phase !== 'playing' || !player.participant || player.done) return;
      const index = asInt(m.i, 0, TOTAL_QUESTIONS - 1, -1);
      if (index < 0 || index !== (player.prog || 0)) return;
      player.prog = index + 1;
      if (!player.results) player.results = [];
      if (!player.qms) player.qms = [];
      player.results[index] = m.ok ? 1 : 0;
      player.qms[index] = asInt(m.ms, 0, 600000, 0);
      player.lastProgressMs = asInt(m.elapsedMs, 0, 24 * 60 * 60 * 1000, player.lastProgressMs || 0);
      player.correct = asInt(m.correct, 0, TOTAL_QUESTIONS, player.correct || 0);
      player.wrong = asInt(m.wrong, 0, TOTAL_QUESTIONS, player.wrong || 0);
      player.skip = asInt(m.skip, 0, TOTAL_QUESTIONS, player.skip || 0);
      broadcastState(room);
    } else if (m.t === 'done') {
      if (room.phase !== 'playing' || !player.participant || player.done) return;
      player.done = true;
      player.prog = TOTAL_QUESTIONS;
      player.actualMs = asInt(m.actualMs, 0, 24 * 60 * 60 * 1000, 0);
      player.correct = asInt(m.correct, 0, TOTAL_QUESTIONS, 0);
      player.wrong = asInt(m.wrong, 0, TOTAL_QUESTIONS, 0);
      player.skip = asInt(m.skip, 0, TOTAL_QUESTIONS, 0);
      player.finalMs = player.actualMs + player.wrong * WRONG_PENALTY + player.skip * SKIP_PENALTY;
      player.lastProgressMs = player.actualMs;
      // 逐题对错 / 逐题耗时：校验后存储并下发，供结果页「逐题对决」与战报
      player.results = Array.isArray(m.results)
        ? m.results.slice(0, TOTAL_QUESTIONS).map(function (v) { return v ? 1 : 0; })
        : null;
      player.qms = Array.isArray(m.qms)
        ? m.qms.slice(0, TOTAL_QUESTIONS).map(function (v) {
            var n = parseInt(v, 10); return (n >= 0 && n <= 600000) ? n : 0;
          })
        : null;
      broadcastState(room);
      maybeFinishRound(room);
    } else if (m.t === 'again') {
      if (room.hostCid !== player.cid) {
        fail('HOST_ONLY', '只有房主可以发起下一局');
        return;
      }
      if (room.phase !== 'done') return;
      room.round = (room.round || 1) + 1;
      room.phase = 'lobby';
      room.startedAt = null;
      room.lastLobbyActivityAt = Date.now();
      room.players.forEach(function (p, cid) { if (!p.online) room.players.delete(cid); });
      if (!room.players.has(room.hostCid)) pickNewHost(room);
      resetProgress(room);
      room.players.forEach(function (p) { p.ready = false; });
      broadcastState(room);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', c: Number.isFinite(Number(m.c)) ? Number(m.c) : null, s: Date.now() });
    } else if (m.t === 'leave') {
      const leaving = player;
      if (room.phase === 'lobby') {
        room.players.delete(leaving.cid);
        if (room.hostCid === leaving.cid) pickNewHost(room);
        player = null;
        if (room.players.size === 0) rooms.delete(room.code);
        else broadcastState(room);
      } else {
        // 对局中/结算后保留成绩座位，避免一人返回首页后另一人的战报突然消失。
        leaving.online = false;
        leaving.ws = null;
        leaving.disconnectedAt = Date.now();
        if (room.hostCid === leaving.cid) pickNewHost(room);
        player = null;
        broadcastState(room);
        maybeFinishRound(room);
        scheduleFinishCheck(room);
        scheduleGC(room);
      }
      try { ws.close(1000, 'left room'); } catch (e) {}
    }
  });

  ws.on('close', function () {
    clearTimeout(joinTimer);
    liveConnections = Math.max(0, liveConnections - 1);
    const remainingForIp = Math.max(0, (liveConnectionsByIp.get(clientIp) || 1) - 1);
    if (remainingForIp) liveConnectionsByIp.set(clientIp, remainingForIp);
    else liveConnectionsByIp.delete(clientIp);
    if (!player) return;
    player.online = false;
    player.ws = null;
    player.disconnectedAt = Date.now();
    const room = player._room;
    if (room && rooms.get(room.code) === room) {
      if (room.hostCid === player.cid) pickNewHost(room);
      broadcastState(room);
      scheduleFinishCheck(room);
      scheduleGC(room);
    }
  });

  ws.on('error', function () { /* close 会紧随处理 */ });
});

// WebSocket 心跳：及时清理移动网络留下的“半开连接”，让重连和房主转移更可靠。
const heartbeatTimer = setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);
heartbeatTimer.unref();
wss.on('close', function () { clearInterval(heartbeatTimer); });

server.listen(PORT, function () {
  console.log('[24vs] relay listening on :' + PORT + '  (wss 与 http 同端口)');
});
