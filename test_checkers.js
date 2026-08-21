'use strict';

const fs = require('fs');
const vm = require('vm');

const sandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error,
  setTimeout, clearTimeout,
  document: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
};
sandbox.window = sandbox;
sandbox.addEventListener = function () {};
vm.createContext(sandbox);

const source = fs.readFileSync('public/checkers/checkers.js', 'utf8');
const html = fs.readFileSync('public/checkers/index.html', 'utf8');
const css = fs.readFileSync('public/checkers/checkers.css', 'utf8');
const platformHtml = fs.readFileSync('public/index.html', 'utf8');
const serverSource = fs.readFileSync('server.js', 'utf8');
vm.runInContext(source, sandbox, { filename: 'checkers.js' });

const C = sandbox.__checkersTest;
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

ok('棋盘生成完整的 121 个唯一孔位',
  C.BOARD_CELLS.length === 121 && new Set(C.BOARD_CELLS.map(cell => cell.key)).size === 121);
ok('17 行孔位数量符合六角星棋盘结构',
  C.CONFIG.ROW_COUNTS.join(',') === '1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1');
ok('上下双方营地各有 10 个孔位', C.TOP_CAMP.length === 10 && C.BOTTOM_CAMP.length === 10);

const initial = C.createInitialPieces();
const owners = Object.values(initial);
ok('初始棋局为红蓝双方各 10 枚棋子',
  owners.length === 20 && owners.filter(v => v === 'red').length === 10 && owners.filter(v => v === 'blue').length === 10);

const opening = C.getLegalMoves(initial, '3:-3');
ok('红方前排棋子开局可以走向中央空位',
  opening.steps.includes('4:-4') && opening.steps.includes('4:-2'));

const chainPieces = { '8:0': 'red', '8:2': 'blue', '8:6': 'red' };
const chainMoves = C.getLegalMoves(chainPieces, '8:0');
ok('连续跳跃会一次标出全部可达落点',
  chainMoves.jumps.includes('8:4') && chainMoves.jumps.includes('8:8'));

const blockedPieces = { '8:0': 'red', '8:2': 'blue', '8:4': 'blue' };
ok('被占用的落点不会被判定为合法跳跃',
  !C.getLegalMoves(blockedPieces, '8:0').jumps.includes('8:4'));

const winning = {};
C.BOTTOM_CAMP.forEach(key => { winning[key] = 'red'; });
ok('10 枚棋子全部进入对面营地后判定获胜', C.hasWon(winning, 'red') && C.countInGoal(winning, 'red') === 10);

const validSave = C.sanitizeSavedGame({ pieces: initial, turn: 'blue', moveNumber: 12, gameOver: '' });
ok('合法存档可恢复且保留回合信息', validSave && validSave.turn === 'blue' && validSave.moveNumber === 12);
ok('伪造的获胜标记不会绕过营地胜负判断',
  C.sanitizeSavedGame({ pieces: initial, turn: 'red', moveNumber: 2, gameOver: 'red' }).gameOver === '');
ok('棋子数量不完整或位置越界的存档会被拒绝',
  C.sanitizeSavedGame({ pieces: { '99:99': 'red' }, turn: 'red' }) === null);

ok('跳棋入口完整引用独立样式和脚本',
  /checkers\.css\?v=/.test(html) && /checkers\.js\?v=/.test(html) && /href="\.\.\/"/.test(html));
ok('手机布局会切换为单列并保持棋盘正方形',
  /@media\(max-width:760px\)/.test(css) && /aspect-ratio:1\/1/.test(css));
ok('游戏平台卡片路由到真实跳棋目录且不再虚标联机',
  /href="checkers\/index\.html"/.test(platformHtml) && /本地热座/.test(platformHtml) && !/本地\+联机/.test(platformHtml));
ok('服务器为无尾斜杠跳棋地址提供稳定重定向',
  /'\/checkers': '\/checkers\/'/.test(serverSource));

console.log('\n✅ 中国跳棋核心测试全部通过（' + passed + ' 项）');
