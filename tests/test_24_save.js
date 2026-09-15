'use strict';
// 24 点闯关存档测试：在 Node 桩 DOM 中加载 core.js + data.js + game.js，
// 用真实可用的 localStorage 桩 / 故意抛错的 localStorage 桩两种环境，
// 验证「通关保存 → 刷新后仍在」「存储被禁用时降级且给出提示」「换一批题的清星确认」三类行为。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'public', '24');

function makeEl() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    _html: '', _text: '', children: [], _onclick: null,
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    className: '', value: '', disabled: false, offsetWidth: 0,
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, querySelector() { return makeEl(); }, addEventListener() {},
    focus() {}, select() {},
    set onclick(v) { this._onclick = v; }, get onclick() { return this._onclick; }
  };
}

function makeStorage(backing, opts) {
  if (opts && opts.broken) {
    return {
      getItem() { throw new Error('SecurityError: storage disabled'); },
      setItem() { throw new Error('SecurityError: storage disabled'); },
      removeItem() { throw new Error('SecurityError: storage disabled'); }
    };
  }
  if (opts && opts.quota) {
    // 读正常、写到第 N 次开始抛 QuotaExceededError（模拟写满）
    let writes = 0;
    return {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => { writes++; if (writes > (opts.quotaAfter || 1)) throw new Error('QuotaExceededError'); backing.set(k, String(v)); },
      removeItem: (k) => { backing.delete(k); }
    };
  }
  return {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, String(v)); },
    removeItem: (k) => { backing.delete(k); }
  };
}

function boot(backing, opts) {
  const elems = {};
  function getEl(id) { if (!elems[id]) elems[id] = makeEl(); return elems[id]; }
  const sandbox = {
    console, Math, Date, JSON, parseInt, parseFloat, isNaN,
    Array, Object, String, Number, RegExp, Error, TextEncoder, TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    requestAnimationFrame: () => 0,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {}
  };
  sandbox.window = sandbox;
  sandbox.__domReady = null;
  sandbox.addEventListener = function (type, fn) { if (type === 'DOMContentLoaded') sandbox.__domReady = fn; };
  sandbox.document = {
    getElementById: getEl, createElement: makeEl,
    body: { appendChild() {}, removeChild() {} }, addEventListener() {}
  };
  sandbox.localStorage = makeStorage(backing, opts);
  sandbox.navigator = { clipboard: { writeText() {} } };
  sandbox.location = { origin: 'https://x.test', pathname: '/24/', search: '', hash: '', protocol: 'https:' };
  sandbox.WebSocket = function () {
    return { close() {}, send() {}, readyState: 1,
      set onopen(v) {}, set onmessage(v) {}, set onclose(v) {}, set onerror(v) {} };
  };
  sandbox.Net = {
    getNick: () => '我', readInviteCode: () => null, getServerUrl: () => 'https://x.test',
    setNick() {}, randomRoomCode: () => 'TEST', normalizeRoomCode: (c) => c, isValidRoomCode: () => true,
    getCid: () => 'me', createClient: () => ({ open() {}, send() {}, progress() {}, close() {} }),
    buildRoomQuestions: () => [], roundSeed: () => 0, inviteLink: () => '', encodeScore: () => 'SCORE',
    decodeScore: () => ({}), normalizeServerBase: () => '', setServerUrl() {}
  };
  sandbox.AudioContext = function () {
    return { state: 'running', currentTime: 0, destination: {}, resume() {},
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; },
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; } };
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8'), sandbox, { filename: 'core.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8'), sandbox, { filename: 'data.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8'), sandbox, { filename: 'game.js' });
  return { sandbox, getEl, elems };
}

const STORE_KEY = 'g24_progress_v2';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

function winPerfect(ch, hintUsed) {
  ch.openChallenge(1, 1);
  ch.state.elapsedMs = 30000;
  ch.state.hintUsed = !!hintUsed;
  ch.onChWin({});
}

// ---------- 1. 关卡数据完整性（解锁门控依赖每关 10 题） ----------
console.log('【1】关卡数据');
{
  const A = boot(new Map());
  const T = A.sandbox.window.__test;
  const counts = {};
  A.sandbox.window.LEVELS.levels.forEach((e) => { counts[e.level] = (counts[e.level] || 0) + 1; });
  const levels = Object.keys(counts).map(Number);
  const missing = [];
  for (let l = 1; l <= T.LEVEL_COUNT; l++) if (counts[l] !== 10) missing.push(l + ':' + (counts[l] || 0));
  ok('80 大关每关都有 10 题，无缺口（解锁按每关 10 题门控）', missing.length === 0, missing.join(','));
}

// ---------- 2. 正常存储：通关 → 存档 → 刷新后仍在 ----------
console.log('【2】正常环境：存档与恢复');
{
  const backing = new Map();
  const A = boot(backing);
  A.sandbox.__domReady();
  winPerfect(A.sandbox.window.__test.ch, false);
  const raw = backing.get(STORE_KEY);
  ok('通关后写入存档键', !!raw);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {}
  ok('第 1 关第 1 题记为 3 星', !!(parsed && parsed.stars && parsed.stars['1'] && parsed.stars['1'][1] && parsed.stars['1'][1].stars === 3));
  ok('记录含用时（秒表数据也被保存）', !!(parsed && parsed.stars['1'][1].timeMs === 30000));
  ok('存储正常时不显示告警条', A.getEl('storage-warn').style.display !== 'block');

  // 新会话共享同一存储 = 刷新页面
  const B = boot(backing);
  B.sandbox.__domReady();
  const T2 = B.sandbox.window.__test;
  T2.ch.openStages(1);
  const cells = B.getEl('stages-grid').children;
  ok('刷新后第 1 关仍显示 ★★★', /★★★/.test(cells[0] && cells[0].innerHTML), cells[0] && cells[0].innerHTML);
  ok('刷新后第 2 关解锁（第 1 关通关即解锁下一关）', !!(cells[1] && !/ui-icon--lock/.test(cells[1].innerHTML)), cells[1] && cells[1].innerHTML);
  ok('刷新后第 1 大关保持解锁', T2.ch.levelUnlocked(1) === true);
}

// ---------- 3. 星数取最优：重复通关不降级 ----------
console.log('【3】星数取最优');
{
  const backing = new Map();
  const A = boot(backing);
  const ch = A.sandbox.window.__test.ch;
  winPerfect(ch, false);              // 3 星
  ch.openChallenge(1, 1);
  ch.state.elapsedMs = 5000; ch.state.hintUsed = true;
  ch.onChWin({});                     // 用了提示 → 1 星，不应覆盖 3 星
  const parsed = JSON.parse(backing.get(STORE_KEY));
  ok('重复通关保留历史最高星（3 星不被 1 星覆盖）', parsed.stars['1'][1].stars === 3, JSON.stringify(parsed.stars['1'][1]));
  ok('用时保留更快的一次（5000ms 覆盖 30000ms）', parsed.stars['1'][1].timeMs === 5000, String(parsed.stars['1'][1].timeMs));
}

// ---------- 4. 存储被禁用：不抛错、显式告警、进度不写 ----------
console.log('【4】存储被禁用（隐私模式/内嵌预览沙箱/file://）');
{
  const A = boot(new Map(), { broken: true });
  A.sandbox.__domReady();
  ok('启动即显示「无法保存进度」告警条', A.getEl('storage-warn').style.display === 'block');
  const ch = A.sandbox.window.__test.ch;
  let threw = null;
  try { winPerfect(ch, false); } catch (e) { threw = e; }
  ok('存储被禁用时通关流程不抛异常（结算界面正常）', threw === null, threw && threw.message);
  ok('存储被禁用时结果页仍正常显示 ★★★', /★★★/.test(A.getEl('ch-result-stars').textContent));
}

// ---------- 5. 写入中途配额超限：降级为告警而不是崩溃 ----------
console.log('【5】写入配额超限（QuotaExceeded）');
{
  const backing = new Map();
  const A = boot(backing, { quota: true, quotaAfter: 1 });
  const ch = A.sandbox.window.__test.ch;
  let threw = null;
  try { winPerfect(ch, false); } catch (e) { threw = e; }
  ok('配额超限不抛异常给玩家', threw === null, threw && threw.message);
  ok('配额超限后显示告警条', A.getEl('storage-warn').style.display === 'block');
}

// ---------- 6. 换一批题：有星必须先确认，取消就不清星 ----------
console.log('【6】换一批题确认（防止误清记录）');
{
  const backing = new Map();
  const A = boot(backing);
  A.sandbox.__domReady();
  winPerfect(A.sandbox.window.__test.ch, false);          // 拿到 3 星
  const before = JSON.parse(backing.get(STORE_KEY)).stars['1'];
  const handler = A.getEl('stages-reshuffle').onclick;
  ok('换一批题已绑定处理函数', typeof handler === 'function');
  A.sandbox.confirm = () => false;                        // 玩家点「取消」
  handler();
  const afterCancel = JSON.parse(backing.get(STORE_KEY)).stars['1'];
  ok('确认框点取消 → 星数保留', JSON.stringify(afterCancel) === JSON.stringify(before), JSON.stringify(afterCancel));
  A.sandbox.confirm = () => true;                         // 玩家点「确定」
  handler();
  const afterOk = JSON.parse(backing.get(STORE_KEY)).stars['1'];
  ok('确认后换题 → 该大关星数清空（题目变了，旧星数失效）', !afterOk || afterOk.every((r) => !r), JSON.stringify(afterOk));
}

// ---------- 7. 真实点击通关（不直接调 onChWin，走棋盘真实的 onWin 链路） ----------
console.log('【7】真实点击通关链路');
{
  const backing = new Map();
  const A = boot(backing);
  A.sandbox.__domReady();
  const T = A.sandbox.window.__test;
  const ch = T.ch;
  ch.openChallenge(1, 1);
  const board = ch.board;
  // 第 1 大关第 1 题固定为 [1,2,3,4]，解 1×2×3×4。
  // 注意：一次合并后结果牌会自动成为选中项，因此下一步直接选运算符、再点第二张牌。
  board.clickToken(1); board.clickOp('×'); board.clickToken(2);   // 1×2 → 2（自动选中）
  board.clickOp('×'); board.clickToken(3);                        // 2×3 → 6（自动选中）
  board.clickOp('×'); board.clickToken(4);                        // 6×4 → 24 ⇒ 触发 onWin
  const raw = backing.get(STORE_KEY);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {}
  ok('点击牌面凑出 24 会触发真实 onWin 并写入通关记录',
    !!(parsed && parsed.stars && parsed.stars['1'] && parsed.stars['1'][1]),
    'localStorage=' + String(raw).slice(0, 120));
  ok('真实通关记 3 星（未用提示、未超时）',
    !!(parsed && parsed.stars['1'][1] && parsed.stars['1'][1].stars === 3),
    JSON.stringify(parsed && parsed.stars));
  const overlay = A.getEl('ch-result');
  ok('通关结果浮层已显示', overlay.style.display === 'flex', String(overlay.style.display));
}

// ---------- 8. 续玩：记住上次所在的大关与关卡 ----------
console.log('【8】进度记忆（续玩入口）');
{
  const backing = new Map();
  const A = boot(backing);
  A.sandbox.__domReady();
  const ch = A.sandbox.window.__test.ch;
  ch.openChallenge(1, 1);
  const lastAfterOpen = JSON.parse(backing.get(STORE_KEY) || '{}').last;
  ok('进入关卡即记录「当前所在大关/关卡」', !!(lastAfterOpen && lastAfterOpen.level === 1 && lastAfterOpen.index === 1), JSON.stringify(lastAfterOpen));

  ch.openChallenge(1, 2);
  const last2 = JSON.parse(backing.get(STORE_KEY) || '{}').last;
  ok('切到第 2 关后进度记忆同步更新', !!(last2 && last2.index === 2), JSON.stringify(last2));

  // 刷新后：走真实路径（首页「闯关挑战」→ 关卡地图）验证续玩入口
  const B = boot(backing);
  B.sandbox.__domReady();
  const T2 = B.sandbox.window.__test;
  T2.ch.openChallenge(1, 2);
  B.getEl('btn-challenge').onclick();          // = 首页点「闯关挑战」
  const resume = B.getEl('levels-resume');
  ok('关卡地图渲染出续玩入口容器', !!resume);
  ok('续玩入口文案包含上次所在大关与关卡', /第 1 大关/.test(resume.innerHTML) && /第 2 关/.test(resume.innerHTML), resume.innerHTML);
  ok('续玩入口默认可见（有进度时）', resume.style.display === 'block', String(resume.style.display));
  ok('续玩入口显示累计进度摘要（已通关数 / 总关数 / 星星）', /已通关 \d+ \/ \d+ 关 · 累计 \d+ ★/.test(resume.innerHTML), resume.innerHTML);
  ok('关卡地图标出上次所在的大关格子', /lv-last/.test(B.getEl('levels-grid').children.map((c) => c.className).join(' ')));
  ok('续玩按钮已绑定点击（点击可直达该关）', typeof B.getEl('levels-continue').onclick === 'function');
}

console.log('\n' + (fail === 0 ? '✅ 24 点闯关存档测试全部通过（' + pass + ' 项）' : '❌ 失败 ' + fail + ' 项'));
process.exit(fail === 0 ? 0 : 1);
