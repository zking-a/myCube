# 中国跳棋「生日主题（棋盘+棋子）」改动记录（供独立核查）

> 本文件自包含，列出本次对中国跳棋网页游戏「生日主题」所做的**全部改动**、**设计约束/易错点**、**关键代码**与**验证结果**，
> 便于交给第三方（如 ChatGPT）逐项核查是否正确、是否引入回归。
> 生成日期：2026-09-19（朋友「玫玫」生日当天）。
> 目标：把跳棋棋盘+棋子改成派对风，用于 9/19 生日派对对局。**玩法逻辑文件完全未动**，仅表现层。

---

## 一、改动文件总览

| 文件 | 动作 | 说明 |
|------|------|------|
| `public/checkers/checkers.js` | 修改 | 主题解析 `resolveBirthdayMode` + 棋子配色 `BIRTHDAY_TINTS`/`candyTint` + 糖针 SVG 注入 + 测试导出 |
| `public/checkers/checkers-birthday.css` | 新建/重写 | 暖粉木纹棋盘、玫瑰孔位、彩带撒花/气球、胜利弹窗派对风（全部 `html.birthday-mode` 后代选择器） |
| `public/checkers/birthday-checkers.js` | 新建/重写 | 装饰模块：胜利弹窗加「🎉 生日快乐」前缀、彩带/气球，挂 `window.showWinner`，尊重 reduce-motion |
| `public/checkers/play.html` | 修改 | `<head>` 引入 `checkers-birthday.css` 与 `birthday-checkers.js`（均带 `?v=` 哈希） |
| `tests/test_checkers.js` | 修改 | 新增 6 条生日主题断言（见第五节） |
| `tests/test-birthday-checkers.js`、`tests/test-birthday-checkers-logic.js` | **删除** | 早期冗余孤儿测试，断言已并入 `test_checkers.js` |
| `gen_preview.cjs`、`preview_pieces.html`（仓库根） | 新增（诊断用，可删） | 用真实 `buildPieceNode` 渲染六色棋子预览，供肉眼核对 |

> 可由 `git status` / `git diff` 核对：玩法文件 `checkers_core.js`、`checkers_ai_engine.js`、`server.js` 的规则部分**不应出现在改动中**。

---

## 二、设计约束 / 易错点（核查重点）

1. **defs id 数量被测试钉死为 28**：`tests/test_checkers.js` 断言「id 总数仍为 28（不新增 defs id）」，要求 `buildPieceDefs` 生成的渐变 `<defs>` 子节点数恒为 28。
   因此糖针（彩色小棒）必须用 **inline `<rect>` 直接画**，**不能新开 `<linearGradient>`/`<radialGradient>`**，否则 id 超 28 测试失败。
2. **开发服务器 staticCache 常驻内存、不按 mtime 失效**：`server.js` 对静态资源做永久内存缓存。改完静态文件后，要么重启进程，
   要么靠 `?v=<sha256[:12]>` 哈希变化让该 URL 变成缓存未命中从而回源。**本次已用 `node scripts/version_static_assets.js` 重算 `?v=`**，
   所以即便旧进程仍在，新哈希 URL 也会读磁盘最新内容。
3. **棋子是 JS 生成的 inline SVG，不是 CSS 画的**：颜色来自 `PIECE_TINTS` / `BIRTHDAY_TINTS`，每个阵营生成 4 段 `radialGradient`（`base/shade/rim/vig`）。
   `buildPieceDefs` 在 `ensureBoard()` 时**只调用一次**，所以主题必须在 `checkers.js` 顶层 `resolveBirthdayMode()` 之后、首次 `ensureBoard()` 之前确定。
4. **主题开关逻辑 `resolveBirthdayMode(search, now)`**：`?birthday=1` 强制开；`?birthday=0` 强制关；无参数时仅当 `now` 为 **9 月 19 日**自动开。
   顶层据此给 `<html>` 加 `birthday-mode` 类（用 `document.documentElement` 守卫，避免无 document 报错），并写 `window.__checkersBirthday = { active }`。
5. **测试沙箱日期陷阱**：`tests/test_checkers.js` 中两个 sandbox 的 `location.search` 均设为 `?mode=ai&birthday=0`。
   若设为 `?mode=ai`（无 birthday），则 9/19 跑测试会自动进入生日模式，使「玻璃珠」相关断言失准。设 `birthday=0` 可保证测试稳定。
6. **缓存策略**：`.html` = no-cache；带 `?v=` = immutable 1 年；不带 `?v=` = max-age=300。因此 HTML 改动（引入新 css/js）必须随之刷新对应引用。

---

## 三、逐文件改动详情

### 3.1 `public/checkers/checkers.js`

**(a) 顶层主题解析（约第 31–44 行）**
```js
// 生日模式判断：9月19日自动开启，?birthday=1 强制开，?birthday=0 强制关
function resolveBirthdayMode(search, now) {
  const params = new URLSearchParams(search || '');
  const flag = params.get('birthday');
  if (flag === '1') return true;
  if (flag === '0') return false;
  const d = now || new Date();
  return d.getMonth() === 8 && d.getDate() === 19;   // 月份 8 = 9 月（0-based）
}
const birthdayMode = resolveBirthdayMode(location.search, new Date());
if (birthdayMode && document.documentElement) {
  document.documentElement.classList.add('birthday-mode');
}
window.__checkersBirthday = { active: birthdayMode };
```

**(b) 棋子配色：去掉共用奶油糖体，改为六方各自清晰糖果色（约第 103–124 行）**
```js
// 生日主题配色：六方各用清晰不同的糖果色（草莓/蓝莓/抹茶/柠檬/葡萄/香橙），
// 主体本身即可一眼区分阵营；仍保留糖霜高光与彩针的派对质感。
function hexToRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function candyTint(light, mid, deep, edge, outline, pattern) {
  const d = hexToRgb(edge);
  const sr = d[0] + ',' + d[1] + ',' + d[2];
  return {
    base: [['0%', light], ['38%', mid], ['74%', deep], ['100%', edge]],
    shade: [['0%', 'rgba(' + sr + ',.34)'], ['100%', 'rgba(' + sr + ',0)']],
    rim: [['0%', 'rgba(255,255,255,.92)'], ['45%', 'rgba(255,255,255,.5)'], ['100%', 'rgba(255,255,255,0)']],
    vig: [['0%', 'rgba(' + sr + ',0)'], ['60%', 'rgba(' + sr + ',0)'], ['100%', 'rgba(' + sr + ',.28)']],
    outline: outline, pattern: pattern, rings: false, candy: true
  };
}
const BIRTHDAY_TINTS = {
  red:    candyTint('#ffd9e0', '#ff9bb0', '#f25877', '#d62f54', '#b81f43', '#f25877'),
  blue:   candyTint('#e3e8ff', '#9fb0ff', '#5b74f0', '#344ec9', '#243ba8', '#5b74f0'),
  green:  candyTint('#e2f8e6', '#9fe6ad', '#46c46a', '#1f9a47', '#157a37', '#46c46a'),
  yellow: candyTint('#fff7d6', '#ffe486', '#f7c531', '#d99a0c', '#b87f06', '#f7c531'),
  purple: candyTint('#f3e0ff', '#cf9df0', '#9b54d6', '#7430b0', '#5e2393', '#9b54d6'),
  orange: candyTint('#ffe6cc', '#ffb877', '#ff8a32', '#e3620c', '#c44e08', '#ff8a32')
};
```
> 之前版本是六方 `Object.assign(CANDY_BODY, {outline, pattern})` 共用同一奶油 `CANDY_BODY`，导致棋盘缩放下几乎不可区分；
> 本次改为每方独立 `base` 渐变。同时**移除了 `CANDY_BODY` 常量**及其在 `window.__checkersTest` 导出中的引用。

**(c) `buildPieceNode` 的糖针层注入（约第 234–286 行，节选）**
```js
  if (meta.candy) {
    const sugar = svgEl(doc, 'g', { 'class': 'ck-candy' });
    SPRINKLE_STICKS.forEach(function (s) {
      sugar.appendChild(svgEl(doc, 'rect', {
        x: String(s[0] - s[2] / 2), y: String(s[1] - 1.1),
        width: String(s[2]), height: '2.2', rx: '1.1',
        transform: 'rotate(' + s[3] + ' ' + s[0] + ' ' + s[1] + ')',
        fill: meta.pattern
      }));
    });
    g.appendChild(sugar);
  }
  // …其余：body 圆 + shade + vig + rim + 三处高光椭圆…
  if (meta.candy) {
    g.appendChild(svgEl(doc, 'ellipse', { cx: '34', cy: '30', rx: '25', ry: '14', transform: 'rotate(-30 34 30)', fill: '#ffffff', opacity: '.5' }));
  }
  const candy = !!meta.candy;
  g.appendChild(svgEl(doc, 'circle', {
    cx: '50', cy: '50', r: candy ? '48' : '49.2', fill: 'none',
    stroke: meta.outline, 'stroke-width': candy ? '3.6' : '1.5'
  }));
```
> `SPRINKLE_STICKS` 为 16 根小棒坐标（中心半径 ~30，远小于裁剪圆 r=50），彩针颜色取 `meta.pattern`（各阵营深色调），保证在浅色糖体上可见。

**(d) `window.__checkersTest` 导出（约第 1446 行）**：新增导出 `PIECE_TINTS / BIRTHDAY_TINTS / SPRINKLE_STICKS / activeTints / resolveBirthdayMode / buildPieceDefs / buildPieceNode / birthdayMode` 等，供测试使用（其中 `CANDY_BODY` 已移除）。

### 3.2 `public/checkers/checkers-birthday.css`（关键片段）

全部选择器以 `html.birthday-mode` 开头（避免之前「同元素多类选择器」永远不命中的坑）。
```css
/* 棋盘：暖粉木纹（保留木纹结构，仅染色） */
html.birthday-mode .board-frame{
  --wood-tex:url("data:image/svg+xml,...");   /* 内联 SVG 木纹（fractalNoise + 木纹线条） */
  border-color:#e0a08f;
  background:
    linear-gradient(160deg,rgba(255,236,226,.34) 0%,rgba(255,236,226,0) 34%,rgba(214,110,120,.16) 100%),
    repeating-linear-gradient(2deg, ...),
    repeating-linear-gradient(178.6deg, ...),
    var(--wood-tex),
    linear-gradient(157deg,#f7d9cf 0%,#efc2b4 46%,#e0a596 100%);
  background-repeat:no-repeat;
  background-size:auto,auto,auto,100% 100%,auto;   /* 关键：纹理层按 100% 100% 铺满，防止被最后一层线性渐变覆盖 */
  box-shadow:inset 0 2px 0 rgba(255,240,232,.6),inset 0 -4px 10px rgba(150,80,60,.22),0 12px 26px rgba(170,110,90,.24);
}
/* 孔位（玫瑰奶油）/ 选中高亮（奶油粉光环）/ 提示文字 / 彩带撒花(.confetti)/ 气球(.balloon) / 胜利弹窗(.winner-overlay) 均带 html.birthday-mode 前缀 */
```
> 关键修复点：`background-size:auto,auto,auto,100% 100%,auto` 保证 `--wood-tex` 纹理层整块铺满，否则会被最后一层线性渐变覆盖。
> 彩带/气球 `z-index:210` 且 `pointer-events:none`，不挡胜利弹窗按钮。`@media (prefers-reduced-motion:reduce)` 下隐藏动效。

### 3.3 `public/checkers/birthday-checkers.js`（关键片段）

```js
function active() { return !!(window.__checkersBirthday && window.__checkersBirthday.active); }
function birthdayName() {
  try { var n = new URLSearchParams(location.search).get('name'); return n ? n : '玫玫'; }
  catch (e) { return '玫玫'; }
}
function enhanceWinner() {
  var title = document.getElementById('winnerTitle');
  if (title && title.dataset.birthday !== '1') {
    title.textContent = '🎉 生日快乐，' + birthdayName() + '！' + title.textContent;
    title.dataset.birthday = '1';
  }
  var overlay = document.getElementById('winnerOverlay');
  if (overlay && !overlay.querySelector('.ribbon')) {
    var ribbon = document.createElement('div'); ribbon.className = 'ribbon'; overlay.appendChild(ribbon);
  }
  createBalloons();
}
function boot() {
  if (!active()) return;
  var original = window.showWinner;
  window.showWinner = function (player) {
    if (typeof original === 'function') original(player);
    enhanceWinner();
    createConfetti();
  };
}
```
> 装饰只改「标题前缀 + 彩带/气球」，**保留 `showWinner` 算出的正确获胜阵营**（不覆盖逻辑）。`reduce-motion` 时跳过撒花/气球。

### 3.4 `public/checkers/play.html`（第 11、15 行）

```html
<link rel="stylesheet" href="checkers-birthday.css?v=3e3e038313b3">
...
<script src="birthday-checkers.js?v=919ad91e5845" defer></script>
```
> 实际 `?v=` 哈希以 `version:assets` 重算结果为准（本轮 `checkers.js` 现 `?v=d3cb4d0a23ad`）。

### 3.5 `tests/test_checkers.js`（新增 6 条断言，约第 512–556 行）

1. `play.html 引入生日主题样式与脚本` —— 正则含 `checkers-birthday.css` 与 `birthday-checkers.js`。
2. `生日 CSS 用 html.birthday-mode 后代选择器，无失效的同元素多类选择器` —— 含 `html.birthday-mode`、不含 `body.birthday-mode`/`.ck-piece.birthday-mode`、含 `background-size:auto,auto,auto,100% 100%,auto`。
3. `resolveBirthdayMode：?birthday=1 强制开、?birthday=0 强制关、无参数仅 9/19 开` —— 四个边界用例。
4. `生日六方棋子主体糖果色各不相同，可一眼区分阵营` —— 六方 `base` 集合大小=6、`outline` 集合大小=6、非玻璃红。
5. `生日模式下 defs 渐变颜色确实变了，且 id 总数仍为 28（不新增 defs id）` —— `ids.length===28` 且红方首停点为 `#ffd9e0`（非玻璃 `#f2606c`）。
6. `糖针层仅在生日配色注入（ck-candy + 专属彩针色），平时不注入` —— candy 棋子含 ≥12 个 `fill===pattern` 的 rect，glass 棋子无 `ck-candy`。

---

## 四、验证结果

- `node tests/test_checkers.js` → **90 项全部通过**（含上述 6 条）。
- `node tests/test_checkers_stage.cjs` → 13/13；`node tests/test_checkers_stage_server.cjs` → 3/3（确认 checkers.js 改动未影响玩法/AI/服务端）。
- `node scripts/version_static_assets.js` → 两个生日资源及 checkers.js 重新带上 `?v=` 哈希。
- 线上 dev server（:3000）回源后 HTTP 冒烟：`play.html?birthday=1` 200，返回的 `checkers.js?v=d3cb4d0a23ad` 含 `#ffd9e0`（新红糖果色），`checkers-birthday.css`/`birthday-checkers.js` 均 200。
- `preview_pieces.html`：用真实 `buildPieceNode` 渲染六色糖果棋子 + 六色玻璃珠对照，已肉眼确认六色分明。

---

## 五、给核查者（ChatGPT）的自检清单

- [ ] 打开 `public/checkers/play.html`：仅 `<head>` 新增两行引用，无其他玩法/结构改动。
- [ ] `checkers.js` 顶层 `resolveBirthdayMode` 四边界正确（`1` 开 / `0` 关 / 9-19 开 / 其他关）。
- [ ] `BIRTHDAY_TINTS` 六方 `base` 渐变两两不同（重点：红/蓝/绿/黄/紫/橙在色相上可区分）。
- [ ] `buildPieceDefs(..., BIRTHDAY_TINTS)` 生成的 `<defs>` 子节点数 **严格 = 28**，未新增 id。
- [ ] 糖针层（`ck-candy` + inline rect）只在 `candy:true` 时注入，普通玻璃珠无此层。
- [ ] `checkers-birthday.css` 所有规则以 `html.birthday-mode` 开头，且含 `background-size:auto,auto,auto,100% 100%,auto`。
- [ ] 玩法文件（`checkers_core.js` / `checkers_ai_engine.js` / `server.js` 规则）未被改动（可 `git diff` 确认）。
- [ ] `?birthday=0` 强制普通模式；`?mode=ai` 且非 9/19 为普通模式；9/19 自动生日模式。
- [ ] 运行 `node tests/test_checkers.js` 应 90 项全过。

---

## 六、已知限制 / 待确认

- 颜色为**主观审美**：若觉得某方（如黄色偏浅、紫色偏深）需微调，改对应 `candyTint(...)` 参数即可，不影响结构。
- 本环境无 GUI 浏览器，未做真机截图；以「真实 SVG 渲染预览 + HTTP 冒烟」代替肉眼验收。
- `gen_preview.cjs` / `preview_pieces.html` 为诊断产物，可随时删除，不在产品交付内。
