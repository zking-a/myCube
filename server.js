'use strict';
/*
 * server.js —— 轻量游戏站联机与静态资源服务器
 *
 * 作用：静态托管小游戏，并为 24 点与中国跳棋提供独立的服务端权威联机房间。
 *   - 房间码就是随机种子，双方题目天然一致；服务端按同一规则复现题目并验证表达式。
 *   - 跳棋由服务端保存棋盘、校验回合和合法走法，双方客户端只负责固定阵营视角的展示。
 *   - 房间仍只保存在内存，不需要数据库，适合轻量双人对局。
 *
 * 24 点协议（JSON，UTF-8；跳棋协议见文件下方 /checkers-ws 处理器）
 *   客户端 → 服务端：
 *     {t:'join', room, nick, cid, token, intent:'create'|'join'}
 *     {t:'ready', v:true|false}
 *     {t:'start'}                        // 仅房主有效：开始本局
 *     {t:'prog', i, outcome, proof}       // outcome=correct|wrong|skip；proof=四数运算表达式
 *     {t:'done'}                          // 成绩由服务端按收到时间和逐题记录计算
 *     {t:'again'}                        // 房主发起下一局：round+1 并回到准备大厅
 *     {t:'ping'}
 *   服务端 → 客户端：
 *     {t:'session', cid, token}           // 仅发给当前连接，不广播
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
const Questions = require('./server_questions');
const CheckersCore = require('./public/checkers/checkers_core');

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
const MAX_PLAYERS_PER_ROOM = Math.max(2, parseInt(process.env.MAX_PLAYERS_PER_ROOM, 10) || 2);
const MAX_WS_PAYLOAD = 4096;         // 单条 WebSocket 消息最大字节数
const RATE_LIMIT = 20;               // 每连接每秒最多消息条数
const RATE_BURST = 40;               // 令牌桶初始容量（允许短时突发）
// MAX_CONNECTIONS 表示玩家席位，不再等同于底层 Socket 数；额外 Socket 专供握手与重连。
const MAX_CONNECTIONS = Math.max(1, parseInt(process.env.MAX_CONNECTIONS, 10) || 4);
const MAX_CONNECTIONS_PER_IP = Math.max(1, parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 2);
const MAX_SOCKET_CONNECTIONS = Math.max(MAX_CONNECTIONS + 1, parseInt(process.env.MAX_SOCKET_CONNECTIONS, 10) || (MAX_CONNECTIONS + 4));
const MAX_SOCKET_CONNECTIONS_PER_IP = Math.max(MAX_CONNECTIONS_PER_IP + 1, parseInt(process.env.MAX_SOCKET_CONNECTIONS_PER_IP, 10) || (MAX_CONNECTIONS_PER_IP + 2));
const JOIN_IDLE_MS = 8000;           // 未 join 的连接尽快释放，避免占满全局名额
const CONNECTION_ATTEMPT_LIMIT = Math.max(4, parseInt(process.env.CONNECTION_ATTEMPT_LIMIT, 10) || 12);
const CONNECTION_ATTEMPT_WINDOW = 60 * 1000;
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS, 10) || 0);
const MAX_RATE_LOG_IPS = Math.max(128, parseInt(process.env.MAX_RATE_LOG_IPS, 10) || 2048);
// 房间码字母表须与 public/24/net.js 完全一致：5 位，去掉易混的 I/O/0/1
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
/** roomCode -> 中国跳棋房间（与 24 点共用全服房间和席位上限） */
const checkersRooms = new Map();

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
    questions: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastLobbyActivityAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function createCheckersRoom(code) {
  const room = {
    code: code,
    phase: 'waiting',       // waiting | playing | done
    pieces: CheckersCore.createInitialPieces(),
    turn: 'red',
    moveNumber: 1,
    winner: '',
    hostCid: null,
    players: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    _gc: null
  };
  checkersRooms.set(code, room);
  return room;
}

function resetCheckersRoom(room) {
  room.pieces = CheckersCore.createInitialPieces();
  room.turn = 'red';
  room.moveNumber = 1;
  room.winner = '';
  room.phase = Array.from(room.players.values()).filter(function (p) { return p.online; }).length === 2 ? 'playing' : 'waiting';
  room.lastActivityAt = Date.now();
}

function checkersPlayerList(room) {
  return Array.from(room.players.values()).map(function (p) {
    return { cid: p.cid, nick: p.nick, color: p.color, online: p.online };
  });
}

function broadcastCheckersState(room) {
  const state = JSON.stringify({
    t: 'state',
    room: room.code,
    phase: room.phase,
    pieces: room.pieces,
    turn: room.turn,
    moveNumber: room.moveNumber,
    winner: room.winner,
    host: room.hostCid,
    players: checkersPlayerList(room)
  });
  room.players.forEach(function (p) { send(p.ws, state); });
}

function pickCheckersHost(room) {
  const next = Array.from(room.players.values()).find(function (p) { return p.online; }) || room.players.values().next().value;
  room.hostCid = next ? next.cid : null;
}

function scheduleCheckersGC(room) {
  if (room._gc) clearTimeout(room._gc);
  room._gc = setTimeout(function () {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    if (!anyOnline && checkersRooms.get(room.code) === room) checkersRooms.delete(room.code);
  }, ROOM_TTL);
}

function expireCheckersRoom(room, reason) {
  if (!room || checkersRooms.get(room.code) !== room) return;
  checkersRooms.delete(room.code);
  if (room._gc) { clearTimeout(room._gc); room._gc = null; }
  room.players.forEach(function (p) {
    send(p.ws, { t: 'err', code: 'ROOM_EXPIRED', msg: reason });
    if (p.ws) { try { p.ws.close(1000, 'room expired'); } catch (e) {} }
    p.online = false;
    p.ws = null;
  });
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
    p.lastProgressAt = null;
    p.participant = false;
  });
}

function countSeats() {
  let total = 0;
  rooms.forEach(function (room) { total += room.players.size; });
  checkersRooms.forEach(function (room) { total += room.players.size; });
  return total;
}

function countSeatsForIp(ip) {
  let total = 0;
  rooms.forEach(function (room) {
    room.players.forEach(function (p) { if (p.clientIp === ip) total++; });
  });
  checkersRooms.forEach(function (room) {
    room.players.forEach(function (p) { if (p.clientIp === ip) total++; });
  });
  return total;
}

function createReconnectToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function tokenMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
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
  if (!roomCreateLog.has(ip) && roomCreateLog.size >= MAX_RATE_LOG_IPS) return false;
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
  if (!connectionAttemptLog.has(ip) && connectionAttemptLog.size >= MAX_RATE_LOG_IPS) return false;
  arr.push(now);
  connectionAttemptLog.set(ip, arr);
  return true;
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip.slice(0, 64);
}

// 只有显式配置可信代理跳数后才读取 X-Forwarded-For；客户端自带的 CF 头不再受信。
function getClientIp(req) {
  const remote = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!TRUST_PROXY_HOPS) return remote;
  const forwarded = String(req.headers && req.headers['x-forwarded-for'] || '')
    .split(',').map(normalizeIp).filter(Boolean);
  if (forwarded.length < TRUST_PROXY_HOPS) return remote;
  return forwarded[forwarded.length - TRUST_PROXY_HOPS];
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
  checkersRooms.forEach(function (room, code) {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    const idleLimit = room.phase === 'waiting' ? LOBBY_IDLE_MS : ONLINE_ROOM_IDLE_MS;
    if (anyOnline && now - (room.lastActivityAt || room.createdAt) > idleLimit) {
      expireCheckersRoom(room, '跳棋房间长时间没有操作，已自动释放');
      return;
    }
    if (!anyOnline && now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL) {
      checkersRooms.delete(code);
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
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  // 规范化并防目录穿越：只允许访问 PUBLIC_DIR 内
  const rel = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '').replace(/^[\/\\]+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    writeHead(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  function respond(entry) {
    const useGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && !!entry.gzip;
    const body = useGzip ? entry.gzip : entry.data;
    const etag = useGzip ? entry.gzipEtag : entry.etag;
    if (req.headers['if-none-match'] === etag) {
      writeHead(res, 304, { ETag: etag, 'Cache-Control': entry.cacheControl, Vary: 'Accept-Encoding' });
      res.end();
      return;
    }
    writeHead(res, 200, {
      'Content-Type': entry.contentType,
      'Content-Length': body.length,
      'Cache-Control': entry.cacheControl,
      ETag: etag,
      Vary: 'Accept-Encoding',
      ...(useGzip ? { 'Content-Encoding': 'gzip' } : {})
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
    const ext = path.extname(filePath).toLowerCase();
    const hash = crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16);
    const canGzip = data.length > 1024 && /^(\.html|\.js|\.css|\.json|\.svg)$/.test(ext);
    const entry = {
      data: data,
      gzip: canGzip ? zlib.gzipSync(data, { level: 6 }) : null,
      etag: '"' + hash + '"',
      gzipEtag: '"' + hash + '-gzip"',
      contentType: MIME[ext] || 'application/octet-stream',
      cacheControl: ext === '.html' ? 'no-cache' : 'public, max-age=300, must-revalidate'
    };
    staticCache.set(filePath, entry);
    respond(entry);
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
    res.end(JSON.stringify({
      ok: true,
      service: 'light-games',
      rooms: rooms.size + checkersRooms.size,
      rooms24: rooms.size,
      roomsCheckers: checkersRooms.size,
      seats: countSeats(),
      sockets: liveConnections,
      ts: Date.now()
    }));
    return;
  }
  // 游戏目录使用稳定的尾斜杠 URL；旧数独入口继续可用。
  const routeRedirects = {
    '/24': '/24/',
    '/sudoku': '/sudoku/',
    '/sudoku.html': '/sudoku/',
    '/checkers': '/checkers/'
  };
  if (routeRedirects[urlPath]) {
    const query = (req.url || '').slice(urlPath.length);
    writeHead(res, 308, { Location: routeRedirects[urlPath] + query, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  serveStatic(req, res);
});
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

// ===================== WebSocket =====================
const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
const checkersWss = new WebSocket.Server({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

// 显式分发升级请求，避免多个 WebSocket.Server 各自监听 server 时互相抢占路径。
server.on('upgrade', function (req, socket, head) {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (e) {}
  const target = pathname === '/ws' ? wss : (pathname === '/checkers-ws' ? checkersWss : null);
  if (!target) { socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, function (ws) { target.emit('connection', ws, req); });
});

let liveConnections = 0;

wss.on('connection', function (ws, req) {
  const clientIp = getClientIp(req);

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
  if (ipConnections >= MAX_SOCKET_CONNECTIONS_PER_IP) {
    ws.close(1013, 'too many connections from this ip');
    return;
  }
  if (liveConnections >= MAX_SOCKET_CONNECTIONS) {
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
        ? m.nick.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 16) : '玩家';
      const reconnectToken = typeof m.token === 'string' ? m.token.slice(0, 128) : '';
      const intent = m.intent === 'create' || m.intent === 'join' ? m.intent : 'legacy';

      let room = rooms.get(code);
      if (!room) {
        if (intent === 'join') {
          fail('ROOM_NOT_FOUND', '房间不存在或已失效，请向房主确认房间码');
          return;
        }
        if (countSeats() >= MAX_CONNECTIONS || countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试');
          return;
        }
        // ---- 单 IP 建房限速：防单 IP 占满全部房间导致所有正常用户被拒 ----
        if (!checkRoomCreateLimit(clientIp)) {
          fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试');
          return;
        }
        // ---- 全服房间数上限 ----
        if (rooms.size + checkersRooms.size >= MAX_ROOMS) {
          fail('SERVER_FULL', '服务器房间已满，请稍后再试');
          return;
        }
        room = createRoom(code);
      } else if (intent === 'create') {
        // 建房成功后的首个 state 可能在弱网中丢失；同一 cid 的离线座位仍按重连处理。
        const ownSeat = room.players.get(cid);
        if (!ownSeat) {
          fail('ROOM_EXISTS', '房间码碰巧重复，正在换一个新房间码');
          return;
        }
        if (!tokenMatches(ownSeat.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '重连身份已失效，请退出房间后重新加入');
          return;
        }
      }

      let p = room.players.get(cid);
      let replacedSocket = null;
      if (p) {
        // 重连令牌由服务器签发且不广播；只有持令牌者可以恢复或替换旧半开连接。
        if (!tokenMatches(p.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '无法验证该玩家身份，请退出房间后重新加入');
          return;
        }
        replacedSocket = p.ws && p.ws !== ws ? p.ws : null;
        p.ws = ws;
        p.nick = nick;
        p.clientIp = clientIp;
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
        if (countSeats() >= MAX_CONNECTIONS) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试');
          return;
        }
        if (countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('IP_PLAYER_LIMIT', '当前网络加入的玩家数已达上限');
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
          lastProgressMs: 0, lastProgressAt: null, participant: false,
          disconnectedAt: null, clientIp: clientIp,
          reconnectToken: createReconnectToken(), _room: room
        };
        room.players.set(cid, p);
        if (!room.hostCid) room.hostCid = cid;
      }
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = p;
      send(ws, { t: 'session', cid: p.cid, token: p.reconnectToken });
      if (replacedSocket) { try { replacedSocket.terminate(); } catch (e) {} }
      room.lastActivityAt = Date.now();
      if (room.phase === 'lobby') room.lastLobbyActivityAt = room.lastActivityAt;
      clearTimeout(joinTimer); // 已加入，取消空连接超时
      if (room.phase === 'playing') scheduleFinishCheck(room);
      broadcastState(room);
      return;
    }

    if (!player) return; // 其余指令需先 join
    if (player.ws !== ws) { try { ws.close(1008, 'session replaced'); } catch (e) {} return; }
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
      room.questions = Questions.buildRoomQuestions(room.code + '#' + room.round, TOTAL_QUESTIONS);
      resetProgress(room);
      room.players.forEach(function (p) {
        p.participant = p.online;
        p.ready = false;
      });
      broadcastState(room);
      broadcastStart(room);
    } else if (m.t === 'prog') {
      if (room.phase !== 'playing' || !player.participant || player.done) return;
      if (!room.startedAt || now < room.startedAt) {
        fail('ROUND_NOT_STARTED', '倒计时尚未结束');
        return;
      }
      const index = asInt(m.i, 0, TOTAL_QUESTIONS - 1, -1);
      if (index < 0 || index !== (player.prog || 0)) return;
      const outcome = m.outcome === 'correct' || m.outcome === 'wrong' || m.outcome === 'skip' ? m.outcome : '';
      if (!outcome) {
        fail('CLIENT_OUTDATED', '客户端版本过旧，请刷新页面后重新进入');
        return;
      }
      const expected = room.questions && room.questions[index];
      if (!expected || (outcome !== 'skip' && !Questions.verifyProof(m.proof, expected.numbers, outcome === 'correct'))) {
        fail('INVALID_PROOF', '本题运算记录校验失败，请刷新后重试');
        return;
      }
      const elapsed = Math.max(0, now - room.startedAt);
      player.prog = index + 1;
      if (!player.results) player.results = [];
      if (!player.qms) player.qms = [];
      player.results[index] = outcome === 'correct' ? 1 : 0;
      player.qms[index] = Math.max(0, elapsed - (player.lastProgressMs || 0));
      player.lastProgressMs = elapsed;
      player.lastProgressAt = now;
      if (outcome === 'correct') player.correct++;
      else if (outcome === 'wrong') player.wrong++;
      else player.skip++;
      broadcastState(room);
    } else if (m.t === 'done') {
      if (room.phase !== 'playing' || !player.participant || player.done) return;
      if (player.prog !== TOTAL_QUESTIONS) {
        fail('ROUND_INCOMPLETE', '还有题目尚未提交，暂时不能交卷');
        return;
      }
      player.done = true;
      player.prog = TOTAL_QUESTIONS;
      player.actualMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, now - room.startedAt));
      player.finalMs = player.actualMs + player.wrong * WRONG_PENALTY + player.skip * SKIP_PENALTY;
      player.lastProgressMs = player.actualMs;
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
      room.questions = null;
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
    // 该座位已被携带有效令牌的新连接接管，旧 Socket 关闭不能把新连接标成离线。
    if (player.ws !== ws) { player = null; return; }
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

// ===================== 中国跳棋 WebSocket =====================
// 服务端持有唯一棋局状态；客户端只能提交起点和终点，不能自行声明回合或胜负。
checkersWss.on('connection', function (ws, req) {
  const clientIp = getClientIp(req);
  const origin = req && req.headers && req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    const ok = origin === ALLOWED_ORIGIN ||
      (host && (origin === 'https://' + host || origin === 'http://' + host)) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!ok) { ws.close(1008, 'origin not allowed'); return; }
  }
  if (!checkConnectionAttemptLimit(clientIp)) { ws.close(1013, 'too many connection attempts'); return; }
  const ipConnections = liveConnectionsByIp.get(clientIp) || 0;
  if (ipConnections >= MAX_SOCKET_CONNECTIONS_PER_IP) { ws.close(1013, 'too many connections from this ip'); return; }
  if (liveConnections >= MAX_SOCKET_CONNECTIONS) { ws.close(1013, 'too many connections'); return; }

  liveConnections++;
  liveConnectionsByIp.set(clientIp, ipConnections + 1);
  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });

  let tokens = RATE_BURST;
  let lastRefill = Date.now();
  let player = null;

  function fail(code, msg) { send(ws, { t: 'err', code: code, msg: msg }); }
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
      if (player) return;
      const code = String(m.room || '').toUpperCase();
      if (!ROOM_CODE_RE.test(code)) { fail('ROOM_INVALID', '房间码格式不正确'); return; }
      const cid = typeof m.cid === 'string' ? m.cid.slice(0, 32) : '';
      if (!cid || cid.length < 4) { fail('SESSION_INVALID', '玩家身份格式不正确'); return; }
      const nick = typeof m.nick === 'string' && m.nick.trim()
        ? m.nick.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 16) : '玩家';
      const reconnectToken = typeof m.token === 'string' ? m.token.slice(0, 128) : '';
      const intent = m.intent === 'create' ? 'create' : 'join';

      let room = checkersRooms.get(code);
      if (!room) {
        if (intent !== 'create') { fail('ROOM_NOT_FOUND', '房间不存在或已失效，请向房主确认房间码'); return; }
        if (countSeats() >= MAX_CONNECTIONS || countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return;
        }
        if (!checkRoomCreateLimit(clientIp)) { fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试'); return; }
        if (rooms.size + checkersRooms.size >= MAX_ROOMS) { fail('SERVER_FULL', '服务器房间已满，请稍后再试'); return; }
        room = createCheckersRoom(code);
      } else if (intent === 'create') {
        const ownSeat = room.players.get(cid);
        if (!ownSeat) { fail('ROOM_EXISTS', '房间码碰巧重复，请重新创建'); return; }
        if (!tokenMatches(ownSeat.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '重连身份已失效，请退出房间后重新加入'); return;
        }
      }

      let p = room.players.get(cid);
      let replacedSocket = null;
      if (p) {
        if (!tokenMatches(p.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '无法验证该玩家身份，请退出房间后重新加入'); return;
        }
        replacedSocket = p.ws && p.ws !== ws ? p.ws : null;
        p.ws = ws;
        p.nick = nick;
        p.online = true;
        p.clientIp = clientIp;
        p.disconnectedAt = null;
        p._room = room;
      } else {
        if (room.phase !== 'waiting') { fail('ROUND_IN_PROGRESS', '棋局已经开始，暂时不能加入'); return; }
        if (countSeats() >= MAX_CONNECTIONS) { fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return; }
        if (countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) { fail('IP_PLAYER_LIMIT', '当前网络加入的玩家数已达上限'); return; }
        if (room.players.size >= 2) { fail('ROOM_FULL', '该跳棋房间已有两位玩家'); return; }
        const redTaken = Array.from(room.players.values()).some(function (seat) { return seat.color === 'red'; });
        p = {
          cid: cid,
          nick: nick,
          color: redTaken ? 'blue' : 'red',
          ws: ws,
          online: true,
          clientIp: clientIp,
          disconnectedAt: null,
          reconnectToken: createReconnectToken(),
          _room: room
        };
        room.players.set(cid, p);
        if (!room.hostCid) room.hostCid = cid;
      }

      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = p;
      send(ws, { t: 'session', cid: p.cid, token: p.reconnectToken });
      if (replacedSocket) { try { replacedSocket.terminate(); } catch (e) {} }
      if (room.phase === 'waiting' && room.players.size === 2 &&
          Array.from(room.players.values()).every(function (seat) { return seat.online; })) room.phase = 'playing';
      room.lastActivityAt = Date.now();
      clearTimeout(joinTimer);
      broadcastCheckersState(room);
      return;
    }

    if (!player) return;
    if (player.ws !== ws) { try { ws.close(1008, 'session replaced'); } catch (e) {} return; }
    const room = player._room;
    if (!room || checkersRooms.get(room.code) !== room) return;
    if (m.t !== 'ping') room.lastActivityAt = Date.now();

    if (m.t === 'move') {
      if (room.phase !== 'playing' || room.winner) return;
      if (room.players.size !== 2 || !Array.from(room.players.values()).every(function (seat) { return seat.online; })) {
        fail('OPPONENT_OFFLINE', '对手已离线，正在等待其重连'); return;
      }
      if (player.color !== room.turn) { fail('NOT_YOUR_TURN', '还没有轮到你走'); return; }
      if (Number(m.seq) !== room.moveNumber) { fail('STATE_OUTDATED', '棋局状态已更新，请按最新棋盘走棋'); broadcastCheckersState(room); return; }
      const from = typeof m.from === 'string' ? m.from.slice(0, 12) : '';
      const target = typeof m.target === 'string' ? m.target.slice(0, 12) : '';
      const applied = CheckersCore.applyMove(room.pieces, player.color, from, target);
      if (!applied) { fail('ILLEGAL_MOVE', '这一步不符合跳棋规则'); return; }
      room.pieces = applied.pieces;
      room.moveNumber++;
      if (applied.winner) {
        room.winner = applied.winner;
        room.phase = 'done';
      } else room.turn = player.color === 'red' ? 'blue' : 'red';
      broadcastCheckersState(room);
    } else if (m.t === 'again') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以发起下一局'); return; }
      if (room.phase !== 'done') return;
      resetCheckersRoom(room);
      broadcastCheckersState(room);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', s: Date.now() });
    } else if (m.t === 'leave') {
      room.players.delete(player.cid);
      if (room.hostCid === player.cid) pickCheckersHost(room);
      player = null;
      if (!room.players.size) {
        checkersRooms.delete(room.code);
        if (room._gc) clearTimeout(room._gc);
      } else {
        resetCheckersRoom(room);
        broadcastCheckersState(room);
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
    if (player.ws !== ws) { player = null; return; }
    player.online = false;
    player.ws = null;
    player.disconnectedAt = Date.now();
    const room = player._room;
    if (room && checkersRooms.get(room.code) === room) {
      room.lastActivityAt = Date.now();
      broadcastCheckersState(room);
      scheduleCheckersGC(room);
    }
  });
  ws.on('error', function () {});
});

// WebSocket 心跳：及时清理移动网络留下的“半开连接”，让重连和房主转移更可靠。
const heartbeatTimer = setInterval(function () {
  [wss, checkersWss].forEach(function (socketServer) {
    socketServer.clients.forEach(function (ws) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  });
}, 30000);
heartbeatTimer.unref();
wss.on('close', function () { if (!checkersWss.clients.size) clearInterval(heartbeatTimer); });
checkersWss.on('close', function () { if (!wss.clients.size) clearInterval(heartbeatTimer); });

server.listen(PORT, function () {
  console.log('[light-games] relay listening on :' + PORT + '  (24点 /ws，跳棋 /checkers-ws)');
});
