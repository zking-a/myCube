'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync('public/platform.js', 'utf8');
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

function run(seed) {
  const values = Object.assign({}, seed);
  const elements = {
    recentGame: { hidden: true },
    recentGameLink: { href: '24/' },
    recentGameTitle: { textContent: '' },
    recentGameMeta: { textContent: '' }
  };
  const storage = {
    get length() { return Object.keys(values).length; },
    key(index) { return Object.keys(values)[index] || null; },
    getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
    setItem(key, value) { values[key] = String(value); }
  };
  const sandbox = {
    console, JSON, Number, Array, Object, Math, Date, URL,
    localStorage: storage,
    location: { search: '', hash: '', href: 'http://example.test/', replace() {} },
    document: {
      getElementById(id) { return elements[id] || null; },
      querySelectorAll() { return []; }
    }
  };
  vm.runInNewContext(source, sandbox, { filename: 'platform.js' });
  return elements;
}

ok('没有有效存档时不显示伪继续入口', run({}).recentGame.hidden);
ok('只有最近访问记录时仍不冒充可续玩存档', run({
  light_games_recent_v1: JSON.stringify({ id: 'sudoku', name: '数独挑战', href: 'sudoku/' })
}).recentGame.hidden);

const sudokuBoard = new Array(81).fill(1); sudokuBoard[40] = 0;
const sudoku = run({ sudoku_save: JSON.stringify({ board: sudokuBoard, seconds: 125 }) });
ok('有效数独存档会展示真正的继续入口',
  !sudoku.recentGame.hidden && sudoku.recentGameLink.href === 'sudoku/' &&
  sudoku.recentGameTitle.textContent === '继续数独挑战' && /125 秒/.test(sudoku.recentGameMeta.textContent));

const preferred = run({
  light_games_recent_v1: JSON.stringify({ id: 'gomoku', name: '五子棋', href: 'gomoku/' }),
  sudoku_save: JSON.stringify({ board: sudokuBoard, seconds: 1 }),
  gomoku_save_ai_v1: JSON.stringify({ mode: 'ai', finished: false, moveNumber: 6, board: [[]] })
});
ok('多个存档优先继续最近玩过的游戏',
  preferred.recentGameLink.href === 'gomoku/' && /6 手/.test(preferred.recentGameMeta.textContent));

function htmlFiles(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(target, out);
    else if (entry.name.endsWith('.html')) out.push(target);
  });
  return out;
}
const stale = [];
htmlFiles('public', []).forEach(function (htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const re = /(?:src|href)=["']([^"'?#]+\.(?:js|css))(?:\?v=([^"']+))?["']/g;
  let match;
  while ((match = re.exec(html))) {
    const asset = path.resolve(path.dirname(htmlFile), match[1]);
    const expected = crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex').slice(0, 12);
    if (match[2] !== expected) stale.push(htmlFile + ' -> ' + match[1]);
  }
});
ok('所有版本化脚本与样式都使用当前内容哈希', stale.length === 0);

console.log('\n✅ 游戏大厅续玩测试全部通过（' + passed + ' 项）');
