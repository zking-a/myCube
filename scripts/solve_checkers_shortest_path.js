'use strict';

/** 受预算保护的中国跳棋单人搬运双向 A* 命令行入口。 */
const fs = require('fs');
const path = require('path');
const { ChineseCheckersShortestPathSolver } = require('../ai-engine/games/chinese_checkers_shortest_path');

function numberArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function stringArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback;
}

const maxNodes = Math.floor(numberArg('max-nodes', 50000));
const timeLimitMs = Math.floor(numberArg('time-limit-ms', 5000));
const heuristicWeight = Math.max(1, numberArg('heuristic-weight', 1));
const output = stringArg('output', '');
const player = stringArg('player', 'red') === 'blue' ? 'blue' : 'red';
const solver = new ChineseCheckersShortestPathSolver({ corridorOnly: true });
const result = solver.solveInitial(player, {
  maxNodes: maxNodes,
  timeLimitMs: timeLimitMs,
  heuristicWeight: heuristicWeight
});

const report = {
  problem: 'standard-10-piece-solitaire-army-transfer',
  player: player,
  boardCells: solver.allowedCells.length,
  theoreticalOptimum: 27,
  exactMode: heuristicWeight === 1,
  found: result.found,
  optimal: result.optimal,
  cost: Number.isFinite(result.cost) ? result.cost : null,
  suggestedAction: result.suggestedAction,
  initialEstimate: result.initialEstimate,
  expanded: result.expanded,
  generated: result.generated,
  elapsedMs: result.elapsedMs,
  stopReason: result.reason,
  actions: result.actions
};

if (output) {
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
