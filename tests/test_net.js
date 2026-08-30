'use strict';
// 网络层回归：确保部署后的“留空即同域联机”、建/加房意图、时钟换算和主动离房不会退化。
const fs = require('fs');
const vm = require('vm');

const storage = new Map();
const sockets = [];
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  open() { this.readyState = 1; if (this.onopen) this.onopen(); }
  message(value) { if (this.onmessage) this.onmessage({ data: JSON.stringify(value) }); }
}

const sandbox = {
  console, Math, Date, JSON, parseInt, isFinite, Number, String, Array, Object, RegExp, Error,
  TextEncoder, TextDecoder,
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  setTimeout, clearTimeout, setInterval, clearInterval,
  WebSocket: FakeWebSocket,
  crypto: { getRandomValues: bytes => { for (let i = 0; i < bytes.length; i++) bytes[i] = i + 1; return bytes; } },
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value))
  },
  location: {
    protocol: 'https:', origin: 'https://game.test', pathname: '/24/', search: '', hash: '#r=ABCDE'
  },
  history: { replaceState() {} }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('public/24/net.js', 'utf8'), sandbox, { filename: 'net.js' });

const Net = sandbox.Net;
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

ok('空配置在 https 页面自动解析为同域 wss', Net.resolveServerBase() === 'wss://game.test');
ok('邀请链接房间码可读取', Net.readInviteCode() === 'ABCDE');

let lastState = null;
const client = Net.createClient({ onState: state => { lastState = state; } });
ok('createClient.open 成功发起连接', client.open('ABCDE', '小明', 'create'));
const socket = sockets[0];
ok('WebSocket 固定连接同域 /ws', socket.url === 'wss://game.test/ws');
socket.open();
ok('首包明确携带 create 意图', socket.sent[0].t === 'join' && socket.sent[0].intent === 'create');
ok('客户端身份使用 128 位随机 cid', socket.sent[0].cid === '0102030405060708090a0b0c0d0e0f10');

const reconnectToken = 'abcdefghijklmnopqrstuvwx12345678';
socket.message({ t: 'session', cid: socket.sent[0].cid, token: reconnectToken });
ok('服务端重连令牌按房间保存且不会自行生成', Net.getRoomToken('ABCDE') === reconnectToken);

const now = Date.now();
socket.message({ t: 'pong', c: now - 20, s: now - 5 });
socket.message({ t: 'state', round: 1, phase: 'playing', startedAt: now + 2000, serverNow: now, players: [] });
ok('收到 state 后连接状态为 online', client.isOnline() && client.state.mode === 'online');
ok('建房成功后重连意图自动切换为 join', client.state.intent === 'join');
ok('服务器开局时间被换算成本地时间', lastState && Math.abs(lastState.startedAtLocal - (now + 2000)) < 100);

client.ready(true);
ok('准备状态走实时协议发送', socket.sent.some(m => m.t === 'ready' && m.v === true));
client.progress(0, 'correct', '1×2×3×4');
ok('逐题进度只发送结果类型与运算证明', socket.sent.some(m => m.t === 'prog' && m.outcome === 'correct' && m.proof === '1×2×3×4' && !('actualMs' in m)));
client.done({ actualMs: 0, correct: 10 });
ok('交卷不再上传客户端自报成绩', socket.sent.some(m => m.t === 'done' && Object.keys(m).length === 1));
client.close(true);
ok('主动离房会发送 leave，避免大厅残留幽灵玩家', socket.sent.some(m => m.t === 'leave'));

console.log('\n✅ 网络层回归全部通过（' + passed + ' 项）');
