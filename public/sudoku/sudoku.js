'use strict';
/* ========== SECTION 3: 配置参数（所有可调参数集中管理） ========== */
/*
  修改本区任何数值即可调整游戏行为，无需改动函数内部代码。
  分类：① 游戏机制  ② UI 交互  ③ 动画特效  ④ 存储键名
*/
const CONFIG = {
  // ① 游戏机制
  TOTAL_CELLS      : 81,
  BOARD_SIZE        : 9,
  BOX_SIZE          : 3,
  MAX_SOLUTIONS_CHECK: 2,
  DIFFICULTY_KEEP  : [40, 34, 30, 26, 23],

  // ② UI 交互
  TOAST_DURATION    : 3000,
  TIMER_INTERVAL    : 1000,
  PROGRESS_DELAY    : 80,
  AUTO_SAVE_INTERVAL: 5000,

  // ③ 动画特效
  FIREWORK_PARTICLES: 40,
  FIREWORK_GLOWS   : 4,
  FIREWORK_COLORS  : ["#0891b2","#22d3ee","#22c55e","#f59e0b","#ec4899","#8b5cf6","#f97316"],
  FIREWORK_DURATION : 900,
  FIREWORK_GLOW_DUR : 2200,

  // ④ 存储键名
  STORAGE_SAVE      : "sudoku_save",
  STORAGE_STATS     : "sudoku_stats",
  STORAGE_DARK      : "sudoku_dark",
  STORAGE_SOUND     : "sudoku_sound",
  STORAGE_PRAISE_IDX: "sudoku_praise_indices",
};

/* ========== SECTION 4: 常量与工具函数 ========== */
/*
  本区函数清单：
  | 函数名          | 参数              | 功能简述                        |
  |-----------------|-------------------|---------------------------------|
  | $               | id: string        | 快捷 getElementById             |
  | shuffle         | arr: number[]     | Fisher-Yates 洗牌               |
  | clamp           | v,lo,hi: number   | 将 v 限制在 [lo,hi] 区间        |
*/

/* 快捷 DOM 访问 */
function $(id) { return document.getElementById(id); }

/* Fisher-Yates 洗牌 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* 数值钳制 */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function normalizeDifficulty(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 && n < CONFIG.DIFFICULTY_KEEP.length ? n : 0;
}

function formatDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  return hours > 0 ? String(hours).padStart(2, "0") + ":" + mmss : mmss;
}

function gridIndexAtPoint(x, y, width, height) {
  if (x < 0 || y < 0 || x >= width || y >= height || width <= 0 || height <= 0) return -1;
  const col = Math.floor(x / (width / CONFIG.BOARD_SIZE));
  const row = Math.floor(y / (height / CONFIG.BOARD_SIZE));
  return row * CONFIG.BOARD_SIZE + col;
}

function getDragRectBox(start, current, width, height) {
  const cw = width / CONFIG.BOARD_SIZE;
  const ch = height / CONFIG.BOARD_SIZE;
  const sr = Math.floor(start / CONFIG.BOARD_SIZE);
  const sc = start % CONFIG.BOARD_SIZE;
  const er = Math.floor(current / CONFIG.BOARD_SIZE);
  const ec = current % CONFIG.BOARD_SIZE;
  const r1 = Math.min(sr, er);
  const r2 = Math.max(sr, er);
  const c1 = Math.min(sc, ec);
  const c2 = Math.max(sc, ec);
  return { left: c1 * cw, top: r1 * ch, width: (c2 - c1 + 1) * cw, height: (r2 - r1 + 1) * ch };
}

/* ========== SECTION 5: 游戏状态管理 ========== */
/*
  本区函数清单：
  | 函数名          | 参数 | 功能简述                  |
  |-----------------|-------------------|---------------------------|
  | resetGameState  | —    | 重置所有全局状态变量      |
*/
let solution      = [];
let givens       = [];
let board        = [];
let notes        = {};
let selected     = -1;
let selectedCells= [];
let noteMode     = false;
let showAllCands= false;
let finished     = false;
let history      = [];
let seconds      = 0;
let timerInterval= null;
let timerStartedAt = 0;
let autoSaveTimer = null;
let saveDirty = false;
let toastTimer   = null;
let isDragging  = false;
let dragStart    = -1;
let dragCurrent  = -1;
let soundEnabled = true;
let autoFillMode = false;
let usedPraiseIndices = [];
let lastPraiseText = "";      // 保存最近一次随机到的赞美诗，供分享复用
let currentDifficulty = 0;
let homeDifficulty = 0;

function resetGameState() {
  solution       = [];
  givens        = [];
  board         = [];
  notes         = {};
  selected      = -1;
  selectedCells = [];
  noteMode      = false;
  showAllCands = false;
  finished      = false;
  history       = [];
  seconds       = 0;
  isDragging   = false;
  dragStart     = -1;
  dragCurrent   = -1;
  usedPraiseIndices = [];
}

/* 统一历史压栈 */
function pushHistory(entry) {
  history.push(entry);
}

/* ========== SECTION 6: 核心算法 ========== */
/*
  本区函数清单：
  | 函数名          | 参数                   | 功能简述                          |
  |-----------------|------------------------|-----------------------------------|
  | SEED_SOLUTION   | （常量）               | 种子解，用于生成新题目            |
  | generateSolution | —                      | 生成一局完整终盘                  |
  | isValid         | board,pos,num         | 检查 num 放入 board[pos] 是否合法  |
  | countSolutions  | board,limit=2         | 统计解法数量，最多搜 limit 个      |
  | generateGivens  | solution,diff          | 按难度挖洞，保证唯一解            |
  | getCandidates   | index                  | 计算 index 格的所有可能候选数    |
  | isBoardFilled   | —                      | 所有非题目格均已填入（不一定对）|
  | checkWin        | —                      | 当前盘面是否完全正确              |
*/

/* 种子解（合法完整数独，用于生成新题目）*/
const SEED_SOLUTION = [
  5,3,4, 6,7,8, 9,1,2,
  6,7,2, 1,9,5, 3,4,8,
  1,9,8, 3,4,2, 5,6,7,

  8,5,9, 7,6,1, 4,2,3,
  4,2,6, 8,5,3, 7,9,1,
  7,1,3, 9,2,4, 8,5,6,

  9,6,1, 5,3,7, 2,8,4,
  2,8,7, 4,1,9, 6,3,5,
  3,4,5, 2,8,6, 1,7,9,
];

/* 生成随机完整数独：数字、行带、列栈与转置共同随机，避免每局只有数字不同。 */
function generateSolution() {
  const perm = [1,2,3,4,5,6,7,8,9];
  shuffle(perm);
  const bandOrder = shuffle([0,1,2]);
  const stackOrder = shuffle([0,1,2]);
  const rows = [];
  const cols = [];
  bandOrder.forEach(band => shuffle([0,1,2]).forEach(offset => rows.push(band * 3 + offset)));
  stackOrder.forEach(stack => shuffle([0,1,2]).forEach(offset => cols.push(stack * 3 + offset)));
  const transpose = Math.random() < .5;
  const out = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const sourceRow = transpose ? cols[c] : rows[r];
      const sourceCol = transpose ? rows[r] : cols[c];
      out.push(perm[SEED_SOLUTION[sourceRow * 9 + sourceCol] - 1]);
    }
  }
  return out;
}

/* 检查某个数字放在某位置是否合法（回溯用）*/
function isValid(board, pos, num) {
  const row = Math.floor(pos / 9);
  const col = pos % 9;
  for (let i = 0; i < 9; i++) {
    if (board[row * 9 + i] === num) return false;
    if (board[i * 9 + col] === num) return false;
  }
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      if (board[r * 9 + c] === num) return false;
  return true;
}

/* 统计数独解的数量（最多找 limit 个就停）*/
function countSolutions(givensBoard, limit) {
  limit = limit || CONFIG.MAX_SOLUTIONS_CHECK;
  const b = givensBoard.slice();
  let count = 0;
  function solve() {
    if (count >= limit) return;
    let bestPos = -1;
    let bestCandidates = null;
    for (let pos = 0; pos < CONFIG.TOTAL_CELLS; pos++) {
      if (b[pos] !== 0) continue;
      const candidates = [];
      for (let n = 1; n <= 9; n++) if (isValid(b, pos, n)) candidates.push(n);
      if (candidates.length === 0) return;
      if (!bestCandidates || candidates.length < bestCandidates.length) {
        bestPos = pos;
        bestCandidates = candidates;
        if (candidates.length === 1) break;
      }
    }
    if (bestPos < 0) { count++; return; }
    for (const n of bestCandidates) {
      b[bestPos] = n;
      solve();
      b[bestPos] = 0;
      if (count >= limit) return;
    }
  }
  solve();
  return count;
}

/* 根据难度生成题目（挖洞）*/
function generateGivens(solution, difficulty) {
  const keep = CONFIG.DIFFICULTY_KEEP[difficulty] || CONFIG.DIFFICULTY_KEEP[0];
  const targetRemove = CONFIG.TOTAL_CELLS - keep;
  const positions = shuffle([...Array(CONFIG.TOTAL_CELLS).keys()]);
  let givens = solution.slice();
  let removed = 0;
  for (const pos of positions) {
    if (removed >= targetRemove) break;
    const backup = givens[pos];
    givens[pos] = 0;
    if (countSolutions(givens, 2) === 1) {
      removed++;
    } else {
      givens[pos] = backup;
    }
  }
  return givens;
}

/* 候选数计算 */
function getCandidates(index) {
  if (board[index] !== 0) return [];
  const row = Math.floor(index / 9);
  const col = index % 9;
  const used = new Set();
  for (let c = 0; c < 9; c++) used.add(board[row * 9 + c]);
  for (let r = 0; r < 9; r++) used.add(board[r * 9 + col]);
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      used.add(board[r * 9 + c]);
  const res = [];
  for (let n = 1; n <= 9; n++) if (!used.has(n)) res.push(n);
  return res;
}

function isBoardFilled() {
  return board.every((v, i) => givens[i] !== 0 || v !== 0);
}

function checkWin() {
  return board.every((v, i) => v === solution[i]);
}

/* ========== SECTION 7: UI 渲染 ========== */
/*
  本区函数清单：
  | 函数名                | 参数 | 功能简述                          |
  |-----------------------|------|-----------------------------------|
  | renderBoard           | —    | 清空并重建 81 格 DOM，绑定点击事件  |
  | renderKeypad         | —    | 初始化渲染数字 1-9 键盘            |
  | refreshKeypadCounts  | —    | 刷新每个数字键的剩余计数          |
  | updateKeypadRecommend | —    | 根据选中格候选数高亮推荐数字键    |
  | clearKeypadRecommend  | —    | 清除所有数字键的推荐高亮          |
  | updateProgress        | —    | 计算并刷新进度条和进度文字        |
  | updateTimer           | —    | 刷新顶部计时器显示                |
*/

function renderBoard() {
  const boardEl = $("board");
  boardEl.innerHTML = "";
  bindBoardEvents();

  boardEl.classList.toggle("show-all-candidates", showAllCands);

  const selectedNum = selected >= 0 ? board[selected] : 0;
  const multiSet = new Set(selectedCells);

  for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
    const r = Math.floor(i / 9);
    const c = i % 9;
    const val       = board[i];
    const isGiven   = givens[i] !== 0;
    const isUser    = !isGiven && val !== 0;
    const isSelected= selected === i;
    const inMulti   = multiSet.has(i) && selected !== i;
    const hasError  = isUser && val !== solution[i];

    let isHighlightRow = false;
    let isHighlightCol = false;
    if (selected >= 0 && !isSelected) {
      const sr = Math.floor(selected / 9);
      const sc = selected % 9;
      if (r === sr) isHighlightRow = true;
      if (c === sc) isHighlightCol = true;
    }

    let isSameNum = false;
    if (selectedNum > 0 && val === selectedNum && !isSelected) {
      isSameNum = true;
    }

    const cell = document.createElement("div");
    const cls = [
      "cell",
      "r" + r, "c" + c,
      isGiven     ? "given"        : "",
      isUser      ? "user-filled"  : "",
      isSelected  ? "selected"     : "",
      inMulti     ? "multi-selected" : "",
      hasError    ? "error"        : "",
      isHighlightRow ? "highlight-row" : "",
      isHighlightCol ? "highlight-col" : "",
      isSameNum   ? "same-num"     : "",
    ].filter(Boolean).join(" ");
    cell.className = cls;
    cell.dataset.index = String(i);
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-selected", isSelected ? "true" : "false");
    cell.setAttribute("aria-label", "第 " + (r + 1) + " 行第 " + (c + 1) + " 列，" + (val ? (val + (isGiven ? "，题目数字" : "，玩家填写")) : "空格"));
    cell.tabIndex = isSelected ? 0 : -1;

    cell.onclick = (e) => {
      e.preventDefault();
      selectCell(i, e.ctrlKey || e.metaKey, e.shiftKey);
    };

    if (val) {
      const span = document.createElement("span");
      span.textContent = val;
      cell.appendChild(span);
    } else if (notes[i] && notes[i].length > 0) {
      const nd = document.createElement("div");
      nd.className = "candidates";
      for (let k = 1; k <= 9; k++) {
        const s = document.createElement("span");
        s.textContent = (notes[i] || []).includes(k) ? k : "";
        if (noteMode) {
          s.style.cursor = "pointer";
          s.onclick = (e) => { e.stopPropagation(); toggleCandidate(i, k); };
        }
        nd.appendChild(s);
      }
      cell.appendChild(nd);
    } else if (showAllCands) {
      const cands = getCandidates(i);
      if (cands.length > 0) {
        const cd = document.createElement("div");
        cd.className = "candidates";
        for (let k = 1; k <= 9; k++) {
          const s = document.createElement("span");
          s.textContent = cands.includes(k) ? k : "";
          if (noteMode && s.textContent !== "") {
            s.style.cursor = "pointer";
            s.onclick = (e) => { e.stopPropagation(); toggleCandidate(i, k); };
          }
          cd.appendChild(s);
        }
        cell.appendChild(cd);
      }
    } else if (isSelected && !noteMode) {
      const cands = getCandidates(i);
      if (cands.length > 0) {
        const cd = document.createElement("div");
        cd.className = "candidates";
        for (let k = 1; k <= 9; k++) {
          const s = document.createElement("span");
          s.textContent = cands.includes(k) ? k : "";
          cd.appendChild(s);
        }
        cell.appendChild(cd);
      }
    }

    boardEl.appendChild(cell);
  }

  updateKeypadRecommend();
}

function renderKeypad() {
  const kp = $("keypad");
  kp.innerHTML = "";
  for (let n = 1; n <= 9; n++) {
    const btn = document.createElement("button");
    btn.dataset.num = n;
    btn.type = "button";
    btn.setAttribute("aria-label", "填写数字 " + n);
    let placed = 0;
    for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
      if (board[i] === n) placed++;
    }
    const remain = 9 - placed;
    btn.innerHTML = '<span class="num-text">' + n + '</span>'
                   + '<span class="remain">' + remain + '</span>';
    btn.classList.toggle("used-up", remain <= 0);
    btn.onclick = () => fillNumber(n);
    kp.appendChild(btn);
  }
  const clr = document.createElement("button");
  clr.type = "button";
  clr.innerHTML = "⌫ 清除当前格";
  clr.className = "clear-btn";
  clr.setAttribute("aria-label", "清除当前选中格");
  clr.onclick = () => fillNumber(0);
  kp.appendChild(clr);
}

function refreshKeypadCounts() {
  for (let n = 1; n <= 9; n++) {
    let placed = 0;
    for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
      if (board[i] === n) placed++;
    }
    const remain = 9 - placed;
    const btn = document.querySelector('#keypad button[data-num="' + n + '"]');
    if (!btn) continue;
    btn.innerHTML = '<span class="num-text">' + n + '</span>'
                     + '<span class="remain">' + remain + '</span>';
    btn.classList.toggle("used-up", remain <= 0);
  }
}

function updateKeypadRecommend() {
  clearKeypadRecommend();
  if (selected < 0 || noteMode) return;
  const cands = getCandidates(selected);
  if (cands.length === 0) return;
  const btns = document.querySelectorAll("#keypad button");
  btns.forEach((btn, i) => {
    if (i < 9 && cands.includes(i + 1)) {
      btn.classList.add("recommended");
    }
  });
}

function clearKeypadRecommend() {
  document.querySelectorAll("#keypad button").forEach(b =>
    b.classList.remove("recommended")
  );
}

function updateProgress() {
  let blanks  = 0;
  let correct = 0;
  for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
    if (givens[i] === 0) {
      blanks++;
      if (board[i] === solution[i] && board[i] !== 0) correct++;
    }
  }
  const pct = blanks === 0 ? 0 : Math.floor(correct / blanks * 100);
  $("progressText").textContent = "进度：" + pct + "%";
  $("progressBar").value = pct;
}

function updateTimer() {
  $("timerText").textContent = "⏱ " + formatDuration(seconds);
}

/* ========== SECTION 8: 格子选择与拖选 ========== */
/*
  本区函数清单：
  | 函数名          | 参数             | 功能简述                    |
  |-----------------|------------------|-----------------------------|
  | selectCell      | i,ctrl,shift     | 处理单击/Ctrl多选/Shift区间选 |
  | cellFromEvent   | e: Event        | 从鼠标/触摸事件计算格子索引  |
  | onBoardMouseDown | e                | 鼠标按下：开始拖选          |
  | onBoardMouseMove | e                | 鼠标移动：更新拖选范围      |
  | onBoardMouseUp   | e                | 鼠标抬起：结束拖选          |
  | updateDragRect  | —                | 更新拖选虚线框位置          |
  | bindBoardEvents | —                | 绑定棋盘事件（仅一次）      |
*/

function selectCell(index, isCtrl, isShift) {
  if (finished) return;
  if (isShift && selected >= 0 && index >= 0) {
    const a = Math.min(selected, index);
    const b = Math.max(selected, index);
    selectedCells = [];
    for (let i = a; i <= b; i++) {
      if (givens[i] === 0) selectedCells.push(i);
    }
    if (!selectedCells.includes(selected)) {
      selectedCells.push(selected);
    }
    renderBoard();
    return;
  }
  if (isCtrl) {
    if (selectedCells.includes(index)) {
      selectedCells = selectedCells.filter(i => i !== index);
      if (selected === index) {
        selected = selectedCells.length > 0 ? selectedCells[selectedCells.length - 1] : -1;
      }
    } else {
      selectedCells.push(index);
      selected = index;
    }
    renderBoard();
    return;
  }
  if (selected === index && !selectedCells.includes(index)) {
    selected = -1;
  } else {
    selected = index;
    selectedCells = [index];
  }
  renderBoard();
}

function cellFromEvent(e, preferTarget) {
  const boardEl = $("board");
  if (preferTarget && e.target && typeof e.target.closest === "function") {
    const targetCell = e.target.closest(".cell");
    if (targetCell && boardEl.contains(targetCell)) {
      const directIndex = parseInt(targetCell.dataset.index, 10);
      if (Number.isInteger(directIndex)) return directIndex;
    }
  }
  const rect = boardEl.getBoundingClientRect();
  const point = e.touches && e.touches.length ? e.touches[0] : e;
  // clientWidth/clientHeight 不包含棋盘外边框；坐标也扣除边框，避免格子映射偏移。
  // 落在棋盘自身的外框上时吸附到最近单元格，消除最下/最右侧的点击死区。
  const x = clamp(point.clientX - rect.left - boardEl.clientLeft, 0, boardEl.clientWidth - 0.001);
  const y = clamp(point.clientY - rect.top - boardEl.clientTop, 0, boardEl.clientHeight - 0.001);
  return gridIndexAtPoint(x, y, boardEl.clientWidth, boardEl.clientHeight);
}

function onBoardMouseDown(e) {
  if (finished) return;
  const idx = cellFromEvent(e, true);
  if (idx < 0 || givens[idx] !== 0) return;
  e.preventDefault();
  isDragging  = true;
  dragStart    = idx;
  dragCurrent  = idx;
  selected     = idx;
  selectedCells= [idx];
  renderBoard();
  // 普通点按只使用单元格自身的实线选中态；确实拖到另一格后才显示虚线选区。
}

function ensureDragRect() {
  let rectEl = $("dragRect");
  if (!rectEl) {
    rectEl = document.createElement("div");
    rectEl.id = "dragRect";
    rectEl.className = "drag-rect";
    $("board").appendChild(rectEl);
  }
  return rectEl;
}

function updateDragRect() {
  const rectEl = $("dragRect");
  if (!rectEl || dragStart < 0) return;
  const boardEl = $("board");
  // 绝对定位的参考区域是棋盘内框，使用 client 尺寸与单元格网格完全对齐。
  const bw = boardEl.clientWidth;
  const bh = boardEl.clientHeight;
  const box = getDragRectBox(dragStart, dragCurrent, bw, bh);
  rectEl.style.left   = box.left + "px";
  rectEl.style.top    = box.top + "px";
  rectEl.style.width  = box.width + "px";
  rectEl.style.height = box.height + "px";
}

function onBoardMouseMove(e) {
  if (!isDragging) return;
  const idx = cellFromEvent(e);
  if (idx >= 0 && idx !== dragCurrent) {
    dragCurrent = idx;
    const sr = Math.floor(dragStart / 9);
    const sc = dragStart % 9;
    const er = Math.floor(idx / 9);
    const ec = idx % 9;
    const r1 = Math.min(sr, er);
    const r2 = Math.max(sr, er);
    const c1 = Math.min(sc, ec);
    const c2 = Math.max(sc, ec);
    selectedCells = [];
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const i = r * 9 + c;
        if (givens[i] === 0) selectedCells.push(i);
      }
    if (selectedCells.length > 0) selected = selectedCells[selectedCells.length - 1];
    renderBoard();
    ensureDragRect();
    updateDragRect();
  }
}

function onBoardMouseUp(e) {
  if (!isDragging) return;
  isDragging = false;
  dragStart = -1;
  dragCurrent = -1;
  const rectEl = $("dragRect");
  if (rectEl) rectEl.remove();
}

function bindBoardEvents() {
  const boardEl = $("board");
  if (boardEl._eventsBound) return;
  boardEl.addEventListener("mousedown", onBoardMouseDown);
  boardEl.addEventListener("mousemove", onBoardMouseMove);
  boardEl.addEventListener("mouseup", onBoardMouseUp);
  boardEl.addEventListener("mouseleave", onBoardMouseUp);
  boardEl.addEventListener("touchstart", (e) => { onBoardMouseDown(e); }, {passive: false});
  boardEl.addEventListener("touchmove",  (e) => { onBoardMouseMove(e); }, {passive: false});
  boardEl.addEventListener("touchend",    (e) => { onBoardMouseUp(e); });
  boardEl.addEventListener("touchcancel", (e) => { onBoardMouseUp(e); });
  boardEl._eventsBound = true;
}

/* ========== SECTION 9: 填数与笔记功能 ========== */
/*
  本区函数清单：
  | 函数名          | 参数        | 功能简述                              |
  |-----------------|-------------|---------------------------------------|
  | fillNumber      | value:number | 核心填数函数（清除/笔记/普通三种分支）|
  | toggleNoteMode  | —           | 切换笔记模式开/关                    |
  | toggleShowAllCands | —        | 切换"全部显示候选数"开/关            |
  | toggleCandidate | i,k         | 笔记模式下点击候选数格              |
  | autoEraseNotes | row,col,num| 填数后自动擦除同行/列/宫相同候选  |
  | clearAllUser    | —           | 清除所有用户填入的数字和笔记        |
  | cleanEmptyNotes | idx         | 若 notes[idx] 为空则删除该键       |
*/

/* 清理空笔记（内部工具函数）*/
function cleanEmptyNotes(idx) {
  if (notes[idx] && notes[idx].length === 0) {
    delete notes[idx];
  }
}

function fillNumber(value) {
  if (finished) return;
  if (selected < 0 && selectedCells.length === 0) return;

  /* ── Case 1: 清除数字（value === 0）── */
  if (value === 0) {
    const targets = (selectedCells.length > 0 && selectedCells.includes(selected))
      ? selectedCells : [selected];
    let changed = false;
    targets.forEach(i => {
      if (givens[i] !== 0) return;
      if (board[i] !== 0 || (notes[i] && notes[i].length > 0)) {
        pushHistory({
          index: i,
          prevValue: board[i],
          prevNotes: notes[i] ? [...notes[i]] : null,
        });
        board[i] = 0;
        delete notes[i];
        changed = true;
      }
    });
    if (changed) {
      renderBoard();
      updateProgress();
      refreshKeypadCounts();
      autoSave();
    }
    return;
  }

  /* ── Case 2: 笔记模式 ── */
  if (noteMode) {
    let userTargets = selectedCells.length > 0 ? selectedCells.slice() : [selected];
    userTargets = userTargets.filter(i => givens[i] === 0 && board[i] === 0);
    if (userTargets.length === 0) return;

    /* 如果 showAllCands 开启，先确保目标格有笔记数据 */
    if (showAllCands) {
      userTargets.forEach(idx => {
        if (!notes[idx] || notes[idx].length === 0) {
          notes[idx] = getCandidates(idx).slice();
        }
      });
    }

    /* 判断：是否所有目标格都已包含 value */
    const allHaveIt = userTargets.every(idx => (notes[idx] || []).includes(value));

    userTargets.forEach(idx => {
      pushHistory({
        index: idx,
        prevValue: board[idx],
        prevNotes: notes[idx] ? [...notes[idx]] : null,
      });

      if (allHaveIt) {
        /* 所有格都有 value → 统一删除 */
        notes[idx] = (notes[idx] || []).filter(v => v !== value);
        cleanEmptyNotes(idx);
      } else {
        /* 不是所有格都有 → 有则删，无则加 */
        if ((notes[idx] || []).includes(value)) {
          notes[idx] = notes[idx].filter(v => v !== value);
          cleanEmptyNotes(idx);
        } else {
          notes[idx] = [...(notes[idx] || []), value].sort();
        }
      }
    });

    renderBoard();
    updateProgress();
    refreshKeypadCounts();
    autoSave();
    playSound("fill");
    return;
  }

  /* ── Case 3: 普通填数模式 ── */
  let targets = (selectedCells.length > 0 && selectedCells.includes(selected))
    ? selectedCells : [selected];
  targets = targets.filter(i => givens[i] === 0);
  if (targets.length === 0) return;

  targets.forEach(i => {
    pushHistory({
      index: i,
      prevValue: board[i],
      prevNotes: notes[i] ? [...notes[i]] : null,
    });
    board[i] = value;
    delete notes[i];
    autoEraseNotes(Math.floor(i / 9), i % 9, value);
  });

  /* 检查错误 */
  let hasError = false;
  targets.forEach(i => {
    if (board[i] !== solution[i]) hasError = true;
  });
  if (hasError) {
    showToast("数字不对哦，再想想 🤔");
    playSound("error");
  } else {
    playSound("fill");
  }

  renderBoard();
  updateProgress();
  refreshKeypadCounts();
  autoSave();

  /* 检查是否获胜 */
  if (isBoardFilled() && checkWin()) {
    checkWinAndFinish();
  } else if (autoFillMode && !hasError) {
    runAutoFill(false);
  }
}

function toggleNoteMode() {
  noteMode = !noteMode;
  $("noteBtn").textContent = "笔记：" + (noteMode ? "开" : "关");
  $("noteBtn").classList.toggle("active-btn", noteMode);
  if (!noteMode) { selected = -1; selectedCells = []; }
  renderBoard();
  autoSave();
}

function toggleShowAllCands() {
  showAllCands = !showAllCands;
  const btn = $("candBtn");
  btn.textContent = "候选：" + (showAllCands ? "开" : "关");
  btn.classList.toggle("active-btn", showAllCands);
  selected = -1;
  selectedCells = [];
  renderBoard();
  autoSave();
}

function toggleCandidate(i, k) {
  if (!noteMode) return;
  if (givens[i] !== 0) return;
  selected = i;
  selectedCells = [i];
  fillNumber(k);
}

function autoEraseNotes(row, col, num) {
  for (let c = 0; c < 9; c++) {
    const idx = row * 9 + c;
    if (notes[idx]) {
      notes[idx] = notes[idx].filter(v => v !== num);
      cleanEmptyNotes(idx);
    }
  }
  for (let r = 0; r < 9; r++) {
    const idx = r * 9 + col;
    if (notes[idx]) {
      notes[idx] = notes[idx].filter(v => v !== num);
      cleanEmptyNotes(idx);
    }
  }
  const br = Math.floor(row / 3) * 3;
  const bc = Math.floor(col / 3) * 3;
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++) {
      const idx = r * 9 + c;
      if (notes[idx]) {
        notes[idx] = notes[idx].filter(v => v !== num);
        cleanEmptyNotes(idx);
      }
    }
}

function clearAllUser() {
  if (finished) return;
  const changes = [];
  for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
    if (givens[i] === 0 && (board[i] !== 0 || (notes[i] && notes[i].length))) {
      changes.push({ index: i, prevValue: board[i], prevNotes: notes[i] ? [...notes[i]] : null });
      board[i] = 0;
      delete notes[i];
    }
  }
  if (changes.length) {
    pushHistory({ bulk: changes });
    selected = -1;
    selectedCells = [];
    renderBoard();
    updateProgress();
    refreshKeypadCounts();
    autoSave();
  }
}

/* ========== SECTION 10: 撤销系统 ========== */
/*
  本区函数清单：
  | 函数名 | 参数 | 功能简述                |
  |---------|------|-------------------------|
  | undo    | —    | 撤销最后一步操作        |
*/
function restoreHistoryEntry(targetBoard, targetNotes, last) {
  if (Array.isArray(last.bulk)) {
    last.bulk.forEach(entry => restoreHistoryEntry(targetBoard, targetNotes, entry));
    return;
  }
  if (last.prevValue !== undefined) {
    targetBoard[last.index] = last.prevValue;
  }
  if (last.prevNotes !== undefined) {
    if (last.prevNotes) {
      targetNotes[last.index] = [...last.prevNotes];
    } else {
      delete targetNotes[last.index];
    }
  }
}

function undo() {
  if (finished || history.length === 0) return;
  const last = history.pop();
  restoreHistoryEntry(board, notes, last);

  if (Array.isArray(last.bulk)) {
    selected = -1;
    selectedCells = [];
  } else {
    selected = last.index;
    selectedCells = [last.index];
  }
  renderBoard();
  updateProgress();
  refreshKeypadCounts();
  autoSave();
}

/* ========== SECTION 11: 提示功能 ========== */
/*
  本区函数清单：
  | 函数名       | 参数 | 功能简述                          |
  |--------------|------|-----------------------------------|
  | showHint     | —    | 智能提示：填入候选数最少的可填空格  |
  | showTechHint | —    | 弹窗显示数独技巧提示              |
  | findHiddenSingle | — | 寻找隐式唯一（Hidden Single）    |
*/

function showHint() {
  if (finished) return;
  let best = -1, bestCount = 10;
  for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
    if (givens[i] === 0 && board[i] === 0) {
      const c = getCandidates(i);
      if (c.length > 0 && c.length < bestCount) {
        bestCount = c.length;
        best = i;
      }
    }
  }
  if (best < 0) return;
  selected = best;
  selectedCells = [best];
  pushHistory({ index: best, prevValue: board[best] });
  board[best] = solution[best];
  autoSave();
  renderBoard();
  updateProgress();
  refreshKeypadCounts();

  if (isBoardFilled() && checkWin()) {
    checkWinAndFinish();
  }
}

function showTechHint() {
  const result = findHiddenSingle();
  if (result) {
    showTechHintBox(result.title, result.desc);
  } else {
    showTechHintBox("💡 技巧提示", "当前暂无简单的技巧提示。<br>试试逐格分析候选数吧！");
  }
}

function findHiddenSingle() {
  /* 行扫描 */
  for (let r = 0; r < 9; r++) {
    for (let n = 1; n <= 9; n++) {
      let positions = [];
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        if (board[i] === 0 && getCandidates(i).includes(n)) {
          positions.push(i);
        }
      }
      if (positions.length === 1) {
        const c = positions[0] % 9 + 1;
        return {
          title: "🔍 隐式唯一（Hidden Single）",
          desc: "数字 <b>" + n + "</b> 在第 <b>" + (r+1) + "</b> 行只能放在第 <b>" + c + "</b> 列。<br>" +
                "这一行其他空格都无法容纳 " + n + "，因此它必须在这里。"
        };
      }
    }
  }
  /* 列扫描 */
  for (let c = 0; c < 9; c++) {
    for (let n = 1; n <= 9; n++) {
      let positions = [];
      for (let r = 0; r < 9; r++) {
        const i = r * 9 + c;
        if (board[i] === 0 && getCandidates(i).includes(n)) {
          positions.push(i);
        }
      }
      if (positions.length === 1) {
        const r = Math.floor(positions[0] / 9) + 1;
        return {
          title: "🔍 隐式唯一（Hidden Single）",
          desc: "数字 <b>" + n + "</b> 在第 <b>" + (c+1) + "</b> 列只能放在第 <b>" + r + "</b> 行。<br>" +
                "这一列其他空格都无法容纳 " + n + "，因此它必须在这里。"
        };
      }
    }
  }
  return null;
}

function showTechHintBox(title, desc) {
  $("techHintBody").innerHTML =
    '<div style="margin-bottom:12px;font-weight:700;font-size:16px;color:var(--accent)">' + title + '</div>' +
    '<div>' + desc + '</div>';
  $("techHintOverlay").classList.add("active");
}

function closeTechHint() {
  $("techHintOverlay").classList.remove("active");
}

/* ========== SECTION 12: 自动填入 ========== */
/*
  本区函数清单：
  | 函数名       | 参数 | 功能简述                    |
  |--------------|------|-----------------------------|
  | toggleAutoFill | —    | 切换自动填入模式开/关      |
  | runAutoFill   | —    | 执行一次自动填入            |
*/
function toggleAutoFill() {
  autoFillMode = !autoFillMode;
  const btn = $("autoFillBtn");
  btn.textContent = "自动填入：" + (autoFillMode ? "开" : "关");
  btn.classList.toggle("active-btn", autoFillMode);
  if (autoFillMode) runAutoFill();
}

function runAutoFill(showEmptyToast = true) {
  if (finished) return;
  let filled = false;
  for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
    if (givens[i] === 0 && board[i] === 0) {
      const cands = getCandidates(i);
      if (cands.length === 1) {
        pushHistory({ index: i, prevValue: 0 });
        board[i] = cands[0];
        filled = true;
      }
    }
  }
  if (filled) {
    renderBoard();
    updateProgress();
    refreshKeypadCounts();
    autoSave();
    playSound("fill");
    if (isBoardFilled() && checkWin()) {
      checkWinAndFinish();
    }
  } else if (showEmptyToast) {
    showToast("当前没有唯一候选数可自动填入");
  }
}

/* ========== SECTION 13: 分享功能 ========== */
/*
  本区函数清单：
  | 函数名         | 参数 | 功能简述                    |
  |----------------|------|-----------------------------|
  | showShare      | —    | 打开分享弹窗并生成分享图片  |
  | generateShareImg | —   | 在 Canvas 上绘制分享成绩图  |
  | downloadShareImg | —    | 将 Canvas 内容下载为 PNG   |
  | getRandomPraise | —    | 从赞美话库随机抽取一句      |
*/

/* 赞美话库 */
const PRAISE_LIB = [
  "春风得意马蹄疾，一日看尽长安花 🌸",
  "会当凌绝顶，一览众山小 ⛰️",
  "长风破浪会有时，直挂云帆济沧海 ⛵",
  "千淘万漉虽辛苦，吹尽狂沙始到金 ✨",
  "黄沙百战穿金甲，不破楼兰终不还 💪",
  "仰天大笑出门去，我辈岂是蓬蒿人 😎",
  "欲穷千里目，更上一层楼 🏞️",
  "天生我材必有用，千金散尽还复来 💰",
  "莫愁前路无知己，天下谁人不识君 🌟",
  "大鹏一日同风起，扶摇直上九万里 🦅",
  "宝剑锋从磨砺出，梅花香自苦寒来 🗡️",
  "不畏浮云遮望眼，自缘身在最高层 🏔️",
  "我要飞得更高！🎤",
  "阳光总在风雨后 🌈️",
  "我相信我就是我，我相信明天 🌉",
  "我的未来不是梦 💫",
  "少年自有少年狂，心似骄阳万丈光 ☀️",
  "星辰大海，是你与我 ⭐",
  "我命由我不由天 ⚡",
  "我们一起闯荡，在这茫茫人海 🌊",
  "追梦赤子心，热血铸青春 🔥",
  "逆风的方向，更适合飞翔 🕊️",
  "YYDS！你就是永远的神 🏆",
  "这个是我要的逻辑 三个选中格的候选分别是： • 格A：[1, 5, 9] • 格B：[5, 7] • 格C：[1, 3] 按你说的逻辑，点 5 之后，你期望变成： • 格A：[1,, 9] • 格B：[7] • 格C：[1, 3, 5]",
  "大佬大佬，给大佬递茶 🍵",
  "格局打开！这操作我直呼内行 🧐",
  "DNA动了！这就是天才的直觉吗 🧬",
  "666666，这波在大气层 🌍",
  "牛逼！我直接好家伙 🐂",
  "神仙操作！瑞思拜 🛐",
  "双向奔赴了属于是 💞",
  "破防了！太强了吧 😱",
  "你真的强！强的离谱 💪",
  "绝了绝了！这都能对 ❓",
  "爷青回！这就是大神吗 🎆",
  "太强了，我愿称你为最强 👑",
  "这波操作，妥妥的教科书级别 📖",
  "直接起飞！🛫",
  "真的假不了，假的真不了——你真的太强了 💎",
  "你这脑子，是不是装了外挂 🤖",
  "你真棒！👏",
  "太厉害了！🎉",
  "简直是天才！✨",
  "无解！完全无解！💥",
  "完美！零失误！🎯",
  "太强了！膜拜大佬 🙇",
  "数独小天才就是你 🧠",
  "这速度，没谁了 🏎️",
  "智商天花板被你击穿了 🧠",
  "服了服了，真服了 🏅",
  "你就是数独之神 🔮",
  "人类智慧之光 💡",
  "这都不叫事，你太稳了 🅾",
  "行云流水，一气呵成 🌊",
];
function getRandomPraise() {
  if (usedPraiseIndices.length >= PRAISE_LIB.length) usedPraiseIndices = [];
  const available = [];
  for (let i = 0; i < PRAISE_LIB.length; i++) {
    if (!usedPraiseIndices.includes(i)) available.push(i);
  }
  const pick = available[Math.floor(Math.random() * available.length)];
  usedPraiseIndices.push(pick);
  return PRAISE_LIB[pick];
}

function showShare() {
  $("shareOverlay").classList.add("active");
  generateShareImg();
}

function closeShare() {
  $("shareOverlay").classList.remove("active");
}

function generateShareImg() {
  const canvas = $("shareCanvas");
  const ctx = canvas.getContext("2d");
  const diffNames = ["简单","中等","困难","专家","极限"];
  const diff = diffNames[parseInt($("diffSelect").value) || 0];

  /* 背景 */
  ctx.fillStyle = "#f0fafd";
  ctx.fillRect(0, 0, 360, 480);

  /* 标题 */
  ctx.fillStyle = "#0891b2";
  ctx.font = "bold 22px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("数独游戏", 180, 40);

  /* 难度 & 用时 */
  ctx.fillStyle = "#164e63";
  ctx.font = "16px Inter, sans-serif";
  ctx.fillText("难度：" + diff + "　　用时：" + seconds + " 秒", 180, 75);

  /* 赞美语 */
  ctx.fillStyle = "#0891b2";
  ctx.font = "14px Inter, sans-serif";
  const praise = lastPraiseText || getRandomPraise();   // 复用完成时的同一句诗
  ctx.fillText(praise, 180, 105);

  /* 绘制迷你棋盘 */
  const offsetX = 30, offsetY = 125, cellSize = 34;
  ctx.strokeStyle = "#164e63";
  ctx.lineWidth = 2;
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const x = offsetX + c * cellSize;
      const y = offsetY + r * cellSize;
      if (givens[r * 9 + c] !== 0) {
        ctx.fillStyle = "#e0f2fe";
      } else if (board[r * 9 + c] === solution[r * 9 + c] && board[r * 9 + c] !== 0) {
        ctx.fillStyle = "#ccfbf1";
      } else {
        ctx.fillStyle = "#fff";
      }
      ctx.fillRect(x, y, cellSize, cellSize);
      ctx.strokeRect(x, y, cellSize, cellSize);
      const val = board[r * 9 + c];
      if (val !== 0) {
        ctx.fillStyle = givens[r * 9 + c] !== 0 ? "#1e293b" : "#0891b2";
        ctx.font = (givens[r * 9 + c] !== 0 ? "bold " : "") + "15px Inter, sans-serif";
        ctx.fillText(val, x + cellSize/2, y + cellSize/2 + 5);
      }
    }
  }
  /* 粗边框（3x3宫）*/
  ctx.strokeStyle = "#164e63";
  ctx.lineWidth = 3;
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      ctx.strokeRect(
        offsetX + bc * 3 * cellSize,
        offsetY + br * 3 * cellSize,
        3 * cellSize, 3 * cellSize
      );
    }
  }

  /* 底部文字 */
  ctx.fillStyle = "#475569";
  ctx.font = "12px Inter, sans-serif";
  ctx.fillText("—— 数独游戏 ——", 180, 460);
}

function downloadShareImg() {
  const canvas = $("shareCanvas");
  const link = document.createElement("a");
  link.download = "数独成绩.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
}

/* ========== SECTION 14: 深色模式 ========== */
/*
  本区函数清单：
  | 函数名         | 参数 | 功能简述                          |
  |----------------|------|-----------------------------------|
  | toggleDarkMode  | —    | 切换深色/浅色主题，保存到 localStorage |
  | restoreDarkMode | —    | 页面加载时恢复上次的深色模式设置  |
*/
function toggleDarkMode() {
  const body = document.body;
  const btn  = $("darkBtn");
  body.classList.toggle("dark");
  const isDark = body.classList.contains("dark");
  btn.textContent = isDark ? "☀️" : "🌙";
  btn.classList.toggle("active", isDark);
  try { localStorage.setItem(CONFIG.STORAGE_DARK, isDark ? "1" : "0"); } catch(e) {}
}

function restoreDarkMode() {
  try {
    const v = localStorage.getItem(CONFIG.STORAGE_DARK);
    if (v === "1") {
      document.body.classList.add("dark");
      $("darkBtn").textContent = "☀️";
      $("darkBtn").classList.add("active");
    }
  } catch(e) {}
}

/* ========== SECTION 15: 音效系统 ========== */
/*
  本区函数清单：
  | 函数名      | 参数        | 功能简述                    |
  |--------------|-------------|-----------------------------|
  | playSound    | type:string | 播放指定类型音效            |
  | toggleSound  | —           | 切换音效开/关              |
  | getAudioCtx  | —           | 懒加载并返回 AudioContext 单例 |
*/
let _audioCtx = null;

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

function playSound(type) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    switch (type) {
      case "fill":
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
        break;
      case "error":
        osc.frequency.value = 220;
        gain.gain.setValueAtTime(0.10, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
        break;
      case "complete":
        osc.frequency.value = 523.25;
        gain.gain.setValueAtTime(0.10, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.start(ctx.currentTime);
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1);
        osc.frequency.setValueAtTime(784.00, ctx.currentTime + 0.2);
        osc.frequency.setValueAtTime(1046.50, ctx.currentTime + 0.3);
        osc.stop(ctx.currentTime + 0.5);
        break;
    }
  } catch(e) {}
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  $("soundBtn").textContent = soundEnabled ? "🔊" : "🔇";
  try { localStorage.setItem(CONFIG.STORAGE_SOUND, soundEnabled ? "1" : "0"); } catch(e) {}
}

function restoreSoundSetting() {
  try {
    const v = localStorage.getItem(CONFIG.STORAGE_SOUND);
    if (v === "0") {
      soundEnabled = false;
      $("soundBtn").textContent = "🔇";
    }
  } catch(e) {}
}

/* ========== SECTION 16: 烟花效果 ========== */
/*
  本区函数清单：
  | 函数名        | 参数              | 功能简述                |
  |----------------|-------------------|-------------------------|
  | launchFireworks | —                 | 启动烟花动画            |
  | createParticle  | container,color   | 在容器内创建一个粒子  |
*/
function launchFireworks() {
  const wrap  = $("fireworksWrap");
  const left  = $("fwLeft");
  const right = $("fwRight");
  left.innerHTML = "";
  right.innerHTML = "";

  /* 爆炸光晕 */
  for (let g = 0; g < CONFIG.FIREWORK_GLOWS; g++) {
    const glow = document.createElement("div");
    glow.className = "fw-glow";
    glow.style.left = (Math.random() * 70 + 15) + "%";
    glow.style.top  = (Math.random() * 60 + 20) + "%";
    glow.style.width = glow.style.height = [90,120,150,60][g] + "px";
    glow.style.background = "radial-gradient(circle," + CONFIG.FIREWORK_COLORS[g % CONFIG.FIREWORK_COLORS.length] + "88,transparent)";
    left.appendChild(glow);
    /* 右侧也加 */
    const glow2 = glow.cloneNode(true);
    right.appendChild(glow2);
  }

  /* 粒子 */
  [left, right].forEach(container => {
    for (let i = 0; i < CONFIG.FIREWORK_PARTICLES; i++) {
      createParticle(container, CONFIG.FIREWORK_COLORS[Math.floor(Math.random() * CONFIG.FIREWORK_COLORS.length)]);
    }
  });

  wrap.classList.add("active");
  setTimeout(() => wrap.classList.remove("active"), CONFIG.FIREWORK_DURATION + 500);
}

function createParticle(container, color) {
  const p = document.createElement("div");
  p.className = "fw-particle";
  const size = Math.random() * 10 + 5;
  const angle = Math.random() * 2 * Math.PI;
  const dist  = 60 + Math.random() * 100;
  p.style.width  = size + "px";
  p.style.height = size + "px";
  p.style.left   = "50%";
  p.style.top    = "50%";
  p.style.background = color;
  p.style.setProperty("--tx", Math.cos(angle) * dist + "px");
  p.style.setProperty("--ty", Math.sin(angle) * dist + "px");
  container.appendChild(p);
}

/* ========== SECTION 17: 本地存储（存档与统计）========== */
/*
  本区函数清单：
  | 函数名      | 参数            | 功能简述                    |
  |--------------|-----------------|-----------------------------|
  | autoSave     | —               | 自动存档当前游戏状态        |
  | getSave      | —               | 读取存档，返回对象或 null  |
  | clearSave    | —               | 清除存档                  |
  | checkResume  | —               | 检查是否有未完成的游戏    |
  | resumeGame   | —               | 从存档恢复游戏状态        |
  | recordStats  | diff,timeSec    | 记录一局完成统计          |
  | getStats     | —               | 读取统计数据              |
  | clearStats   | —               | 清除所有统计数据          |
  | showStats    | —               | 打开统计弹窗并渲染表格    |
*/

function writeSaveNow() {
  if (finished) return;
  try {
    const data = {
      solution, givens, board, notes,
      selected, selectedCells, noteMode, showAllCands,
      seconds, usedPraiseIndices, difficulty: currentDifficulty,
    };
    localStorage.setItem(CONFIG.STORAGE_SAVE, JSON.stringify(data));
  } catch(e) {}
}

// 高频操作只标记为脏并合并写入；切后台/离页时通过 force 立即落盘。
function autoSave(force) {
  if (finished) return;
  saveDirty = true;
  if (force) {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    saveDirty = false;
    writeSaveNow();
    return;
  }
  if (!autoSaveTimer) {
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (!saveDirty || finished) return;
      saveDirty = false;
      writeSaveNow();
    }, CONFIG.AUTO_SAVE_INTERVAL);
  }
}

function getSave() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_SAVE);
    const save = raw ? JSON.parse(raw) : null;
    if (!save || !Array.isArray(save.solution) || !Array.isArray(save.givens) || !Array.isArray(save.board)) return null;
    if (save.solution.length !== 81 || save.givens.length !== 81 || save.board.length !== 81) return null;
    if (!save.solution.every(v => Number.isInteger(v) && v >= 1 && v <= 9)) return null;
    if (!save.givens.every((v, i) => v === 0 || v === save.solution[i])) return null;
    if (!save.board.every(v => Number.isInteger(v) && v >= 0 && v <= 9)) return null;
    return save;
  } catch(e) { return null; }
}

function getSavedDifficulty(save) {
  if (save && save.difficulty != null) return normalizeDifficulty(save.difficulty);
  const clueCount = save && Array.isArray(save.givens) ? save.givens.filter(v => v !== 0).length : CONFIG.DIFFICULTY_KEEP[0];
  let bestIndex = 0;
  let nearest = Infinity;
  CONFIG.DIFFICULTY_KEEP.forEach((keep, index) => {
    const distance = Math.abs(keep - clueCount);
    if (distance < nearest) { nearest = distance; bestIndex = index; }
  });
  return bestIndex;
}

function clearSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  saveDirty = false;
  try { localStorage.removeItem(CONFIG.STORAGE_SAVE); } catch(e) {}
}

function checkResume() {
  const save = getSave();
  const card = $("homeResumeCard");
  if (!save) {
    if (card) card.hidden = true;
    return false;
  }
  /* 检查是否真的未完成 */
  let done = 0;
  for (let i = 0; i < CONFIG.TOTAL_CELLS; i++) {
    if (save.givens[i] === 0 && save.board[i] === save.solution[i] && save.board[i] !== 0) done++;
  }
  const totalBlanks = save.givens.filter(v => v === 0).length;
  if (done >= totalBlanks && totalBlanks > 0) {
    clearSave();
    if (card) card.hidden = true;
    return false;
  }
  const difficulty = getSavedDifficulty(save);
  const percent = totalBlanks > 0 ? Math.floor(done / totalBlanks * 100) : 0;
  if (card) {
    $("homeResumeTitle").textContent = "继续未完成的一局";
    $("homeResumeMeta").textContent =
      ["简单","中等","困难","专家","极限"][difficulty] + " · " +
      formatDuration(save.seconds) + " · 完成 " + percent + "%";
    card.hidden = false;
  }
  return true;
}

function resumeGame() {
  const save = getSave();
  if (!save) {
    checkResume();
    return;
  }
  solution       = save.solution;
  givens        = save.givens;
  board          = save.board;
  notes          = save.notes && typeof save.notes === "object" ? save.notes : {};
  selected      = Number.isInteger(save.selected) && save.selected >= 0 && save.selected < 81 ? save.selected : -1;
  selectedCells = Array.isArray(save.selectedCells) ? save.selectedCells.filter(i => Number.isInteger(i) && i >= 0 && i < 81) : [];
  noteMode      = save.noteMode || false;
  showAllCands  = save.showAllCands || false;
  seconds       = Math.max(0, Math.floor(Number(save.seconds) || 0));
  usedPraiseIndices = Array.isArray(save.usedPraiseIndices) ? save.usedPraiseIndices : [];
  currentDifficulty = getSavedDifficulty(save);
  finished = false;
  history = [];

  $("noteBtn").textContent = "笔记：" + (noteMode ? "开" : "关");
  $("noteBtn").classList.toggle("active-btn", noteMode);
  $("candBtn").textContent = "候选：" + (showAllCands ? "开" : "关");
  $("candBtn").classList.toggle("active-btn", showAllCands);
  $("diffSelect").value = String(currentDifficulty);

  showGameScreen(true);
  startTimer();

  renderBoard();
  renderKeypad();
  updateProgress();
  updateTimer();
}

function recordStats(diff, timeSec) {
  try {
    const stats = getStats();
    const key = String(diff);                  // 强制转字符串键
    if (!stats[key]) stats[key] = { count: 0, best: Infinity, total: 0 };
    stats[key].count++;
    stats[key].best = Math.min(stats[key].best, timeSec);
    stats[key].total += timeSec;
    localStorage.setItem(CONFIG.STORAGE_STATS, JSON.stringify(stats));
  } catch(e) {}
}

function getStats() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_STATS);
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

function clearStats() {
  try {
    localStorage.removeItem(CONFIG.STORAGE_STATS);
    closeStats();
  } catch(e) {}
}

function showStats() {
  const stats = getStats();
  const diffNames = ["简单","中等","困难","专家","极限"];
  let html = "";
  for (let d = 0; d < 5; d++) {
    const key = String(d);           // 用字符串键，与 recordStats 一致
    const s = stats[key];
    html += "<tr>";
    html += "<td>" + diffNames[d] + "</td>";
    if (s && s.count > 0) {
      html += "<td>" + s.count + "</td>";
      html += "<td>" + (s.best === Infinity ? "—" : s.best + " 秒") + "</td>";
      html += "<td>" + Math.round(s.total / s.count) + " 秒</td>";
    } else {
      html += "<td>—</td><td>—</td><td>—</td>";
    }
    html += "</tr>";
  }
  $("statsBody").innerHTML = html;
  $("statsOverlay").classList.add("active");
}

function closeStats() {
  $("statsOverlay").classList.remove("active");
}

/* ========== SECTION 18: Toast 提示 ========== */
/*
  本区函数清单：
  | 函数名    | 参数        | 功能简述              |
  |------------|-------------|-----------------------|
  | showToast  | msg:string  | 显示 Toast 提示      |
  | hideToast  | —           | 立即隐藏 Toast        |
*/
function showToast(msg) {
  hideToast();
  const t = document.createElement("div");
  t.className = "toast";
  t.id = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  toastTimer = setTimeout(hideToast, CONFIG.TOAST_DURATION);
}

function hideToast() {
  clearTimeout(toastTimer);
  const t = $("toast");
  if (t) t.remove();
}

/* ========== SECTION 19: 游戏流程控制 ========== */
/*
  本区函数清单：
  | 函数名          | 参数 | 功能简述                    |
  |------------------|------|-----------------------------|
  | newGame          | —    | 开始新游戏                  |
  | onDifficultyChange | —   | 难度下拉框变更回调          |
  | startTimer       | —    | 启动计时器                  |
  | stopTimer        | —    | 停止计时器                  |
  | checkWinAndFinish | —   | 检查是否获胜并触发完成流程  |
*/
function syncHomeDifficulty() {
  document.querySelectorAll("#homeDifficulty [data-diff]").forEach(btn => {
    const active = normalizeDifficulty(btn.dataset.diff) === homeDifficulty;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function selectHomeDifficulty(value) {
  homeDifficulty = normalizeDifficulty(value);
  $("diffSelect").value = String(homeDifficulty);
  syncHomeDifficulty();
}

function showGameScreen(pushState) {
  $("sudokuHome").hidden = true;
  $("sudokuGame").hidden = false;
  document.body.classList.add("playing");
  if (pushState && window.history && location.hash !== "#play") {
    window.history.pushState({ sudoku: "play" }, "", "#play");
  }
}

function leaveFocusMode() {
  document.body.classList.remove("focus-mode");
  const btn = $("fullscreenBtn");
  if (btn) {
    btn.textContent = "⛶";
    btn.setAttribute("aria-label", "进入沉浸全屏");
    btn.title = "进入沉浸全屏";
  }
  if (document.fullscreenElement && document.exitFullscreen) {
    const result = document.exitFullscreen();
    if (result && typeof result.catch === "function") result.catch(() => {});
  }
}

function showSudokuHome(updateUrl) {
  if (timerStartedAt) {
    stopTimer();
    autoSave(true);
  }
  leaveFocusMode();
  document.body.classList.remove("playing");
  $("sudokuGame").hidden = true;
  $("sudokuHome").hidden = false;
  checkResume();
  if (updateUrl && window.history && location.hash === "#play") {
    window.history.replaceState({ sudoku: "home" }, "", location.pathname + location.search);
  }
  window.scrollTo(0, 0);
}

function canReplaceCurrentGame() {
  if (!getSave()) return true;
  if (typeof window.confirm !== "function") return true;
  return window.confirm("开始新局会替换当前未完成的进度，确定继续吗？");
}

function startHomeGame() {
  if (!canReplaceCurrentGame()) return;
  $("diffSelect").value = String(homeDifficulty);
  showGameScreen(true);
  newGame();
}

function requestNewGame() {
  if (!canReplaceCurrentGame()) return;
  newGame();
}

function requestClearBoard() {
  if (typeof window.confirm === "function" && !window.confirm("清空本局所有填写和笔记吗？题目数字会保留。")) return;
  clearAllUser();
}

function toggleFullscreenMode() {
  const entering = !document.body.classList.contains("focus-mode");
  const btn = $("fullscreenBtn");
  document.body.classList.toggle("focus-mode", entering);
  btn.textContent = entering ? "↙" : "⛶";
  btn.setAttribute("aria-label", entering ? "退出沉浸全屏" : "进入沉浸全屏");
  btn.title = entering ? "退出沉浸全屏" : "进入沉浸全屏";
  if (entering && !document.fullscreenElement && document.documentElement.requestFullscreen) {
    const result = document.documentElement.requestFullscreen();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } else if (!entering && document.fullscreenElement && document.exitFullscreen) {
    const result = document.exitFullscreen();
    if (result && typeof result.catch === "function") result.catch(() => {});
  }
}

function startTimer() {
  clearInterval(timerInterval);
  timerStartedAt = Date.now() - seconds * 1000;
  const tick = () => {
    if (finished) return;
    seconds = Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000));
    updateTimer();
    autoSave();
  };
  tick();
  timerInterval = setInterval(tick, CONFIG.TIMER_INTERVAL);
}

function stopTimer() {
  if (timerStartedAt) seconds = Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000));
  clearInterval(timerInterval);
  timerInterval = null;
  timerStartedAt = 0;
}

function checkWinAndFinish() {
  finished = true;
  stopTimer();
  const praiseText = getRandomPraise();   // 随机一句诗
  lastPraiseText = praiseText;            // 保存，供分享复用
  $("finishMsg").style.display = "block";
  const finishMsg = $("finishMsg");
  finishMsg.textContent = "🎉 " + praiseText + " · 用时 " + formatDuration(seconds);
  const shareButton = document.createElement("button");
  shareButton.type = "button";
  shareButton.className = "finish-share-btn";
  shareButton.textContent = "分享成绩";
  shareButton.addEventListener("click", showShare);
  finishMsg.appendChild(document.createElement("br"));
  finishMsg.appendChild(shareButton);
  launchFireworks();
  playSound("complete");
  recordStats(currentDifficulty, seconds);
  clearSave();
}

function newGame() {
  stopTimer();
  clearSave();
  const idx = normalizeDifficulty($("diffSelect").value);
  currentDifficulty = idx;
  solution      = generateSolution();
  givens       = generateGivens(solution, idx);
  board         = givens.slice();
  notes         = {};
  selected     = -1;
  selectedCells= [];
  noteMode     = false;
  showAllCands= false;
  finished     = false;
  history      = [];
  seconds      = 0;
  usedPraiseIndices = [];

  /* 停止旧计时器，启动新计时器 */
  startTimer();

  hideToast();
  $("noteBtn").textContent = "笔记：关";
  $("noteBtn").classList.remove("active-btn");
  $("candBtn").textContent = "候选：关";
  $("candBtn").classList.remove("active-btn");
  $("autoFillBtn").textContent = "自动填入：关";
  autoFillMode = false;
  $("finishMsg").style.display = "none";
  renderBoard();
  renderKeypad();
  updateProgress();
  updateTimer();
  clearKeypadRecommend();
  autoSave();
}

function onDifficultyChange() {
  selectHomeDifficulty($("diffSelect").value);
}

/* ========== SECTION 20: 键盘事件 ========== */
/*
  本区函数清单：
  | 函数名           | 参数 | 功能简述                |
  |-------------------|------|-------------------------|
  | bindKeyboardEvents | —    | 绑定全局 keydown 事件  |
*/
function bindKeyboardEvents() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const activeOverlay = document.querySelector(".modal-overlay.active");
      if (activeOverlay) {
        e.preventDefault();
        activeOverlay.classList.remove("active");
        return;
      }
    }
    if (finished) return;
    const key = e.key;

    /* 数字键 1-9 → 填数 */
    if (key >= "1" && key <= "9") {
      e.preventDefault();
      fillNumber(parseInt(key));
      return;
    }
    /* Backspace / Delete → 清除 */
    if (key === "Backspace" || key === "Delete") {
      e.preventDefault();
      fillNumber(0);
      return;
    }
    /* N → 切换笔记模式 */
    if (key === "n" || key === "N") {
      e.preventDefault();
      toggleNoteMode();
      return;
    }
    /* H → 提示 */
    if (key === "h" || key === "H") {
      e.preventDefault();
      showHint();
      return;
    }
    /* Z → 撤销（不支持 Ctrl+Z，避免冲突）*/
    if ((key === "z" || key === "Z") && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      undo();
      return;
    }
    /* 方向键 → 移动选中格 */
    if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(key)) {
      e.preventDefault();
      let delta = 0;
      if (key === "ArrowUp")    delta = -9;
      if (key === "ArrowDown")  delta = +9;
      if (key === "ArrowLeft")  delta = -1;
      if (key === "ArrowRight") delta = +1;
      const cur = selected >= 0 ? selected : 40;
      let next = cur + delta;
      if (next < 0 || next > 80) return;
      selectCell(next, e.ctrlKey || e.metaKey, e.shiftKey);
      return;
    }
    /* Escape → 取消选中 */
    if (key === "Escape") {
      e.preventDefault();
      selected = -1;
      selectedCells = [];
      renderBoard();
    }
  });
}

/* ========== SECTION 21: 初始化 ========== */
/*
  本区函数清单：
  | 函数名    | 参数 | 功能简述                  |
  |------------|------|---------------------------|
  | initApp    | —    | 应用初始化入口            |
*/
function bindUiEvents() {
  $("soundBtn").addEventListener("click", toggleSound);
  $("darkBtn").addEventListener("click", toggleDarkMode);
  $("fullscreenBtn").addEventListener("click", toggleFullscreenMode);
  $("gameHomeBtn").addEventListener("click", () => showSudokuHome(true));
  $("homeStartBtn").addEventListener("click", startHomeGame);
  $("homeResumeBtn").addEventListener("click", resumeGame);
  $("homeStatsBtn").addEventListener("click", showStats);
  document.querySelectorAll("#homeDifficulty [data-diff]").forEach(btn => {
    btn.addEventListener("click", () => selectHomeDifficulty(btn.dataset.diff));
  });
  $("diffSelect").addEventListener("change", onDifficultyChange);
  $("newGameBtn").addEventListener("click", requestNewGame);
  $("noteBtn").addEventListener("click", toggleNoteMode);
  $("candBtn").addEventListener("click", toggleShowAllCands);
  $("undoBtn").addEventListener("click", undo);
  $("hintBtn").addEventListener("click", showHint);
  $("techHintBtn").addEventListener("click", showTechHint);
  $("statsBtn").addEventListener("click", showStats);
  $("autoFillBtn").addEventListener("click", toggleAutoFill);
  $("clearBoardBtn").addEventListener("click", requestClearBoard);
  $("statsCloseBtn").addEventListener("click", closeStats);
  $("statsDoneBtn").addEventListener("click", closeStats);
  $("clearStatsBtn").addEventListener("click", clearStats);
  $("techHintCloseBtn").addEventListener("click", closeTechHint);
  $("techHintDoneBtn").addEventListener("click", closeTechHint);
  $("shareCloseBtn").addEventListener("click", closeShare);
  $("shareDoneBtn").addEventListener("click", closeShare);
  $("shareDownloadBtn").addEventListener("click", downloadShareImg);
  ["statsOverlay", "techHintOverlay", "shareOverlay"].forEach(id => {
    $(id).addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove("active"); });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && !finished && timerStartedAt) {
      seconds = Math.max(0, Math.floor((Date.now() - timerStartedAt) / 1000));
      autoSave(true);
    }
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("focus-mode")) leaveFocusMode();
  });
  window.addEventListener("pagehide", () => { if (!finished && timerStartedAt) autoSave(true); });
  window.addEventListener("popstate", () => {
    if (location.hash !== "#play" && !$("sudokuGame").hidden) showSudokuHome(false);
  });
}

function initApp() {
  restoreDarkMode();
  restoreSoundSetting();
  bindUiEvents();
  bindKeyboardEvents();
  selectHomeDifficulty(0);
  const hadSave = checkResume();
  if (location.hash === "#play" && hadSave) resumeGame();
  else showSudokuHome(location.hash === "#play");
}

window.__sudokuTest = {
  CONFIG,
  SEED_SOLUTION: SEED_SOLUTION.slice(),
  generateSolution,
  generateGivens,
  countSolutions,
  isValid,
  normalizeDifficulty,
  formatDuration,
  restoreHistoryEntry,
  gridIndexAtPoint,
  getDragRectBox,
  autoSave,
  clearSave,
};

window.addEventListener("DOMContentLoaded", initApp);
