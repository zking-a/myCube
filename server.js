'use strict';
/*
 * server.js —— 轻量游戏站联机与静态资源服务器
 *
 * 作用：静态托管小游戏，并为 24 点、中国跳棋、数独、飞行棋与五子棋提供独立的联机房间。
 *   - 房间码就是随机种子，双方题目天然一致；服务端按同一规则复现题目并验证表达式。
 *   - 跳棋由服务端保存棋盘、校验回合和合法走法，双方客户端只负责固定阵营视角的展示。
 *   - 数独协作由服务端保存同一盘面，双方只提交填写，避免客户端各自漂移。
 *   - 飞行棋由服务端掷骰并校验 2–4 人回合、移动与胜负，客户端只提交操作意图。
 *   - 五子棋由服务端校验回合、落子和胜负，客户端只提交落子意图。
 *   - 房间仍只保存在内存，不需要数据库，适合轻量好友对局。
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
const { Worker } = require('node:worker_threads');
const WebSocket = require('ws');
const Questions = require('./server_questions');
const CheckersCore = require('./public/checkers/checkers_core');
const FlightChessCore = require('./public/flight-chess/flight_chess_core');
const GomokuCore = require('./public/gomoku/gomoku_core');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SYNC_DELAY = 2000;     // 开局同步缓冲(ms)，给两端网络延迟留余量
const ROOM_TTL = 5 * 60 * 1000; // 房间内全员离线后保留时长，超时回收
const LOBBY_IDLE_MS = Math.max(60 * 1000, parseInt(process.env.LOBBY_IDLE_MS, 10) || 5 * 60 * 1000);
const ONLINE_ROOM_IDLE_MS = Math.max(5 * 60 * 1000, parseInt(process.env.ONLINE_ROOM_IDLE_MS, 10) || 15 * 60 * 1000);
// 只有一人的等待房间使用不可续期的绝对寿命，避免持续发消息永久占住稀缺房间。
const UNMATCHED_ROOM_TTL_MS = Math.max(60 * 1000, parseInt(process.env.UNMATCHED_ROOM_TTL_MS, 10) || 2 * 60 * 1000);
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
// 飞行棋最多四人；默认允许同一家庭网络的四台设备坐满一局。
const MAX_CONNECTIONS_PER_IP = Math.max(1, parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 4);
const MAX_ROOMS_PER_IP = Math.max(1, parseInt(process.env.MAX_ROOMS_PER_IP, 10) || 1);
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
/** roomCode -> 数独好友协作房间（双方实时编辑同一盘面） */
const sudokuRooms = new Map();
/** roomCode -> 飞行棋房间（2–4 人，服务端权威骰点与棋局） */
const flightChessRooms = new Map();
/** roomCode -> 五子棋房间（2 人，服务端权威落子与胜负判定） */
const gomokuRooms = new Map();

function createRoom(code, creatorIp) {
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
    creatorIp: creatorIp || '',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastLobbyActivityAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

/** 联机真人固定为红蓝对家；三人房额外使用右上营地，保证蓝方始终存在。 */
function planCheckersSeats(botCount) {
  const total = Math.max(2, Math.min(6, 2 + botCount));
  const camps = total === 3 ? ['top', 'ur', 'bottom'] : CheckersCore.SEAT_LAYOUTS[total];
  const humanCamps = ['top', 'bottom'];
  return camps.map(function (camp) {
    return { camp: camp, color: CheckersCore.CAMP_COLORS[camp], isBot: humanCamps.indexOf(camp) < 0, cid: '', nick: '' };
  });
}

function createCheckersRoom(code, creatorIp, botCount, botLevel) {
  const seats = planCheckersSeats(botCount);
  const room = {
    code: code,
    phase: 'waiting',       // waiting | opening | playing | done
    round: 0,
    openingReady: new Set(),
    seats: seats,
    botLevel: ['easy', 'normal', 'hard'].indexOf(botLevel) >= 0 ? botLevel : 'normal',
    pieces: CheckersCore.createInitialPiecesForSeats(seats.map(function (seat) { return seat.camp; })),
    turn: seats[0].color,
    moveNumber: 1,
    winner: '',
    lastMove: null,
    hostCid: null,
    creatorIp: creatorIp || '',
    players: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    _gc: null,
    _botTimer: null
  };
  checkersRooms.set(code, room);
  return room;
}

function checkersHumansOnline(room) {
  return room.seats.every(function (seat) {
    if (seat.isBot) return true;
    const player = seat.cid ? room.players.get(seat.cid) : null;
    return !!(player && player.online);
  });
}

function resetCheckersRoom(room) {
  clearCheckersBotTimer(room);
  room.openingReady.clear();
  room.pieces = CheckersCore.createInitialPiecesForSeats(room.seats.map(function (seat) { return seat.camp; }));
  room.turn = room.seats[0].color;
  room.moveNumber = 1;
  room.winner = '';
  room.lastMove = null;
  room.phase = 'waiting';
  room.lastActivityAt = Date.now();
}

function startCheckersRoom(room) {
  if (room.phase !== 'waiting' || !checkersHumansOnline(room)) return false;
  room.round++;
  room.openingReady.clear();
  room.phase = 'opening';
  room.lastActivityAt = Date.now();
  return true;
}

function clearCheckersBotTimer(room) {
  if (room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
  const job = room._botJob;
  room._botJob = null;
  if (job) {
    clearTimeout(job.timeout);
    if (job.worker) job.worker.terminate().catch(function () {});
  }
}

function checkersSeatForColor(room, color) {
  return room.seats.find(function (seat) { return seat.color === color; }) || null;
}

/** 与客户端 advanceTurn 同语义：从当前行动方之后找第一个有棋可走的席位，全员卡死则顺延下一位。 */
function nextCheckersTurn(room, fromColor) {
  const colors = room.seats.map(function (seat) { return seat.color; });
  const start = Math.max(0, colors.indexOf(fromColor));
  for (let i = 1; i < colors.length; i++) {
    const candidate = colors[(start + i) % colors.length];
    if (CheckersCore.listMoves(room.pieces, candidate).length) return candidate;
  }
  return colors[(start + 1) % colors.length];
}

/** 真人与电脑共用同一套权威走子校验与状态推进。 */
function checkersApplyMove(room, color, from, target) {
  const applied = CheckersCore.applyMove(room.pieces, color, from, target);
  if (!applied) return null;
  room.lastActivityAt = Date.now();
  room.pieces = applied.pieces;
  room.lastMove = {
    player: color,
    from: from,
    target: target,
    kind: applied.kind,
    path: applied.path,
    moveNumber: room.moveNumber
  };
  room.moveNumber++;
  if (applied.winner) {
    room.winner = applied.winner;
    room.phase = 'done';
  } else room.turn = nextCheckersTurn(room, color);
  return applied;
}

/** 电脑走子由服务器托管：稍作延迟再落子，与真人走子走同一条校验与广播链路。 */
function scheduleCheckersBotMove(room) {
  clearCheckersBotTimer(room);
  if (!room || checkersRooms.get(room.code) !== room) return;
  if (room.phase !== 'playing' || room.winner) return;
  const seat = checkersSeatForColor(room, room.turn);
  if (!seat || !seat.isBot) return;
  room._botTimer = setTimeout(function () { runCheckersBotMove(room); }, 700);
}

function runCheckersBotMove(room) {
  room._botTimer = null;
  if (!room || checkersRooms.get(room.code) !== room) return;
  if (room.phase !== 'playing' || room.winner) return;
  const seat = checkersSeatForColor(room, room.turn);
  if (!seat || !seat.isBot) return;
  const snapshot = room.pieces, sequence = room.moveNumber;
  const job = { worker: null, timeout: null };
  room._botJob = job;
  const finish = function (move) {
    if (room._botJob !== job) return;
    clearCheckersBotTimer(room);
    // A restarted/expired room must never accept a result from the previous board.
    if (checkersRooms.get(room.code) !== room || room.phase !== 'playing' || room.winner ||
        room.pieces !== snapshot || room.moveNumber !== sequence || room.turn !== seat.color) return;
    if (!move || !CheckersCore.applyMove(snapshot, seat.color, move.from, move.target)) {
      move = CheckersCore.listMoves(snapshot, seat.color).sort(function (a, b) {
        return CheckersCore.moveScore(snapshot, seat.color, b) - CheckersCore.moveScore(snapshot, seat.color, a);
      })[0];
    }
    if (move) checkersApplyMove(room, seat.color, move.from, move.target);
    else room.turn = nextCheckersTurn(room, seat.color);
    broadcastCheckersState(room);
    scheduleCheckersBotMove(room);
  };
  try {
    job.worker = new Worker(path.join(__dirname, 'scripts/checkers_bot_worker.js'), {
      workerData: { pieces: snapshot, player: seat.color, seats: room.seats.map(function (s) { return s.color; }),
        level: room.botLevel, seed: sequence * 104729 + room.seats.length }
    });
    job.worker.once('message', function (result) { finish(result && result.move); });
    job.worker.once('error', function () { finish(null); });
    job.worker.once('exit', function () { if (room._botJob === job) finish(null); });
    job.timeout = setTimeout(function () { finish(null); }, 3000);
  } catch (error) {
    finish(null);
  }
}

// 创建新房间前，释放同一 IP 遗留的“单人等待房”（房主已离开但房间未被 GC），
// 否则 MAX_ROOMS_PER_IP 会把强制退出后的再次建房挡在门外（表现为“提示已存在房间”）。
function releaseAbandonedCheckersRoomsForIp(ip) {
  checkersRooms.forEach(function (room) {
    if (room.creatorIp !== ip || room.phase !== 'waiting' || room.players.size > 1) return;
    const hasOpenPlayer = Array.from(room.players.values()).some(function (player) {
      return player.online && player.ws && player.ws.readyState === WebSocket.OPEN;
    });
    if (!hasOpenPlayer) expireCheckersRoom(room, '旧的跳棋等待房已由新房间替换');
  });
}

function createSudokuRoom(code, creatorIp, puzzle, difficulty) {
  const room = {
    code: code,
    phase: 'waiting', // waiting | playing | done
    solution: puzzle.solution.slice(),
    givens: puzzle.givens.slice(),
    board: puzzle.givens.slice(),
    difficulty: difficulty,
    startedAt: null,
    finishedAt: null,
    lastEditorCid: '',
    creatorIp: creatorIp || '',
    players: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    _gc: null
  };
  sudokuRooms.set(code, room);
  return room;
}

// 与五子棋/飞行棋同款兜底：释放同一 IP 遗留的“单人协作等待房”，避免再次创建时被 IP 房间上限拦截。
function releaseAbandonedSudokuRoomsForIp(ip) {
  sudokuRooms.forEach(function (room) {
    if (room.creatorIp !== ip || room.phase !== 'waiting' || room.players.size > 1) return;
    const hasOpenPlayer = Array.from(room.players.values()).some(function (player) {
      return player.online && player.ws && player.ws.readyState === WebSocket.OPEN;
    });
    if (!hasOpenPlayer) expireSudokuRoom(room, '旧的协作等待房已由新房间替换');
  });
}

function createFlightChessRoom(code, creatorIp, capacity) {
  const room = {
    code: code,
    phase: 'waiting', // waiting | playing | done
    capacity: FlightChessCore.normalizePlayerCount(capacity),
    round: 1,
    revision: 0,
    game: null,
    hostCid: null,
    creatorIp: creatorIp || '',
    players: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    _gc: null
  };
  flightChessRooms.set(code, room);
  return room;
}

function flightChessPlayerList(room) {
  const colors = FlightChessCore.createGame(room.capacity).players.map(function (player) { return player.colorId; });
  return Array.from(room.players.values()).sort(function (a, b) { return a.seat - b.seat; }).map(function (player) {
    return {
      cid: player.cid,
      nick: player.nick,
      seat: player.seat,
      colorId: colors[player.seat],
      online: player.online
    };
  });
}

function broadcastFlightChessState(room) {
  const state = JSON.stringify({
    t: 'state',
    room: room.code,
    phase: room.phase,
    capacity: room.capacity,
    round: room.round,
    revision: room.revision,
    host: room.hostCid,
    players: flightChessPlayerList(room),
    game: room.game,
    serverNow: Date.now()
  });
  room.players.forEach(function (player) { send(player.ws, state); });
}

function pickFlightChessHost(room) {
  const next = Array.from(room.players.values()).sort(function (a, b) { return a.seat - b.seat; })
    .find(function (player) { return player.online; }) || room.players.values().next().value;
  room.hostCid = next ? next.cid : null;
}

function nextFlightChessSeat(room) {
  const used = new Set(Array.from(room.players.values()).map(function (player) { return player.seat; }));
  for (let seat = 0; seat < room.capacity; seat++) if (!used.has(seat)) return seat;
  return -1;
}

function startFlightChessGame(room, nextRound) {
  const players = Array.from(room.players.values()).sort(function (a, b) { return a.seat - b.seat; });
  if (nextRound) room.round += 1;
  room.game = FlightChessCore.createGame(room.capacity, players.map(function (player) { return player.nick; }));
  room.phase = 'playing';
  room.revision += 1;
  room.lastActivityAt = Date.now();
}

function resetFlightChessWaitingRoom(room) {
  room.phase = 'waiting';
  room.game = null;
  room.revision += 1;
  room.createdAt = Date.now();
  room.lastActivityAt = Date.now();
}

function scheduleFlightChessGC(room) {
  if (room._gc) clearTimeout(room._gc);
  room._gc = setTimeout(function () {
    const anyOnline = Array.from(room.players.values()).some(function (player) { return player.online; });
    if (!anyOnline && flightChessRooms.get(room.code) === room) flightChessRooms.delete(room.code);
  }, ROOM_TTL);
}

function expireFlightChessRoom(room, reason) {
  if (!room || flightChessRooms.get(room.code) !== room) return;
  flightChessRooms.delete(room.code);
  if (room._gc) { clearTimeout(room._gc); room._gc = null; }
  room.players.forEach(function (player) {
    send(player.ws, { t: 'err', code: 'ROOM_EXPIRED', msg: reason });
    if (player.ws) { try { player.ws.close(1000, 'room expired'); } catch (error) {} }
    player.online = false;
    player.ws = null;
  });
}

// 创建新房前回收同一来源已经完全离线的单人等待房。
// 这样浏览器返回大厅或异常关闭后可以立即重建，同时不会踢掉仍在线的房主。
function releaseAbandonedFlightChessRoomsForIp(ip) {
  flightChessRooms.forEach(function (room) {
    if (room.creatorIp !== ip || room.phase !== 'waiting' || room.players.size > 1) return;
    const hasOpenPlayer = Array.from(room.players.values()).some(function (player) {
      return player.online && player.ws && player.ws.readyState === WebSocket.OPEN;
    });
    if (!hasOpenPlayer) expireFlightChessRoom(room, '旧的飞行棋等待房已由新房间替换');
  });
}

// ===================== 五子棋房间（2 人，服务端权威落子） =====================

function createGomokuRoom(code, creatorIp) {
  const room = {
    code: code,
    phase: 'waiting', // waiting | playing | done
    capacity: 2,
    round: 1,
    revision: 0,
    game: null,
    hostCid: null,
    creatorIp: creatorIp || '',
    players: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    _gc: null
  };
  gomokuRooms.set(code, room);
  return room;
}

function gomokuPlayerList(room) {
  return Array.from(room.players.values()).sort(function (a, b) { return a.seat - b.seat; }).map(function (player) {
    return {
      cid: player.cid,
      nick: player.nick,
      seat: player.seat,
      color: GomokuCore.seatColor(player.seat),
      online: player.online
    };
  });
}

function broadcastGomokuState(room) {
  const state = JSON.stringify({
    t: 'state',
    room: room.code,
    phase: room.phase,
    capacity: room.capacity,
    round: room.round,
    revision: room.revision,
    host: room.hostCid,
    players: gomokuPlayerList(room),
    game: GomokuCore.publicGame(room.game),
    serverNow: Date.now()
  });
  room.players.forEach(function (player) { send(player.ws, state); });
}

function pickGomokuHost(room) {
  const next = Array.from(room.players.values()).sort(function (a, b) { return a.seat - b.seat; })
    .find(function (player) { return player.online; }) || room.players.values().next().value;
  room.hostCid = next ? next.cid : null;
}

function nextGomokuSeat(room) {
  const used = new Set(Array.from(room.players.values()).map(function (player) { return player.seat; }));
  for (let seat = 0; seat < 2; seat++) if (!used.has(seat)) return seat;
  return -1;
}

function startGomokuGame(room, nextRound) {
  const players = Array.from(room.players.values()).sort(function (a, b) { return a.seat - b.seat; });
  if (nextRound) room.round += 1;
  room.game = GomokuCore.createGame(players.map(function (player) { return player.nick; }));
  room.phase = 'playing';
  room.revision += 1;
  room.lastActivityAt = Date.now();
}

function resetGomokuWaitingRoom(room) {
  room.phase = 'waiting';
  room.game = null;
  room.revision += 1;
  room.createdAt = Date.now();
  room.lastActivityAt = Date.now();
}

function scheduleGomokuGC(room) {
  if (room._gc) clearTimeout(room._gc);
  room._gc = setTimeout(function () {
    const anyOnline = Array.from(room.players.values()).some(function (player) { return player.online; });
    if (!anyOnline && gomokuRooms.get(room.code) === room) gomokuRooms.delete(room.code);
  }, ROOM_TTL);
}

function expireGomokuRoom(room, reason) {
  if (!room || gomokuRooms.get(room.code) !== room) return;
  gomokuRooms.delete(room.code);
  if (room._gc) { clearTimeout(room._gc); room._gc = null; }
  room.players.forEach(function (player) {
    send(player.ws, { t: 'err', code: 'ROOM_EXPIRED', msg: reason });
    if (player.ws) { try { player.ws.close(1000, 'room expired'); } catch (error) {} }
    player.online = false;
    player.ws = null;
  });
}

// 与飞行棋同策略：建房前回收同来源已完全离线的单人等待房。
function releaseAbandonedGomokuRoomsForIp(ip) {
  gomokuRooms.forEach(function (room) {
    if (room.creatorIp !== ip || room.phase !== 'waiting' || room.players.size > 1) return;
    const hasOpenPlayer = Array.from(room.players.values()).some(function (player) {
      return player.online && player.ws && player.ws.readyState === WebSocket.OPEN;
    });
    if (!hasOpenPlayer) expireGomokuRoom(room, '旧的五子棋等待房已由新房间替换');
  });
}

function sudokuPlayerList(room) {
  return Array.from(room.players.values()).map(function (p) {
    return { cid: p.cid, seat: p.seat, online: p.online };
  });
}

function broadcastSudokuState(room) {
  const state = JSON.stringify({
    t: 'state', room: room.code, phase: room.phase,
    solution: room.solution, givens: room.givens, board: room.board,
    difficulty: room.difficulty, startedAt: room.startedAt, finishedAt: room.finishedAt, lastEditor: room.lastEditorCid,
    serverNow: Date.now(), players: sudokuPlayerList(room)
  });
  room.players.forEach(function (p) { send(p.ws, state); });
}

function scheduleSudokuGC(room) {
  if (room._gc) clearTimeout(room._gc);
  room._gc = setTimeout(function () {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    if (!anyOnline && sudokuRooms.get(room.code) === room) sudokuRooms.delete(room.code);
  }, ROOM_TTL);
}

function expireSudokuRoom(room, reason) {
  if (!room || sudokuRooms.get(room.code) !== room) return;
  sudokuRooms.delete(room.code);
  if (room._gc) { clearTimeout(room._gc); room._gc = null; }
  room.players.forEach(function (p) {
    send(p.ws, { t: 'err', code: 'ROOM_EXPIRED', msg: reason });
    if (p.ws) { try { p.ws.close(1000, 'room expired'); } catch (e) {} }
    p.online = false;
    p.ws = null;
  });
}

function isSudokuSolution(values) {
  if (!Array.isArray(values) || values.length !== 81 || !values.every(function (v) { return Number.isInteger(v) && v >= 1 && v <= 9; })) return false;
  for (let group = 0; group < 9; group++) {
    const row = new Set(), col = new Set(), box = new Set();
    for (let i = 0; i < 9; i++) {
      row.add(values[group * 9 + i]);
      col.add(values[i * 9 + group]);
      const r = Math.floor(group / 3) * 3 + Math.floor(i / 3);
      const c = (group % 3) * 3 + (i % 3);
      box.add(values[r * 9 + c]);
    }
    if (row.size !== 9 || col.size !== 9 || box.size !== 9) return false;
  }
  return true;
}

function isSudokuPuzzle(solution, givens) {
  return isSudokuSolution(solution) && Array.isArray(givens) && givens.length === 81 &&
    givens.every(function (v, i) { return Number.isInteger(v) && v >= 0 && v <= 9 && (!v || v === solution[i]); }) &&
    givens.filter(Boolean).length >= 17;
}

function checkersPlayerList(room) {
  return Array.from(room.players.values()).map(function (p) {
    return { cid: p.cid, nick: p.nick, color: p.color, online: p.online };
  });
}

function checkersSeatList(room) {
  return room.seats.map(function (seat) {
    const player = seat.cid ? room.players.get(seat.cid) : null;
    return {
      cid: seat.cid || '',
      nick: seat.isBot ? '电脑' : (player ? player.nick : ''),
      color: seat.color,
      online: seat.isBot ? true : !!(player && player.online),
      isBot: !!seat.isBot
    };
  });
}

function broadcastCheckersState(room) {
  const state = JSON.stringify({
    t: 'state',
    room: room.code,
    phase: room.phase,
    round: room.round,
    pieces: room.pieces,
    turn: room.turn,
    moveNumber: room.moveNumber,
    winner: room.winner,
    lastMove: room.lastMove,
    host: room.hostCid,
    botLevel: room.botLevel,
    seats: checkersSeatList(room),
    players: checkersPlayerList(room)
  });
  room.players.forEach(function (p) { send(p.ws, state); });
  // 广播后统一调度电脑走子：函数自带幂等守卫，非电脑回合或未开局时为空操作。
  scheduleCheckersBotMove(room);
}

function pickCheckersHost(room) {
  const next = Array.from(room.players.values()).find(function (p) { return p.online; }) || room.players.values().next().value;
  room.hostCid = next ? next.cid : null;
  if (next && next.color !== 'blue') {
    room.seats.forEach(function (seat) { if (seat.cid === next.cid) { seat.cid = ''; seat.nick = ''; } });
    const blue = room.seats.find(function (seat) { return seat.color === 'blue'; });
    blue.cid = next.cid; blue.nick = next.nick; next.color = 'blue';
  }
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
  clearCheckersBotTimer(room);
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
  sudokuRooms.forEach(function (room) { total += room.players.size; });
  flightChessRooms.forEach(function (room) { total += room.players.size; });
  gomokuRooms.forEach(function (room) { total += room.players.size; });
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
  sudokuRooms.forEach(function (room) {
    room.players.forEach(function (p) { if (p.clientIp === ip) total++; });
  });
  flightChessRooms.forEach(function (room) {
    room.players.forEach(function (p) { if (p.clientIp === ip) total++; });
  });
  gomokuRooms.forEach(function (room) {
    room.players.forEach(function (p) { if (p.clientIp === ip) total++; });
  });
  return total;
}

function countRoomsForIp(ip) {
  if (!ip) return 0;
  let total = 0;
  rooms.forEach(function (room) { if (room.creatorIp === ip) total++; });
  checkersRooms.forEach(function (room) { if (room.creatorIp === ip) total++; });
  sudokuRooms.forEach(function (room) { if (room.creatorIp === ip) total++; });
  flightChessRooms.forEach(function (room) { if (room.creatorIp === ip) total++; });
  gomokuRooms.forEach(function (room) { if (room.creatorIp === ip) total++; });
  return total;
}

function countRooms() {
  return rooms.size + checkersRooms.size + sudokuRooms.size + flightChessRooms.size + gomokuRooms.size;
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
    if (room.phase === 'lobby' && room.players.size < 2 && now - room.createdAt > UNMATCHED_ROOM_TTL_MS) {
      expireRoom(room, '等待对手超时，房间已自动释放');
      return;
    }
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
    const hasBots = room.seats.some(function (seat) { return seat.isBot; });
    if (room.phase === 'waiting' && room.players.size < 2 && !hasBots && now - room.createdAt > UNMATCHED_ROOM_TTL_MS) {
      expireCheckersRoom(room, '等待对手超时，房间已自动释放');
      return;
    }
    const idleLimit = room.phase === 'waiting' ? LOBBY_IDLE_MS : ONLINE_ROOM_IDLE_MS;
    if (anyOnline && now - (room.lastActivityAt || room.createdAt) > idleLimit) {
      expireCheckersRoom(room, '跳棋房间长时间没有操作，已自动释放');
      return;
    }
    if (!anyOnline && now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL) {
      checkersRooms.delete(code);
      clearCheckersBotTimer(room);
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
    }
  });
  sudokuRooms.forEach(function (room, code) {
    const anyOnline = Array.from(room.players.values()).some(function (p) { return p.online; });
    if (room.phase === 'waiting' && room.players.size < 2 && now - room.createdAt > UNMATCHED_ROOM_TTL_MS) {
      expireSudokuRoom(room, '等待协作好友超时，房间已自动释放');
      return;
    }
    const idleLimit = room.phase === 'waiting' ? LOBBY_IDLE_MS : ONLINE_ROOM_IDLE_MS;
    if (anyOnline && now - (room.lastActivityAt || room.createdAt) > idleLimit) {
      expireSudokuRoom(room, '协作房间长时间没有操作，已自动释放');
      return;
    }
    if (!anyOnline && now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL) {
      sudokuRooms.delete(code);
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
    }
  });
  flightChessRooms.forEach(function (room, code) {
    const anyOnline = Array.from(room.players.values()).some(function (player) { return player.online; });
    if (room.phase === 'waiting' && room.players.size < room.capacity && now - room.createdAt > UNMATCHED_ROOM_TTL_MS) {
      expireFlightChessRoom(room, '等待飞行员超时，房间已自动释放');
      return;
    }
    const idleLimit = room.phase === 'waiting' ? LOBBY_IDLE_MS : ONLINE_ROOM_IDLE_MS;
    if (anyOnline && now - (room.lastActivityAt || room.createdAt) > idleLimit) {
      expireFlightChessRoom(room, '飞行棋房间长时间没有操作，已自动释放');
      return;
    }
    if (!anyOnline && now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL) {
      flightChessRooms.delete(code);
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
    }
  });
  gomokuRooms.forEach(function (room, code) {
    const anyOnline = Array.from(room.players.values()).some(function (player) { return player.online; });
    if (room.phase === 'waiting' && room.players.size < 2 && now - room.createdAt > UNMATCHED_ROOM_TTL_MS) {
      expireGomokuRoom(room, '等待对手超时，房间已自动释放');
      return;
    }
    const idleLimit = room.phase === 'waiting' ? LOBBY_IDLE_MS : ONLINE_ROOM_IDLE_MS;
    if (anyOnline && now - (room.lastActivityAt || room.createdAt) > idleLimit) {
      expireGomokuRoom(room, '五子棋房间长时间没有操作，已自动释放');
      return;
    }
    if (!anyOnline && now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL) {
      gomokuRooms.delete(code);
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
  const ext = path.extname(filePath).toLowerCase();
  const versionedAsset = ext !== '.html' && /(?:\?|&)v=[A-Za-z0-9._-]+(?:&|$)/.test(req.url || '');
  function respond(entry) {
    const useGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && !!entry.gzip;
    const body = useGzip ? entry.gzip : entry.data;
    const etag = useGzip ? entry.gzipEtag : entry.etag;
    const cacheControl = ext === '.html' ? 'no-cache' :
      (versionedAsset ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate');
    if (req.headers['if-none-match'] === etag) {
      writeHead(res, 304, { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
      res.end();
      return;
    }
    writeHead(res, 200, {
      'Content-Type': entry.contentType,
      'Content-Length': body.length,
      'Cache-Control': cacheControl,
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
    const hash = crypto.createHash('sha1').update(data).digest('base64url').slice(0, 16);
    const canGzip = data.length > 1024 && /^(\.html|\.js|\.css|\.json|\.svg)$/.test(ext);
    const entry = {
      data: data,
      gzip: canGzip ? zlib.gzipSync(data, { level: 6 }) : null,
      etag: '"' + hash + '"',
      gzipEtag: '"' + hash + '-gzip"',
      contentType: MIME[ext] || 'application/octet-stream'
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
      rooms: countRooms(),
      rooms24: rooms.size,
      roomsCheckers: checkersRooms.size,
      roomsSudoku: sudokuRooms.size,
      roomsFlightChess: flightChessRooms.size,
      roomsGomoku: gomokuRooms.size,
      seats: countSeats(),
      sockets: liveConnections,
      ts: Date.now()
    }));
    return;
  }
  // AI 实验室是本地开发后端，不属于玩家页面。除显式开启外只允许本机读取。
  if (urlPath === '/ai-lab/run' || urlPath === '/ai-lab/live') {
    const remoteAddress = String(req.socket && req.socket.remoteAddress || '');
    const localRequest = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
    if (!localRequest && process.env.AI_LAB_ENABLED !== '1') {
      writeHead(res, 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"error":"NOT_FOUND"}');
      return;
    }
    const filePath = urlPath === '/ai-lab/live'
      ? path.join(__dirname, 'models', 'checkers-live.json')
      : path.join(__dirname, 'public', 'checkers', 'training', 'latest.json');
    fs.readFile(filePath, function (error, data) {
      if (error) {
        writeHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(urlPath === '/ai-lab/live' ? '{"active":false}' : '{"error":"NO_TRAINING_RUN"}');
        return;
      }
      try { JSON.parse(data.toString('utf8')); }
      catch (parseError) {
        writeHead(res, 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('{"error":"TRAINING_SNAPSHOT_UPDATING"}');
        return;
      }
      writeHead(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') res.end(); else res.end(data);
    });
    return;
  }
  // 游戏目录使用稳定的尾斜杠 URL；旧数独入口继续可用。
  const routeRedirects = {
    '/24': '/24/',
    '/sudoku': '/sudoku/',
    '/sudoku.html': '/sudoku/',
    '/checkers': '/checkers/',
    '/flight-chess': '/flight-chess/',
    '/gomoku': '/gomoku/'
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
const sudokuWss = new WebSocket.Server({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
const flightChessWss = new WebSocket.Server({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
const gomokuWss = new WebSocket.Server({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

// 显式分发升级请求，避免多个 WebSocket.Server 各自监听 server 时互相抢占路径。
server.on('upgrade', function (req, socket, head) {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (e) {}
  const target = pathname === '/ws' ? wss
    : (pathname === '/checkers-ws' ? checkersWss
      : (pathname === '/sudoku-ws' ? sudokuWss
        : (pathname === '/flight-chess-ws' ? flightChessWss
          : (pathname === '/gomoku-ws' ? gomokuWss : null))));
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
        if (countRoomsForIp(clientIp) >= MAX_ROOMS_PER_IP) {
          fail('IP_ROOM_LIMIT', '当前网络已经创建了一个房间，请使用原房间或等待释放');
          return;
        }
        // ---- 单 IP 建房限速：防单 IP 占满全部房间导致所有正常用户被拒 ----
        if (!checkRoomCreateLimit(clientIp)) {
          fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试');
          return;
        }
        // ---- 全服房间数上限 ----
        if (countRooms() >= MAX_ROOMS) {
          fail('SERVER_FULL', '服务器房间已满，请稍后再试');
          return;
        }
        room = createRoom(code, clientIp);
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

    if (m.t === 'ready') {
      if (room.phase !== 'lobby') return;
      room.lastActivityAt = Date.now();
      room.lastLobbyActivityAt = room.lastActivityAt;
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
      room.lastActivityAt = Date.now();
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
      room.lastActivityAt = Date.now();
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
      room.lastActivityAt = Date.now();
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
      room.lastActivityAt = Date.now();
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
        releaseAbandonedCheckersRoomsForIp(clientIp);
        if (countSeats() >= MAX_CONNECTIONS || countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return;
        }
        if (countRoomsForIp(clientIp) >= MAX_ROOMS_PER_IP) {
          fail('IP_ROOM_LIMIT', '当前网络已有正在使用的房间，请先退出旧房间再创建'); return;
        }
        if (!checkRoomCreateLimit(clientIp)) { fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试'); return; }
        if (countRooms() >= MAX_ROOMS) { fail('SERVER_FULL', '服务器房间已满，请稍后再试'); return; }
        const botCount = Math.max(0, Math.min(4, Math.floor(Number(m.bots)) || 0));
        room = createCheckersRoom(code, clientIp, botCount, typeof m.level === 'string' ? m.level : '');
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
        const requestedColor = room.hostCid ? 'red' : 'blue';
        const openSeat = room.seats.find(function (seat) { return !seat.isBot && !seat.cid && seat.color === requestedColor; });
        if (!openSeat) { fail('ROOM_FULL', '该跳棋房间的真人席位已满'); return; }
        p = {
          cid: cid,
          nick: nick,
          color: openSeat.color,
          ws: ws,
          online: true,
          clientIp: clientIp,
          disconnectedAt: null,
          reconnectToken: createReconnectToken(),
          _room: room
        };
        room.players.set(cid, p);
        openSeat.cid = cid;
        openSeat.nick = nick;
        if (!room.hostCid) room.hostCid = cid;
      }

      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = p;
      send(ws, { t: 'session', cid: p.cid, token: p.reconnectToken });
      if (replacedSocket) { try { replacedSocket.terminate(); } catch (e) {} }
      room.lastActivityAt = Date.now();
      clearTimeout(joinTimer);
      broadcastCheckersState(room);
      return;
    }

    if (!player) return;
    if (player.ws !== ws) { try { ws.close(1008, 'session replaced'); } catch (e) {} return; }
    const room = player._room;
    if (!room || checkersRooms.get(room.code) !== room) return;
    if (m.t === 'start') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以开始对局'); return; }
      if (!checkersHumansOnline(room)) { fail('PLAYERS_NOT_READY', '请等待双方进入房间并保持在线'); return; }
      if (startCheckersRoom(room)) broadcastCheckersState(room);
    } else if (m.t === 'opening_ready') {
      if (room.phase !== 'opening' || Number(m.round) !== room.round) return;
      room.openingReady.add(player.cid);
      if (checkersHumansOnline(room) && room.seats.every(function (seat) { return seat.isBot || room.openingReady.has(seat.cid); })) {
        room.phase = 'playing'; room.lastActivityAt = Date.now();
        broadcastCheckersState(room);
      }
    } else if (m.t === 'move') {
      if (room.phase !== 'playing' || room.winner) { fail('ROUND_NOT_STARTED', '请等待房主开始并完成开幕式'); return; }
      const humanOffline = room.seats.some(function (seat) {
        if (seat.isBot) return false;
        const seatPlayer = seat.cid ? room.players.get(seat.cid) : null;
        return !(seatPlayer && seatPlayer.online);
      });
      if (humanOffline) {
        fail('OPPONENT_OFFLINE', '对手已离线，正在等待其重连'); return;
      }
      if (player.color !== room.turn) { fail('NOT_YOUR_TURN', '还没有轮到你走'); return; }
      if (Number(m.seq) !== room.moveNumber) { fail('STATE_OUTDATED', '棋局状态已更新，请按最新棋盘走棋'); broadcastCheckersState(room); return; }
      const from = typeof m.from === 'string' ? m.from.slice(0, 12) : '';
      const target = typeof m.target === 'string' ? m.target.slice(0, 12) : '';
      const applied = checkersApplyMove(room, player.color, from, target);
      if (!applied) { fail('ILLEGAL_MOVE', '这一步不符合跳棋规则'); return; }
      broadcastCheckersState(room);
    } else if (m.t === 'again') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以发起下一局'); return; }
      if (room.phase !== 'done') return;
      room.lastActivityAt = Date.now();
      resetCheckersRoom(room);
      startCheckersRoom(room);
      broadcastCheckersState(room);
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', s: Date.now() });
    } else if (m.t === 'leave') {
      room.seats.forEach(function (seat) {
        if (seat.cid === player.cid) { seat.cid = ''; seat.nick = ''; }
      });
      room.players.delete(player.cid);
      if (room.hostCid === player.cid) pickCheckersHost(room);
      player = null;
      if (!room.players.size) {
        checkersRooms.delete(room.code);
        clearCheckersBotTimer(room);
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

// ===================== 数独好友协作 WebSocket =====================
// 服务端保存唯一盘面；双方只提交要修改的格子，所有已连接客户端收到同一状态快照。
sudokuWss.on('connection', function (ws, req) {
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
      const reconnectToken = typeof m.token === 'string' ? m.token.slice(0, 128) : '';
      const intent = m.intent === 'create' ? 'create' : 'join';
      let room = sudokuRooms.get(code);
      if (!room) {
        if (intent !== 'create') { fail('ROOM_NOT_FOUND', '协作房间不存在或已失效，请向朋友确认邀请码'); return; }
        const difficulty = Number.isInteger(m.difficulty) && m.difficulty >= 0 && m.difficulty <= 4 ? m.difficulty : 0;
        if (!isSudokuPuzzle(m.solution, m.givens)) { fail('PUZZLE_INVALID', '协作题目校验失败，请刷新后重试'); return; }
        releaseAbandonedSudokuRoomsForIp(clientIp);
        if (countSeats() >= MAX_CONNECTIONS || countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return;
        }
        if (countRoomsForIp(clientIp) >= MAX_ROOMS_PER_IP) { fail('IP_ROOM_LIMIT', '当前网络已有正在使用的房间，请先退出旧房间再创建'); return; }
        if (!checkRoomCreateLimit(clientIp)) { fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试'); return; }
        if (countRooms() >= MAX_ROOMS) { fail('SERVER_FULL', '服务器房间已满，请稍后再试'); return; }
        room = createSudokuRoom(code, clientIp, { solution: m.solution, givens: m.givens }, difficulty);
      } else if (intent === 'create') {
        const ownSeat = room.players.get(cid);
        if (!ownSeat) { fail('ROOM_EXISTS', '房间码碰巧重复，正在换一个新房间码'); return; }
        if (!tokenMatches(ownSeat.reconnectToken, reconnectToken)) { fail('SESSION_INVALID', '重连身份已失效，请重新创建协作房间'); return; }
      }

      let p = room.players.get(cid);
      let replacedSocket = null;
      if (p) {
        if (!tokenMatches(p.reconnectToken, reconnectToken)) { fail('SESSION_INVALID', '无法验证协作者身份，请让朋友重新分享邀请码'); return; }
        replacedSocket = p.ws && p.ws !== ws ? p.ws : null;
        p.ws = ws;
        p.online = true;
        p.clientIp = clientIp;
        p.disconnectedAt = null;
        p._room = room;
      } else {
        if (room.phase !== 'waiting') { fail('ROUND_IN_PROGRESS', '这盘协作已经开始，需由原协作者重连'); return; }
        if (countSeats() >= MAX_CONNECTIONS) { fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return; }
        if (countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) { fail('IP_PLAYER_LIMIT', '当前网络加入的玩家数已达上限'); return; }
        if (room.players.size >= 2) { fail('ROOM_FULL', '该数独协作房间已有两位玩家'); return; }
        p = {
          cid: cid, seat: room.players.size + 1, ws: ws, online: true,
          clientIp: clientIp, disconnectedAt: null,
          reconnectToken: createReconnectToken(), _room: room
        };
        room.players.set(cid, p);
      }
      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = p;
      send(ws, { t: 'session', cid: p.cid, token: p.reconnectToken });
      if (replacedSocket) { try { replacedSocket.terminate(); } catch (e) {} }
      if (room.phase === 'waiting' && room.players.size === 2 &&
          Array.from(room.players.values()).every(function (seat) { return seat.online; })) {
        room.phase = 'playing';
        room.startedAt = Date.now();
      }
      room.lastActivityAt = Date.now();
      clearTimeout(joinTimer);
      broadcastSudokuState(room);
      return;
    }

    if (!player) return;
    if (player.ws !== ws) { try { ws.close(1008, 'session replaced'); } catch (e) {} return; }
    const room = player._room;
    if (!room || sudokuRooms.get(room.code) !== room) return;
    if (m.t === 'set') {
      if (room.phase !== 'playing') { fail('ROOM_NOT_READY', '等待两位协作者都进入后再开始填写'); return; }
      if (!Array.isArray(m.changes)) return;
      let changed = false;
      const seen = new Set();
      m.changes.slice(0, 81).forEach(function (entry) {
        const index = entry && Number.isInteger(entry.index) ? entry.index : -1;
        const value = entry && Number.isInteger(entry.value) ? entry.value : -1;
        if (seen.has(index) || index < 0 || index >= 81 || value < 0 || value > 9 || room.givens[index] !== 0) return;
        seen.add(index);
        if (room.board[index] !== value) { room.board[index] = value; changed = true; }
      });
      if (!changed) return;
      room.lastActivityAt = now;
      room.lastEditorCid = player.cid;
      if (room.board.every(function (value, index) { return value === room.solution[index]; })) {
        room.phase = 'done';
        room.finishedAt = now;
      }
      broadcastSudokuState(room);
    } else if (m.t === 'leave') {
      room.players.delete(player.cid);
      player = null;
      if (!room.players.size) {
        sudokuRooms.delete(room.code);
        if (room._gc) clearTimeout(room._gc);
      } else {
        room.phase = 'waiting';
        room.startedAt = null;
        room.lastActivityAt = now;
        broadcastSudokuState(room);
      }
      try { ws.close(1000, 'left room'); } catch (e) {}
    } else if (m.t === 'ping') {
      send(ws, { t: 'pong', s: Date.now() });
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
    if (room && sudokuRooms.get(room.code) === room) {
      room.lastActivityAt = Date.now();
      broadcastSudokuState(room);
      scheduleSudokuGC(room);
    }
  });
  ws.on('error', function () {});
});

// ===================== 飞行棋 WebSocket =====================
// 服务端生成骰点并持有唯一棋局；客户端只能请求“掷骰”或提交飞机编号。
flightChessWss.on('connection', function (ws, req) {
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
    if (!player) { try { ws.close(1000, 'join timeout'); } catch (error) {} }
  }, JOIN_IDLE_MS);

  function allSeatsOnline(room) {
    return room.players.size === room.capacity &&
      Array.from(room.players.values()).every(function (seat) { return seat.online; });
  }

  function requireCurrentRevision(room, message) {
    if (Number(message.rev) === room.revision) return true;
    fail('STATE_OUTDATED', '棋局状态已更新，请按最新状态操作');
    broadcastFlightChessState(room);
    return false;
  }

  ws.on('message', function (data) {
    const now = Date.now();
    tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_LIMIT);
    lastRefill = now;
    if (tokens < 1) { ws.close(1008, 'rate limit'); return; }
    tokens -= 1;

    let message;
    try { message = JSON.parse(data.toString()); } catch (error) { return; }
    if (!message || typeof message.t !== 'string') return;

    if (message.t === 'join') {
      if (player) return;
      const code = String(message.room || '').toUpperCase();
      if (!ROOM_CODE_RE.test(code)) { fail('ROOM_INVALID', '房间码格式不正确'); return; }
      const cid = typeof message.cid === 'string' ? message.cid.slice(0, 32) : '';
      if (!cid || cid.length < 4) { fail('SESSION_INVALID', '玩家身份格式不正确'); return; }
      const nick = typeof message.nick === 'string' && message.nick.trim()
        ? message.nick.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 16)
        : '玩家';
      const reconnectToken = typeof message.token === 'string' ? message.token.slice(0, 128) : '';
      const intent = message.intent === 'create' ? 'create' : 'join';
      const capacity = Number.isInteger(message.capacity) && message.capacity >= 2 && message.capacity <= 4
        ? message.capacity : 4;

      let room = flightChessRooms.get(code);
      if (!room) {
        if (intent !== 'create') { fail('ROOM_NOT_FOUND', '飞行棋房间不存在或已失效，请向房主确认房间码'); return; }
        releaseAbandonedFlightChessRoomsForIp(clientIp);
        if (countSeats() >= MAX_CONNECTIONS || countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return;
        }
        if (countRoomsForIp(clientIp) >= MAX_ROOMS_PER_IP) {
          fail('IP_ROOM_LIMIT', '当前网络已有正在使用的房间，请先退出旧房间再创建'); return;
        }
        if (!checkRoomCreateLimit(clientIp)) { fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试'); return; }
        if (countRooms() >= MAX_ROOMS) { fail('SERVER_FULL', '服务器房间已满，请稍后再试'); return; }
        room = createFlightChessRoom(code, clientIp, capacity);
      } else if (intent === 'create') {
        const ownSeat = room.players.get(cid);
        if (!ownSeat) { fail('ROOM_EXISTS', '房间码碰巧重复，请重新创建'); return; }
        if (!tokenMatches(ownSeat.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '重连身份已失效，请退出房间后重新加入'); return;
        }
      }

      let seat = room.players.get(cid);
      let replacedSocket = null;
      if (seat) {
        if (!tokenMatches(seat.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '无法验证该玩家身份，请退出房间后重新加入'); return;
        }
        replacedSocket = seat.ws && seat.ws !== ws ? seat.ws : null;
        seat.ws = ws;
        seat.nick = nick;
        seat.online = true;
        seat.clientIp = clientIp;
        seat.disconnectedAt = null;
        seat._room = room;
      } else {
        if (room.phase !== 'waiting') { fail('ROUND_IN_PROGRESS', '棋局已经开始，只允许原玩家重连'); return; }
        if (room.players.size >= room.capacity) { fail('ROOM_FULL', '该房间的飞行员已经到齐'); return; }
        if (countSeats() >= MAX_CONNECTIONS) { fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return; }
        if (countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) { fail('IP_PLAYER_LIMIT', '当前网络加入的玩家数已达上限'); return; }
        const seatIndex = nextFlightChessSeat(room);
        if (seatIndex < 0) { fail('ROOM_FULL', '该房间的飞行员已经到齐'); return; }
        seat = {
          cid: cid,
          nick: nick,
          seat: seatIndex,
          ws: ws,
          online: true,
          clientIp: clientIp,
          disconnectedAt: null,
          reconnectToken: createReconnectToken(),
          _room: room
        };
        room.players.set(cid, seat);
        if (!room.hostCid) room.hostCid = cid;
      }

      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = seat;
      send(ws, { t: 'session', cid: seat.cid, token: seat.reconnectToken, seat: seat.seat });
      if (replacedSocket) { try { replacedSocket.terminate(); } catch (error) {} }
      room.lastActivityAt = Date.now();
      clearTimeout(joinTimer);
      broadcastFlightChessState(room);
      return;
    }

    if (!player) return;
    if (player.ws !== ws) { try { ws.close(1008, 'session replaced'); } catch (error) {} return; }
    const room = player._room;
    if (!room || flightChessRooms.get(room.code) !== room) return;

    if (message.t === 'start') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以开始棋局'); return; }
      if (room.phase !== 'waiting') return;
      if (room.players.size !== room.capacity) { fail('ROOM_NOT_READY', '请等待 ' + room.capacity + ' 位飞行员全部加入'); return; }
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '有飞行员暂时离线，请等待其重连'); return; }
      startFlightChessGame(room, false);
      broadcastFlightChessState(room);
    } else if (message.t === 'roll') {
      if (room.phase !== 'playing' || !room.game) return;
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '有飞行员暂时离线，棋局已暂停'); return; }
      if (!requireCurrentRevision(room, message)) return;
      if (room.game.currentPlayer !== player.seat) { fail('NOT_YOUR_TURN', '还没有轮到你掷骰子'); return; }
      if (room.game.phase !== 'roll') { fail('PLANE_REQUIRED', '请先选择一架可移动的飞机'); return; }
      try {
        // 骰点只由服务端生成，忽略客户端携带的任何点数。
        room.game = FlightChessCore.rollDice(room.game, crypto.randomInt(1, 7));
      } catch (error) { fail('ROLL_REJECTED', '当前不能掷骰子'); return; }
      room.revision += 1;
      room.lastActivityAt = now;
      broadcastFlightChessState(room);
    } else if (message.t === 'move') {
      if (room.phase !== 'playing' || !room.game) return;
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '有飞行员暂时离线，棋局已暂停'); return; }
      if (!requireCurrentRevision(room, message)) return;
      if (room.game.currentPlayer !== player.seat) { fail('NOT_YOUR_TURN', '还没有轮到你移动飞机'); return; }
      if (room.game.phase !== 'move') { fail('ROLL_REQUIRED', '请先掷骰子'); return; }
      const planeIndex = Number(message.plane);
      if (!Number.isInteger(planeIndex) || planeIndex < 0 || planeIndex >= FlightChessCore.PLANE_COUNT) {
        fail('PLANE_INVALID', '飞机编号不正确'); return;
      }
      try { room.game = FlightChessCore.movePlane(room.game, planeIndex); }
      catch (error) { fail('ILLEGAL_MOVE', '这架飞机当前不能移动'); return; }
      room.revision += 1;
      room.lastActivityAt = now;
      if (room.game.phase === 'gameover') room.phase = 'done';
      broadcastFlightChessState(room);
    } else if (message.t === 'again') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以发起下一局'); return; }
      if (room.phase !== 'done') return;
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '请等待所有飞行员重连后再开新局'); return; }
      startFlightChessGame(room, true);
      broadcastFlightChessState(room);
    } else if (message.t === 'leave') {
      room.players.delete(player.cid);
      if (room.hostCid === player.cid) pickFlightChessHost(room);
      player = null;
      if (!room.players.size) {
        flightChessRooms.delete(room.code);
        if (room._gc) clearTimeout(room._gc);
      } else {
        resetFlightChessWaitingRoom(room);
        broadcastFlightChessState(room);
      }
      try { ws.close(1000, 'left room'); } catch (error) {}
    } else if (message.t === 'ping') {
      send(ws, { t: 'pong', s: Date.now() });
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
    if (room && flightChessRooms.get(room.code) === room) {
      room.lastActivityAt = Date.now();
      broadcastFlightChessState(room);
      scheduleFlightChessGC(room);
    }
  });
  ws.on('error', function () {});
});

gomokuWss.on('connection', function (ws, req) {
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
    if (!player) { try { ws.close(1000, 'join timeout'); } catch (error) {} }
  }, JOIN_IDLE_MS);

  function allSeatsOnline(room) {
    return room.players.size === 2 &&
      Array.from(room.players.values()).every(function (seat) { return seat.online; });
  }

  function requireCurrentRevision(room, message) {
    if (Number(message.rev) === room.revision) return true;
    fail('STATE_OUTDATED', '棋局状态已更新，请按最新状态操作');
    broadcastGomokuState(room);
    return false;
  }

  ws.on('message', function (data) {
    const now = Date.now();
    tokens = Math.min(RATE_BURST, tokens + ((now - lastRefill) / 1000) * RATE_LIMIT);
    lastRefill = now;
    if (tokens < 1) { ws.close(1008, 'rate limit'); return; }
    tokens -= 1;

    let message;
    try { message = JSON.parse(data.toString()); } catch (error) { return; }
    if (!message || typeof message.t !== 'string') return;

    if (message.t === 'join') {
      if (player) return;
      const code = String(message.room || '').toUpperCase();
      if (!ROOM_CODE_RE.test(code)) { fail('ROOM_INVALID', '房间码格式不正确'); return; }
      const cid = typeof message.cid === 'string' ? message.cid.slice(0, 32) : '';
      if (!cid || cid.length < 4) { fail('SESSION_INVALID', '玩家身份格式不正确'); return; }
      const nick = typeof message.nick === 'string' && message.nick.trim()
        ? message.nick.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 16)
        : '玩家';
      const reconnectToken = typeof message.token === 'string' ? message.token.slice(0, 128) : '';
      const intent = message.intent === 'create' ? 'create' : 'join';

      let room = gomokuRooms.get(code);
      if (!room) {
        if (intent !== 'create') { fail('ROOM_NOT_FOUND', '五子棋房间不存在或已失效，请向房主确认房间码'); return; }
        releaseAbandonedGomokuRoomsForIp(clientIp);
        if (countSeats() >= MAX_CONNECTIONS || countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) {
          fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return;
        }
        if (countRoomsForIp(clientIp) >= MAX_ROOMS_PER_IP) {
          fail('IP_ROOM_LIMIT', '当前网络已有正在使用的房间，请先退出旧房间再创建'); return;
        }
        if (!checkRoomCreateLimit(clientIp)) { fail('CREATE_RATE_LIMIT', '建房过于频繁，请稍后再试'); return; }
        if (countRooms() >= MAX_ROOMS) { fail('SERVER_FULL', '服务器房间已满，请稍后再试'); return; }
        room = createGomokuRoom(code, clientIp);
      } else if (intent === 'create') {
        const ownSeat = room.players.get(cid);
        if (!ownSeat) { fail('ROOM_EXISTS', '房间码碰巧重复，请重新创建'); return; }
        if (!tokenMatches(ownSeat.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '重连身份已失效，请退出房间后重新加入'); return;
        }
      }

      let seat = room.players.get(cid);
      let replacedSocket = null;
      if (seat) {
        if (!tokenMatches(seat.reconnectToken, reconnectToken)) {
          fail('SESSION_INVALID', '无法验证该玩家身份，请退出房间后重新加入'); return;
        }
        replacedSocket = seat.ws && seat.ws !== ws ? seat.ws : null;
        seat.ws = ws;
        seat.nick = nick;
        seat.online = true;
        seat.clientIp = clientIp;
        seat.disconnectedAt = null;
        seat._room = room;
      } else {
        if (room.phase !== 'waiting') { fail('ROUND_IN_PROGRESS', '棋局已经开始，只允许原玩家重连'); return; }
        if (room.players.size >= 2) { fail('ROOM_FULL', '这个房间已经有两位棋手了'); return; }
        if (countSeats() >= MAX_CONNECTIONS) { fail('SERVER_FULL', '服务器玩家席位已满，请稍后再试'); return; }
        if (countSeatsForIp(clientIp) >= MAX_CONNECTIONS_PER_IP) { fail('IP_PLAYER_LIMIT', '当前网络加入的玩家数已达上限'); return; }
        const seatIndex = nextGomokuSeat(room);
        if (seatIndex < 0) { fail('ROOM_FULL', '这个房间已经有两位棋手了'); return; }
        seat = {
          cid: cid,
          nick: nick,
          seat: seatIndex,
          ws: ws,
          online: true,
          clientIp: clientIp,
          disconnectedAt: null,
          reconnectToken: createReconnectToken(),
          _room: room
        };
        room.players.set(cid, seat);
        if (!room.hostCid) room.hostCid = cid;
      }

      if (room._gc) { clearTimeout(room._gc); room._gc = null; }
      player = seat;
      send(ws, { t: 'session', cid: seat.cid, token: seat.reconnectToken, seat: seat.seat });
      if (replacedSocket) { try { replacedSocket.terminate(); } catch (error) {} }
      room.lastActivityAt = Date.now();
      clearTimeout(joinTimer);
      // 两位棋手到齐且都在线时自动开局，省掉一次多余点击。
      if (room.phase === 'waiting' && allSeatsOnline(room)) startGomokuGame(room, false);
      broadcastGomokuState(room);
      return;
    }

    if (!player) return;
    if (player.ws !== ws) { try { ws.close(1008, 'session replaced'); } catch (error) {} return; }
    const room = player._room;
    if (!room || gomokuRooms.get(room.code) !== room) return;

    if (message.t === 'start') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以开始棋局'); return; }
      if (room.phase !== 'waiting') return;
      if (room.players.size !== 2) { fail('ROOM_NOT_READY', '请等待两位棋手全部加入'); return; }
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '有棋手暂时离线，请等待其重连'); return; }
      startGomokuGame(room, false);
      broadcastGomokuState(room);
    } else if (message.t === 'move') {
      if (room.phase !== 'playing' || !room.game) return;
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '有棋手暂时离线，棋局已暂停'); return; }
      if (!requireCurrentRevision(room, message)) return;
      const color = GomokuCore.seatColor(player.seat);
      if (room.game.turn !== color) { fail('NOT_YOUR_TURN', '还没有轮到你落子'); return; }
      const r = Number(message.r);
      const c = Number(message.c);
      if (!Number.isInteger(r) || !Number.isInteger(c)) { fail('MOVE_INVALID', '落子坐标不正确'); return; }
      try {
        room.game = GomokuCore.placeStone(room.game, r, c, color);
      } catch (error) {
        const reason = error && error.message;
        if (reason === 'OCCUPIED') { fail('OCCUPIED', '这个位置已经有棋子了'); return; }
        if (reason === 'OUT_OF_BOARD') { fail('MOVE_INVALID', '落子超出棋盘范围'); return; }
        if (reason === 'NOT_YOUR_TURN') { fail('NOT_YOUR_TURN', '还没有轮到你落子'); return; }
        fail('ILLEGAL_MOVE', '这一步不合法'); return;
      }
      room.revision += 1;
      room.lastActivityAt = now;
      if (room.game.finished) room.phase = 'done';
      broadcastGomokuState(room);
    } else if (message.t === 'again') {
      if (room.hostCid !== player.cid) { fail('HOST_ONLY', '只有房主可以发起下一局'); return; }
      if (room.phase !== 'done') return;
      if (!allSeatsOnline(room)) { fail('PLAYER_OFFLINE', '请等待两位棋手重连后再开新局'); return; }
      startGomokuGame(room, true);
      broadcastGomokuState(room);
    } else if (message.t === 'leave') {
      room.players.delete(player.cid);
      if (room.hostCid === player.cid) pickGomokuHost(room);
      player = null;
      if (!room.players.size) {
        gomokuRooms.delete(room.code);
        if (room._gc) clearTimeout(room._gc);
      } else {
        resetGomokuWaitingRoom(room);
        broadcastGomokuState(room);
      }
      try { ws.close(1000, 'left room'); } catch (error) {}
    } else if (message.t === 'ping') {
      send(ws, { t: 'pong', s: Date.now() });
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
    if (room && gomokuRooms.get(room.code) === room) {
      room.lastActivityAt = Date.now();
      broadcastGomokuState(room);
      scheduleGomokuGC(room);
    }
  });
  ws.on('error', function () {});
});

// WebSocket 心跳：及时清理移动网络留下的“半开连接”，让重连和房主转移更可靠。
const heartbeatTimer = setInterval(function () {
  [wss, checkersWss, sudokuWss, flightChessWss, gomokuWss].forEach(function (socketServer) {
    socketServer.clients.forEach(function (ws) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    });
  });
}, 30000);
heartbeatTimer.unref();
// 只有五路通道全部空闲才停心跳，避免某一路关闭时误停其它游戏的检测。
function allChannelsIdle() {
  return !wss.clients.size && !checkersWss.clients.size && !sudokuWss.clients.size
    && !flightChessWss.clients.size && !gomokuWss.clients.size;
}
wss.on('close', function () { if (allChannelsIdle()) clearInterval(heartbeatTimer); });
checkersWss.on('close', function () { if (allChannelsIdle()) clearInterval(heartbeatTimer); });
sudokuWss.on('close', function () { if (allChannelsIdle()) clearInterval(heartbeatTimer); });
flightChessWss.on('close', function () { if (allChannelsIdle()) clearInterval(heartbeatTimer); });
gomokuWss.on('close', function () { if (allChannelsIdle()) clearInterval(heartbeatTimer); });

server.listen(PORT, function () {
  console.log('[light-games] relay listening on :' + PORT + '  (24点 /ws，跳棋 /checkers-ws，数独协作 /sudoku-ws，飞行棋 /flight-chess-ws，五子棋 /gomoku-ws)');
});
