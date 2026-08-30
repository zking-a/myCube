'use strict';

const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const rootDir = path.join(__dirname, '..');

const PORT = 3211;
const BASE = 'ws://127.0.0.1:' + PORT + '/ws';
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function request(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000);
    child.stdout.on('data', data => {
      if (String(data).includes('relay listening')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('server exited: ' + code)); });
  });
}

function closedResult(ws) {
  return new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
}

(async function () {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), TRUST_PROXY_HOPS: '0',
      MAX_CONNECTIONS: '4', MAX_SOCKET_CONNECTIONS: '8',
      MAX_CONNECTIONS_PER_IP: '2', MAX_SOCKET_CONNECTIONS_PER_IP: '4'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const sockets = [];
  try {
    await waitForServer(child);

    const evil = new WebSocket(BASE, { origin: 'https://evil.example' });
    const evilClose = await closedResult(evil);
    ok('跨站 WebSocket Origin 被拒绝', evilClose.code === 1008);

    const closeEvents = [];
    for (let i = 1; i <= 5; i++) {
      const ws = new WebSocket(BASE, {
        origin: 'http://127.0.0.1:' + PORT,
        headers: { 'cf-connecting-ip': '198.51.100.' + i }
      });
      sockets.push(ws);
      ws.on('close', (code, reason) => closeEvents.push({ i, code, reason: reason.toString() }));
    }
    await wait(600);
    ok('伪造 CF IP 头不能绕过单 IP Socket 限制',
      sockets.slice(0, 4).every(ws => ws.readyState === WebSocket.OPEN) &&
      closeEvents.some(e => e.i === 5 && e.code === 1013 && /from this ip/.test(e.reason)));
    ok('4 个玩家席位之外仍保留额外握手/重连 Socket 容量', sockets.slice(0, 4).every(ws => ws.readyState === WebSocket.OPEN));

    const gzip = await request('/24/data.js', { 'Accept-Encoding': 'gzip' });
    const cached = await request('/24/data.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': gzip.headers.etag });
    const plain = await request('/24/data.js');
    ok('gzip 表示使用独立 ETag 并可直接命中 304 缓存',
      gzip.status === 200 && gzip.headers['content-encoding'] === 'gzip' && cached.status === 304 && plain.headers.etag !== gzip.headers.etag);

    console.log('\n✅ 安全与缓存回归全部通过（' + passed + ' 项）');
  } finally {
    sockets.forEach(ws => { try { ws.terminate(); } catch (e) {} });
    child.kill();
  }
})().catch(error => {
  console.error('\n❌ 安全回归失败：' + error.message);
  process.exitCode = 1;
});
