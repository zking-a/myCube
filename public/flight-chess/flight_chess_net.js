'use strict';

/*
 * 飞行棋联机客户端。
 *
 * 仅负责连接、标签页级私密重连身份和消息收发，不参与规则判定。身份放在
 * sessionStorage，刷新可续局，同时避免同一浏览器的两个玩家互相顶掉席位。
 * 棋局状态、骰点、合法移动与胜负均由 /flight-chess-ws 服务端下发。
 */
(function exposeFlightChessNet(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FlightChessNet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFlightChessNetApi() {
  const ROOM_RE = /^[A-HJ-NP-Z2-9]{5}$/;
  const SESSION_PREFIX = 'flight_chess_online_session_v1_';
  const FATAL_ERRORS = new Set([
    'ROOM_INVALID', 'ROOM_NOT_FOUND', 'ROOM_EXISTS', 'ROOM_FULL', 'ROUND_IN_PROGRESS',
    'SESSION_INVALID', 'SERVER_FULL', 'IP_ROOM_LIMIT', 'IP_PLAYER_LIMIT', 'CREATE_RATE_LIMIT', 'ROOM_EXPIRED'
  ]);

  function normalizeRoom(value) {
    return String(value || '').toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 5);
  }

  function websocketUrl(locationLike) {
    const source = locationLike || (typeof location !== 'undefined' ? location : { protocol: 'http:', host: 'localhost' });
    return (source.protocol === 'https:' ? 'wss://' : 'ws://') + source.host + '/flight-chess-ws';
  }

  function reconnectDelayForAttempt(attempt, jitterValue) {
    const step = Math.max(1, Number(attempt) || 1);
    const jitter = Number.isFinite(jitterValue) ? jitterValue : Math.random();
    return Math.min(10000, Math.round(500 * Math.pow(1.7, step - 1) + jitter * 300));
  }

  function randomCid(cryptoLike) {
    const bytes = new Uint8Array(16);
    if (cryptoLike && cryptoLike.getRandomValues) cryptoLike.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }

  function safeRead(storage, key) {
    try { return storage && storage.getItem(key); } catch (error) { return null; }
  }

  function safeWrite(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (error) {}
  }

  function safeRemove(storage, key) {
    try { if (storage) storage.removeItem(key); } catch (error) {}
  }

  function loadIdentity(room, storage, cryptoLike) {
    const key = SESSION_PREFIX + room;
    let saved = null;
    try { saved = JSON.parse(safeRead(storage, key) || 'null'); } catch (error) {}
    const cid = saved && typeof saved.cid === 'string' && saved.cid.length >= 16
      ? saved.cid.slice(0, 32) : randomCid(cryptoLike);
    const token = saved && typeof saved.token === 'string' ? saved.token.slice(0, 128) : '';
    const identity = { cid: cid, token: token };
    safeWrite(storage, key, JSON.stringify(identity));
    return identity;
  }

  function createClient(options) {
    const settings = options || {};
    const room = normalizeRoom(settings.room);
    if (!ROOM_RE.test(room)) throw new Error('房间码格式不正确');
    const storage = settings.storage || (typeof sessionStorage !== 'undefined' ? sessionStorage :
      (typeof localStorage !== 'undefined' ? localStorage : null));
    const cryptoLike = settings.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    const WebSocketClass = settings.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WebSocketClass) throw new Error('当前环境不支持 WebSocket');
    const identity = loadIdentity(room, storage, cryptoLike);
    const sessionKey = SESSION_PREFIX + room;
    let socket = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let active = true;
    let terminalStatus = '';
    let intent = settings.intent === 'create' ? 'create' : 'join';

    function notifyStatus(status) {
      if (typeof settings.onStatus === 'function') settings.onStatus(status);
    }

    function send(message) {
      if (!socket || socket.readyState !== WebSocketClass.OPEN) return false;
      try { socket.send(JSON.stringify(message)); return true; } catch (error) { return false; }
    }

    function scheduleReconnect() {
      if (!active || reconnectTimer) return;
      reconnectAttempt += 1;
      const delay = reconnectDelayForAttempt(reconnectAttempt);
      notifyStatus('offline');
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      if (!active || (socket && (socket.readyState === WebSocketClass.OPEN || socket.readyState === WebSocketClass.CONNECTING))) return;
      notifyStatus('connecting');
      socket = new WebSocketClass(settings.url || websocketUrl(settings.location));
      socket.addEventListener('open', function () {
        send({
          t: 'join', room: room, nick: String(settings.nick || '玩家').slice(0, 16),
          cid: identity.cid, token: identity.token, intent: intent,
          capacity: Number(settings.capacity) || 4
        });
      });
      socket.addEventListener('message', function (event) {
        let message;
        try { message = JSON.parse(String(event.data || '')); } catch (error) { return; }
        if (!message || typeof message.t !== 'string') return;
        if (message.t === 'session') {
          identity.cid = String(message.cid || identity.cid).slice(0, 32);
          identity.token = String(message.token || '').slice(0, 128);
          safeWrite(storage, sessionKey, JSON.stringify(identity));
          intent = 'join';
          reconnectAttempt = 0;
          notifyStatus('online');
          if (typeof settings.onSession === 'function') settings.onSession(message);
          return;
        }
        if (message.t === 'state') {
          intent = 'join';
          reconnectAttempt = 0;
          notifyStatus('online');
          if (typeof settings.onState === 'function') settings.onState(message);
          return;
        }
        if (message.t === 'err') {
          if (FATAL_ERRORS.has(message.code)) {
            active = false;
            terminalStatus = 'failed';
            notifyStatus(terminalStatus);
            try { socket.close(1000, 'join rejected'); } catch (error) {}
          }
          if (typeof settings.onError === 'function') settings.onError(message);
          return;
        }
        if (typeof settings.onMessage === 'function') settings.onMessage(message);
      });
      socket.addEventListener('close', function () {
        socket = null;
        if (active) scheduleReconnect();
        else notifyStatus(terminalStatus || 'offline');
      });
      socket.addEventListener('error', function () {});
    }

    function leave() {
      active = false;
      terminalStatus = 'offline';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      send({ t: 'leave' });
      safeRemove(storage, sessionKey);
      const closingSocket = socket;
      setTimeout(function () { if (closingSocket) try { closingSocket.close(1000, 'left room'); } catch (error) {} }, 30);
    }

    function dispose() {
      active = false;
      terminalStatus = terminalStatus || 'offline';
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (socket) try { socket.close(1000, 'page closed'); } catch (error) {}
      socket = null;
    }

    return {
      room: room,
      identity: identity,
      connect: connect,
      send: send,
      leave: leave,
      dispose: dispose,
      isActive: function () { return active; }
    };
  }

  return Object.freeze({
    ROOM_RE: ROOM_RE,
    SESSION_PREFIX: SESSION_PREFIX,
    normalizeRoom: normalizeRoom,
    websocketUrl: websocketUrl,
    reconnectDelayForAttempt: reconnectDelayForAttempt,
    randomCid: randomCid,
    loadIdentity: loadIdentity,
    createClient: createClient
  });
});
