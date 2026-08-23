'use strict';

/**
 * Offline promotion arena for any dynamic-policy-value-v1 checkpoint.
 * The candidate alternates colors against the current V0 hard agent. Results
 * are reported separately from training so a checkpoint cannot self-promote.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PolicyValueModel, PuctMcts, createRandom, playArenaGame } = require('../ai-engine');
const { ChineseCheckersAdapter, Core } = require('../ai-engine/games/chinese_checkers_adapter');
const { buildOpeningSuite, selectOpening } = require('../ai-engine/games/chinese_checkers_openings');

function numberArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function stringArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
function floatArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

const config = {
  model: stringArg('model', ''), runOutput: stringArg('run-output', ''), report: stringArg('report', ''),
  agent: stringArg('agent', 'puct'), learnedWeight: floatArg('learned-weight', 180),
  safeMargin: floatArg('safe-margin', Number.POSITIVE_INFINITY),
  movesToGoStrengthMargin: floatArg('mtg-strength-margin', 40),
  enableMovesToGo: hasFlag('enable-mtg'),
  enableTranspositionTable: hasFlag('enable-tt'),
  games: numberArg('games', 8), simulations: numberArg('simulations', 24),
  maxMoves: numberArg('max-moves', 130), seed: numberArg('seed', 20260823),
  minPromotionGames: numberArg('min-promotion-games', 100),
  minScoreRate: floatArg('min-score-rate', .60),
  minCompletionRate: floatArg('min-completion-rate', .98),
  maxAverageMoves: floatArg('max-average-moves', 90),
  openingMinPlies: numberArg('opening-min-plies', 4),
  openingMaxPlies: numberArg('opening-max-plies', 8),
  bootstrapSamples: numberArg('bootstrap-samples', 5000)
};
if (!config.model) throw new Error('请通过 --model 指定候选 checkpoint');
if (config.games % 2 !== 0) throw new Error('paired-opening 竞技场要求 --games 为偶数');
if (config.agent !== 'puct' && config.agent !== 'hybrid') {
  throw new Error('--agent 仅支持 puct 或 hybrid；未过门槛的实验代理已移除');
}

function representative(results) {
  const completed = results.filter(function (result) { return result.winner && result.winner !== 'limit'; });
  const pool = completed.length ? completed : results;
  return pool.slice().sort(function (left, right) { return Math.abs(left.moves - 85) - Math.abs(right.moves - 85); })[0] || null;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = values.slice().sort(function (left, right) { return left - right; });
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(probability * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  return values.length
    ? Number((values.reduce(function (sum, value) { return sum + value; }, 0) / values.length).toFixed(1))
    : 0;
}

function pairBootstrapLowerBound(results, sampleCount, seed) {
  const pairs = new Map();
  results.forEach(function (result) {
    if (!pairs.has(result.openingPairId)) pairs.set(result.openingPairId, []);
    pairs.get(result.openingPairId).push(result.candidateScore);
  });
  const pairScores = Array.from(pairs.values()).filter(function (scores) { return scores.length === 2; }).map(function (scores) {
    return (scores[0] + scores[1]) / 2;
  });
  if (!pairScores.length) return { pairs: 0, lowerBound95: 0 };
  const random = createRandom(seed);
  const estimates = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    let score = 0;
    for (let index = 0; index < pairScores.length; index++) score += pairScores[Math.floor(random() * pairScores.length)];
    estimates.push(score / pairScores.length);
  }
  estimates.sort(function (left, right) { return left - right; });
  return {
    pairs: pairScores.length,
    lowerBound95: Number(estimates[Math.floor((estimates.length - 1) * .05)].toFixed(4))
  };
}

function main() {
  const started = Date.now();
  const modelBytes = fs.readFileSync(path.resolve(config.model));
  const payload = JSON.parse(modelBytes.toString('utf8'));
  const model = PolicyValueModel.fromJSON(payload);
  const declaredFeatures = Number(payload.metadata && payload.metadata.adapterFeatureVersion) || 0;
  const featureVersion = declaredFeatures || (model.stateSize > Core.BOARD_CELLS.length * 2 + 1 ? 2 : 1);
  const game = new ChineseCheckersAdapter({ maxMoves: config.maxMoves, featureVersion: featureVersion });
  if (model.stateSize !== game.stateSize || model.actionSize !== game.actionSize) {
    throw new Error('checkpoint 与中国跳棋特征编码不兼容');
  }
  const results = [];
  const openings = buildOpeningSuite(game, config.games / 2, {
    seed: config.seed + 30000, minPlies: config.openingMinPlies,
    maxPlies: config.openingMaxPlies, suiteId: 'promotion-' + config.seed
  });
  let candidateWins = 0, baselineWins = 0, draws = 0, completed = 0, totalMoves = 0;
  const searchTelemetry = {
    decisions: 0, nodes: 0, completeDecisions: 0, ttProbes: 0, ttHits: 0,
    ttExactHits: 0, ttCutoffs: 0, ttStores: 0, budgetCutoffs: 0, maxTableSize: 0
  };
  for (let index = 0; index < config.games; index++) {
    const candidateColor = index % 2 === 0 ? 'red' : 'blue';
    const openingPair = openings[Math.floor(index / 2)];
    const opening = selectOpening(openingPair, index % 2 === 0 ? 'a' : 'b');
    const pairSeed = config.seed + 9000 + Math.floor(index / 2);
    const search = config.agent === 'puct' ? new PuctMcts(game, model, {
      simulations: config.simulations, cPuct: 2.2,
      heuristicPriorWeight: .42, heuristicValueWeight: .22,
      dirichletWeight: 0, seed: config.seed + 5000 + index
    }) : null;
    const candidateRandom = createRandom(pairSeed + 3000);
    const baselineRandom = createRandom(pairSeed);
    const candidate = config.agent === 'hybrid'
      ? function (state) {
        const decision = game.guidedBaselineDecision(state, model, candidateRandom, {
          learnedMoveWeight: config.learnedWeight, safeLearnedMargin: config.safeMargin,
          movesToGoStrengthMargin: config.movesToGoStrengthMargin,
          enableMovesToGo: config.enableMovesToGo,
          enableTranspositionTable: config.enableTranspositionTable
        });
        const trace = decision.trace || {};
        searchTelemetry.decisions++;
        searchTelemetry.nodes += Number(trace.searchNodes) || 0;
        if (trace.searchComplete) searchTelemetry.completeDecisions++;
        searchTelemetry.ttProbes += Number(trace.ttProbes) || 0;
        searchTelemetry.ttHits += Number(trace.ttHits) || 0;
        searchTelemetry.ttExactHits += Number(trace.ttExactHits) || 0;
        searchTelemetry.ttCutoffs += Number(trace.ttCutoffs) || 0;
        searchTelemetry.ttStores += Number(trace.ttStores) || 0;
        searchTelemetry.budgetCutoffs += Number(trace.budgetCutoffs) || 0;
        searchTelemetry.maxTableSize = Math.max(searchTelemetry.maxTableSize, Number(trace.transpositionTableSize) || 0);
        return decision.action;
      }
      : function (state) { return search.choose(state, 0).action; };
    const baseline = function (state) { return game.baselineAction(state, 'hard', baselineRandom); };
    const agents = candidateColor === 'red' ? { red: candidate, blue: baseline } : { red: baseline, blue: candidate };
    const result = playArenaGame(game, agents, {
      maxMoves: config.maxMoves, captureReplay: true, startState: opening.startState,
      openingId: opening.openingId, openingPairId: opening.openingPairId,
      openingFamilyId: opening.openingFamilyId, splitGroupId: opening.splitGroupId
    });
    totalMoves += result.finalPly;
    if (result.winner) completed++; else draws++;
    if (result.winner === candidateColor) candidateWins++;
    else if (result.winner) baselineWins++;
    results.push({
      candidateColor: candidateColor, winner: result.winner || 'limit', moves: result.finalPly,
      candidateScore: result.winner === candidateColor ? 1 : (result.winner ? 0 : .5),
      openingId: opening.openingId, openingPairId: opening.openingPairId,
      openingFamilyId: opening.openingFamilyId, replay: result.replay
    });
    console.log(JSON.stringify({ phase: 'model_arena', game: index + 1, candidate: candidateColor, winner: result.winner || 'limit', moves: result.finalPly, openingPairId: opening.openingPairId }));
  }
  const averageMoves = Number((totalMoves / config.games).toFixed(1));
  const scoreRate = (candidateWins + draws * .5) / config.games;
  const completionRate = completed / config.games;
  // One-sided 95% Wilson lower bound. Promotion needs evidence, not a small-sample lead.
  const z = 1.6448536269514722;
  const denominator = 1 + z * z / config.games;
  const center = scoreRate + z * z / (2 * config.games);
  const radius = z * Math.sqrt((scoreRate * (1 - scoreRate) + z * z / (4 * config.games)) / config.games);
  const scoreLowerBound = (center - radius) / denominator;
  const pairBootstrap = pairBootstrapLowerBound(results, config.bootstrapSamples, config.seed + 70000);
  const completedMoves = results.filter(function (result) { return result.winner !== 'limit'; })
    .map(function (result) { return result.moves; });
  const candidateWinMoves = results.filter(function (result) { return result.candidateScore === 1; })
    .map(function (result) { return result.moves; });
  const candidateLossMoves = results.filter(function (result) { return result.candidateScore === 0; })
    .map(function (result) { return result.moves; });
  const promoted = config.games >= config.minPromotionGames &&
    scoreRate >= config.minScoreRate && scoreLowerBound > .5 &&
    pairBootstrap.lowerBound95 > .5 &&
    completionRate >= config.minCompletionRate && averageMoves < config.maxAverageMoves;
  const report = {
    model: path.basename(config.model),
    modelSha256: crypto.createHash('sha256').update(modelBytes).digest('hex'),
    status: promoted ? 'promoted' : 'experimental',
    adapterFeatureVersion: featureVersion,
    games: config.games, candidateWins: candidateWins, baselineWins: baselineWins,
    draws: draws, completed: completed, averageMoves: averageMoves,
    medianMoves: quantile(completedMoves, .5), p90Moves: quantile(completedMoves, .9),
    candidateWinAverageMoves: average(candidateWinMoves),
    candidateLossAverageMoves: average(candidateLossMoves),
    scoreRate: Number(scoreRate.toFixed(4)), completionRate: Number(completionRate.toFixed(4)),
    scoreLowerBound95: Number(scoreLowerBound.toFixed(4)),
    openingPairs: pairBootstrap.pairs, pairBootstrapLowerBound95: pairBootstrap.lowerBound95,
    promotionGate: {
      minGames: config.minPromotionGames, minScoreRate: config.minScoreRate,
      minCompletionRate: config.minCompletionRate, maxAverageMoves: config.maxAverageMoves,
      requirePairBootstrapLowerBoundAbove: .5
    },
    agent: config.agent, simulations: config.agent === 'puct' ? config.simulations : 0,
    learnedWeight: config.agent === 'hybrid' ? config.learnedWeight : 0,
    movesToGoStrengthMargin: config.agent === 'hybrid' ? config.movesToGoStrengthMargin : 0,
    movesToGoEnabled: config.agent === 'hybrid' && config.enableMovesToGo,
    transpositionTableEnabled: config.agent === 'hybrid' && config.enableTranspositionTable,
    searchTelemetry: Object.assign({}, searchTelemetry, {
      ttHitRate: searchTelemetry.ttProbes
        ? Number((searchTelemetry.ttHits / searchTelemetry.ttProbes).toFixed(4))
        : 0,
      averageNodes: searchTelemetry.decisions
        ? Number((searchTelemetry.nodes / searchTelemetry.decisions).toFixed(1))
        : 0,
      completeDecisionRate: searchTelemetry.decisions
        ? Number((searchTelemetry.completeDecisions / searchTelemetry.decisions).toFixed(4))
        : 0
    }),
    // JSON.stringify converts Infinity to null. Keep the report explicit so a
    // missing numeric value cannot be mistaken for a malformed experiment.
    safeMargin: config.agent === 'hybrid'
      ? (Number.isFinite(config.safeMargin) ? config.safeMargin : 'unbounded')
      : 0,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    results: results.map(function (result) {
      return {
        candidateColor: result.candidateColor, winner: result.winner, moves: result.moves,
        openingId: result.openingId, openingPairId: result.openingPairId,
        openingFamilyId: result.openingFamilyId
      };
    })
  };
  if (config.report) {
    const reportPath = path.resolve(config.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (config.runOutput) {
    const runPath = path.resolve(config.runOutput);
    const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    run.numpyArena = report;
    const replay = representative(results);
    if (replay) {
      run.replays = (run.replays || []).filter(function (item) { return item.id !== 'numpy-arena'; });
      run.replays.push({
        id: 'numpy-arena', phase: 'arena', title: (payload.metadata && payload.metadata.name || 'NumPy 候选模型') + ' 对阵 V0',
        winner: replay.winner, moves: replay.moves, candidateColor: replay.candidateColor,
        actions: replay.replay
      });
    }
    fs.writeFileSync(runPath, JSON.stringify(run, null, 2) + '\n');
  }
  console.log('ARENA_RESULT ' + JSON.stringify(report));
}

main();
