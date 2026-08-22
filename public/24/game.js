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
    var isHost = opts.isHost || (opts.hostCid && opts.hostCid === p.cid);
    var medal = p.done ? '🏁' : (opts.showCrown && isHost ? '👑' : '');
    var status;
    if (opts.lobby) {
      if (!p.online) status = '离线';
      else if (isHost) status = '房主';
      else status = p.ready ? '已准备' : '未准备';
    } else {
      status = p.done ? '完成' : ((p.prog || 0) + '/' + total);
    }
    row.innerHTML = '<div class="medal">' + medal + '</div>' +
      '<div class="pn">' + escapeHtml(p.nick || '玩家') + '</div>' +
      '<div class="pbar"><i style="width:' + (Math.round((p.prog || 0) / total * 100)) + '%"></i></div>' +
      '<div class="pv">' + status + '</div>';
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
    if (correct) { state.correct++; setFeedback(opts.fbEl, 'success', '答对了！'); }
    else { state.wrong++; setFeedback(opts.fbEl, 'bad', '答错！+5 秒罚时'); }
    if (opts.onTrack) opts.onTrack(correct); // 计数更新后再上报，断线恢复拿到的是完整状态
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
  function toSafeMs(v) {
    var n = Number(v);
    return (typeof n === 'number' && isFinite(n) && n > -1) ? Math.round(n) : 0;
  }
  function countCorrectFromResults(results) {
    if (!results || !results.length) return 0;
    var c = 0;
    for (var i = 0; i < results.length; i++) if (results[i]) c++;
    return c;
  }
  function getCorrect(p) {
    if (!p) return 0;
    if (p.results && p.results.length) return countCorrectFromResults(p.results);
    var c = parseInt(p.correct, 10);
    return isFinite(c) && c > -1 ? c : 0;
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
          self.tokens.push({ id: self.nextId++, value: new Rational(n), label: String(n), expr: String(n), kind: 'orig', alive: true, win: false, bad: false });
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
          var res = { id: resId, value: r, label: r.toString(), expr: '(' + a.expr + this.op + b.expr + ')', kind: 'res', alive: true, win: false, bad: false, fresh: true };
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
        var alive = this.aliveTokens();
        c.classList.toggle('board-four', alive.length === 4);
        alive.forEach(function (t) {
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
    room: '', round: 1, phase: 'lobby', online: false, connection: 'idle',
    host: false, hostCid: '', myCid: '', intent: 'join', lastError: null,
    questions: [], current: 0,
    elapsedMs: 0, timer: null, wrong: 0, skip: 0, correct: 0,
    finished: false, started: false, myResult: null, client: null, players: [],
    playRound: 0, startingRound: 0, countdownTimer: null, startedAtLocal: 0
  };
  var boardVs = makeBoard({
    containerId: 'vp-board', statusId: 'vp-status',
    onFlash: function (msg) { vsFeedback('error', msg); },
    onStatus: function (txt) { $('vp-status').textContent = txt; },
    onWin: function (tok) { onVsResolved(true, tok); },
    onStuck: function (tok) { onVsResolved(false, tok); }
  });

  function vsFeedback(type, text) { setFeedback('vp-feedback', type, text); }
  function vsSetNetBadge(elId, mode) {
    var el = $(elId); if (!el) return;
    if (mode === 'online') { el.className = 'net-badge net-on'; el.textContent = '已联机'; }
    else if (mode === 'reconnecting') { el.className = 'net-badge net-wait'; el.textContent = '重连中…'; }
    else if (mode === 'connecting') { el.className = 'net-badge net-wait'; el.textContent = '连接中…'; }
    else if (mode === 'error') { el.className = 'net-badge net-off'; el.textContent = '连接失败'; }
    else { el.className = 'net-badge net-off'; el.textContent = '离线练习'; }
  }

  function setVsJoinConfig(open) {
    var config = $('vs-join-config');
    var trigger = $('vs-open-join');
    if (!config || !trigger) return;
    config.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // ---- 大厅 ----
  function openVsLobby() {
    var nick = Net.getNick(); if (nick) $('vs-nick').value = nick;
    var invite = Net.readInviteCode();
    if (invite) {
      $('vs-code').value = invite;
      $('vs-join').textContent = '加入房间 ' + invite;
      setVsJoinConfig(true);
    } else {
      $('vs-join').textContent = '加入房间 →';
      setVsJoinConfig(false);
    }
    var srv = Net.getServerUrl(); if (srv) $('vs-server').value = srv;
    if (Net.canUseOnline()) {
      $('vs-netstate').className = 'net-badge net-wait';
      $('vs-netstate').textContent = srv ? '自定义服务器' : '本站自动联机';
    } else {
      $('vs-netstate').className = 'net-badge net-off';
      $('vs-netstate').textContent = '本地文件';
    }
    show('vs');
  }
  function createVsRoom() {
    var nick = ($('vs-nick').value || '').trim() || '玩家'; Net.setNick(nick);
    var code = Net.randomRoomCode();
    enterVsRoom(code, 'create');
  }
  function joinVsRoom() {
    var nick = ($('vs-nick').value || '').trim() || '玩家'; Net.setNick(nick);
    var code = Net.normalizeRoomCode($('vs-code').value);
    if (!Net.isValidRoomCode(code)) {
      alert('房间码不正确，请检查（5 位字母数字，不含 I / O / 0 / 1）');
      return;
    }
    enterVsRoom(code, 'join');
  }
  function enterVsRoom(code, intent) {
    if (vsState.client) { try { vsState.client.close(false); } catch (e) {} }
    vsState.room = code;
    vsState.round = 1;
    vsState.phase = 'lobby';
    vsState.intent = intent === 'create' ? 'create' : 'join';
    vsState.myCid = Net.getCid();
    vsState.players = [];
    vsState.connection = Net.canUseOnline() ? 'connecting' : 'offline';
    vsState.lastError = null;
    vsState.finished = false; vsState.started = false; vsState.myResult = null;
    vsState.playRound = 0; vsState.startingRound = 0;
    Net.rememberInviteCode(code);
    $('vr-code').textContent = code;
    $('vr-link').value = Net.inviteLink(code);
    $('vp-room').textContent = code;
    if ($('vr-error')) { $('vr-error').textContent = ''; $('vr-error').style.display = 'none'; }
    show('vsroom');
    if (Net.canUseOnline()) {
      setupVsClient();
      vsState.client.open(code, Net.getNick(), vsState.intent);
    } else {
      vsState.online = false; vsState.client = null; vsState.host = false;
      renderVsRoom();
    }
  }

  function getVsMe() {
    for (var i = 0; i < vsState.players.length; i++) {
      if (vsState.players[i].cid === vsState.myCid) return vsState.players[i];
    }
    return null;
  }

  function setupVsClient() {
    vsState.client = Net.createClient({
      onMode: function (mode) {
        vsState.connection = mode;
        vsState.online = (mode === 'online');
        vsSetNetBadge('vr-netstate', mode);
        vsSetNetBadge('vres-netstate', mode);
        if (mode === 'online') $('vr-share-tip').textContent = '已连接。分享邀请后，等朋友准备好即可同时开局。';
        else if (mode === 'connecting' || mode === 'reconnecting') $('vr-share-tip').textContent = '正在连接服务器；首次唤醒免费服务器可能需要几秒。';
        else if (mode === 'error') $('vr-share-tip').textContent = '连接没有成功，请按下方提示检查后重试。';
        else $('vr-share-tip').textContent = '本地文件模式：可各自作答，再用成绩码对比。';
        renderVsRoom();
      },
      onState: function (m) {
        var previousRound = vsState.round;
        vsState.players = m.players || [];
        vsState.round = m.round || vsState.round;
        vsState.phase = m.phase || vsState.phase;
        vsState.hostCid = m.host || '';
        vsState.host = (m.host === vsState.myCid);
        vsState.lastError = null;
        if ($('vr-error')) { $('vr-error').textContent = ''; $('vr-error').style.display = 'none'; }

        if (vsState.phase === 'lobby' && previousRound !== vsState.round) {
          stopVsTimer();
          cancelVsCountdown();
          vsState.started = false; vsState.finished = false; vsState.myResult = null;
          vsState.playRound = 0; vsState.startingRound = 0;
          show('vsroom');
        } else if (vsState.phase === 'playing') {
          var activeMe = getVsMe();
          if (activeMe && activeMe.done) restoreVsResult(activeMe);
          else beginVsPlay(m.startedAtLocal || Date.now(), activeMe);
        } else if (vsState.phase === 'done') {
          var me = getVsMe();
          if (me && me.done) restoreVsResult(me);
          else if (me && !me.done) {
            stopVsTimer(); cancelVsCountdown();
            vsState.started = false; vsState.finished = false;
            vsState.lastError = '你错过了本局结算，请等待房主发起下一局。';
            if ($('vr-error')) { $('vr-error').textContent = vsState.lastError; $('vr-error').style.display = 'block'; }
            show('vsroom');
          }
        }
        renderVsRoom(); renderVsPlay(); renderVsResult();
      },
      onStart: function (m) {
        vsState.round = m.round || vsState.round;
        vsState.phase = 'playing';
        // start 通知通常晚于 state 几毫秒，此时已拿到更准确的时钟采样，刷新倒计时截止点。
        if (vsState.startingRound === vsState.round && !vsState.started) {
          vsState.startingRound = 0;
          cancelVsCountdown();
        }
        beginVsPlay(m.localAt || Date.now(), getVsMe());
      },
      onError: function (m) {
        if (m.code === 'ROOM_EXISTS' && vsState.intent === 'create') {
          enterVsRoom(Net.randomRoomCode(), 'create');
          return;
        }
        vsState.lastError = m.msg || '服务器暂时无法处理请求';
        if ($('vr-error')) {
          $('vr-error').textContent = vsState.lastError;
          $('vr-error').style.display = 'block';
        }
        if (/^(CLIENT_OUTDATED|INVALID_PROOF|SESSION_INVALID)$/.test(m.code || '')) {
          stopVsTimer(); cancelVsCountdown();
          vsState.started = false;
          show('vsroom');
        }
        renderVsRoom();
      }
    });
  }

  function vsStart() {
    if (vsState.online && vsState.client) {
      if (vsState.host) {
        if (vsState.phase === 'done') vsState.client.again();
        else vsState.client.start();
      }
      else {
        var me = getVsMe();
        vsState.client.ready(!(me && me.ready));
      }
    } else if (vsState.connection === 'error' && vsState.client) {
      vsState.lastError = null;
      vsState.client.reconnect();
    } else if (vsState.connection === 'offline') {
      beginVsPlay(Date.now());
    }
  }

  // ---- 开局（带同步倒计时）----
  function cancelVsCountdown() {
    if (vsState.countdownTimer) { clearInterval(vsState.countdownTimer); vsState.countdownTimer = null; }
    var cd = $('sr-countdown'); if (cd) cd.style.display = 'none';
  }

  function beginVsPlay(atMs, resumePlayer) {
    if ((vsState.playRound === vsState.round && (vsState.started || vsState.finished)) ||
        vsState.startingRound === vsState.round) return;
    vsState.startingRound = vsState.round;
    atMs = Number(atMs) || Date.now();
    vsState.startedAtLocal = atMs;
    cancelVsCountdown();
    var cd = $('sr-countdown');
    function tick() {
      var left = atMs - Date.now();
      if (left <= 50) {
        cancelVsCountdown();
        startVsBoard(resumePlayer, atMs);
        return;
      }
      cd.style.display = 'flex';
      cd.innerHTML = '<span>' + Math.max(1, Math.ceil(left / 1000)) + '</span>';
    }
    if (atMs - Date.now() > 100) {
      tick();
      vsState.countdownTimer = setInterval(tick, 100);
    } else {
      startVsBoard(resumePlayer, atMs);
    }
  }

  function startVsBoard(resumePlayer, atMs) {
    if (vsState.playRound === vsState.round && vsState.started) return;
    vsState.questions = Net.buildRoomQuestions(Net.roundSeed(vsState.room, vsState.round), TOTAL_VS, LEVELS);
    var resumeAt = resumePlayer && resumePlayer.participant ? Math.max(0, Math.min(TOTAL_VS, resumePlayer.prog || 0)) : 0;
    var priorResults = resumePlayer && resumePlayer.results || [];
    var priorQms = resumePlayer && resumePlayer.qms || [];
    for (var i = 0; i < resumeAt; i++) {
      vsState.questions[i].correct = !!priorResults[i];
      vsState.questions[i].ms = Math.max(0, Number(priorQms[i]) || 0);
    }
    vsState.current = resumeAt;
    vsState.correct = resumePlayer ? (resumePlayer.correct || 0) : 0;
    vsState.wrong = resumePlayer ? (resumePlayer.wrong || 0) : 0;
    vsState.skip = resumePlayer ? (resumePlayer.skip || 0) : 0;
    vsState.finished = false; vsState.started = true; vsState.myResult = null;
    vsState.playRound = vsState.round; vsState.startingRound = 0;
    vsState.startedAtLocal = Number(atMs) || Date.now();
    vsState.elapsedMs = Math.max(0, Date.now() - vsState.startedAtLocal);
    vsState._qStart = resumePlayer ? (resumePlayer.lastProgressMs || vsState.elapsedMs) : 0;
    if (resumeAt >= TOTAL_VS) {
      if (resumePlayer && resumePlayer.done) restoreVsResult(resumePlayer);
      else vsFinishVs(); // 最后一题进度已到服务器、done 包尚未送达时也能安全续交卷
      return;
    }
    vsSetQuestion(resumeAt);
    // 恢复时从服务器记录的上一题完成时刻继续累计当前题耗时。
    vsState._qStart = resumePlayer ? (resumePlayer.lastProgressMs || vsState.elapsedMs) : vsState.elapsedMs;
    show('vsplay');
    startVsTimer();
  }

  function restoreVsResult(player) {
    stopVsTimer();
    if (!vsState.questions.length || vsState.playRound !== vsState.round) {
      vsState.questions = Net.buildRoomQuestions(Net.roundSeed(vsState.room, vsState.round), TOTAL_VS, LEVELS);
    }
    var results = player.results || [];
    var qms = player.qms || [];
    vsState.questions.forEach(function (q, i) {
      q.correct = !!results[i];
      q.ms = Math.max(0, Number(qms[i]) || 0);
    });
    vsState.elapsedMs = player.actualMs || player.lastProgressMs || 0;
    vsState.correct = player.correct || 0;
    vsState.wrong = player.wrong || 0;
    vsState.skip = player.skip || 0;
    vsState.current = TOTAL_VS;
    vsState.started = false; vsState.finished = true;
    vsState.playRound = vsState.round; vsState.startingRound = 0;
    vsState.myResult = {
      finalMs: player.finalMs || vsState.elapsedMs,
      actualMs: player.actualMs || vsState.elapsedMs,
      correct: vsState.correct, wrong: vsState.wrong, skip: vsState.skip,
      results: results.slice(), qms: qms.slice()
    };
    show('vsresult');
    renderVsResult();
  }
  function vsSetQuestion(i) {
    var q = vsState.questions[i];
    boardVs.init(q.numbers);
    $('vp-index').textContent = (i + 1);
    $('vp-total').textContent = TOTAL_VS;
    vsState._qStart = vsState.elapsedMs; // 本题开始计时
    vsFeedback('', '');
  }
  function onVsResolved(correct, token) {
    var currentQuestion = vsState.questions[vsState.current];
    currentQuestion.proof = token && token.expr ? token.expr : '';
    resolve(vsState, correct, {
      total: TOTAL_VS, fbEl: 'vp-feedback',
      setQuestion: vsSetQuestion, finish: vsFinishVs,
      onTrack: function (c) {
        var q = vsState.questions[vsState.current];
        q.ms = vsState.elapsedMs - vsState._qStart; // 本题耗时
        if (vsState.online && vsState.client) {
          vsState.client.progress(vsState.current, c ? 'correct' : 'wrong', q.proof);
        }
      }
    });
  }
  function vsSkip() {
    if (vsState.finished || !vsState.started) return;
    if (boardVs.locked) return;
    vsState.questions[vsState.current].correct = false;
    vsState.questions[vsState.current].ms = vsState.elapsedMs - vsState._qStart; // 本题耗时
    vsState.skip++;
    vsFeedback('bad', '已跳过 +15 秒罚时');
    boardVs.locked = true;
    if (vsState.online && vsState.client) {
      vsState.client.progress(vsState.current, 'skip', '');
    }
    setTimeout(function () {
      var next = vsState.current + 1;
      if (next < TOTAL_VS) { vsState.current = next; vsSetQuestion(next); }
      else vsFinishVs();
    }, 500);
  }
  function startVsTimer() {
    stopVsTimer();
    function updateTimer() {
      vsState.elapsedMs = Math.max(0, Date.now() - vsState.startedAtLocal);
      $('vp-timer').textContent = formatClock(vsState.elapsedMs);
    }
    updateTimer();
    vsState.timer = setInterval(updateTimer, 100);
  }
  function stopVsTimer() { if (vsState.timer) { clearInterval(vsState.timer); vsState.timer = null; } }

  function vsFinishVs() {
    if (vsState.startedAtLocal) vsState.elapsedMs = Math.max(0, Date.now() - vsState.startedAtLocal);
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
      vsState.client.done();
    }
    setTimeout(function () { show('vsresult'); renderVsResult(); }, vsState.online ? 180 : 0);
  }

  // ---- 渲染：房间 ----
  function renderVsRoom() {
    var onlineCount = vsState.players.filter(function (p) { return p.online; }).length;
    $('vr-count').textContent = vsState.players.length ? (onlineCount + ' 在线') : '1';
    $('vr-round').textContent = vsState.round;
    var list = $('vr-players'); list.innerHTML = '';
    var players = vsState.players.length ? vsState.players
      : [{ cid: vsState.myCid, nick: Net.getNick() || '我', ready: false, online: true, prog: 0, done: false }];
    players.forEach(function (p) {
      list.appendChild(renderPlayerRow(p, {
        isMe: p.cid === vsState.myCid, showCrown: true, lobby: true,
        isHost: p.cid === (vsState.hostCid || (vsState.host ? vsState.myCid : ''))
      }));
    });
    var startBtn = $('vr-start');
    startBtn.style.opacity = '1';
    if (vsState.connection === 'connecting' || vsState.connection === 'reconnecting') {
      startBtn.textContent = vsState.connection === 'reconnecting' ? '正在重连…' : '正在连接房间…';
      startBtn.disabled = true; startBtn.style.opacity = '0.6';
      $('vr-role').textContent = '连接成功后会自动恢复房间和对局进度。';
    } else if (vsState.connection === 'error') {
      startBtn.textContent = '↻ 重新连接';
      startBtn.disabled = false;
      $('vr-role').textContent = vsState.lastError || '连接失败，请重试。';
    } else if (vsState.online) {
      var me = getVsMe();
      if (vsState.phase === 'done') {
        startBtn.textContent = vsState.host ? '🔁 发起下一局' : '等待房主发起下一局…';
        startBtn.disabled = !vsState.host;
        if (startBtn.disabled) startBtn.style.opacity = '0.6';
        $('vr-role').textContent = '本局已经结束，下一局会重新准备再开场。';
      } else if (vsState.host) {
        var waiting = players.filter(function (p) { return p.online && p.cid !== vsState.myCid && !p.ready; });
        var canStart = onlineCount >= 2 && waiting.length === 0 && vsState.phase === 'lobby';
        startBtn.textContent = onlineCount < 2 ? '等待朋友加入…' : (waiting.length ? ('等待 ' + waiting.length + ' 人准备…') : '▶ 同步开始对战');
        startBtn.disabled = !canStart;
        if (!canStart) startBtn.style.opacity = '0.6';
        $('vr-role').textContent = onlineCount < 2 ? '你是房主。先把邀请发给朋友。' : (waiting.length ? '朋友点“我准备好了”后，你就能开局。' : '全员已准备，所有人会同时倒计时开局。');
      } else {
        startBtn.textContent = me && me.ready ? '✓ 已准备（点击取消）' : '✓ 我准备好了';
        startBtn.disabled = vsState.phase !== 'lobby';
        if (startBtn.disabled) startBtn.style.opacity = '0.6';
        $('vr-role').textContent = me && me.ready ? '已通知房主，等房主同步开局。' : '准备好后点一下，避免朋友还没进来就开局。';
      }
    } else {
      startBtn.textContent = '▶ 开始练习（稍后用成绩码对比）'; startBtn.disabled = false; startBtn.style.opacity = '1';
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
    var meCorrect = getCorrect(me);
    var meActual = toSafeMs(me.actualMs);
    var meFinal = toSafeMs(me.finalMs);
    var mePenalty = Math.max(0, meFinal - meActual);
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
    // 由服务器统一结束本局：掉线玩家有 30 秒重连窗口，避免一闪断就被判负。
    var winnerReady = !vsState.online || vsState.phase === 'done';
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
    var waiting = players.filter(function (p) { return p.participant !== false && p.online && !p.done; });
    var reconnecting = players.filter(function (p) { return p.participant && !p.online && !p.done; });
    $('vres-waiting').textContent = vsState.online
      ? (winnerReady ? '本局已结算' : (waiting.length ? ('等待 ' + waiting.length + ' 位玩家完成…') : (reconnecting.length ? '对手掉线，等待重连（最多 30 秒）…' : '等待服务器结算…')))
      : '';

    // ---- 胜负归因：最终差 = 基础用时差 + 罚时差 ----
    var reason = '';
    var second = null;
    if (winnerReady && winner) {
      players.forEach(function (p) {
        if (p.done && p !== winner) { if (second === null || p.finalMs < second.finalMs) second = p; }
      });
      if (second) {
        var gap = second.finalMs - winner.finalMs;
        var cd = winner.correct - second.correct;
        var correctDiff = cd > 0 ? ('（多答对 ' + cd + ' 题）') : (cd < 0 ? ('（少答对 ' + Math.abs(cd) + ' 题，但总成绩更快）') : '');
        if (winner.cid === vsState.myCid) {
          reason = '你领先 ' + formatClock(gap) + correctDiff + ' 拿下本局！';
        } else if (second.cid === vsState.myCid) {
          reason = '你以 ' + formatClock(gap) + ' 之差惜败' + correctDiff + '。';
        } else {
          reason = escapeHtml(winner.nick || '玩家') + ' 领先 ' + formatClock(gap) + ' 获胜' + correctDiff + '。';
        }
      } else {
        reason = winner.cid === vsState.myCid ? '全场你最快完成，本局你赢！' : (escapeHtml(winner.nick || '玩家') + ' 第一个完成，本局他赢。');
      }
    } else if (!winnerReady && vsState.finished) {
      reason = '你已交卷，等对手也完成就能见分晓。';
    }
    var opp = null;
    players.forEach(function (p) {
      if (p.cid === vsState.myCid) return;
      if (!opp || (p.done && !opp.done) || (p.done && opp.done && Math.abs(toSafeMs(p.finalMs) - meFinal) < Math.abs(toSafeMs(opp.finalMs) - meFinal))) opp = p;
    });
    var comparisonReady = !!(winnerReady && opp && opp.done);
    var compareMain = $('vres-compare-main');
    var compareBadge = $('vres-compare-badge');
    var oppActual = comparisonReady ? toSafeMs(opp.actualMs) : 0;
    var oppFinal = comparisonReady ? toSafeMs(opp.finalMs) : 0;
    var oppPenalty = Math.max(0, oppFinal - oppActual);
    var oppCorrect = comparisonReady ? getCorrect(opp) : 0;
    var speedDelta = oppActual - meActual;
    var penaltyDelta = oppPenalty - mePenalty;
    var finalDelta = oppFinal - meFinal;
    function gapText(ms) {
      var raw = Number(ms);
      var n = isFinite(raw) ? Math.max(0, Math.round(Math.abs(raw))) : 0;
      return n < 60000 ? (n / 1000).toFixed(1) + ' 秒' : formatClock(n);
    }
    function attrRow(label, delta, maxAbs, total) {
      var side = delta > 0 ? 'me' : (delta < 0 ? 'opp' : 'tie');
      var width = delta === 0 ? 0 : Math.max(3, Math.min(48, Math.abs(delta) / maxAbs * 48));
      var desc = delta > 0 ? ('为你赢得 ' + gapText(delta)) : (delta < 0 ? ('让你落后 ' + gapText(delta)) : '双方持平');
      return '<div class="attr-row' + (total ? ' total' : '') + '">' +
        '<div class="attr-row-head"><span>' + label + '</span><b class="' + side + '">' + desc + '</b></div>' +
        '<div class="attr-track">' + (side === 'tie' ? '' : '<i class="attr-fill ' + side + '" style="width:' + width.toFixed(1) + '%"></i>') + '</div></div>';
    }
    function metricCard(label, mine, his, higherWins) {
      var mineLead = higherWins ? mine > his : mine < his;
      var hisLead = higherWins ? his > mine : his < mine;
      return '<div class="metric-card"><span class="metric-name">' + label + '</span><div class="metric-values">' +
        '<b' + (mineLead ? ' class="lead"' : '') + '>' + mine + '</b><span>我 : 对手</span><b' + (hisLead ? ' class="lead"' : '') + '>' + his + '</b></div></div>';
    }
    if (comparisonReady) {
      var maxAbs = Math.max(1000, Math.abs(speedDelta), Math.abs(penaltyDelta), Math.abs(finalDelta));
      var badgeClass = finalDelta > 0 ? 'me' : (finalDelta < 0 ? 'opp' : 'tie');
      compareBadge.className = 'compare-badge ' + badgeClass;
      compareBadge.textContent = finalDelta > 0 ? '你占优' : (finalDelta < 0 ? '对手占优' : '势均力敌');
      compareMain.className = '';
      compareMain.innerHTML =
        '<div class="compare-score"><div class="compare-player"><span>我</span><b>' + formatClock(meFinal) + '</b></div>' +
        '<div class="compare-vs">VS</div><div class="compare-player"><span>' + escapeHtml(opp.nick || '对手') + '</span><b>' + formatClock(oppFinal) + '</b></div></div>' +
        '<div class="attr-chart"><div class="attr-axis"><span>← 对手优势</span><span>我的优势 →</span></div>' +
        attrRow('基础用时影响', speedDelta, maxAbs, false) + attrRow('罚时影响', penaltyDelta, maxAbs, false) + attrRow('最终成绩差', finalDelta, maxAbs, true) + '</div>' +
        '<div class="battle-metrics">' + metricCard('答对', meCorrect, oppCorrect, true) + metricCard('答错', me.wrong || 0, opp.wrong || 0, false) + metricCard('跳过', me.skip || 0, opp.skip || 0, false) + '</div>';
      var dominant = Math.abs(speedDelta) >= Math.abs(penaltyDelta) ? '基础用时' : '罚时控制';
      $('vres-reason').innerHTML = '<div class="reason-card">' + (finalDelta === 0 ? '双方最终成绩完全相同。' : ('你最终' + (finalDelta > 0 ? '快 ' : '慢 ') + gapText(finalDelta) + '，影响最大的是' + dominant + '。')) + '</div>';
    } else {
      compareBadge.className = 'compare-badge';
      compareBadge.textContent = winnerReady ? '暂无对手成绩' : '等待结算';
      compareMain.className = 'attribution-empty';
      compareMain.textContent = winnerReady ? '当前只有你的成绩，收到对手成绩后才能生成归因图。' : '对手提交成绩后，将自动拆解基础用时与罚时的胜负影响。';
      $('vres-reason').innerHTML = reason ? '<div class="reason-card">' + reason + '</div>' : '';
    }

    // ---- 逐题对决改为紧凑轨迹：保留关键题信息，去掉横向表格 ----
    var duelPanel = $('vres-duelpanel');
    var duel = $('vres-duel');
    if (me.results && me.results.length && opp && opp.results && opp.results.length) {
      duelPanel.style.display = '';
      var n = Math.min(me.results.length, opp.results.length);
      var points = '';
      for (var di = 0; di < n; di++) {
        var mine = me.results[di], his = opp.results[di];
        var dcls = (mine && !his) ? 'me' : (!mine && his) ? 'opp' : (mine && his) ? 'both' : 'none';
        var mark = dcls === 'me' ? '+1' : (dcls === 'opp' ? '-1' : (dcls === 'both' ? '✓✓' : '××'));
        var note = dcls === 'me' ? '你得分' : (dcls === 'opp' ? '对手得分' : (dcls === 'both' ? '都答对' : '都未对'));
        points += '<div class="duel-point ' + dcls + '"><span>第' + (di + 1) + '题</span><b>' + mark + '</b><small>' + note + '</small></div>';
      }
      duel.innerHTML = points;
    } else {
      duelPanel.style.display = 'none';
    }

    // 战术复盘：只保留可行动的信息，避免与归因图重复报数。
    var report = [];
    if (comparisonReady && me.results && opp.results) {
      var loss = [], winp = [];
      var cnt = Math.min(me.results.length, opp.results.length);
      for (var ri = 0; ri < cnt; ri++) {
        if (!me.results[ri] && opp.results[ri]) loss.push(ri + 1);
        else if (me.results[ri] && !opp.results[ri]) winp.push(ri + 1);
      }
      var turnText = loss.length && winp.length ? ('你在第 ' + winp.join('、') + ' 题抢回优势，但第 ' + loss.join('、') + ' 题被对手拉开。') :
        (loss.length ? ('第 ' + loss.join('、') + ' 题是主要失分点。') : (winp.length ? ('第 ' + winp.join('、') + ' 题是你拉开差距的关键。') : '双方逐题结果完全一致，胜负由用时决定。'));
      report.push({ icon: '🎯', title: '关键转折', text: turnText });
      var advice = mePenalty > oppPenalty ? ('本局罚时比对手多 ' + gapText(mePenalty - oppPenalty) + '，优先减少错误和跳过。') :
        (meActual > oppActual ? ('基础用时慢 ' + gapText(meActual - oppActual) + '，下一局重点提升计算与操作速度。') : '速度与罚时控制都不错，继续保持稳定作答。');
      report.push({ icon: '💡', title: '下一局建议', text: advice });
    }
    if (me.qms && me.qms.length) {
      var si = 0; for (var a = 1; a < me.qms.length; a++) if (me.qms[a] > me.qms[si]) si = a;
      report.splice(Math.min(1, report.length), 0, { icon: '⏱', title: '耗时瓶颈', text: '第 ' + (si + 1) + ' 题用时 ' + (toSafeMs(me.qms[si]) / 1000).toFixed(1) + ' 秒，是你本局最需要提速的一题。' });
    }
    $('vres-report').innerHTML = report.length ? report.map(function (r) {
      return '<div class="rpt-card"><span class="rpt-icon">' + r.icon + '</span><div><b>' + r.title + '</b><p>' + r.text + '</p></div></div>';
    }).join('') : '<div class="report-empty">完成对战后，这里会给出关键转折和下一局建议。</div>';

    $('vres-actual').textContent = formatClock(meActual);
    $('vres-penalty').textContent = '+' + formatClock(mePenalty);
    $('vres-final').textContent = formatClock(meFinal);
    $('vres-correct').textContent = meCorrect + '/' + TOTAL_VS;
    // 实时联机由服务器统一结算；成绩码只作为断网/离线模式的兜底，避免玩家误以为还要手动提交一次。
    var codeWrap = $('vres-codewrap');
    if (vsState.online) {
      codeWrap.style.display = 'none';
      $('vres-mycode').value = '';
      $('vres-theircode').value = '';
      $('vres-compare-out').textContent = '';
    } else {
      codeWrap.style.display = '';
      $('vres-mycode').value = Net.encodeScore({
        room: vsState.room, round: vsState.round, nick: Net.getNick() || '我',
        finalMs: meFinal, actualMs: meActual, correct: meCorrect, wrong: me.wrong || 0, skip: me.skip || 0
      });
    }
    var againBtn = $('vres-again');
    if (vsState.online) {
      if (vsState.host) {
        againBtn.textContent = vsState.phase === 'done' ? '🔁 发起下一局' : '等待本局结算…';
        againBtn.disabled = vsState.phase !== 'done';
      } else {
        againBtn.textContent = '等待房主发起下一局…';
        againBtn.disabled = true;
      }
      againBtn.style.opacity = againBtn.disabled ? '0.6' : '1';
    } else {
      againBtn.textContent = '🔁 再来一局（换新题）';
      againBtn.disabled = false; againBtn.style.opacity = '1';
    }
    var review = $('vres-review'); review.innerHTML = '';
    vsState.questions.forEach(function (q, i) { review.appendChild(renderReviewRow(q, i)); });
  }

  function vsAgain() {
    if (vsState.online && vsState.client) {
      if (vsState.host && vsState.phase === 'done') vsState.client.again();
    } else {
      vsState.round = (vsState.round || 1) + 1;
      beginVsPlay(Date.now());
    }
  }
  function leaveVs() {
    if (vsState.started && !vsState.finished && typeof confirm === 'function' && !confirm('正在对战，确定要退出吗？')) return;
    stopVsTimer();
    cancelVsCountdown();
    if (vsState.client) { try { vsState.client.close(true); } catch (e) {} vsState.client = null; }
    Net.clearInviteCode();
    vsState.online = false; vsState.connection = 'idle'; vsState.started = false; vsState.finished = false;
    show('home');
  }

  function shareVsInvite() {
    var link = $('vr-link').value;
    var text = '来和我玩 24 点！房间码 ' + vsState.room;
    if (navigator.share && !/^\(本地文件/.test(link)) {
      navigator.share({ title: '24点好友对战', text: text, url: link }).catch(function () {});
    } else {
      copyText(text + ' ' + link);
      $('vr-copy').textContent = '已复制';
      setTimeout(function () { $('vr-copy').textContent = '分享邀请'; }, 1500);
    }
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
    if (d.room !== vsState.room || d.round !== vsState.round) {
      out.textContent = '这不是当前房间、当前局的成绩码，请确认双方使用相同房间码并完成同一局。';
      out.style.color = '#eb5757';
      return;
    }
    var me = vsState.myResult || { finalMs: 0 };
    var myFinal = me.finalMs || 0;
    var tie = myFinal === d.finalMs;
    var iWin = myFinal < d.finalMs;
    out.style.color = tie ? 'var(--blue)' : (iWin ? 'var(--green)' : '#eb5757');
    out.innerHTML = '对方 ' + escapeHtml(d.nick) + '：最终 ' + formatClock(d.finalMs) + '（对 ' + d.correct + '/' + TOTAL_VS + '）　｜　你：' + formatClock(myFinal) +
      '<br/>' + (tie ? '难分高下，本局平局！' : (iWin ? '🎉 你更快，赢了！' : '你慢了 ' + ((myFinal - d.finalMs) / 1000).toFixed(1) + ' 秒。'));
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
      var cd = $('sr-countdown'); cd.style.display = 'flex'; cd.innerHTML = '<span>3</span>';
      var n = 3;
      var t = setInterval(function () {
        n--;
        if (n <= 0) { clearInterval(t); cd.style.display = 'none'; startSpeed(); }
        else cd.innerHTML = '<span>' + n + '</span>';
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
    $('vs-open-join').onclick = function () {
      var opening = $('vs-join-config').hidden;
      setVsJoinConfig(opening);
      if (opening) $('vs-code').focus();
    };
    $('vs-join').onclick = joinVsRoom;
    $('vs-code').oninput = function () { this.value = Net.normalizeRoomCode(this.value); };
    $('vs-code').onkeydown = function (e) { if (e.key === 'Enter') joinVsRoom(); };
    $('vs-nick').onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      if (!($('vs-join-config').hidden) && Net.isValidRoomCode(Net.normalizeRoomCode($('vs-code').value))) joinVsRoom();
      else { setVsJoinConfig(true); $('vs-code').focus(); }
    };
    $('vr-back').onclick = leaveVs;
    $('vr-start').onclick = vsStart;
    $('vr-copy').onclick = shareVsInvite;
    $('vp-back').onclick = leaveVs;
    $('vp-skip').onclick = vsSkip;
    $('vp-undo').onclick = function () { boardVs.undo(); };
    $('vp-restart').onclick = function () { boardVs.restart(); vsFeedback('', ''); };
    $('vp-op-add').onclick = function () { boardVs.clickOp('+'); };
    $('vp-op-sub').onclick = function () { boardVs.clickOp('−'); };
    $('vp-op-mul').onclick = function () { boardVs.clickOp('×'); };
    $('vp-op-div').onclick = function () { boardVs.clickOp('÷'); };
    $('vs-server-save').onclick = function () {
      var saved = Net.setServerUrl($('vs-server').value);
      $('vs-server-msg').textContent = saved ? '已保存自定义服务器。' : '已恢复自动连接当前站点。';
      openVsLobby();
    };
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
    var invite = Net.readInviteCode();
    if (invite) {
      openVsLobby();
      if (Net.getNick()) enterVsRoom(invite, 'join');
    } else {
      show('home');
    }
  });
})();
