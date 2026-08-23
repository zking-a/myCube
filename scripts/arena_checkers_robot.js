'use strict';

/**
 * 新机器人 vs 旧机器人竞技场（同一规则核心的 before/after 对比）。
 * 旧核心从 git HEAD 提取，双方都加载同一个轻量价值模型。
 * 用法：
 *   node scripts/arena_checkers_robot.js --games 8 [--time-limit 420] [--seed 20260823]
 */
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

function numberArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

function loadCore(source) {
  const sandbox = { console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error, RegExp, Uint8Array };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'checkers_core.js' });
  return sandbox.CheckersCore;
}

function loadModel() {
  const sandbox = { console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('public/checkers/checkers_ai_model.js', 'utf8'), sandbox, { filename: 'checkers_ai_model.js' });
  return sandbox.CheckersAiModel;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 双方都用各自配置打一整局。返回 {winner, moves, timeMs}。 */
function playGame(oldCore, newCore, model, seed, redConfig, blueConfig, maxMoves) {
  const random = seededRandom(seed);
  let pieces = newCore.createInitialPieces();
  let player = 'red';
  let moves = 0;
  let timeMs = 0;
  const recent = [];
  const limit = maxMoves || 260;
  for (let ply = 0; ply < limit; ply++) {
    const core = player === 'red' ? redConfig.core : blueConfig.core;
    const options = Object.assign({}, player === 'red' ? redConfig.options : blueConfig.options, {
      recentPositions: recent.slice(-20)
    });
    const start = Date.now();
    const move = core.chooseAiMove(pieces, player, 'hard', random, options);
    timeMs += Date.now() - start;
    if (!move) break;
    const result = core.applyMove(pieces, player, move.from, move.target);
    if (!result) throw new Error('非法走法 ' + player + ' ' + move.from + '>' + move.target);
    pieces = result.pieces;
    recent.push(core.positionKey(pieces));
    if (recent.length > 20) recent.shift();
    moves++;
    if (result.winner) return { winner: result.winner, moves: moves, timeMs: timeMs };
    player = player === 'red' ? 'blue' : 'red';
  }
  return { winner: 'limit', moves: moves, timeMs: timeMs };
}

function main() {
  const games = numberArg('games', 8);
  const seed = numberArg('seed', 20260823);
  const timeLimit = numberArg('time-limit', 420);
  if (games % 2 !== 0) throw new Error('--games 需要为偶数（配对换色）');
  console.log('提取旧核心（git HEAD）…');
  const oldSource = execFileSync('git', ['show', 'HEAD:public/checkers/checkers_core.js'], { encoding: 'utf8' });
  const oldCore = loadCore(oldSource);
  const newCore = loadCore(fs.readFileSync('public/checkers/checkers_core.js', 'utf8'));
  const model = loadModel();

  const oldOptions = { model: model, recentPositions: [] };
  const newOptions = { model: model, recentPositions: [], adaptive: true, enableTranspositionTable: true, timeLimitMs: timeLimit };
  const newEvalOnly = { model: model, recentPositions: [] }; // 只验证评估改进（旧搜索参数）

  function configOf(kind) {
    if (kind === 'old') return { core: oldCore, options: oldOptions };
    if (kind === 'new') return { core: newCore, options: newOptions };
    return { core: newCore, options: newEvalOnly };
  }

  // 三组对比：新(完整) vs 旧、新(仅评估) vs 旧、新(完整) vs 新(仅评估)
  const matchups = [
    { name: '新(加深+评估) vs 旧', redKind: 'old', blueKind: 'new' },
    { name: '新(仅评估) vs 旧', redKind: 'old', blueKind: 'eval' },
    { name: '新(加深+评估) vs 新(仅评估)', redKind: 'eval', blueKind: 'new' }
  ];

  for (const matchup of matchups) {
    let redWins = 0, blueWins = 0, limits = 0, totalMoves = 0, totalTime = 0;
    const red = configOf(matchup.redKind);
    const blue = configOf(matchup.blueKind);
    const details = [];
    for (let index = 0; index < games; index++) {
      const gameSeed = seed + index * 131;
      const result = playGame(oldCore, newCore, model, gameSeed, red, blue, 260);
      totalMoves += result.moves;
      totalTime += result.timeMs;
      if (result.winner === 'red') redWins++;
      else if (result.winner === 'blue') blueWins++;
      else limits++;
      details.push(result.winner + ':' + result.moves);
    }
    const avgMoves = Number((totalMoves / games).toFixed(1));
    const avgTime = Number((totalTime / games / 1000).toFixed(1));
    console.log('\n=== ' + matchup.name + '（' + games + ' 局）===');
    console.log('  红(' + matchup.redKind + ') 胜 ' + redWins + '，蓝(' + matchup.blueKind + ') 胜 ' + blueWins +
      '，上限 ' + limits + '；平均手数 ' + avgMoves + '，平均耗时 ' + avgTime + 's/局');
    console.log('  明细: ' + details.join(' '));
  }
}

main();
