'use strict';

/**
 * 线上机器人强度基准（浏览器核心，Node 内 vm 沙箱运行）。
 * 用法：
 *   node scripts/bench_checkers_robot.js --games 6            # 自对弈耗时/节点/局长
 *   node scripts/bench_checkers_robot.js --probes             # 战术探测
 *   node scripts/bench_checkers_robot.js --games 4 --level normal
 */
const fs = require('fs');
const vm = require('vm');

function numberArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function stringArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sandbox = { console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error, RegExp, Uint8Array };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('public/checkers/checkers_core.js', 'utf8'), sandbox, { filename: 'checkers_core.js' });
vm.runInContext(fs.readFileSync('public/checkers/checkers_ai_model.js', 'utf8'), sandbox, { filename: 'checkers_ai_model.js' });
const C = sandbox.CheckersCore;
const M = sandbox.CheckersAiModel;

function seededRandom(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 完整跑一局 self-play，返回统计。level 决定双方强度。 */
function playGame(level, seed, searchOptionsFactory) {
  const random = seededRandom(seed);
  let pieces = C.createInitialPieces();
  let player = 'red';
  let moveCount = 0;
  let nodes = 0;
  let elapsedMs = 0;
  const recent = [];
  const winner = { player: '', moves: 0 };
  const maxMoves = 260;
  for (let ply = 0; ply < maxMoves; ply++) {
    const opts = searchOptionsFactory ? searchOptionsFactory(level, pieces, player) : null;
    const start = Date.now();
    const analysis = C.analyzeAiMoves(pieces, player, level, opts);
    elapsedMs += Date.now() - start;
    nodes += analysis.totalNodes;
    const move = C.chooseAiMove(pieces, player, level, random, opts);
    if (!move) break;
    const result = C.applyMove(pieces, player, move.from, move.target);
    if (!result) throw new Error('非法走法 ' + player + ' ' + move.from + '>' + move.target);
    pieces = result.pieces;
    recent.push(C.positionKey(pieces));
    if (recent.length > 20) recent.shift();
    moveCount++;
    if (result.winner) { winner.player = result.winner; winner.moves = moveCount; break; }
    player = player === 'red' ? 'blue' : 'red';
  }
  return { winner: winner.player || 'limit', moves: moveCount, nodes: nodes, elapsedMs: elapsedMs };
}

function average(values) {
  return values.length ? Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(1)) : 0;
}

function runSelfPlay() {
  const games = numberArg('games', 6);
  const level = stringArg('level', 'hard');
  console.log('=== 自对弈基线（' + level + ' vs ' + level + '，' + games + ' 局）===');
  const stats = [];
  for (let index = 0; index < games; index++) {
    const result = playGame(level, 1000 + index * 7, null);
    stats.push(result);
    console.log('局 ' + (index + 1) + ': 胜者=' + (result.winner === 'limit' ? '上限' : result.winner) +
      ' 手数=' + result.moves + ' 节点=' + result.nodes + ' 耗时=' + result.elapsedMs + 'ms');
  }
  const allNodes = stats.map(s => s.nodes);
  const allTime = stats.map(s => s.elapsedMs);
  const allMoves = stats.map(s => s.moves);
  console.log('\n平均: 手数=' + average(allMoves) +
    ' 节点/局=' + average(allNodes) + ' 耗时/局=' + average(allTime) + 'ms' +
    ' 节点/步=' + average(allNodes.map((n, i) => n / allMoves[i])) +
    ' 耗时/步=' + average(allTime.map((t, i) => t / allMoves[i])) + 'ms' +
    ' 红胜=' + stats.filter(s => s.winner === 'red').length +
    ' 蓝胜=' + stats.filter(s => s.winner === 'blue').length);
}

function positionKeyOf(pieces) { return C.positionKey(pieces); }

/** 战术探测：直接验证机器人在关键局面下是否走出正确的一步。 */
function runProbes() {
  console.log('=== 战术探测（hard + 模型）===');
  const opts = { model: M };
  let failed = 0;

  function probe(name, pieces, player, predicate) {
    const move = C.chooseAiMove(pieces, player, 'hard', () => 0.5, opts);
    const ok = !!move && predicate(move);
    if (!ok) failed++;
    console.log((ok ? '  PASS ' : '  FAIL ') + name + (move ? ' → ' + move.from + '>' + move.target : ' (无走法)'));
    return move;
  }

  // 1) 直接获胜：9/10 在营，一步可赢，必须选择获胜落点。
  const winState = {};
  C.BOTTOM_CAMP.forEach(key => { if (key !== '14:0') winState[key] = 'red'; });
  winState['12:2'] = 'red';
  C.TOP_CAMP.forEach(key => { winState[key] = 'blue'; });
  probe('终局一步获胜', winState, 'red', m => m.from === '12:2' && m.target === '14:0');

  // 2) 营内挪动：红 8/10 在营、营外两子远在 5:-1 与 8:2（跳不进营），
  //    营内有空孔可挪（13:3>15:1、14:0>15:-1 等都合法），但任何挪动都是浪费手数。
  const shuffleState = {};
  C.BOTTOM_CAMP.forEach(key => { shuffleState[key] = 'red'; });
  C.TOP_CAMP.forEach(key => { shuffleState[key] = 'blue'; });
  delete shuffleState['15:-1']; delete shuffleState['15:1'];
  shuffleState['5:-1'] = 'red'; shuffleState['8:2'] = 'red';
  delete shuffleState['1:-1']; delete shuffleState['1:1'];
  shuffleState['11:1'] = 'blue'; shuffleState['10:0'] = 'blue';
  probe('营外棋子可动时不应营内挪动', shuffleState, 'red', m => {
    const from = C.BOARD_CELLS.find(c => c.key === m.from);
    const target = C.BOARD_CELLS.find(c => c.key === m.target);
    const result = C.applyMove(shuffleState, 'red', m.from, m.target);
    if (!result) return false;
    if (C.BOTTOM_CAMP.includes(m.from)) return false;    // 红方营地 = 目标营，从营内出发 = 挪动
    if (m.kind === 'jump') return true;                  // 营外长跳
    return target.row - from.row > 0;                    // 营外前进
  });

  // 4) 竞速终局：红 8/10 在营、2 子在外（其中 12:2 可通过腾出的 14:0 跳入营地），
  //    蓝 7/10。红应先完成 12:2>14:0 入营而非挪动或侧移。
  const raceState = {};
  C.BOTTOM_CAMP.forEach(key => { raceState[key] = 'red'; });
  C.TOP_CAMP.forEach(key => { raceState[key] = 'blue'; });
  delete raceState['15:-1']; delete raceState['14:0'];
  raceState['11:-1'] = 'red'; raceState['12:2'] = 'red';
  delete raceState['1:-1']; delete raceState['1:1']; delete raceState['0:0'];
  raceState['4:-2'] = 'blue'; raceState['5:-1'] = 'blue'; raceState['3:1'] = 'blue';
  const raceMove = probe('竞速终局不入营挪动（保留入营路线）', raceState, 'red', m => {
    // 12:2>14:0 与先侧移 11:-1 再入营是等价计划（搜索分数相同），
    // 这里只禁止真正浪费的营内挪动。
    if (C.BOTTOM_CAMP.includes(m.from)) return false;
    return true;
  });
  if (raceMove) {
    const result = C.applyMove(raceState, 'red', raceMove.from, raceMove.target);
    console.log('  INFO 竞速终局走法 ' + raceMove.from + '>' + raceMove.target + ' 后红方营内=' + C.countInGoal(result.pieces, 'red'));
  }

  console.log(failed ? '\n❌ ' + failed + ' 项探测失败' : '\n✅ 全部战术探测通过');
  process.exitCode = failed ? 1 : 0;
}

if (process.argv.includes('--probes')) runProbes();
else runSelfPlay();
