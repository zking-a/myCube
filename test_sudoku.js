'use strict';

const fs = require('fs');
const vm = require('vm');

const sandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, RegExp, Error,
  parseInt, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
};
sandbox.window = sandbox;
sandbox.addEventListener = function () {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('public/sudoku/sudoku.js', 'utf8'), sandbox, { filename: 'sudoku.js' });

const S = sandbox.__sudokuTest;
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

function validUnit(values) {
  return values.slice().sort((a, b) => a - b).join('') === '123456789';
}

function validSolution(board) {
  if (!Array.isArray(board) || board.length !== 81) return false;
  for (let r = 0; r < 9; r++) if (!validUnit(board.slice(r * 9, r * 9 + 9))) return false;
  for (let c = 0; c < 9; c++) {
    const col = []; for (let r = 0; r < 9; r++) col.push(board[r * 9 + c]);
    if (!validUnit(col)) return false;
  }
  for (let br = 0; br < 3; br++) for (let bc = 0; bc < 3; bc++) {
    const box = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push(board[(br * 3 + r) * 9 + bc * 3 + c]);
    if (!validUnit(box)) return false;
  }
  return true;
}

const generated = [];
for (let i = 0; i < 8; i++) generated.push(S.generateSolution());
ok('生成的完整终盘均符合行、列、宫规则', generated.every(validSolution));
ok('随机终盘不只是同一盘面的重复', new Set(generated.map(v => v.join(''))).size > 1);

const base = S.generateSolution();
const puzzles = [0, 1, 2, 3, 4].map(diff => S.generateGivens(base, diff));
ok('五档题目都保留给定数字且不篡改答案', puzzles.every(p => p.length === 81 && p.every((v, i) => v === 0 || v === base[i])));
ok('五档题目全部保持唯一解', puzzles.every(p => S.countSolutions(p, 2) === 1));
const clueCounts = puzzles.map(p => p.filter(Boolean).length);
console.log('  INFO  五档给定数：' + clueCounts.join('/'));
ok('难度越高给定数字不增加', clueCounts.every((v, i) => i === 0 || v <= clueCounts[i - 1]));

ok('难度参数越界时安全回落到简单', S.normalizeDifficulty(-1) === 0 && S.normalizeDifficulty(99) === 0);
ok('计时格式覆盖分钟和小时', S.formatDuration(65) === '01:05' && S.formatDuration(3661) === '01:01:01');
const historyBoard = [7];
const historyNotes = { 0: [1, 2] };
S.restoreHistoryEntry(historyBoard, historyNotes, { index: 0, prevValue: 0, prevNotes: null });
ok('撤销普通填数会同时恢复数字与笔记', historyBoard[0] === 0 && historyNotes[0] === undefined);

console.log('\n✅ 数独核心测试全部通过（' + passed + ' 项，给定数：' + clueCounts.join('/') + '）');
