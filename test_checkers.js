'use strict';

const fs = require('fs');
const vm = require('vm');

const sandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error, RegExp,
  Uint8Array, URL, URLSearchParams,
  setTimeout, clearTimeout,
  document: {},
  location: { protocol: 'https:', host: 'game.test', href: 'https://game.test/checkers/play.html?mode=ai', search: '?mode=ai' },
  navigator: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  WebSocket: { OPEN: 1 }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {};
vm.createContext(sandbox);

const coreSource = fs.readFileSync('public/checkers/checkers_core.js', 'utf8');
const source = fs.readFileSync('public/checkers/checkers.js', 'utf8');
const lobbyHtml = fs.readFileSync('public/checkers/index.html', 'utf8');
const playHtml = fs.readFileSync('public/checkers/play.html', 'utf8');
const css = fs.readFileSync('public/checkers/checkers.css', 'utf8');
const platformHtml = fs.readFileSync('public/index.html', 'utf8');
const serverSource = fs.readFileSync('server.js', 'utf8');
vm.runInContext(coreSource, sandbox, { filename: 'checkers_core.js' });
vm.runInContext(source, sandbox, { filename: 'checkers.js' });

const T = sandbox.__checkersTest;
const C = T.Core;
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

ok('棋盘生成完整的 121 个唯一孔位',
  C.BOARD_CELLS.length === 121 && new Set(C.BOARD_CELLS.map(cell => cell.key)).size === 121);
ok('17 行孔位数量符合六角星棋盘结构',
  C.ROW_COUNTS.join(',') === '1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1');
ok('上下双方营地各有 10 个孔位', C.TOP_CAMP.length === 10 && C.BOTTOM_CAMP.length === 10);

const topCell = C.BOARD_CELLS.find(cell => cell.row === 0);
const bottomCell = C.BOARD_CELLS.find(cell => cell.row === 16);
ok('红方视角把红方逻辑营地映射到屏幕下方', C.orientPoint(topCell, 'red').y > 280);
ok('蓝方视角把蓝方逻辑营地保持在屏幕下方', C.orientPoint(bottomCell, 'blue').y > 280);
ok('本地与人机视角固定为红方，不会跟随回合改变',
  T.getViewPlayerForMode('ai', '') === 'red' && T.getViewPlayerForMode('local', 'blue') === 'red');
ok('联机视角只由服务器分配的本机阵营决定',
  T.getViewPlayerForMode('online', 'red') === 'red' && T.getViewPlayerForMode('online', 'blue') === 'blue');
ok('棋盘不再通过 CSS 旋转或按回合切换视角',
  !/checker-board\.view-(red|blue)/.test(css) && !/\.checker-board[^}]*rotate/.test(css) && !/viewPlayer\s*=\s*turn/.test(source));

const initial = C.createInitialPieces();
const owners = Object.values(initial);
ok('初始棋局为红蓝双方各 10 枚棋子',
  owners.length === 20 && owners.filter(v => v === 'red').length === 10 && owners.filter(v => v === 'blue').length === 10);

const opening = C.getLegalMoves(initial, '3:-3');
ok('红方前排棋子开局可以走向中央空位',
  opening.steps.includes('4:-4') && opening.steps.includes('4:-2'));
const applied = C.applyMove(initial, 'red', '3:-3', '4:-4');
ok('共用规则核心能执行合法走棋且不修改原棋盘',
  applied && applied.pieces['4:-4'] === 'red' && initial['3:-3'] === 'red');
ok('规则核心返回完整路径，供双方准确还原上一步',
  applied.kind === 'step' && applied.path.join(',') === '3:-3,4:-4');
ok('共用规则核心拒绝越权阵营和非法落点',
  C.applyMove(initial, 'blue', '3:-3', '4:-4') === null && C.applyMove(initial, 'red', '3:-3', '8:0') === null);

const chainPieces = { '8:0': 'red', '8:2': 'blue', '8:6': 'red' };
const chainMoves = C.getLegalMoves(chainPieces, '8:0');
ok('连续跳跃会一次标出全部可达落点',
  chainMoves.jumps.includes('8:4') && chainMoves.jumps.includes('8:8'));
const chainPath = C.findMovePath(chainPieces, '8:0', '8:8');
ok('连续跳跃会保留每一段经过的孔位',
  chainPath && chainPath.join(',') === '8:0,8:4,8:8');

const aiMove = C.chooseAiMove(initial, 'blue', 'hard', () => 0);
ok('电脑可以从初始棋局选择一条合法蓝方走法',
  aiMove && C.getLegalMoves(initial, aiMove.from).all.includes(aiMove.target) && initial[aiMove.from] === 'blue');

const validState = C.sanitizeState({ pieces: initial, turn: 'blue', moveNumber: 12, winner: '' });
ok('合法棋局状态可恢复且保留回合信息', validState && validState.turn === 'blue' && validState.moveNumber === 12);
const stateWithMove = C.sanitizeState({ pieces: applied.pieces, turn: 'blue', moveNumber: 2, winner: '', lastMove: {
  player: 'red', from: '3:-3', target: '4:-4', kind: 'step', path: ['3:-3', '4:-4'], moveNumber: 1
} });
ok('上一步来源、落点和路线会随棋局状态安全恢复',
  stateWithMove && stateWithMove.lastMove && stateWithMove.lastMove.path.length === 2);
ok('棋子数量不完整或位置越界的状态会被拒绝',
  C.sanitizeState({ pieces: { '99:99': 'red' }, turn: 'red' }) === null);

ok('大厅提供人机、本地双人、联机三种入口且不再混放棋盘',
  /id="startAiBtn"/.test(lobbyHtml) && /id="startLocalBtn"/.test(lobbyHtml) &&
  /id="createRoomBtn"/.test(lobbyHtml) && !/id="checkerBoard"/.test(lobbyHtml));
ok('游戏页只承载棋局，并先加载规则核心再加载交互脚本',
  /id="board"/.test(playHtml) && !/id="createRoomBtn"/.test(playHtml) &&
  playHtml.indexOf('checkers_core.js') >= 0 && playHtml.indexOf('checkers_core.js') < playHtml.indexOf('checkers.js'));
ok('游戏页提供上一步说明，棋盘能绘制来源、落点和完整路线',
  /id="lastMoveBar"/.test(playHtml) && /last-move-path/.test(source) &&
  /move-origin/.test(source) && /move-destination/.test(source));
ok('相邻落点与跳跃落点使用不同提示，不再共用简陋圆点',
  /step-target/.test(css) && /jump-target/.test(css) && /step-dot/.test(playHtml) && /jump-dot/.test(playHtml));
ok('手机布局保持单列与正方形棋盘', /@media\s*\(max-width:\s*820px\)/.test(css) && /aspect-ratio:\s*1(?:\s*\/\s*1)?/.test(css));
ok('邀请链接和联机地址使用跳棋专属入口',
  /new URL\('index\.html'/.test(source) && /searchParams\.set\('room'/.test(source) &&
  T.websocketUrl() === 'wss://game.test/checkers-ws');
const reconnectDelays = [1, 2, 4, 12].map(function (attempt) { return T.reconnectDelayForAttempt(attempt, .5); });
ok('断线重连使用有上限的指数退避，而不是固定频率重试',
  reconnectDelays[0] === 800 && reconnectDelays[1] === 1360 &&
  reconnectDelays[2] > reconnectDelays[1] && reconnectDelays[3] === 10000);
ok('游戏平台卡片已展示人机与在线联机能力',
  /href="checkers\/index\.html"/.test(platformHtml) && /人机挑战/.test(platformHtml) && /在线联机/.test(platformHtml));
ok('服务器加载同一规则核心并提供权威跳棋 WebSocket',
  /require\('\.\/public\/checkers\/checkers_core'\)/.test(serverSource) &&
  /pathname === '\/checkers-ws'/.test(serverSource) &&
  /CheckersCore\.applyMove\(room\.pieces/.test(serverSource));
ok('服务器限制单一来源建房并为未匹配房间设置不可续期寿命',
  /MAX_ROOMS_PER_IP/.test(serverSource) && /countRoomsForIp\(clientIp\)/.test(serverSource) &&
  /now - room\.createdAt > UNMATCHED_ROOM_TTL_MS/.test(serverSource));
ok('服务器为无尾斜杠跳棋地址提供稳定重定向', /'\/checkers': '\/checkers\/'/.test(serverSource));

console.log('\n✅ 中国跳棋核心测试全部通过（' + passed + ' 项）');
