'use strict';
/* net.js —— 24点大挑战·联机对战网络层
 *
 * 设计要点（为什么这样设计）：
 *   1) 【同房间码 = 同一套题】房间码本身就是随机种子，用确定性 PRNG 从
 *      meta.speedLadder（难度递增的题目桶）里抽题。因此双方题目**天然一致**，
 *      公平性不依赖服务器，也不需要服务器下发题目。
 *   2) 【无后端也能比拼】未配置服务器时自动进入「离线房间」：双方用同一房间码
 *      各自作答，结束后生成「成绩码」互发对比，照样能分出胜负。
 *   3) 【有后端就是实时对战】配置了 WebSocket 中转（EdgeOne Pages Node Functions /
 *      任意支持 WebSocket 的 Node 服务，免费）后，可实时看到对手进度条、同步开局、自动排名。
 *
 * 暴露 window.Net。无第三方依赖，file:// 直接可用。
 */
(function () {
  // ==================================================================
  //  1. 确定性随机（同一种子必得同一序列）
  // ==================================================================
  // xmur3：字符串 → 32 位种子
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }
  // mulberry32：32 位种子 → [0,1) 均匀随机
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededRandom(seedStr) {
    return mulberry32(xmur3(String(seedStr))());
  }

  // ==================================================================
  //  2. 房间码
  // ==================================================================
  // 去掉易混字符 I/O/0/1，避免朋友之间口头传错
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var CODE_LEN = 5;

  function randomRoomCode() {
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) {
      s += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return s;
  }
  // 归一化：转大写 + 丢弃字母表外的字符（空格、连字符、误输入的 O/I/0/1 等）。
  // 注意：这里刻意「不做」O→0 之类的模糊纠正——字母表已排除易混字符，
  // 强行映射反而会把用户带进另一个真实存在的房间，宁可让他重新输入。
  function normalizeRoomCode(input) {
    var s = String(input || '').toUpperCase();
    var out = '';
    for (var i = 0; i < s.length && out.length < CODE_LEN; i++) {
      if (ALPHABET.indexOf(s.charAt(i)) >= 0) out += s.charAt(i);
    }
    return out;
  }
  function isValidRoomCode(s) {
    return typeof s === 'string' && s.length === CODE_LEN && normalizeRoomCode(s) === s;
  }

  // ==================================================================
  //  3. 同题生成（确定性 + 难度递增）
  // ==================================================================
  // 用 meta.speedLadder（10 个按感知难度升序的题目下标桶）：
  // 第 n 题从第 n 桶里「确定性随机」抽 1 道 ⇒ 难度递增、同房间码必然同题。
  function buildRoomQuestions(seedStr, count, levelsData) {
    var LEVELS = levelsData || window.LEVELS;
    var rnd = seededRandom(seedStr);
    var ladder = (LEVELS.meta && LEVELS.meta.speedLadder) || null;
    var picked = [];
    var usedIdx = {};

    if (ladder && ladder.length) {
      for (var s = 0; s < count; s++) {
        var bi = Math.min(Math.floor((s * ladder.length) / count), ladder.length - 1);
        var bucket = ladder[bi];
        if (!bucket || !bucket.length) continue;
        // 同桶内避免抽到同一题（多轮尝试后放弃，转由兜底补齐）
        var idx = -1;
        for (var tryN = 0; tryN < 12; tryN++) {
          var cand = bucket[Math.floor(rnd() * bucket.length)];
          if (!usedIdx[cand]) { idx = cand; break; }
        }
        if (idx < 0) continue;
        usedIdx[idx] = 1;
        picked.push(LEVELS.levels[idx]);
      }
    }
    // 兜底：题库缺 speedLadder 或桶内取不到时，按确定性顺序补齐
    if (picked.length < count) {
      var total = LEVELS.levels.length;
      var guard = 0;
      while (picked.length < count && guard++ < total * 4) {
        var k = Math.floor(rnd() * total);
        if (usedIdx[k]) continue;
        usedIdx[k] = 1;
        picked.push(LEVELS.levels[k]);
      }
    }
    return picked.slice(0, count).map(function (x) {
      return {
        numbers: x.numbers.slice(),
        answer: x.standardAnswer,
        difficulty: x.difficulty,
        correct: null,
        ms: null
      };
    });
  }
  // 房间某一轮的种子：房间码 + 轮次（"再来一局"换题但双方仍一致）
  function roundSeed(roomCode, round) {
    return String(roomCode) + '#' + String(round || 1);
  }

  // ==================================================================
  //  4. 成绩码（离线模式下互发对比用）
  // ==================================================================
  function b64uEncode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(s) {
    var t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  // 紧凑管道分隔，比 JSON 短一半以上；昵称里的 | 做转义
  function encodeScore(o) {
    var nick = String(o.nick || '玩家').replace(/\|/g, '/');
    var parts = [
      'S1', o.room, o.round || 1, nick,
      o.finalMs, o.actualMs, o.correct, o.wrong, o.skip
    ];
    return b64uEncode(parts.join('|'));
  }
  function decodeScore(code) {
    try {
      var p = b64uDecode(String(code).trim()).split('|');
      if (p[0] !== 'S1' || p.length < 9) return null;
      return {
        room: p[1],
        round: parseInt(p[2], 10) || 1,
        nick: p[3],
        finalMs: parseInt(p[4], 10),
        actualMs: parseInt(p[5], 10),
        correct: parseInt(p[6], 10),
        wrong: parseInt(p[7], 10),
        skip: parseInt(p[8], 10)
      };
    } catch (e) {
      return null;
    }
  }

  // ==================================================================
  //  5. 配置持久化（昵称 / 服务器地址）
  // ==================================================================
  var K_SERVER = 'g24_server_url';
  var K_NICK = 'g24_nick';

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // 把用户输入规范成「服务器基址」：统一 wss://、去掉末尾斜杠、去掉末尾 /ws、/websocket 路径。
  // 前端连接时统一在此基址后拼 /ws，避免用户填了带 /ws 的地址导致 /ws/ws 双拼。
  function normalizeServerBase(u) {
    var s = String(u || '').trim();
    if (/^https:\/\//i.test(s)) s = s.replace(/^https:/i, 'wss:');
    else if (/^http:\/\//i.test(s)) s = s.replace(/^http:/i, 'ws:');
    s = s.replace(/\/(ws|websocket)\/*$/i, '');
    s = s.replace(/\/+$/, '');
    return s;
  }
  function getServerUrl() { return lsGet(K_SERVER); }
  function setServerUrl(u) {
    var s = normalizeServerBase(u);
    lsSet(K_SERVER, s);
    return s;
  }
  function getNick() { return lsGet(K_NICK); }
  function setNick(n) { lsSet(K_NICK, String(n || '').slice(0, 10)); }

  // 网页部署时默认连接当前站点；只有 file:// 才是真正的离线模式。
  // 这条规则必须同时用于大厅状态和实际 open，避免界面说“可联机”但根本没发起连接。
  function resolveServerBase() {
    var saved = normalizeServerBase(getServerUrl());
    if (saved) return saved;
    try {
      if (location && location.protocol && !/^file:/i.test(location.protocol)) {
        return normalizeServerBase(location.origin);
      }
    } catch (e) {}
    return '';
  }
  function canUseOnline() { return !!resolveServerBase(); }

  // 客户端唯一 id（同一浏览器刷新后保持不变，便于断线重连回到原座位）
  var K_CID = 'g24_cid';
  function getCid() {
    var c = lsGet(K_CID);
    if (!c) {
      c = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      lsSet(K_CID, c);
    }
    return c;
  }

  // ==================================================================
  //  6. 邀请链接 / URL 参数
  // ==================================================================
  // 支持 ?r=ABCDE 与 #r=ABCDE 两种（静态托管对 hash 更友好）
  function readInviteCode() {
    try {
      var m = /[?&#]r=([A-Za-z0-9]{1,8})/.exec(location.search + location.hash);
      return m ? normalizeRoomCode(m[1]) : '';
    } catch (e) { return ''; }
  }
  function inviteLink(roomCode) {
    try {
      var base = location.origin + location.pathname;
      if (/^file:/i.test(location.protocol)) return '(本地文件模式，需先部署到网上才能分享链接)';
      return base + '#r=' + roomCode;
    } catch (e) { return ''; }
  }
  function rememberInviteCode(roomCode) {
    try {
      if (/^file:/i.test(location.protocol) || !history || !history.replaceState) return;
      history.replaceState(null, '', location.pathname + location.search + '#r=' + roomCode);
    } catch (e) {}
  }
  function clearInviteCode() {
    try {
      if (/^file:/i.test(location.protocol) || !history || !history.replaceState) return;
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {}
  }

  // ==================================================================
  //  7. WebSocket 房间客户端
  // ==================================================================
  /* 协议（JSON）
   *  客户端 → 服务端：
   *    {t:'join', room, nick, cid, intent:'create'|'join'}
   *    {t:'ready', v:true|false}
   *    {t:'start'}                       // 仅房主有效
   *    {t:'prog', i, ok, ms}             // 第 i 题完成（0 基），ok=是否答对
   *    {t:'done', finalMs, actualMs, correct, wrong, skip, results:[0|1...], qms:[ms...]}
   *         —— results/qms 为「逐题对错 / 逐题耗时」，用于结果页「逐题对决」与战报。
   *    {t:'again'}                       // 房主发起下一局，回到准备大厅
   *    {t:'ping'}
   *  服务端 → 客户端：
   *    {t:'state', round, phase, startedAt, serverNow, host, players:[...]}
   *    {t:'start', round, at}            // at=服务器时间戳，用于同步开局
   *    {t:'pong'}
   *    {t:'err', msg}
   */
  function createClient(handlers) {
    var h = handlers || {};
    var ws = null;
    var closedByUser = false;
    var terminalError = false;
    var retry = 0;
    var retryTimer = null;
    var pingTimer = null;
    var connectTimer = null;
    var socketSeq = 0;
    var clockOffset = 0; // serverNow - localNow
    var clockSamples = 0;
    var state = { connected: false, room: '', nick: '', intent: 'join', mode: 'offline' };

    function log(msg) { if (h.onLog) h.onLog(msg); }

    function setMode(mode) {
      state.mode = mode;
      if (h.onMode) h.onMode(mode);
    }

    function send(obj) {
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(obj)); return true; } catch (e) {}
      }
      return false;
    }

    function clearTimers() {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    }

    function sampleClock(clientSentAt, serverAt) {
      var now = Date.now();
      var sent = Number(clientSentAt);
      var server = Number(serverAt);
      if (!isFinite(sent) || !isFinite(server) || sent <= 0) return;
      var sample = server - ((sent + now) / 2);
      clockOffset = clockSamples ? (clockOffset * 0.7 + sample * 0.3) : sample;
      clockSamples++;
    }

    function toLocalTime(serverAt) {
      var n = Number(serverAt);
      return isFinite(n) && n > 0 ? n - clockOffset : Date.now();
    }

    function ping() { send({ t: 'ping', c: Date.now() }); }

    function scheduleRetry() {
      if (closedByUser || terminalError) return;
      if (retryTimer) return;
      retry++;
      var delay = Math.min(800 * Math.pow(1.7, retry - 1), 10000);
      log('连接断开，' + Math.round(delay / 1000) + ' 秒后重连…');
      retryTimer = setTimeout(function () {
        retryTimer = null;
        open(state.room, state.nick, state.intent);
      }, delay);
    }

    function open(room, nick, intent) {
      var url = resolveServerBase();
      if (!url) {
        state.connected = false;
        setMode('offline');
        return false;
      }
      socketSeq++;
      var mySeq = socketSeq;
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      clearTimers();
      closedByUser = false;
      terminalError = false;
      state.room = room;
      state.nick = nick;
      state.intent = intent === 'create' ? 'create' : 'join';
      state.connected = false;
      setMode(retry ? 'reconnecting' : 'connecting');
      try {
        ws = new WebSocket(url + '/ws');
      } catch (e) {
        log('服务器地址无效：' + e.message);
        setMode('error');
        return false;
      }
      connectTimer = setTimeout(function () {
        if (mySeq !== socketSeq || !ws || ws.readyState === 1) return;
        try { ws.close(); } catch (e) {}
      }, 10000);
      ws.onopen = function () {
        if (mySeq !== socketSeq) return;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        send({ t: 'join', room: room, nick: nick, cid: getCid(), intent: state.intent });
        ping();
        pingTimer = setInterval(ping, 20000);
      };
      ws.onmessage = function (ev) {
        if (mySeq !== socketSeq) return;
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'pong') {
          sampleClock(m.c, m.s);
        } else if (m.t === 'state') {
          if (!clockSamples && Number(m.serverNow)) clockOffset = Number(m.serverNow) - Date.now();
          retry = 0;
          state.connected = true;
          // 建房只用于首包；一旦拿到房间状态，后续掉线都应按“重返原房间”处理。
          state.intent = 'join';
          setMode('online');
          m.startedAtLocal = m.startedAt ? toLocalTime(m.startedAt) : null;
          if (h.onState) h.onState(m);
        } else if (m.t === 'start') {
          m.localAt = toLocalTime(m.at);
          if (h.onStart) h.onStart(m);
        } else if (m.t === 'err') {
          log(m.msg || '服务器错误');
          if (h.onError) h.onError(m);
          if (/^(ROOM_NOT_FOUND|ROOM_EXISTS|ROOM_FULL|ROOM_EXPIRED|ROUND_IN_PROGRESS|ROUND_FINISHED|DUPLICATE_ID|SERVER_FULL|CREATE_RATE_LIMIT)$/.test(m.code || '')) {
            terminalError = true;
            closedByUser = true;
            setMode('error');
            try { ws.close(1000, 'terminal error'); } catch (e) {}
          }
        }
      };
      ws.onclose = function () {
        if (mySeq !== socketSeq) return;
        clearTimers();
        state.connected = false;
        if (!terminalError) setMode(closedByUser ? 'offline' : 'reconnecting');
        scheduleRetry();
      };
      ws.onerror = function () { /* onclose 会紧随其后，统一在那里处理 */ };
      return true;
    }

    function close(leaveRoom) {
      closedByUser = true;
      terminalError = false;
      socketSeq++;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      clearTimers();
      if (leaveRoom) send({ t: 'leave' });
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      state.connected = false;
      setMode('offline');
    }

    return {
      state: state,
      open: open,
      close: close,
      send: send,
      isOnline: function () { return state.connected; },
      toLocalTime: toLocalTime,
      ready: function (v) { return send({ t: 'ready', v: !!v }); },
      start: function () { return send({ t: 'start' }); },
      progress: function (i, ok, ms, elapsedMs, stats) {
        stats = stats || {};
        return send({
          t: 'prog', i: i, ok: !!ok, ms: ms, elapsedMs: elapsedMs,
          correct: stats.correct, wrong: stats.wrong, skip: stats.skip
        });
      },
      done: function (r) {
        return send({
          t: 'done', finalMs: r.finalMs, actualMs: r.actualMs,
          correct: r.correct, wrong: r.wrong, skip: r.skip,
          results: r.results, qms: r.qms
        });
      },
      again: function () { return send({ t: 'again' }); },
      reconnect: function () { return open(state.room, state.nick, state.intent); }
    };
  }

  // ==================================================================
  //  导出
  // ==================================================================
  window.Net = {
    // 随机与种子
    seededRandom: seededRandom,
    // 房间码
    randomRoomCode: randomRoomCode,
    normalizeRoomCode: normalizeRoomCode,
    isValidRoomCode: isValidRoomCode,
    CODE_LEN: CODE_LEN,
    // 同题
    buildRoomQuestions: buildRoomQuestions,
    roundSeed: roundSeed,
    // 成绩码
    encodeScore: encodeScore,
    decodeScore: decodeScore,
    // 配置
    normalizeServerBase: normalizeServerBase,
    getServerUrl: getServerUrl,
    setServerUrl: setServerUrl,
    resolveServerBase: resolveServerBase,
    canUseOnline: canUseOnline,
    getNick: getNick,
    setNick: setNick,
    getCid: getCid,
    // 邀请
    readInviteCode: readInviteCode,
    inviteLink: inviteLink,
    rememberInviteCode: rememberInviteCode,
    clearInviteCode: clearInviteCode,
    // 客户端
    createClient: createClient
  };
})();
