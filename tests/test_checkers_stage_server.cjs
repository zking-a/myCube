'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const WebSocket = require('ws');
const Core = require('../public/checkers/checkers_core');

test('Six-seat room: server workers play every bot color and broadcast legal moves', async () => {
  const port = 35000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port) }, stdio: 'ignore'
  });
  const sockets = [];
  try {
    for (let n = 0; n < 80; n++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const frames = [];
    for (const cid of ['STAGE-HOST', 'STAGE-GUEST']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/checkers-ws`); sockets.push(ws);
      ws.on('message', data => { if (cid === 'STAGE-HOST') frames.push(JSON.parse(data)); });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ t: 'join', room: 'STAGE', nick: cid, cid,
        intent: cid === 'STAGE-HOST' ? 'create' : 'join', bots: 4, level: 'hard' }));
    }
    async function stateAfter(sequence) {
      for (let n = 0; n < 200; n++) {
        const state = frames.find(m => m.t === 'state' && m.phase === 'playing' && m.moveNumber === sequence);
        if (state) return state;
        const error = frames.find(m => m.t === 'err'); if (error) throw new Error(JSON.stringify(error));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Timed out waiting for move ' + sequence);
    }
    let state = await stateAfter(1);
    assert.equal(state.seats.length, 6);
    const botColors = [];
    for (let sequence = 1; sequence <= 6; sequence++) {
      const actor = state.turn, seat = state.seats.find(s => s.color === actor);
      if (!seat.isBot) {
        const move = Core.listMoves(state.pieces, actor)[0];
        sockets[seat.cid === 'STAGE-HOST' ? 0 : 1].send(JSON.stringify({t:'move', ...move, seq:sequence}));
      } else botColors.push(actor);
      const next = await stateAfter(sequence + 1), move = next.lastMove;
      assert.equal(move.player, actor);
      const applied = Core.applyMove(state.pieces, actor, move.from, move.target);
      assert.ok(applied); assert.deepEqual(next.pieces, applied.pieces);
      state = next;
    }
    assert.deepEqual(new Set(botColors), new Set(['green', 'yellow', 'purple', 'orange']));
    assert.equal(state.turn, 'red');
  } finally {
    sockets.forEach(ws => ws.terminate()); server.kill();
  }
});

test('Bot result from a previous board is discarded; cancelled worker is terminated', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const definitions = ['clearCheckersBotTimer', 'runCheckersBotMove'].map(name =>
    source.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}'))[0]).join('\n');
  let worker, applied = 0;
  class FakeWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    terminate() { this.terminated = true; return Promise.resolve(); }
  }
  const room = { code:'STAGE', pieces:Core.createInitialPieces(), phase:'playing', turn:'blue', moveNumber:2,
    seats:[{color:'red'}, {color:'blue',isBot:true}], botLevel:'hard' };
  const context = vm.createContext({ Worker:FakeWorker, CheckersCore:Core, path, __dirname,
    checkersRooms:new Map([['STAGE',room]]), setTimeout:() => 1, clearTimeout:() => {},
    checkersSeatForColor:() => room.seats[1], checkersApplyMove:() => { applied++; },
    broadcastCheckersState:() => {}, scheduleCheckersBotMove:() => {}, room });
  vm.runInContext(definitions + '\nrunCheckersBotMove(room);', context);
  const move = Core.listMoves(room.pieces, 'blue')[0];
  room.pieces = Core.createInitialPieces(); // A restart can have the same move number but a new board.
  worker.emit('message', {move});
  assert.equal(applied, 0); assert.equal(worker.terminated, true);
  vm.runInContext('runCheckersBotMove(room); clearCheckersBotTimer(room);', context);
  worker.emit('message', {move}); assert.equal(applied, 0); assert.equal(worker.terminated, true);
});

test('Turn rotation skips a blocked seat using all of that color’s pieces', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const definition = source.match(/function nextCheckersTurn\([\s\S]*?\n\}/)[0];
  const next = vm.runInNewContext('(' + definition + ')', { CheckersCore:Core });
  const pieces = {}, colors = ['red','blue','green','yellow','purple','orange'];
  Core.BOARD_CELLS.filter(c => c.row <= 3).forEach(c => { pieces[c.key] = 'blue'; });
  Core.BOARD_CELLS.filter(c => c.row > 3).slice(0,50).forEach((c,i) => {
    pieces[c.key] = ['red','green','yellow','purple','orange'][Math.floor(i/10)];
  });
  assert.ok(Core.sanitizePieces(pieces)); assert.equal(Core.listMoves(pieces,'blue').length,0);
  const expected = colors.slice(1).find(c => Core.listMoves(pieces,c).length);
  assert.ok(expected); assert.notEqual(expected,'blue');
  assert.equal(next({pieces,seats:colors.map(color=>({color}))},'red'),expected);
});
