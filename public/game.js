'use strict';
/* game.js —— 24点大挑战（HTML 测试版）UI 与玩法逻辑 v2
 * 交互改为「合并式」：点两张牌 → 选运算符 → 立刻算出结果（按点击顺序），
 * 结果变成新的一张牌，可继续合并，直到只剩一张且等于 24 即过关。无括号按钮。
 * 计算内核来自 core.js 的 Rational（与小程序同源，分数精确，无 eval）。
 * 覆盖：闯关(15级×15关/解锁门控/三星/三级提示) + 竞速(10题/计时/罚时/结算)。
 */
(function () {
  var LEVELS = window.LEVELS;
  var Rational = window.Rational;
  var LEVEL_COUNT = LEVELS.levels.reduce(function (m, x) { return Math.max(m, x.level); }, 0);

  // 每级实际题数（关卡结构改为「可变每关题数」：简单5/中等8/困难10），不再硬编码
  function perLevelCount(level) {
    var n = 0;
    for (var i = 0; i < LEVELS.levels.length; i++) {
      if (LEVELS.levels[i].level === level) n++;
    }
    return n;
  }
  var TOTAL_SPEED = 10;
  var TIME_LIMIT_MS = 60000; // 每关 60 秒（超时完成得 2 星）
  var WRONG_PENALTY = 5000;
  var SKIP_PENALTY = 15000;

  // ---------- 每级称号（中外数学家混排；顶级难关以杰出数学家命名） ----------
  // 单一数据源：来自 levels.json 的 meta.titles / meta.mathNotes（由 scripts/genLevels.js 生成）。
  var LEVEL_TITLES = (LEVELS.meta && LEVELS.meta.titles) || {};
  // 数学史小知识（仅数学家主题级展示）：单一数据源来自 meta.mathNotes
  var MATH_NOTE = (LEVELS.meta && LEVELS.meta.mathNotes) || {};

  // ---------- 存储 ----------
  var STORE_KEY = 'g24_progress_v2';
  var SPEED_BEST_KEY = 'g24_speed_best_v2';
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { slots: {}, stars: {} }; }
    catch (e) { return { slots: {}, stars: {} }; }
  }
  function saveStore(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {} }
  var store = loadStore();
  if (!store.slots) store.slots = {};
  if (!store.stars) store.stars = {};

  function stageCleared(level, index) {
    var arr = store.stars[level];
    return !!(arr && arr[index] && arr[index].stars > 0);
  }
  function levelUnlocked(level) {
    if (level === 1) return true;
    var need = perLevelCount(level - 1);
    for (var i = 1; i <= need; i++) if (!stageCleared(level - 1, i)) return false;
    return true;
  }
  function stageUnlocked(level, index) {
    if (index === 1) return levelUnlocked(level);
    return stageCleared(level, index - 1);
  }
  function saveStageResult(level, index, res) {
    if (!store.stars[level]) store.stars[level] = [];
    var prev = store.stars[level][index];
    var best = {
      stars: Math.max((prev && prev.stars) || 0, res.stars),
      timeMs: prev && prev.timeMs != null ? Math.min(prev.timeMs, res.timeMs) : res.timeMs,
      hintUsed: (prev && prev.hintUsed) || res.hintUsed
    };
    store.stars[level][index] = best;
    saveStore(store);
  }

  // 每级 10 题：直接取 levels.json 中固定题目（已按难度曲线排好），绑定到关卡槽位持久化。
  function toQuestion(e) {
    return {
      numbers: e.numbers.slice(),
      difficulty: e.difficulty,
      standardAnswer: e.standardAnswer
    };
  }
  function fixedForLevel(level) {
    return LEVELS.levels.filter(function (x) { return x.level === level; })
      .sort(function (a, b) { return a.index - b.index; })
      .map(toQuestion);
  }
  function getSlotQuestions(level) {
    if (!store.slots[level]) { store.slots[level] = fixedForLevel(level); saveStore(store); }
    return store.slots[level];
  }
  // 换一批题：在该级目标难度 ±1 分内随机重抽 10 题（保持难度基本一致）
  function reshuffleLevel(level) {
    var fixed = fixedForLevel(level);
    var target = fixed.length ? fixed[0].difficulty.score : 5;
    var pool = LEVELS.levels.filter(function (x) {
      return Math.abs(x.difficulty.score - target) <= 1;
    });
    var arr = shuffle(pool.slice());
    store.slots[level] = arr.slice(0, perLevelCount(level)).map(toQuestion);
    delete store.stars[level];
    saveStore(store);
  }

  function loadSpeedBest() {
    try { var v = localStorage.getItem(SPEED_BEST_KEY); return v == null ? null : parseInt(v, 10); }
    catch (e) { return null; }
  }
  function saveSpeedBest(ms) { try { localStorage.setItem(SPEED_BEST_KEY, String(ms)); } catch (e) {} }

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function show(view) {
    ['home', 'levels', 'stages', 'challenge', 'speedready', 'speed', 'speedresult',
     'vs', 'vsroom', 'vsplay', 'vsresult'].forEach(function (v) {
      $('view-' + v).style.display = (v === view) ? 'block' : 'none';
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- 三模式共用的小工具（DRY：闯关/竞速/联机不再各写一遍）----
  // 统一反馈条渲染（ch/sp/vs 仅元素 id 不同）
  function setFeedback(elId, type, text) {
    var el = $(elId); if (!el) return;
    el.textContent = text;
    el.className = 'feedback' + (type ? ' ' + type : '');
  }
  // 统一玩家行渲染（房间列表 / 对战进度共用）
  function renderPlayerRow(p, opts) {
    opts = opts || {};
    var total = opts.total || TOTAL_VS;
    var row = document.createElement('div');
    row.className = 'prow' + (opts.isMe ? ' me' : '') + (p.done ? ' done' : '') + (p.online ? '' : ' offline');
    var medal = p.done ? '🏁' : (opts.showCrown && opts.isMe && opts.host ? '👑' : '');
    row.innerHTML = '<div class="medal">' + medal + '</div>' +
      '<div class="pn">' + escapeHtml(p.nick || '玩家') + '</div>' +
      '<div class="pbar"><i style="width:' + (Math.round((p.prog || 0) / total * 100)) + '%"></i></div>' +
      '<div class="pv">' + (p.done ? '完成' : ((p.prog || 0) + '/' + total)) + '</div>';
    return row;
  }
  // 统一结算回顾行渲染（竞速结算 / 联机结算共用）
  function renderReviewRow(q, i) {
    var row = document.createElement('div');
    row.className = 'review-row ' + (q.correct ? 'ok' : 'no');
    row.innerHTML = '<span class="rv-idx">' + (i + 1) + '</span>' +
      '<span class="rv-nums">' + q.numbers.join(' · ') + '</span>' +
      '<span class="rv-ans">' + (q.answer || '') + '</span>' +
      '<span class="rv-mark">' + (q.correct ? '✓' : '✗') + '</span>';
    return row;
  }
  // 统一“答完一题”的判定推进（竞速 / 联机共用；闯关无对错走 win/stuck 故不入此）
  function resolve(state, correct, opts) {
    var q = state.questions[state.current];
    q.correct = correct;
    if (opts.onTrack) opts.onTrack(correct); // 联机需记逐题耗时 + 上报进度
    if (correct) { state.correct++; setFeedback(opts.fbEl, 'success', '答对了！'); bumpCombo(); }
    else { state.wrong++; setFeedback(opts.fbEl, 'bad', '答错！+5 秒罚时'); breakCombo(); }
    var delay = correct ? 650 : 950;
    setTimeout(function () {
      var next = state.current + 1;
      if (next < opts.total) { state.current = next; opts.setQuestion(next); }
      else opts.finish();
    }, delay);
  }
  function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; } } catch (e) {}
    try {
      var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }
  function formatClock(ms) {
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), ss = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---------- 成功音效（Web Audio 合成，file:// 可用） ----------
  var _audio = null;
  function playWin() {
    try {
      _audio = _audio || new (window.AudioContext || window.webkitAudioContext)();
      if (_audio.state === 'suspended') _audio.resume();
      var t = _audio.currentTime;
      [523.25, 659.25, 783.99, 1046.50].forEach(function (f, k) {
        var o = _audio.createOscillator(), g = _audio.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        o.connect(g); g.connect(_audio.destination);
        var s = t + k * 0.10;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.35, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.30);
        o.start(s); o.stop(s + 0.32);
      });
    } catch (e) {}
  }

  // ---------- 提示：把标准答案解析成「合并步骤」序列 ----------
  function parseSolutionSteps(expr) {
    var s = expr, i = 0;
    var OPS = { '+': '+', '−': '-', '-': '-', '×': '*', '*': '*', '÷': '/', '/': '/' };
    function pe() {
      var n = pt();
      while (s[i] === '+' || s[i] === '−' || s[i] === '-') { var op = OPS[s[i]]; i++; n = { op: op, l: n, r: pt() }; }
      return n;
    }
    function pt() {
      var n = pf();
      while (s[i] === '×' || s[i] === '*' || s[i] === '÷' || s[i] === '/') { var op = OPS[s[i]]; i++; n = { op: op, l: n, r: pf() }; }
      return n;
    }
    function pf() {
      if (s[i] === '(') { i++; var e = pe(); i++; return e; }
      var d = ''; while (s[i] >= '0' && s[i] <= '9') d += s[i++];
      return { num: parseInt(d, 10) };
    }
    var root = pe();
    var steps = [];
    function walk(node) {
      if (node.num !== undefined) return { v: new Rational(node.num), disp: String(node.num) };
      var L = walk(node.l), R = walk(node.r), val, sym;
      if (node.op === '+') { val = L.v.add(R.v); sym = '+'; }
      else if (node.op === '-') { val = L.v.sub(R.v); sym = '−'; }
      else if (node.op === '*') { val = L.v.mul(R.v); sym = '×'; }
      else { val = L.v.div(R.v); sym = '÷'; }
      var disp = val.toString();
      steps.push(L.disp + ' ' + sym + ' ' + R.disp + ' = ' + disp);
      return { v: val, disp: disp };
    }
    walk(root);
    return steps;
  }
  function buildHints(entry) {
    var sa = entry.standardAnswer;
    var steps = parseSolutionSteps(sa);
    // 取解法里“第一步”（两个原始数字直接合并的叶步骤）作为最具体的提示，紧扣本题数字
    var firstLeaf = null;
    for (var k = 0; k < steps.length; k++) {
      if (/^\d+ [+−×÷] \d+ = /.test(steps[k])) { firstLeaf = steps[k]; break; }
    }
    var l1 = firstLeaf
      ? ('提示①：先算 ' + firstLeaf + '。')
      : '提示①：先试着把其中两个数字合并。';
    // 提示②：本题的完整解题步骤
    var l2 = '提示②（解题步骤）：' + steps.join('  →  ');
    // 提示③：直接给出答案
    var l3 = '提示③（答案）：' + sa + ' = 24';
    return { 1: l1, 2: l2, 3: l3 };
  }

  // ====================================================================
  //  连对 combo（闯关 / 竞速 / 联机 共用）
  // ====================================================================
  var combo = 0;
  function bumpCombo() {
    combo++;
    if (combo >= 2) {
      var el = $('combo-pop');
      if (!el) return;
      el.textContent = '🔥 ' + combo + ' 连对！';
      el.classList.remove('show');
      void el.offsetWidth; // 强制回流，重触发入场动画
      el.classList.add('show');
    }
  }
  function breakCombo() {
    combo = 0;
    var el = $('combo-pop');
    if (el) el.classList.remove('show');
  }

  // ====================================================================
  //  合并式棋盘（闯关 / 竞速 共用）
  // ====================================================================
  function makeBoard(opts) {
    return {
      containerId: opts.containerId,
      statusId: opts.statusId,
      opts: opts,
      tokens: [], selId: null, op: null, history: [], nextId: 1, locked: false, _numbers: [],
      init: function (numbers) {
        this._numbers = numbers.slice();
        this.tokens = [];
        this.selId = null; this.op = null; this.history = []; this.nextId = 1; this.locked = false;
        var self = this;
        numbers.forEach(function (n) {
          self.tokens.push({ id: self.nextId++, value: new Rational(n), label: String(n), kind: 'orig', alive: true, win: false, bad: false });
        });
        this.render();
      },
      find: function (id) { for (var i = 0; i < this.tokens.length; i++) if (this.tokens[i].id === id) return this.tokens[i]; return null; },
      aliveTokens: function () { return this.tokens.filter(function (t) { return t.alive; }); },
      compute: function (a, op, b) {
        if (op === '+') return a.add(b);
        if (op === '−') return a.sub(b);
        if (op === '×') return a.mul(b);
        return a.div(b);
      },
      clickToken: function (id) {
        if (this.locked) return;
        var t = this.find(id);
        if (!t || !t.alive) return;
        if (this.op !== null && this.selId !== null && id !== this.selId) {
          var a = this.find(this.selId), b = t;
          if (this.op === '÷' && b.value.n === 0) {
            this.opts.onFlash('不能除以 0，换种算法吧');
            this.op = null; this.selId = null; this.render(); return;
          }
          var r = this.compute(a.value, this.op, b.value);
          var resId = this.nextId++;
          var res = { id: resId, value: r, label: r.toString(), kind: 'res', alive: true, win: false, bad: false, fresh: true };
          a.alive = false; b.alive = false;
          this.tokens.push(res);
          this.history.push({ resId: resId, aId: a.id, bId: b.id });
          this.selId = resId; this.op = null;
          this.render();
          if (this.aliveTokens().length === 1) {
            var only = this.aliveTokens()[0];
            if (only.value.eq(new Rational(24))) {
              only.win = true; only.fresh = false; this.locked = true; this.render(); this.opts.onWin(only);
            } else {
              only.bad = true; this.locked = true; this.render(); this.opts.onStuck(only);
            }
          }
          return;
        }
        if (this.selId === null) { this.selId = id; this.render(); return; }
        if (this.selId === id) { this.selId = null; this.render(); return; }
        this.selId = id; this.render();
      },
      clickOp: function (sym) {
        if (this.locked) return;
        if (this.selId === null) { this.opts.onFlash('先点一张数字牌'); return; }
        this.op = sym; this.render();
      },
      undo: function () {
        if (this.locked) return;
        var h = this.history.pop();
        if (!h) return;
        var r = this.find(h.resId); if (r) r.alive = false;
        var a = this.find(h.aId), b = this.find(h.bId);
        if (a) a.alive = true; if (b) b.alive = true;
        this.selId = null; this.op = null; this.render();
      },
      restart: function () { this.init(this._numbers); },
      render: function () {
        var c = $(this.containerId); if (!c) return;
        c.innerHTML = '';
        var self = this;
        this.aliveTokens().forEach(function (t) {
          var d = document.createElement('div');
          d.className = 'tk ' + (t.kind === 'orig' ? 'tk-orig' : 'tk-res') +
            (self.selId === t.id ? ' tk-sel' : '') + (t.win ? ' tk-win' : '') + (t.bad ? ' tk-bad' : '') +
            (t.fresh ? ' tk-fresh' : '');
          d.textContent = t.label;
          d.onclick = function () { self.clickToken(t.id); };
          c.appendChild(d);
          t.fresh = false;
        });
        var st;
        if (this.locked) st = '本关已完成';
        else if (this.selId === null) st = '① 点一张数字牌开始';
        else if (this.op === null) st = '② 已选 ' + this.find(this.selId).label + '，请点 + − × ÷';
        else st = '③ ' + this.find(this.selId).label + ' ' + this.op + ' ▸ 点下一张牌';
        if (this.opts.onStatus) this.opts.onStatus(st);
      }
    };
  }

  // ====================================================================
  //  闯关模式
  // ====================================================================
  var chState = { level: 1, index: 1, entry: null, hints: {}, hintLevel: 0, hintUsed: false,
                  elapsedMs: 0, timer: null, timedOut: false, showResult: false };
  var boardCh = makeBoard({
    containerId: 'ch-board', statusId: 'ch-status',
    onFlash: function (msg) { setChFeedback('error', msg); },
    onStatus: function (txt) { $('ch-status').textContent = txt; },
    onWin: function (tok) { onChWin(tok); },
    onStuck: function (tok) { onChStuck(tok); }
  });

  function renderLevels() {
    var grid = $('levels-grid'); grid.innerHTML = '';
    for (var lv = 1; lv <= LEVEL_COUNT; lv++) {
      (function (l) {
        var unlocked = levelUnlocked(l);
    var cleared = 0;
    var total = perLevelCount(l);
    for (var i = 1; i <= total; i++) if (stageCleared(l, i)) cleared++;
        var cell = document.createElement('div');
        cell.className = 'level-cell' + (unlocked ? '' : ' locked');
        cell.innerHTML = '<div class="lv-num">' + l + '</div>' +
          '<div class="lv-title">' + LEVEL_TITLES[l] + '</div>' +
          '<div class="lv-prog">' + cleared + '/' + perLevelCount(l) + '★</div>';
        if (unlocked) cell.onclick = function () { openStages(l); };
        grid.appendChild(cell);
      })(lv);
    }
  }
  function openStages(level) {
    $('stages-title').textContent = '第 ' + level + ' 级 · ' + LEVEL_TITLES[level];
    $('stages-note').textContent = MATH_NOTE[level] || '';
    var grid = $('stages-grid'); grid.innerHTML = '';
    var stageTotal = perLevelCount(level);
    for (var i = 1; i <= stageTotal; i++) {
      (function (idx) {
        var unlocked = stageUnlocked(level, idx);
        var stars = store.stars[level] && store.stars[level][idx] ? store.stars[level][idx].stars : 0;
        var cell = document.createElement('div');
        cell.className = 'stage-cell' + (unlocked ? '' : ' locked');
        var starStr = '★★★'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars);
        cell.innerHTML = '<div class="st-num">' + idx + '</div>' +
          '<div class="st-stars">' + (unlocked ? starStr : '🔒') + '</div>';
        if (unlocked) cell.onclick = function () { openChallenge(level, idx); };
        grid.appendChild(cell);
      })(i);
    }
    $('stages-reshuffle').style.display = levelUnlocked(level) ? 'block' : 'none';
    show('stages');
  }
  function openChallenge(level, index) {
    var q = getSlotQuestions(level)[index - 1];
    if (!q) { alert('关卡不存在'); return; }
    chState.level = level; chState.index = index; chState.entry = q;
    chState.hints = buildHints(q); chState.hintLevel = 0; chState.hintUsed = false;
    chState.elapsedMs = 0; chState.timedOut = false; chState.showResult = false;
    boardCh.init(q.numbers);
    $('ch-level').textContent = '第 ' + level + ' 级 · ' + LEVEL_TITLES[level];
    $('ch-diff').textContent = (q.difficulty && q.difficulty.label) || '';
    $('ch-hints').innerHTML = '';
    setChFeedback('', '');
    $('ch-result').style.display = 'none';
    show('challenge');
    startChTimer();
  }
  function startChTimer() {
    stopChTimer();
    chState.timer = setInterval(function () {
      chState.elapsedMs += 200;
      chState.timedOut = chState.elapsedMs > TIME_LIMIT_MS;
      $('ch-timer').textContent = formatClock(chState.elapsedMs);
      $('ch-timer').className = 'timer' + (chState.timedOut ? ' over' : '');
    }, 200);
  }
  function stopChTimer() { if (chState.timer) { clearInterval(chState.timer); chState.timer = null; } }

  function onChWin(tok) {
    stopChTimer();
    bumpCombo();
    var timedOut = chState.elapsedMs > TIME_LIMIT_MS;
    var stars = chState.hintUsed ? 1 : (timedOut ? 2 : 3);
    saveStageResult(chState.level, chState.index, { stars: stars, timeMs: chState.elapsedMs, hintUsed: chState.hintUsed });
    chState.showResult = true;
    playWin();
    $('ch-result-stars').textContent = '★★★'.slice(0, stars) + '☆☆☆'.slice(0, 3 - stars);
    $('ch-result-info').textContent = (chState.hintUsed ? '用了提示 → 1 星' : (timedOut ? '超时但独立完成 → 2 星' : '完美！未用提示且未超时 → 3 星'));

    // 通关结果页：根据是否处于本大关最后一题，动态给出「下一关」或「进入下一大关」选项
    var isLastStage = chState.index === perLevelCount(chState.level);
    var hasNextLevel = chState.level < LEVEL_COUNT;
    var nextUnlocked = hasNextLevel ? levelUnlocked(chState.level + 1) : false;
    if (isLastStage) {
      $('ch-result-title').textContent = '🎉 第 ' + chState.level + ' 大关全部通关！';
      $('ch-next').textContent = '本关列表';
      $('ch-next').style.display = 'block';
      if (nextUnlocked) {
        $('ch-next-level').textContent = '进入第 ' + (chState.level + 1) + ' 大关 →';
        $('ch-next-level').style.display = 'block';
      } else {
        $('ch-next-level').style.display = 'none';
      }
    } else {
      $('ch-result-title').textContent = '本关完成！';
      $('ch-next').textContent = '下一关 →';
      $('ch-next').style.display = 'block';
      $('ch-next-level').style.display = 'none';
    }
    $('ch-result').style.display = 'flex';
  }
  function onChStuck(tok) {
    breakCombo();
    setChFeedback('bad', '结果不是 24（得到 ' + tok.label + '），点【重来】再试试');
  }
  function setChFeedback(type, text) { setFeedback('ch-feedback', type, text); }
  function chHint() {
    if (chState.showResult) return;
    if (chState.hintLevel >= 3) return;
    chState.hintLevel++;
    chState.hintUsed = true;
    var p = document.createElement('div');
    p.className = 'hint-line';
    p.textContent = chState.hints[chState.hintLevel];
    $('ch-hints').appendChild(p);
  }
  // 「直接看答案」按钮：一键展示完整步骤 + 最终答案（含具体哪两张牌用哪个符号的提示）
  function chReveal() {
    if (chState.showResult) return;
    // 把 1/2/3 级提示一次性写满
    while (chState.hintLevel < 3) {
      chState.hintLevel++;
      chState.hintUsed = true;
      var p = document.createElement('div');
      p.className = 'hint-line';
      p.textContent = chState.hints[chState.hintLevel];
      $('ch-hints').appendChild(p);
    }
  }
  function chNext() {
    if (chState.index < perLevelCount(chState.level)) openChallenge(chState.level, chState.index + 1);
    else openStages(chState.level);
  }

  // ====================================================================
  //  竞速模式
  // ====================================================================
  var spState = { questions: [], current: 0, elapsedMs: 0, timer: null, wrong: 0, skip: 0, correct: 0, finished: false };
  var boardSp = makeBoard({
    containerId: 'sp-board', statusId: 'sp-status',
    onFlash: function (msg) { spFeedback('error', msg); },
    onStatus: function (txt) { $('sp-status').textContent = txt; },
    onWin: function (tok) { onSpResolved(true); },
    onStuck: function (tok) { onSpResolved(false); }
  });

  // 竞速取题：走 meta.speedLadder（难度递增的题目下标桶，由 scripts/genLevels.js 生成）。
  // 每桶随机抽 1 题 ⇒ 每局题目都不同，且第 1 题最易、第 10 题最难、同局无重复。
  // 若数据缺 speedLadder（旧数据兜底），退回全池洗牌。
  function buildQuestions() {
    var ladder = (LEVELS.meta && LEVELS.meta.speedLadder) || null;
    var picked = [];
    if (ladder && ladder.length) {
      for (var s = 0; s < TOTAL_SPEED; s++) {
        var b = ladder[Math.min(Math.floor((s * ladder.length) / TOTAL_SPEED), ladder.length - 1)];
        if (!b || !b.length) continue;
        picked.push(LEVELS.levels[b[Math.floor(Math.random() * b.length)]]);
      }
    }
    if (picked.length < TOTAL_SPEED) {
      var pool = LEVELS.levels.slice();
      shuffle(pool);
      for (var k = 0; k < pool.length && picked.length < TOTAL_SPEED; k++) {
        if (picked.indexOf(pool[k]) < 0) picked.push(pool[k]);
      }
    }
    return picked.slice(0, TOTAL_SPEED).map(function (x) {
      return { numbers: x.numbers.slice(), answer: x.standardAnswer, correct: null };
    });
  }
  function startSpeed() {
    breakCombo();
    spState.questions = buildQuestions();
    spState.current = 0; spState.elapsedMs = 0; spState.wrong = 0; spState.skip = 0; spState.correct = 0;
    spState.finished = false;
    spSetQuestion(0);
    show('speed');
    startSpTimer();
  }
  function startSpTimer() {
    stopSpTimer();
    spState.timer = setInterval(function () { spState.elapsedMs += 100; $('sp-timer').textContent = formatClock(spState.elapsedMs); }, 100);
  }
  function stopSpTimer() { if (spState.timer) { clearInterval(spState.timer); spState.timer = null; } }
  function spSetQuestion(i) {
    var q = spState.questions[i];
    boardSp.init(q.numbers);
    $('sp-index').textContent = (i + 1);
    $('sp-total').textContent = TOTAL_SPEED;
    spFeedback('', '');
  }
  function onSpResolved(correct) {
    resolve(spState, correct, {
      total: TOTAL_SPEED, fbEl: 'sp-feedback',
      setQuestion: spSetQuestion, finish: spFinish
    });
  }
  function spSkip() {
    if (spState.finished) return;
    if (boardSp.locked) return;
    breakCombo();
    spState.questions[spState.current].correct = false;
    spState.skip++;
    spFeedback('bad', '已跳过 +15 秒罚时');
    boardSp.locked = true;
    setTimeout(function () {
      var next = spState.current + 1;
      if (next < TOTAL_SPEED) { spState.current = next; spSetQuestion(next); }
      else spFinish();
    }, 500);
  }
  function spFeedback(type, text) { setFeedback('sp-feedback', type, text); }
  function spFinish() {
    stopSpTimer();
    spState.finished = true;
    var actualMs = spState.elapsedMs;
    var wrongPenalty = spState.wrong * WRONG_PENALTY;
    var skipPenalty = spState.skip * SKIP_PENALTY;
    var finalMs = actualMs + wrongPenalty + skipPenalty;
    var accuracy = spState.correct / TOTAL_SPEED;
    var prevBest = loadSpeedBest();
    var isRecord = (prevBest == null) || (finalMs < prevBest);
    if (isRecord) saveSpeedBest(finalMs);

    $('sr-actual').textContent = formatClock(actualMs);
    $('sr-penalty').textContent = '+' + formatClock(wrongPenalty + skipPenalty) + '（错' + spState.wrong + '×5s / 跳' + spState.skip + '×15s）';
    $('sr-final').textContent = formatClock(finalMs);
    $('sr-acc').textContent = Math.round(accuracy * 100) + '%';
    $('sr-wrong').textContent = spState.wrong;
    $('sr-skip').textContent = spState.skip;
    $('sr-correct').textContent = spState.correct + '/' + TOTAL_SPEED;
    $('sr-record').textContent = isRecord ? '🏆 新纪录！' : ('历史最佳：' + (prevBest != null ? formatClock(prevBest) : '—'));

    var review = $('sr-review'); review.innerHTML = '';
    spState.questions.forEach(function (q, i) { review.appendChild(renderReviewRow(q, i)); });
    show('speedresult');
  }

  // ====================================================================
  //  联机对战（房间码 = 种子，双方题目天然一致；有服务器则实时同步）
  // ====================================================================
  var TOTAL_VS = 10;
  var vsState = {
    room: '', round: 1, online: false, host: false, myCid: '',
    questions: [], current: 0,
    elapsedMs: 0, timer: null, wrong: 0, skip: 0, correct: 0,
    finished: false, started: false, myResult: null, client: null, players: []
  };
  var boardVs = makeBoard({
    containerId: 'vp-board', statusId: 'vp-status',
    onFlash: function (msg) { vsFeedback('error', msg); },
    onStatus: function (txt) { $('vp-status').textContent = txt; },
    onWin: function (tok) { onVsResolved(true); },
    onStuck: function (tok) { onVsResolved(false); }
  });

  function vsFeedback(type, text) { setFeedback('vp-feedback', type, text); }
  function vsSetNetBadge(elId, mode) {
    var el = $(elId); if (!el) return;
    if (mode === 'online') { el.className = 'net-badge net-on'; el.textContent = '已联机'; }
    else if (mode === 'reconnecting') { el.className = 'net-badge net-wait'; el.textContent = '重连中…'; }
    else { el.className = 'net-badge net-off'; el.textContent = '离线模式'; }
  }

  // ---- 大厅 ----
  function openVsLobby() {
    var nick = Net.getNick(); if (nick) $('vs-nick').value = nick;
    var invite = Net.readInviteCode();
    if (invite) {
      $('vs-code').value = invite;
      $('vs-code').focus();
    }
    var srv = Net.getServerUrl(); if (srv) $('vs-server').value = srv;
    if (srv) { $('vs-netstate').className = 'net-badge net-wait'; $('vs-netstate').textContent = '已配置服务器'; }
    else { $('vs-netstate').className = 'net-badge net-off'; $('vs-netstate').textContent = '离线模式'; }
    show('vs');
  }
  function createVsRoom() {
    var nick = ($('vs-nick').value || '').trim() || '玩家'; Net.setNick(nick);
    var code = Net.randomRoomCode();
    enterVsRoom(code);
  }
  function joinVsRoom() {
    var nick = ($('vs-nick').value || '').trim() || '玩家'; Net.setNick(nick);
    var code = Net.normalizeRoomCode($('vs-code').value);
    if (!Net.isValidRoomCode(code)) {
      alert('房间码不正确，请检查（5 位字母数字，不含 I / O / 0 / 1）');
      return;
    }
    enterVsRoom(code);
  }
  function enterVsRoom(code) {
    vsState.room = code;
    vsState.round = 1;
    vsState.myCid = Net.getCid();
    vsState.players = [];
    vsState.finished = false; vsState.started = false; vsState.myResult = null;
    var url = Net.getServerUrl();
    if (url) {
      setupVsClient();
      vsState.client.open(code, Net.getNick());
    } else {
      vsState.online = false; vsState.client = null; vsState.host = false;
    }
    $('vr-code').textContent = code;
    $('vr-link').value = Net.inviteLink(code);
    $('vp-room').textContent = code;
    renderVsRoom();
    show('vsroom');
  }

  function setupVsClient() {
    vsState.client = Net.createClient({
      onMode: function (mode) {
        vsState.online = (mode === 'online');
        vsSetNetBadge('vr-netstate', mode);
        vsSetNetBadge('vres-netstate', mode);
        if (mode === 'online') $('vr-share-tip').textContent = '已连接服务器，可实时看到对手进度。';
        else $('vr-share-tip').textContent = '未连接服务器：各自打完这套题，用「成绩码」对比也能比出胜负。';
        renderVsRoom();
      },
      onState: function (m) {
        vsState.players = m.players || [];
        vsState.round = m.round || vsState.round;
        vsState.host = (m.host === vsState.myCid);
        renderVsRoom(); renderVsPlay(); renderVsResult();
      },
      onStart: function (m) {
        vsState.round = m.round || vsState.round;
        beginVsPlay(m.at);
      }
    });
  }

  function vsStart() {
    if (vsState.online && vsState.client) {
      if (vsState.host) vsState.client.start();
      else alert('等待房主开始…');
    } else {
      beginVsPlay(Date.now());
    }
  }

  // ---- 开局（带同步倒计时）----
  function beginVsPlay(atMs) {
    atMs = atMs || Date.now();
    var delay = Math.max(0, atMs - Date.now());
    if (delay > 500) {
      var cd = $('sr-countdown'); var span = cd.querySelector('span');
      cd.style.display = 'flex';
      var n = Math.max(1, Math.ceil(delay / 1000));
      span.textContent = String(n);
      var t = setInterval(function () {
        n--;
        if (n <= 0) { clearInterval(t); cd.style.display = 'none'; startVsBoard(); }
        else span.textContent = String(n);
      }, 1000);
    } else {
      startVsBoard();
    }
  }
  function startVsBoard() {
    breakCombo();
    vsState.questions = Net.buildRoomQuestions(Net.roundSeed(vsState.room, vsState.round), TOTAL_VS, LEVELS);
    vsState.current = 0; vsState.elapsedMs = 0;
    vsState.wrong = 0; vsState.skip = 0; vsState.correct = 0;
    vsState.finished = false; vsState.started = true; vsState.myResult = null;
    vsState._qStart = 0; // 当前题的起始计时（用于「逐题耗时」）
    vsSetQuestion(0);
    show('vsplay');
    startVsTimer();
  }
  function vsSetQuestion(i) {
    var q = vsState.questions[i];
    boardVs.init(q.numbers);
    $('vp-index').textContent = (i + 1);
    $('vp-total').textContent = TOTAL_VS;
    vsState._qStart = vsState.elapsedMs; // 本题开始计时
    vsFeedback('', '');
  }
  function onVsResolved(correct) {
    resolve(vsState, correct, {
      total: TOTAL_VS, fbEl: 'vp-feedback',
      setQuestion: vsSetQuestion, finish: vsFinishVs,
      onTrack: function (c) {
        var q = vsState.questions[vsState.current];
        q.ms = vsState.elapsedMs - vsState._qStart; // 本题耗时
        if (vsState.online && vsState.client) vsState.client.progress(vsState.current, c, vsState.elapsedMs);
      }
    });
  }
  function vsSkip() {
    if (vsState.finished || !vsState.started) return;
    if (boardVs.locked) return;
    breakCombo();
    vsState.questions[vsState.current].correct = false;
    vsState.questions[vsState.current].ms = vsState.elapsedMs - vsState._qStart; // 本题耗时
    vsState.skip++;
    vsFeedback('bad', '已跳过 +15 秒罚时');
    boardVs.locked = true;
    if (vsState.online && vsState.client) vsState.client.progress(vsState.current, false, vsState.elapsedMs);
    setTimeout(function () {
      var next = vsState.current + 1;
      if (next < TOTAL_VS) { vsState.current = next; vsSetQuestion(next); }
      else vsFinishVs();
    }, 500);
  }
  function startVsTimer() {
    stopVsTimer();
    vsState.timer = setInterval(function () {
      vsState.elapsedMs += 100;
      $('vp-timer').textContent = formatClock(vsState.elapsedMs);
    }, 100);
  }
  function stopVsTimer() { if (vsState.timer) { clearInterval(vsState.timer); vsState.timer = null; } }

  function vsFinishVs() {
    stopVsTimer();
    vsState.finished = true; vsState.started = false;
    var actualMs = vsState.elapsedMs;
    var wrongPenalty = vsState.wrong * WRONG_PENALTY;
    var skipPenalty = vsState.skip * SKIP_PENALTY;
    var finalMs = actualMs + wrongPenalty + skipPenalty;
    // 逐题对错 + 逐题耗时，供结果页「逐题对决」与战报
    var results = vsState.questions.map(function (q) { return q.correct ? 1 : 0; });
    var qms = vsState.questions.map(function (q) { return Math.max(0, Math.round(q.ms || 0)); });
    vsState.myResult = {
      finalMs: finalMs, actualMs: actualMs,
      correct: vsState.correct, wrong: vsState.wrong, skip: vsState.skip,
      results: results, qms: qms
    };
    if (vsState.online && vsState.client) {
      vsState.client.done({
        finalMs: finalMs, actualMs: actualMs,
        correct: vsState.correct, wrong: vsState.wrong, skip: vsState.skip,
        results: results, qms: qms
      });
    }
    setTimeout(function () { show('vsresult'); renderVsResult(); }, vsState.online ? 450 : 0);
  }

  // ---- 渲染：房间 ----
  function renderVsRoom() {
    $('vr-count').textContent = (vsState.players.length || 1);
    $('vr-round').textContent = vsState.round;
    var list = $('vr-players'); list.innerHTML = '';
    var players = vsState.players.length ? vsState.players
      : [{ cid: vsState.myCid, nick: Net.getNick() || '我', ready: false, online: true, prog: 0, done: false }];
    players.forEach(function (p) {
      list.appendChild(renderPlayerRow(p, {
        isMe: p.cid === vsState.myCid, showCrown: true, host: vsState.host
      }));
    });
    var startBtn = $('vr-start');
    if (vsState.online) {
      if (vsState.host) {
        startBtn.textContent = '▶ 开始对战'; startBtn.disabled = false; startBtn.style.opacity = '1';
        $('vr-role').textContent = '你是房主，点开始让大家同时答题。';
      } else {
        startBtn.textContent = '⌛ 等待房主开始…'; startBtn.disabled = true; startBtn.style.opacity = '0.6';
        $('vr-role').textContent = '房主开始后才能答题。';
      }
    } else {
      startBtn.textContent = '▶ 开始对战（离线·各自计分）'; startBtn.disabled = false; startBtn.style.opacity = '1';
      $('vr-role').textContent = '离线模式：你和朋友用同一房间码会得到相同题目，打完用成绩码对比。';
    }
  }
  // ---- 渲染：对战中的对手进度 ----
  function renderVsPlay() {
    var wrap = $('vp-players'); if (!wrap || $('view-vsplay').style.display === 'none') return;
    wrap.innerHTML = '';
    if (!vsState.online) {
      wrap.innerHTML = '<div class="hintline" style="text-align:center;padding:4px;">离线模式：看不到对手进度，但你们题目相同，用成绩码对比即可。</div>';
      return;
    }
    (vsState.players || []).forEach(function (p) {
      if (p.cid === vsState.myCid) return;
      wrap.appendChild(renderPlayerRow(p, { isMe: false, showCrown: false }));
    });
  }
  // ---- 渲染：结算 ----
  function renderVsResult() {
    if (!$('view-vsresult') || $('view-vsresult').style.display !== 'block') return;
    var me = vsState.myResult || { finalMs: vsState.elapsedMs, actualMs: vsState.elapsedMs, correct: vsState.correct, wrong: vsState.wrong, skip: vsState.skip };
    var players = (vsState.players || []).slice();
    var selfIdx = -1;
    for (var k = 0; k < players.length; k++) if (players[k].cid === vsState.myCid) { selfIdx = k; break; }
    if (selfIdx < 0) {
      players.push({ cid: vsState.myCid, nick: Net.getNick() || '我', done: vsState.finished, finalMs: me.finalMs, actualMs: me.actualMs, correct: me.correct, wrong: me.wrong, skip: me.skip, prog: TOTAL_VS, online: true });
    } else if (players[selfIdx].done && players[selfIdx].finalMs == null) {
      players[selfIdx].finalMs = me.finalMs;
    }
    players.sort(function (a, b) {
      if (a.done && b.done) return a.finalMs - b.finalMs;
      if (a.done) return -1;
      if (b.done) return 1;
      return (b.prog || 0) - (a.prog || 0);
    });
    // 只有「在线玩家都已完成」才定胜负，避免自己一提交就误报“你赢了”
    var onlinePlayers = players.filter(function (p) { return p.online; });
    var winnerReady = players.length === 1 || onlinePlayers.every(function (p) { return p.done; });
    var winner = null;
    if (winnerReady) {
      players.forEach(function (p) { if (p.done && (winner === null || p.finalMs < winner.finalMs)) winner = p; });
    }
    // 一次性入场动画闸门：未定胜负期间持续重置，定胜负那一刻只播一次，避免实时更新闪烁
    var animate = false;
    if (winnerReady) {
      if (!vsState._resultAnimated) { animate = true; vsState._resultAnimated = true; }
    } else {
      vsState._resultAnimated = false;
    }
    var rank = $('vres-rank'); rank.innerHTML = '';
    players.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'rank-row' + (animate ? ' rank-in' + (i < 4 ? ' rank-' + (i + 1) : '') : '');
      var isMe = p.cid === vsState.myCid;
      var medal = (i === 0 && p.done) ? '🥇' : (i === 1 && p.done ? '🥈' : (i === 2 && p.done ? '🥉' : (i + 1)));
      row.innerHTML = '<div class="medal">' + medal + '</div>' +
        '<div class="rn">' + (isMe ? '我（' + escapeHtml(p.nick || '我') + '）' : escapeHtml(p.nick || '玩家')) + '</div>' +
        '<div class="rt">' + (p.done ? formatClock(p.finalMs) : (p.online ? '答题中 ' + (p.prog || 0) + '/' + TOTAL_VS : '离线')) + '</div>';
      rank.appendChild(row);
    });
    var banner = $('vres-banner');
    banner.className = 'win-banner' + (animate && winner ? ' win-pop' : '');
    if (players.length === 1) banner.textContent = '你的成绩';
    else if (!winnerReady) banner.textContent = (vsState.finished ? '你已完成 ✅ 等待对手提交…' : '对战中…');
    else if (winner && winner.cid === vsState.myCid) banner.textContent = '🎉 你赢了！';
    else if (winner) banner.textContent = '本局冠军：' + escapeHtml(winner.nick || '玩家');
    else banner.textContent = '对战中…';
    var waiting = players.filter(function (p) { return p.online && !p.done; });
    $('vres-waiting').textContent = vsState.online ? (waiting.length ? ('等待 ' + waiting.length + ' 位玩家完成…') : (winnerReady ? '全部完成！' : '')) : '';

    // ---- 对战对比表 + 胜负原因 ----
    var body = $('vres-cmp-body'); body.innerHTML = '';
    var reason = '';
    if (winnerReady && winner) {
      var second = null;
      players.forEach(function (p) {
        if (p.done && p !== winner) { if (second === null || p.finalMs < second.finalMs) second = p; }
      });
      if (second) {
        var gap = second.finalMs - winner.finalMs;
        var cd = winner.correct - second.correct;
        if (winner.cid === vsState.myCid) {
          reason = '你领先 ' + formatClock(gap) + (cd !== 0 ? ('（多答对 ' + Math.abs(cd) + ' 题）') : '') + ' 拿下本局！';
        } else if (second.cid === vsState.myCid) {
          reason = '你以 ' + formatClock(gap) + ' 之差惜败' + (cd !== 0 ? ('（少答对 ' + Math.abs(cd) + ' 题）') : '') + '。';
        } else {
          reason = escapeHtml(winner.nick || '玩家') + ' 领先 ' + formatClock(gap) + ' 获胜' + (cd !== 0 ? ('（多答对 ' + Math.abs(cd) + ' 题）') : '') + '。';
        }
      } else {
        reason = winner.cid === vsState.myCid ? '全场你最快完成，本局你赢！' : (escapeHtml(winner.nick || '玩家') + ' 第一个完成，本局他赢。');
      }
    } else if (!winnerReady && vsState.finished) {
      reason = '你已交卷，等对手也完成就能见分晓。';
    }
    players.forEach(function (p) {
      var tr = document.createElement('tr');
      if (winnerReady && winner && p.cid === winner.cid) tr.className = 'win' + (animate ? ' pulse' : '');
      var isMe = p.cid === vsState.myCid;
      var res = !p.done ? (p.online ? '…' : '离线') : (winnerReady && winner && p.cid === winner.cid ? '🏆 胜' : '—');
      tr.innerHTML =
        '<td class="name">' + (isMe ? escapeHtml(Net.getNick() || '我') : escapeHtml(p.nick || '玩家')) +
          (isMe ? '<span class="me-tag">我</span>' : '') + '</td>' +
        '<td>' + (p.done ? formatClock(p.actualMs) : (p.online ? '答题中' : '—')) + '</td>' +
        '<td>' + (p.done ? '+' + formatClock(p.finalMs - p.actualMs) : '—') + '</td>' +
        '<td>' + (p.done ? formatClock(p.finalMs) : '—') + '</td>' +
        '<td>' + (p.done ? (p.correct + '/' + TOTAL_VS) : '—') + '</td>' +
        '<td>' + (p.done ? (p.wrong || 0) : '—') + '</td>' +
        '<td>' + (p.done ? (p.skip || 0) : '—') + '</td>' +
        '<td class="' + (winnerReady && winner && p.cid === winner.cid ? 'cmp-win' : 'cmp-lose') + '">' + res + '</td>';
      body.appendChild(tr);
    });
    // ---- 逐题对决 + 战报（针对「不知道谁哪里赢/输」）----
    var opp = null;
    players.forEach(function (p) {
      if (p.cid !== vsState.myCid && p.results && p.results.length && (!opp || p.done)) opp = p;
    });
    var duelPanel = $('vres-duelpanel');
    var duel = $('vres-duel');
    if (me.results && me.results.length && opp && opp.results && opp.results.length) {
      duelPanel.style.display = '';
      var n = Math.min(me.results.length, opp.results.length);
      var rows = '';
      for (var di = 0; di < n; di++) {
        var mine = me.results[di], his = opp.results[di];
        var dcls = (mine && !his) ? 'win' : (!mine && his) ? 'loss' : '';
        rows += '<tr class="' + dcls + '">' +
          '<td class="name">第' + (di + 1) + '题</td>' +
          '<td>' + (mine ? '✓' : '✗') + '</td>' +
          '<td>' + (his ? '✓' : '✗') + '</td></tr>';
      }
      duel.innerHTML = '<thead><tr><th class="name">题</th><th>我</th><th>' +
        escapeHtml(opp.nick || '对手') + '</th></tr></thead><tbody>' + rows + '</tbody>';
    } else {
      duelPanel.style.display = 'none';
    }

    // 战报：用时差 / 答对差 / 关键得失分题 / 最卡一题
    var report = [];
    if (winnerReady && winner && me.results && opp && opp.results) {
      if (second) {
        report.push('⏱ 用时：你 ' + formatClock(me.finalMs) + '，对手 ' + formatClock(second.finalMs) + '（差 ' + formatClock(gap) + '）');
      }
      report.push('✅ 答对：你 ' + me.correct + '/' + TOTAL_VS + '，对手 ' + (second ? second.correct : '?') + '/' + TOTAL_VS);
      var loss = [], winp = [];
      var cnt = Math.min(me.results.length, opp.results.length);
      for (var ri = 0; ri < cnt; ri++) {
        if (!me.results[ri] && opp.results[ri]) loss.push(ri + 1);
        else if (me.results[ri] && !opp.results[ri]) winp.push(ri + 1);
      }
      if (loss.length) report.push('🔻 关键失分：第 ' + loss.join('、') + ' 题你错、对手对');
      if (winp.length) report.push('🔺 关键得分：第 ' + winp.join('、') + ' 题你对、对手错');
      if (me.qms && me.qms.length) {
        var si = 0; for (var a = 1; a < me.qms.length; a++) if (me.qms[a] > me.qms[si]) si = a;
        report.push('🐢 你最卡的一题：第 ' + (si + 1) + ' 题（' + (me.qms[si] / 1000).toFixed(1) + 's）');
        if (opp.qms && opp.qms.length) {
          var oi = 0; for (var b = 1; b < opp.qms.length; b++) if (opp.qms[b] > opp.qms[oi]) oi = b;
          report.push('🐢 对手最卡：第 ' + (oi + 1) + ' 题（' + (opp.qms[oi] / 1000).toFixed(1) + 's）');
        }
      }
    }
    $('vres-report').innerHTML = report.map(function (r) { return '<div class="rpt-line">' + r + '</div>'; }).join('');

    $('vres-reason').textContent = reason;
    $('vres-actual').textContent = formatClock(me.actualMs);
    $('vres-penalty').textContent = '+' + formatClock(me.finalMs - me.actualMs);
    $('vres-final').textContent = formatClock(me.finalMs);
    $('vres-correct').textContent = me.correct + '/' + TOTAL_VS;
    var code = Net.encodeScore({
      room: vsState.room, round: vsState.round, nick: Net.getNick() || '我',
      finalMs: me.finalMs, actualMs: me.actualMs, correct: me.correct, wrong: me.wrong, skip: me.skip
    });
    $('vres-mycode').value = code;
    var review = $('vres-review'); review.innerHTML = '';
    vsState.questions.forEach(function (q, i) { review.appendChild(renderReviewRow(q, i)); });
  }

  function vsAgain() {
    if (vsState.online && vsState.client) {
      if (vsState.host) vsState.client.again();
      vsState.round = (vsState.round || 1) + 1;
      show('vsroom'); renderVsRoom();
    } else {
      vsState.round = (vsState.round || 1) + 1;
      beginVsPlay(Date.now());
    }
  }
  function leaveVs() {
    stopVsTimer();
    if (vsState.client) { try { vsState.client.close(); } catch (e) {} vsState.client = null; }
    vsState.online = false; vsState.started = false; vsState.finished = false;
    show('home');
  }
  function vsTestServer() {
    var base = Net.normalizeServerBase($('vs-server') ? $('vs-server').value : '');
    if (!base) {
      try {
        if (location && location.protocol && !/^file:/i.test(location.protocol)) {
          base = Net.normalizeServerBase(location.origin);
        }
      } catch (e) {}
    }
    var msg = $('vs-server-msg');
    if (!base) { msg.textContent = '请先填写服务器地址。'; return; }
    msg.textContent = '测试中…';
    var ws, timer;
    var finish = function (text) { if (timer) clearTimeout(timer); msg.textContent = text; };
    try { ws = new WebSocket(base + '/ws'); }
    catch (e) { msg.textContent = '❌ 地址无效：' + e.message; return; }
    timer = setTimeout(function () { try { ws.close(); } catch (e) {} finish('❌ 连接超时，未收到服务器响应。'); }, 8000);
    ws.onopen = function () { finish('✅ 服务器在线（24vs）。保存后创建/加入房间即生效。'); try { ws.close(); } catch (e) {} };
    ws.onerror = function () { finish('❌ 无法连接，请确认地址已部署且可访问。'); try { ws.close(); } catch (e) {} };
  }
  function vsCompare() {
    var code = ($('vres-theircode').value || '').trim();
    var d = Net.decodeScore(code);
    var out = $('vres-compare-out');
    if (!d) { out.textContent = '成绩码无效，请检查是否复制完整。'; out.style.color = '#eb5757'; return; }
    var me = vsState.myResult || { finalMs: 0 };
    var myFinal = me.finalMs || 0;
    var iWin = myFinal <= d.finalMs;
    out.style.color = iWin ? 'var(--green)' : '#eb5757';
    out.innerHTML = '对方 ' + escapeHtml(d.nick) + '：最终 ' + formatClock(d.finalMs) + '（对 ' + d.correct + '/' + TOTAL_VS + '）　｜　你：' + formatClock(myFinal) +
      '<br/>' + (iWin ? '🎉 你更快，赢了！' : '你慢了 ' + ((d.finalMs - myFinal) / 1000).toFixed(1) + ' 秒。');
  }

  // ====================================================================
  //  绑定
  // ====================================================================
  function bind() {
    $('btn-challenge').onclick = function () { renderLevels(); show('levels'); };
    $('btn-speed').onclick = function () { show('speedready'); };
    $('levels-back').onclick = function () { show('home'); };
    $('stages-back').onclick = function () { show('home'); };
    $('stages-reshuffle').onclick = function () {
      var lv = chState.level; // 仅在 stages 视图有意义，用当前关卡
      reshuffleLevel(openStagesLevel); saveStore(store); renderLevels(); openStages(openStagesLevel);
    };
    // 闯关
    $('ch-back').onclick = function () { stopChTimer(); openStages(chState.level); };
    $('ch-undo').onclick = function () { boardCh.undo(); };
    $('ch-restart').onclick = function () { boardCh.restart(); setChFeedback('', ''); };
    $('ch-hint').onclick = chHint;
    $('ch-reveal').onclick = chReveal;
    $('ch-op-add').onclick = function () { boardCh.clickOp('+'); };
    $('ch-op-sub').onclick = function () { boardCh.clickOp('−'); };
    $('ch-op-mul').onclick = function () { boardCh.clickOp('×'); };
    $('ch-op-div').onclick = function () { boardCh.clickOp('÷'); };
    $('ch-next').onclick = chNext;
    $('ch-next-level').onclick = function () { if (chState.level < LEVEL_COUNT) openStages(chState.level + 1); };
    $('ch-replay').onclick = function () { openChallenge(chState.level, chState.index); };
    // 竞速准备
    $('sr-start').onclick = function () {
      var cd = $('sr-countdown'); cd.style.display = 'flex'; cd.textContent = '3';
      var n = 3;
      var t = setInterval(function () {
        n--;
        if (n <= 0) { clearInterval(t); cd.style.display = 'none'; startSpeed(); }
        else cd.textContent = String(n);
      }, 1000);
    };
    $('sr-back').onclick = function () { show('home'); };
    // 竞速
    $('sp-skip').onclick = spSkip;
    $('sp-undo').onclick = function () { boardSp.undo(); };
    $('sp-restart').onclick = function () { boardSp.restart(); spFeedback('', ''); };
    $('sp-op-add').onclick = function () { boardSp.clickOp('+'); };
    $('sp-op-sub').onclick = function () { boardSp.clickOp('−'); };
    $('sp-op-mul').onclick = function () { boardSp.clickOp('×'); };
    $('sp-op-div').onclick = function () { boardSp.clickOp('÷'); };
    $('sp-back').onclick = function () { stopSpTimer(); show('home'); };
    // 结算
    $('sr-again').onclick = function () { show('speedready'); };
    $('sr-home').onclick = function () { show('home'); };

    // 联机对战
    $('btn-vs').onclick = openVsLobby;
    $('vs-back').onclick = leaveVs;
    $('vs-create').onclick = createVsRoom;
    $('vs-join').onclick = joinVsRoom;
    $('vr-back').onclick = leaveVs;
    $('vr-start').onclick = vsStart;
    $('vr-copy').onclick = function () { copyText($('vr-link').value); };
    $('vp-back').onclick = leaveVs;
    $('vp-skip').onclick = vsSkip;
    $('vp-undo').onclick = function () { boardVs.undo(); };
    $('vp-restart').onclick = function () { boardVs.restart(); vsFeedback('', ''); };
    $('vp-op-add').onclick = function () { boardVs.clickOp('+'); };
    $('vp-op-sub').onclick = function () { boardVs.clickOp('−'); };
    $('vp-op-mul').onclick = function () { boardVs.clickOp('×'); };
    $('vp-op-div').onclick = function () { boardVs.clickOp('÷'); };
    $('vs-server-save').onclick = function () { Net.setServerUrl($('vs-server').value); $('vs-server-msg').textContent = '已保存。下次创建/加入房间时生效。'; };
    $('vs-server-test').onclick = vsTestServer;
    $('vres-again').onclick = vsAgain;
    $('vres-home').onclick = leaveVs;
    $('vres-copycode').onclick = function () { copyText($('vres-mycode').value); };
    $('vres-compare').onclick = vsCompare;
  }

  // 记录当前处于 stages 视图的关卡，供“换一批题”使用
  var openStagesLevel = 1;
  var _openStages = openStages;
  openStages = function (level) { openStagesLevel = level; _openStages(level); };

  // 供自动化测试访问（浏览器中仅为 window 上的额外属性，无副作用）
  window.__test = {
    makeBoard: makeBoard, parseSolutionSteps: parseSolutionSteps,
    buildHints: buildHints, getSlotQuestions: getSlotQuestions,
    fixedForLevel: fixedForLevel, reshuffleLevel: reshuffleLevel,
    LEVEL_TITLES: LEVEL_TITLES, MATH_NOTE: MATH_NOTE,
    LEVEL_COUNT: LEVEL_COUNT, perLevelCount: perLevelCount, Rational: Rational,
    // 闯关内部句柄（仅测试用）
    ch: {
      state: chState, board: boardCh, openChallenge: openChallenge,
      openStages: openStages, onChWin: onChWin, levelUnlocked: levelUnlocked
    },
    // 联机对战内部句柄（仅测试用）
    vs: {
      state: vsState, board: boardVs, TOTAL: TOTAL_VS,
      openVsLobby: openVsLobby, createVsRoom: createVsRoom, joinVsRoom: joinVsRoom,
      enterVsRoom: enterVsRoom, vsStart: vsStart, beginVsPlay: beginVsPlay,
      startVsBoard: startVsBoard, vsSetQuestion: vsSetQuestion, onVsResolved: onVsResolved,
      vsSkip: vsSkip, vsFinishVs: vsFinishVs, renderVsResult: renderVsResult,
      renderVsRoom: renderVsRoom, vsAgain: vsAgain, leaveVs: leaveVs,
      vsFeedback: vsFeedback
    }
  };

  window.addEventListener('DOMContentLoaded', function () {
    bind();
    show('home');
  });
})();
