'use strict';

const fs = require('fs');
const Core = require('./public/flight-chess/flight_chess_core');
const Net = require('./public/flight-chess/flight_chess_net');

const lobbyHtml = fs.readFileSync('public/flight-chess/index.html', 'utf8');
const playHtml = fs.readFileSync('public/flight-chess/play.html', 'utf8');
const lobbySource = fs.readFileSync('public/flight-chess/lobby.js', 'utf8');
const netSource = fs.readFileSync('public/flight-chess/flight_chess_net.js', 'utf8');
const gameSource = fs.readFileSync('public/flight-chess/game.js', 'utf8');
const css = fs.readFileSync('public/flight-chess/flight_chess.css', 'utf8');
const platformHtml = fs.readFileSync('public/index.html', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const serverSource = fs.readFileSync('server.js', 'utf8');

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

function setPlane(game, playerIndex, planeIndex, progress) {
  const next = Core.cloneGame(game);
  next.players[playerIndex].planes[planeIndex] = progress;
  return next;
}

ok('公共航道包含 52 个唯一坐标',
  Core.TRACK_COORDINATES.length === 52 &&
  new Set(Core.TRACK_COORDINATES.map(Core.coordinateKey)).size === 52);

const game2 = Core.createGame(2);
const game3 = Core.createGame(3);
const game4 = Core.createGame(4);
ok('支持 2、3、4 人且越界人数安全回落为 4 人',
  game2.players.length === 2 && game3.players.length === 3 && game4.players.length === 4 &&
  Core.createGame(1).players.length === 4 && Core.createGame(5).players.length === 4);
ok('双人使用对角的红蓝阵营，四人使用完整四色',
  game2.players.map(player => player.colorId).join(',') === 'red,blue' &&
  game4.players.map(player => player.colorId).join(',') === 'red,yellow,blue,green');
ok('每位玩家开局均有四架飞机停在各自停机坪',
  game4.players.every(player => player.planes.length === 4 && player.planes.every(progress => progress === Core.HANGAR)));

const ordinaryPass = Core.rollDice(game2, 3);
ok('未起飞时掷非 6 点会自动跳过并轮到下一位',
  ordinaryPass.phase === 'roll' && ordinaryPass.currentPlayer === 1 &&
  ordinaryPass.lastMove.type === 'pass' && game2.currentPlayer === 0);

const takeoffRoll = Core.rollDice(game2, 6);
ok('掷出 6 时四架停机坪飞机均可选择起飞',
  takeoffRoll.phase === 'move' && Core.getMovablePlanes(takeoffRoll, 0, 6).join(',') === '0,1,2,3');
const tookOff = Core.movePlane(takeoffRoll, 2);
ok('起飞落到本方安全起点且掷 6 后保留当前玩家额外回合',
  tookOff.players[0].planes[2] === 0 && tookOff.currentPlayer === 0 && tookOff.phase === 'roll' && tookOff.lastMove.extraTurn);

let moving = Core.createGame(2);
moving = setPlane(moving, 0, 0, 0);
moving = Core.rollDice(moving, 3);
moving = Core.movePlane(moving, 0);
ok('普通移动按骰点前进且结束后切换玩家',
  moving.players[0].planes[0] === 3 && moving.currentPlayer === 1 && moving.turnNumber === 2);

let colorHop = Core.createGame(2);
colorHop = setPlane(colorHop, 0, 0, 4);
colorHop = Core.rollDice(colorHop, 4);
colorHop = Core.movePlane(colorHop, 0);
ok('落到本方颜色格会额外连跳 4 格',
  colorHop.players[0].planes[0] === 12 && colorHop.lastMove.rawTo === 8 && colorHop.lastMove.bonus === 'color-hop');

let shortcut = Core.createGame(2);
shortcut = setPlane(shortcut, 0, 0, 12);
shortcut = Core.rollDice(shortcut, 6);
shortcut = Core.movePlane(shortcut, 0);
ok('落到星标航线会跨越 12 格且不会叠加同色连跳',
  shortcut.players[0].planes[0] === 30 && shortcut.lastMove.bonus === 'shortcut' && shortcut.lastMove.bonusDistance === 12);

let capture = Core.createGame(2);
capture = setPlane(capture, 0, 0, 0);
capture = setPlane(capture, 1, 1, 27);
capture = Core.rollDice(capture, 1);
capture = Core.movePlane(capture, 0);
ok('落到非安全格会把同格的对方飞机撞回停机坪',
  capture.players[1].planes[1] === Core.HANGAR && capture.lastMove.captured.length === 1);

let safeStart = Core.createGame(2);
safeStart = setPlane(safeStart, 1, 0, 26);
safeStart = Core.rollDice(safeStart, 6);
safeStart = Core.movePlane(safeStart, 0);
ok('四个阵营起点为安全格，起飞不会撞回停在该格的对手',
  safeStart.players[1].planes[0] === 26 && safeStart.lastMove.captured.length === 0);

let exactFinish = Core.createGame(2);
exactFinish = setPlane(exactFinish, 0, 0, 57);
exactFinish = Core.rollDice(exactFinish, 1);
exactFinish = Core.movePlane(exactFinish, 0);
ok('终点航道使用恰好点数抵达中心', exactFinish.players[0].planes[0] === Core.FINISHED);

let overshoot = Core.createGame(2);
overshoot = setPlane(overshoot, 0, 0, 57);
overshoot = Core.rollDice(overshoot, 2);
ok('超过终点的骰点不能移动并自动跳过',
  overshoot.players[0].planes[0] === 57 && overshoot.phase === 'roll' && overshoot.currentPlayer === 1);

let win = Core.createGame(2);
win.players[0].planes = [58, 58, 58, 57];
win = Core.rollDice(win, 1);
win = Core.movePlane(win, 3);
ok('四架飞机全部抵达后立即判定胜者并锁定棋局',
  win.phase === 'gameover' && win.winner === 0 && win.players[0].planes.every(progress => progress === 58));

const restored = Core.hydrateGame(JSON.parse(JSON.stringify(capture)));
ok('合法存档可恢复且保留撞机后的局面',
  restored && restored.players[1].planes[1] === Core.HANGAR && restored.currentPlayer === capture.currentPlayer);
ok('存档恢复拒绝未知版本、错误阵营和越界进度',
  Core.hydrateGame({ version: 9 }) === null &&
  Core.hydrateGame(Object.assign({}, game2, { players: [{ colorId: 'green', planes: [-1, -1, -1, -1] }, game2.players[1]] })) === null &&
  Core.hydrateGame(Object.assign({}, game2, { players: [{ colorId: 'red', planes: [99, -1, -1, -1] }, game2.players[1]] })) === null);

ok('大厅按统一交互先选择本地对战，再展开 2/3/4 人配置',
  /id="selectLocalBtn"[^>]*aria-expanded="false"[^>]*aria-controls="localConfig"/.test(lobbyHtml) &&
  /id="localConfig" hidden/.test(lobbyHtml) &&
  (lobbyHtml.match(/data-player-count="[234]"/g) || []).length === 3);
ok('大厅提供 2–4 人好友房间的创建、邀请与加入入口',
  /id="selectOnlineBtn"[^>]*aria-controls="onlineConfig"/.test(lobbyHtml) &&
  /id="createRoomBtn"/.test(lobbyHtml) && /id="joinRoomBtn"/.test(lobbyHtml) &&
  (lobbyHtml.match(/data-online-count="[234]"/g) || []).length === 3 &&
  /mode: 'online'/.test(lobbySource));
ok('大厅将继续存档和开始新局分开，并在覆盖前确认',
  /id="resumeCard" hidden/.test(lobbyHtml) && /id="resumeBtn"/.test(lobbyHtml) &&
  /开始新局会覆盖当前飞行棋进度/.test(lobbySource));
ok('棋局页不重复人数配置，并按规则核心、联机层、交互脚本顺序加载',
  !/data-player-count/.test(playHtml) &&
  playHtml.indexOf('flight_chess_core.js') < playHtml.indexOf('flight_chess_net.js') &&
  playHtml.indexOf('flight_chess_net.js') < playHtml.indexOf('game.js'));
ok('飞行棋资源升级缓存版本且返回大厅会显式离开联机房间',
  /flight_chess_net\.js\?v=20260825d/.test(playHtml) && /game\.js\?v=20260825d/.test(playHtml) &&
  /data-leave-room/.test(playHtml) && /leaveOnlineRoom/.test(gameSource));
ok('棋局使用经典十字棋盘、四个独立机场和中央四向箭头',
  /data-board-style="classic"/.test(playHtml) && /BOARD_OFFSET = 2/.test(gameSource) &&
  /CLASSIC_BASE_COORDINATES/.test(gameSource) && /airspace-zone/.test(gameSource) &&
  (gameSource.match(/goal-arrow/g) || []).length >= 1 && /grid-template-columns: repeat\(19/.test(css));
ok('经典棋盘只重映射显示坐标，不改变规则坐标与联机棋局状态',
  /classicCoordinate\(coordinate\), Core\.coordinateKey\(coordinate\)/.test(gameSource) &&
  /CLASSIC_BASE_COORDINATES\[color\.id\]\[planeIndex\], Core\.coordinateKey\(coordinate\)/.test(gameSource) &&
  /coordinate\[1\] \+ BOARD_OFFSET, 14 - coordinate\[0\] \+ BOARD_OFFSET/.test(gameSource));
ok('棋盘提供经典与柔和皮肤切换，且偏好独立持久化而不进入棋局状态',
  /id="boardSkinSelect"/.test(playHtml) && /value="classic"/.test(playHtml) && /value="soft"/.test(playHtml) &&
  /data-board-skin="classic"/.test(playHtml) && /SKIN_KEY/.test(gameSource) && /applyBoardSkin/.test(gameSource) &&
  /flight-board\[data-board-skin="classic"\]/.test(css));
ok('联机地址与房间码归一化支持 http/ws 和 https/wss',
  Net.normalizeRoom(' a1io-z9 ') === 'AZ9' &&
  Net.websocketUrl({ protocol: 'http:', host: 'localhost:3000' }) === 'ws://localhost:3000/flight-chess-ws' &&
  Net.websocketUrl({ protocol: 'https:', host: 'game.example' }) === 'wss://game.example/flight-chess-ws');
ok('联机身份持久化、退避重连且客户端不产生骰点',
  /SESSION_PREFIX/.test(netSource) && /sessionStorage/.test(netSource) && /reconnectDelayForAttempt/.test(netSource) &&
  !/rollDice|Math\.floor\([^\n]*\* 6/.test(netSource));

const terminalStatuses = [];
let terminalError = null;
class MockFlightSocket {
  constructor() {
    this.readyState = MockFlightSocket.CONNECTING;
    this.handlers = {};
    this.sent = [];
    MockFlightSocket.last = this;
  }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  emit(type, event) { if (this.handlers[type]) this.handlers[type](event || {}); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = MockFlightSocket.CLOSED; this.closed = true; this.emit('close'); }
}
MockFlightSocket.CONNECTING = 0;
MockFlightSocket.OPEN = 1;
MockFlightSocket.CLOSED = 3;
const terminalClient = Net.createClient({
  room: 'BAD24', intent: 'create', WebSocket: MockFlightSocket,
  storage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  crypto: { getRandomValues: function (bytes) { bytes.fill(7); } },
  onStatus: function (status) { terminalStatuses.push(status); },
  onError: function (message) { terminalError = message.code; }
});
terminalClient.connect();
MockFlightSocket.last.readyState = MockFlightSocket.OPEN;
MockFlightSocket.last.emit('open');
MockFlightSocket.last.emit('message', { data: JSON.stringify({ t: 'err', code: 'IP_ROOM_LIMIT' }) });
ok('致命建房错误会停止重连、关闭连接并持久标记失败状态',
  terminalError === 'IP_ROOM_LIMIT' && terminalStatuses[terminalStatuses.length - 1] === 'failed' &&
  MockFlightSocket.last.closed && !terminalClient.isActive());
ok('棋盘飞机只通过规则核心给出的合法列表启用',
  /Core\.getMovablePlanes/.test(gameSource) && /Core\.movePlane/.test(gameSource) && /token\.disabled = !canMove/.test(gameSource));
ok('棋局提供自动存档、规则说明、响应式单列和减少动效支持',
  /saveGame\(\)/.test(gameSource) && /本局规则/.test(playHtml) &&
  /@media \(max-width: 900px\)/.test(css) && /prefers-reduced-motion/.test(css));
ok('游戏平台首页已新增飞行棋入口并更新为四款游戏',
  /href="flight-chess\/"/.test(platformHtml) && /2–4 人/.test(platformHtml) && /四款游戏/.test(platformHtml));
ok('服务端为无尾斜杠飞行棋地址提供稳定重定向',
  /'\/flight-chess': '\/flight-chess\/'/.test(serverSource));
ok('飞行棋服务端独立建房并权威生成骰点、校验移动与状态版本',
  /new WebSocket\.Server\(\{ noServer: true[^\n]*\}\)/.test(serverSource) &&
  /pathname === '\/flight-chess-ws'/.test(serverSource) &&
  /crypto\.randomInt\(1, 7\)/.test(serverSource) &&
  /FlightChessCore\.movePlane/.test(serverSource) && /STATE_OUTDATED/.test(serverSource));
ok('飞行棋新建房会回收同来源已离线的单人等待房',
  /releaseAbandonedFlightChessRoomsForIp/.test(serverSource) && /旧的飞行棋等待房已由新房间替换/.test(serverSource));
ok('package scripts 提供飞行棋测试及整站统一回归入口',
  packageJson.scripts['test:flight-chess'] === 'node test_flight_chess.js' &&
  packageJson.scripts['test:flight-chess:e2e'] === 'node test_flight_chess_online.js' &&
  /test_flight_chess_online\.js/.test(packageJson.scripts['test:all']));

console.log('\n✅ 飞行棋规则与页面契约测试全部通过（' + passed + ' 项）');
