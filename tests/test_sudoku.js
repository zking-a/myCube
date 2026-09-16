'use strict';

const fs = require('fs');
const vm = require('vm');

let storageWrites = 0;
const sandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Map, RegExp, Error,
  parseInt, isFinite,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: {},
  localStorage: { getItem() { return null; }, setItem() { storageWrites++; }, removeItem() {} },
};
sandbox.window = sandbox;
sandbox.addEventListener = function () {};
vm.createContext(sandbox);
const sudokuSource = fs.readFileSync('public/sudoku/sudoku.js', 'utf8');
const sudokuCss = fs.readFileSync('public/sudoku/sudoku.css', 'utf8');
const sudokuHtml = fs.readFileSync('public/sudoku/index.html', 'utf8');
const platformHtml = fs.readFileSync('public/index.html', 'utf8');
const platformCss = fs.readFileSync('public/platform.css', 'utf8');
vm.runInContext(sudokuSource, sandbox, { filename: 'sudoku.js' });

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
ok('极限难度如实说明唯一解下的目标给定数',
  clueCounts[4] >= 24 && clueCounts[4] <= 26 && /极限[\s\S]*约 24 个已知数/.test(sudokuHtml) &&
  /sudoku\.js\?v=[a-f0-9]{12}/.test(sudokuHtml));

ok('难度参数越界时安全回落到简单', S.normalizeDifficulty(-1) === 0 && S.normalizeDifficulty(99) === 0);
ok('计时格式覆盖分钟和小时', S.formatDuration(65) === '01:05' && S.formatDuration(3661) === '01:01:01');
ok('候选辅助关闭时不显示自动候选，人工笔记仍可见',
  S.getCandidateDisplayMode(0, [], false) === 'none' &&
  S.getCandidateDisplayMode(0, [], true) === 'auto' &&
  S.getCandidateDisplayMode(0, [3], false) === 'manual' &&
  S.getCandidateDisplayMode(7, [3], true) === 'none');
ok('点击已填数字始终关联相同数字，候选关联只在辅助开启时生效',
  S.getNumberRelation(3, [], 3, false) === 'same' &&
  S.getNumberRelation(0, [1, 3, 7], 3, false) === 'none' &&
  S.getNumberRelation(0, [1, 3, 7], 3, true) === 'candidate' &&
  S.getNumberRelation(0, [1, 7], 3, true) === 'none');
ok('相同数字使用强高亮，关联候选只圈亮对应小数字',
  /\.cell\.same-num:not\(\.error\)>span/.test(sudokuCss) &&
  /\.cell\.candidate-match\{/.test(sudokuCss) &&
  /\.candidates span\.candidate-match-num\{/.test(sudokuCss) &&
  /s\.classList\.add\("candidate-match-num"\)/.test(sudokuSource));
const noteToggleSource = sudokuSource.slice(
  sudokuSource.indexOf('function toggleNoteMode()'),
  sudokuSource.indexOf('function toggleShowAllCands()'));
const candidateToggleSource = sudokuSource.slice(
  sudokuSource.indexOf('function toggleShowAllCands()'),
  sudokuSource.indexOf('function toggleCandidate('));
ok('候选辅助关闭时不再高亮数字键且切换不会清空选中格',
  /if \(!showAllCands \|\| selected < 0\) return;/.test(sudokuSource) &&
  !/selected = -1/.test(candidateToggleSource) &&
  !/selected = -1/.test(noteToggleSource));
ok('开启候选辅助后写笔记不会复制整格自动候选',
  !/如果 showAllCands 开启，先确保目标格有笔记数据/.test(sudokuSource));
const sanitizedNotes = S.sanitizeNotes({
  0: [9, 2, 2, 0, 10, '3'],
  1: [4],
  2: '5',
  81: [1],
  bad: [7],
}, [0, 8, 0], [0, 8, 0]);
ok('恢复存档时过滤越界、重复、非数字及已填格笔记',
  JSON.stringify(sanitizedNotes) === JSON.stringify({ 0: [2, 9] }));
const sanitizedStats = S.sanitizeStats({
  0: { count: 2.8, best: 65.9, total: 200.7 },
  1: { count: '<img>', best: 20, total: 20 },
  2: { count: 1, best: -1, total: 8 },
  bad: { count: 99, best: 1, total: 1 },
});
ok('战绩存档只接受有效难度和有限非负数值',
  JSON.stringify(sanitizedStats) === JSON.stringify({ 0: { count: 2, best: 65, total: 200 } }));
ok('战绩面板采用可访问对话框并隐藏非激活内容',
  /id="statsOverlay" role="dialog" aria-modal="true" aria-hidden="true"/.test(sudokuHtml) &&
  /\.modal-overlay\{[^}]*visibility:\s*hidden/.test(sudokuCss) &&
  /#statsOverlay\{[^}]*justify-content:\s*flex-end/.test(sudokuCss) &&
  /#statsOverlay\{\s*align-items:flex-end/.test(sudokuCss));
ok('棋盘坐标按内框尺寸映射，不受外边框干扰',
  S.gridIndexAtPoint(0, 0, 441, 441) === 0 &&
  S.gridIndexAtPoint(440.9, 440.9, 441, 441) === 80 &&
  S.gridIndexAtPoint(-0.1, 20, 441, 441) === -1);
const dragBox = S.getDragRectBox(72, 73, 441, 441);
ok('拖拽选区与两个相邻单元格的内框精确对齐',
  dragBox.left === 0 && dragBox.top === 392 && dragBox.width === 98 && dragBox.height === 49);
ok('最下行和最右列不再绘制重复边框',
  /\.cell\.c8\s*\{\s*border-right:\s*0/.test(sudokuCss) &&
  /\.cell\.r8\s*\{\s*border-bottom:\s*0/.test(sudokuCss));
ok('宫格粗线使用整数像素避免缩放亮缝',
  /\.cell\.c2,\s*\.cell\.c5\s*\{\s*border-right:\s*2px/.test(sudokuCss) &&
  /\.cell\.r2,\s*\.cell\.r5\s*\{\s*border-bottom:\s*2px/.test(sudokuCss));
ok('手机游戏大厅不再使用会覆盖标签的绝对定位入口文案',
  !/game-enter/.test(platformHtml) && !/\.game-enter/.test(platformCss));
ok('数独续玩卡保持紧凑横向结构',
  /继续上局/.test(sudokuHtml) &&
  /\.resume-card\{[^}]*min-height:72px[^}]*align-items:center/.test(sudokuCss) &&
  !/\.resume-card\{[^}]*flex-direction:column/.test(sudokuCss));
ok('数独大厅提供好友协作入口与可见的同盘状态栏',
  /id="openCollabBtn"/.test(sudokuHtml) && /id="collabConfig"/.test(sudokuHtml) &&
  /id="collabStatusBar"/.test(sudokuHtml) && /CO-OP SUDOKU/.test(sudokuHtml) &&
  /collab-status-bar\{[^}]*grid-column:1\/-1/.test(sudokuCss));
ok('协作客户端保存私密重连身份并连接数独专属通道',
  /STORAGE_COLLAB/.test(sudokuSource) && /sudoku-ws/.test(sudokuSource) &&
  /sendCollabChanges/.test(sudokuSource) && /resumeCollabGame/.test(sudokuSource));
const historyBoard = [7];
const historyNotes = { 0: [1, 2] };
S.restoreHistoryEntry(historyBoard, historyNotes, { index: 0, prevValue: 0, prevNotes: null });
ok('撤销普通填数会同时恢复数字与笔记', historyBoard[0] === 0 && historyNotes[0] === undefined);

const bulkBoard = [0, 0];
const bulkNotes = {};
S.restoreHistoryEntry(bulkBoard, bulkNotes, { bulk: [
  { index: 0, prevValue: 7, prevNotes: [1, 2] },
  { index: 1, prevValue: 3, prevNotes: null },
] });
ok('整盘清空可一次撤销并恢复全部填写与笔记', bulkBoard[0] === 7 && bulkBoard[1] === 3 && bulkNotes[0].join('') === '12');

const snapshotBoard = [5, 6];
const snapshotNotes = { 0: [9] };
S.restoreHistoryEntry(snapshotBoard, snapshotNotes, {
  bulk: [{ index: 0, prevValue: 0 }, { index: 1, prevValue: 0 }],
  notesSnapshot: { 0: [1, 3], 1: [2, 4] },
});
ok('批量填数撤销会还原所有被自动擦除的候选笔记',
  snapshotBoard.join('') === '00' && snapshotNotes[0].join('') === '13' && snapshotNotes[1].join('') === '24');
ok('赞美语句库不再混入候选功能调试说明', !/这个是我要的逻辑/.test(sudokuSource));

S.CONFIG.AUTO_SAVE_INTERVAL = 20;
S.autoSave(); S.autoSave(); S.autoSave();
ok('连续存档请求不会同步反复写 localStorage', storageWrites === 0);
setTimeout(function () {
  ok('存档请求合并后只执行一次写入', storageWrites === 1);
  S.clearSave();
  console.log('\n✅ 数独核心测试全部通过（' + passed + ' 项，给定数：' + clueCounts.join('/') + '）');
}, 40);
