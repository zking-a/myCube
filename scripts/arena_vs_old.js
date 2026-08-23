'use strict';

/**
 * 候选配置 vs 旧机器人（配对换色，N 局）。
 * 用法：
 *   node scripts/arena_vs_old.js --config depth3 --games 8 [--time-limit 420] [--seed 20260911]
 *   config: depth3  = 固定 3 层 + 时间预算 + 根宽度 24（更完整的 depth-3）
 *           adaptive = 修正后的终局自适应加深（≤4→7 层、≤8→5 层）+ TT + 时间预算
 *           old     = 旧机器人（对照组，应约 4-4）
 */
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

function numberArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function stringArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

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

function loadSolver(core) {
  const sandbox = { console, Math, Date, JSON, Number, String, Array, Object, Set, Map, Error };
  sandbox.CheckersCore = core;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('public/checkers/bidirectional_astar.js', 'utf8'), sandbox, { filename: 'bidirectional_astar.js' });
  vm.runInContext(fs.readFileSync('public/checkers/chinese_checkers_shortest_path.js', 'utf8'), sandbox, { filename: 'chinese_checkers_shortest_path.js' });
  return sandbox.CheckersShortestPath;
}

/** 与 checkers_ai_worker.js 相同的终局求解辅助：只在真终局、最优解、合法且不被一步占位时采用。 */
function endgameSolveAdvice(core, Solver, pieces, player) {
  if (!Solver || !Solver.ChineseCheckersShortestPathSolver) return null;
  try {
    const redOut = 10 - core.countInGoal(pieces, 'red');
    const blueOut = 10 - core.countInGoal(pieces, 'blue');
    if (redOut + blueOut > 4) return null;
    const solver = new Solver.ChineseCheckersShortestPathSolver({ corridorOnly: true });
    const result = solver.solve(
      solver.normalizeState(pieces, player),
      solver.goalState(player),
      { maxNodes: 400, timeLimitMs: 30, heuristicWeight: 1 }
    );
    const action = result && result.found && result.optimal ? result.suggestedAction : null;
    if (!action) return null;
    if (!core.applyMove(pieces, player, action.from, action.target)) return null;
    const opponent = player === 'red' ? 'blue' : 'red';
    const threatened = core.listMoves(pieces, opponent).some(function (move) { return move.target === action.target; });
    if (threatened) return null;
    return action;
  } catch (error) {
    return null;
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function playGame(oldCore, core, model, Solver, seed, newIsRed, newOptions) {
  const random = seededRandom(seed);
  let pieces = core.createInitialPieces();
  let player = 'red';
  let moves = 0;
  let timeMs = 0;
  let adviceUsed = 0;
  const recent = [];
  for (let ply = 0; ply < 260; ply++) {
    const isNew = player === 'red' ? newIsRed : !newIsRed;
    const coreNow = isNew ? core : oldCore;
    const start = Date.now();
    let move;
    if (isNew && Solver) {
      move = endgameSolveAdvice(coreNow, Solver, pieces, player);
      if (move) adviceUsed++;
    }
    if (!move) {
      move = coreNow.chooseAiMove(pieces, player, 'hard', random, isNew
        ? Object.assign({}, newOptions, { recentPositions: recent.slice(-20) })
        : Object.assign({ model: model, recentPositions: recent.slice(-20) }));
    }
    timeMs += Date.now() - start;
    if (!move) break;
    const result = coreNow.applyMove(pieces, player, move.from, move.target);
    if (!result) throw new Error('非法走法 ' + player + ' ' + move.from + '>' + move.target);
    pieces = result.pieces;
    recent.push(coreNow.positionKey(pieces));
    if (recent.length > 20) recent.shift();
    moves++;
    if (result.winner) return { winner: result.winner, moves: moves, timeMs: timeMs, adviceUsed: adviceUsed };
    player = player === 'red' ? 'blue' : 'red';
  }
  return { winner: 'limit', moves: moves, timeMs: timeMs, adviceUsed: adviceUsed };
}

function main() {
  const config = stringArg('config', 'depth3');
  const games = numberArg('games', 8);
  const seed = numberArg('seed', 20260911);
  const timeLimit = numberArg('time-limit', 420);
  const useSolver = process.argv.includes('--solver');
  if (games % 2 !== 0) throw new Error('--games 需要为偶数');
  const oldSource = execFileSync('git', ['show', 'HEAD:public/checkers/checkers_core.js'], { encoding: 'utf8' });
  const oldCore = loadCore(oldSource);
  const core = loadCore(fs.readFileSync('public/checkers/checkers_core.js', 'utf8'));
  const model = loadModel();
  const Solver = useSolver ? loadSolver(core) : null;

  let newOptions;
  if (config === 'old') newOptions = { model: model };
  else if (config === 'depth3') newOptions = { model: model, timeLimitMs: timeLimit, maxNodes: 30000 };
  else if (config === 'adaptive') newOptions = { model: model, timeLimitMs: timeLimit, adaptive: true, enableTranspositionTable: true };
  else throw new Error('未知 config: ' + config);

  let newWins = 0, oldWins = 0, limits = 0, totalMoves = 0, totalTime = 0, totalAdvice = 0;
  const details = [];
  for (let index = 0; index < games; index++) {
    const newIsRed = index % 2 === 0;
    const result = playGame(oldCore, core, model, Solver, seed + index * 131, newIsRed, newOptions);
    totalMoves += result.moves;
    totalTime += result.timeMs;
    totalAdvice += result.adviceUsed || 0;
    const newWon = result.winner === (newIsRed ? 'red' : 'blue');
    if (result.winner === 'limit') limits++;
    else if (newWon) newWins++;
    else oldWins++;
    details.push(result.winner + ':' + result.moves);
  }
  console.log('=== ' + config + (useSolver ? '+求解器' : '') + ' vs 旧（' + games + ' 局, seed=' + seed + '）===');
  console.log('  新胜 ' + newWins + '，旧胜 ' + oldWins + '，上限 ' + limits +
    '；平均手数 ' + Number((totalMoves / games).toFixed(1)) +
    '；平均 ' + Number((totalTime / games / 1000).toFixed(1)) + 's/局' +
    '；求解器采用 ' + totalAdvice + ' 次');
  console.log('  明细: ' + details.join(' '));
}

main();
