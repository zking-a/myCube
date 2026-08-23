'use strict';

/**
 * 中国跳棋策略价值机器人 V1.1+ 训练入口。
 *
 * V1.4 强制契约：按 opening family 切分；真实 W/L + 显式 mask；
 * 冻结历史/V0 对手池；部署一致的 hybrid actor 与完整根决策 trace。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PolicyValueModel, ReplayBuffer, LiveTrainingReporter, createRandom,
  playArenaGame, playLeagueGame, splitByGroup
} = require('../ai-engine');
const { ChineseCheckersAdapter } = require('../ai-engine/games/chinese_checkers_adapter');
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
function parseOpponentPool(value, fallback) {
  const normalized = String(value || '').split(',').map(function (item) { return (item || '').trim(); })
    .filter(function (item) { return ['self', 'history', 'v0_normal', 'v0_hard'].indexOf(item) >= 0; });
  return normalized.length ? normalized : (fallback || ['history', 'self', 'v0_normal', 'v0_hard']);
}

const config = {
  version: stringArg('version', '1.4'),
  seed: numberArg('seed', 20260823),
  teacherGames: numberArg('teacher-games', 48),
  teacherEpochs: numberArg('teacher-epochs', 4),
  teacherHardEvery: numberArg('teacher-hard-every', 5),
  leagueGames: numberArg('league-games', 272),
  leagueEpochs: numberArg('league-epochs', 3),
  arenaGames: numberArg('arena-games', 12),
  replayCapacity: numberArg('replay-capacity', 20000),
  replaySamples: numberArg('replay-samples', 12000),
  maxMoves: numberArg('max-moves', 160),
  featureVersion: numberArg('feature-version', 2),
  opponentPool: parseOpponentPool(stringArg('opponent-pool', ''), ['history', 'self', 'v0_normal', 'v0_hard']),
  historyModel: stringArg('history-model', path.join('models', 'checkers-policy-value-v1_3-numpy.json')),
  historySha256: stringArg('history-sha256', ''),
  initModel: stringArg('init-model', ''),
  initSha256: stringArg('init-sha256', ''),
  dataProfile: stringArg('data-profile', 'v14-generation1'),
  skipTeacherFit: hasFlag('skip-teacher-fit'),
  skipLeagueFit: hasFlag('skip-league-fit'),
  leagueAgent: stringArg('league-agent', 'hybrid'),
  arenaAgent: stringArg('arena-agent', 'hybrid'),
  openingMinPlies: numberArg('opening-min-plies', 4),
  openingMaxPlies: numberArg('opening-max-plies', 8),
  learnedWeight: floatArg('learned-weight', 240),
  safeMargin: floatArg('safe-margin', 100),
  explorationRate: floatArg('exploration-rate', .35),
  explorationMargin: floatArg('exploration-margin', 120),
  output: stringArg('output', ''),
  datasetOutput: stringArg('dataset-output', ''),
  runOutput: stringArg('run-output', ''),
  liveOutput: stringArg('live-output', ''),
  summaryOnly: hasFlag('summary-only')
};
if (config.leagueAgent !== 'hybrid' || config.arenaAgent !== 'hybrid') {
  throw new Error('V1.4 主训练契约要求 --league-agent hybrid --arena-agent hybrid');
}
const isV14 = /^1\.4(?:\.|$)/.test(config.version);
if (isV14 && (!config.skipTeacherFit || !config.skipLeagueFit)) {
  throw new Error('V1.4 固定数据集生成必须同时使用 --skip-teacher-fit --skip-league-fit，禁止采样中途修改 actor');
}
if (isV14 && (!config.initModel || !config.initSha256 || !config.historySha256)) {
  throw new Error('V1.4 固定数据集生成必须显式指定 init/history checkpoint 及 SHA-256');
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function modelSha256(model) { return sha256Bytes(JSON.stringify(model.toJSON())); }
function searchConfigHash(settings) {
  return sha256Bytes(JSON.stringify({
    actor: 'hybrid', learnedWeight: settings.learnedWeight,
    safeMargin: settings.safeMargin,
    explorationRate: Number(settings.explorationRate) || 0,
    explorationMargin: Number(settings.explorationMargin) || 0,
    featureVersion: config.featureVersion
  }));
}

/** Generation-1 fixed mixture: 50% hybrid-v0, 25% self, 10% top-2 exploration. */
function buildLeagueSchedule(gameCount) {
  if (config.dataProfile !== 'v14-generation1') {
    const fallback = config.opponentPool.length ? config.opponentPool : ['history', 'self', 'v0_normal', 'v0_hard'];
    return Array.from({ length: gameCount }, function (_unused, index) { return fallback[index % fallback.length]; });
  }
  const pairCount = Math.ceil(gameCount / 2);
  const explorationPairs = Math.round(pairCount * 2 / 17);
  const selfPairs = Math.round(pairCount * 5 / 17);
  const hardPairs = pairCount - explorationPairs - selfPairs;
  const pairs = [];
  [["v0_hard", hardPairs], ["self", selfPairs], ["explore_v0_hard", explorationPairs]]
    .forEach(function (entry) {
      for (let index = 0; index < entry[1]; index++) pairs.push(entry[0]);
    });
  const random = createRandom(config.seed + 6060);
  for (let index = pairs.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    const value = pairs[index]; pairs[index] = pairs[target]; pairs[target] = value;
  }
  const schedule = [];
  pairs.forEach(function (opponent) { schedule.push(opponent, opponent); });
  return schedule.slice(0, gameCount);
}

function openingForGame(suite, gameIndex) {
  const pair = suite[Math.floor(gameIndex / 2) % suite.length];
  return selectOpening(pair, gameIndex % 2 === 0 ? 'a' : 'b');
}

function argmax(values) {
  let best = 0;
  for (let index = 1; index < values.length; index++) if (values[index] > values[best]) best = index;
  return best;
}

function sampleIndex(probabilities, random) {
  let cursor = random();
  for (let index = 0; index < probabilities.length; index++) {
    cursor -= probabilities[index];
    if (cursor <= 0) return index;
  }
  return probabilities.length - 1;
}

/** 生成带 opening-family、显式 W/L mask 的完整 V0 教师对局。 */
function generateTeacherData(game, random, reporter, openingSuite) {
  const samples = [], games = [];
  for (let gameIndex = 0; gameIndex < config.teacherGames; gameIndex++) {
    const gameId = 'teacher-' + String(gameIndex + 1).padStart(4, '0');
    const opening = openingForGame(openingSuite, gameIndex);
    let state = opening.startState;
    const records = [], replay = [];
    const level = config.dataProfile === 'v14-generation1'
      ? 'hard'
      : (gameIndex % config.teacherHardEvery === 0 ? 'hard' : 'normal');
    reporter.beginGame({ phase: 'teacher', gameId: gameId, title: 'V0 教师采样 · ' + level, opponent: level });
    while (!game.isTerminal(state) && state.ply < config.maxMoves) {
      const player = game.currentPlayer(state);
      const actions = game.legalActions(state);
      if (!actions.length) break;
      const policy = game.teacherPolicy(state, actions, {
        level: level, teacherWeight: level === 'hard' ? .84 : .74, random: random
      });
      records.push({
        gameId: gameId, state: game.encodeState(state, player),
        actions: actions.map(function (action) { return game.encodeAction(state, action, player); }),
        actionKeys: actions.map(function (action) { return game.actionKey(action); }),
        policy: policy, player: player, ply: state.ply, source: 'teacher_' + level
      });
      const selected = state.ply < 12 || random() < .05 ? sampleIndex(policy, random) : argmax(policy);
      replay.push({
        ply: state.ply + 1, player: player, from: actions[selected].from,
        target: actions[selected].target, kind: actions[selected].kind || '',
        confidence: Number(Number(policy[selected] || 0).toFixed(4))
      });
      reporter.recordMove(replay[replay.length - 1]);
      state = game.applyAction(state, actions[selected]);
    }
    records.forEach(function (record) {
      const outcome = game.trainingOutcome(state, record.player);
      samples.push(Object.assign({
        schemaVersion: 'cc-hybrid-v14',
        gameId: gameId, state: record.state, actions: record.actions, policy: record.policy,
        actionKeys: record.actionKeys, ply: record.ply, player: record.player,
        value: outcome.value, valueMask: outcome.valueMask,
        movesToGo: outcome.valueMask === 1
          ? Math.max(0, Math.min(1, (state.ply - record.ply) / Math.max(1, config.maxMoves)))
          : 0,
        progressMask: outcome.valueMask,
        progressScale: Math.max(1, config.maxMoves),
        completed: outcome.valueMask === 1, finalPly: state.ply,
        actorType: 'v0-teacher', actorCheckpointSha256: '', opponentId: level,
        opponentCheckpointSha256: '',
        searchConfigHash: '', candidateMask: [], baseDfsScores: [], learnedScores: [],
        finalHybridScores: [], selectedIndex: -1, bestBaseMargin: null, searchNodes: 0,
        source: config.dataProfile === 'v14-generation1' ? 'v0_hard_anchor' : record.source
      }, {
        openingId: opening.openingId, openingPairId: opening.openingPairId,
        openingFamilyId: opening.openingFamilyId, splitGroupId: opening.splitGroupId
      }));
    });
    games.push(Object.assign({ gameId: gameId, winner: state.winner || '', moves: state.ply, completed: !!state.winner, level: level, replay: replay }, opening));
    reporter.endGame({ winner: state.winner || '' });
    console.log(JSON.stringify({ phase: 'teacher', game: gameIndex + 1, gameId: gameId, level: level, moves: state.ply, winner: state.winner || 'limit', samples: samples.length }));
  }
  return { samples: samples, games: games };
}

function createBaselineAgent(game, level, random) {
  const agent = function (state, player, ply, actions) {
    const policy = game.teacherPolicy(state, actions, {
      level: level, teacherWeight: level === 'hard' ? .86 : .76, random: random
    });
    return {
      action: actions[argmax(policy)], policy: policy,
      actorType: 'v0-' + level, actorCheckpointSha256: '', searchConfigHash: '',
      source: 'league_v0_' + level
    };
  };
  agent.actorId = 'v0-' + level;
  agent.checkpointSha256 = '';
  return agent;
}

/** Deployment-aligned hybrid actor: V0 DFS is the safety base, model is residual guidance. */
function createHybridAgent(game, model, options) {
  const settings = options || {};
  const random = createRandom(Number(settings.seed) || 1);
  const agent = function (state, player, ply, actions) {
    const decision = game.guidedBaselineDecision(state, model, random, {
      learnedMoveWeight: Number(settings.learnedWeight) || config.learnedWeight,
      safeLearnedMargin: Number.isFinite(Number(settings.safeMargin)) ? Number(settings.safeMargin) : config.safeMargin
    });
    let action = decision.action;
    let trace = decision.trace;
    if (settings.controlledTop2 && trace && Array.isArray(trace.finalHybridScores)) {
      const ranked = trace.finalHybridScores.map(function (score, index) {
        return { index: index, score: Number(score) };
      }).filter(function (item) {
        return Number.isFinite(item.score) && (!trace.candidateMask.length || trace.candidateMask[item.index]);
      }).sort(function (left, right) {
        return right.score - left.score || left.index - right.index;
      });
      const margin = Math.max(0, Number(settings.explorationMargin) || config.explorationMargin);
      const topTwo = ranked.slice(0, 2).filter(function (item) {
        return !ranked.length || ranked[0].score - item.score <= margin;
      });
      const explore = topTwo.length > 1 && random() < Math.max(0, Math.min(1, Number(settings.explorationRate) || config.explorationRate));
      const selected = explore ? topTwo[1] : topTwo[0];
      if (selected && actions[selected.index]) {
        action = actions[selected.index];
        trace = Object.assign({}, trace, {
          actorType: 'hybrid-top2-exploration',
          teacherSelectedIndex: trace.selectedIndex,
          selectedIndex: selected.index,
          explorationApplied: explore
        });
      }
    }
    return {
      action: action, policy: decision.policyTarget, trace: trace,
      value: model.predictValue(game.encodeState(state, player)),
      actorType: settings.controlledTop2 ? 'hybrid-top2-exploration' : 'hybrid',
      actorCheckpointSha256: String(settings.actorCheckpointSha256 || ''),
      searchConfigHash: String(settings.searchConfigHash || ''),
      source: settings.source || 'league_hybrid'
    };
  };
  agent.actorId = String(settings.actorId || settings.source || 'hybrid');
  agent.checkpointSha256 = String(settings.actorCheckpointSha256 || '');
  return agent;
}

function createCandidateAgent(game, model, options) {
  return createHybridAgent(game, model, options);
}

function loadHistoryModel(game) {
  const historyPath = path.resolve(config.historyModel);
  if (!fs.existsSync(historyPath)) throw new Error('冻结历史 checkpoint 不存在：' + historyPath);
  const bytes = fs.readFileSync(historyPath);
  const sha256 = sha256Bytes(bytes);
  if (config.historySha256 && sha256.toLowerCase() !== config.historySha256.toLowerCase()) {
    throw new Error('冻结历史 checkpoint SHA-256 不匹配：' + historyPath);
  }
  const model = PolicyValueModel.fromJSON(JSON.parse(bytes.toString('utf8')));
  if (model.stateSize !== game.stateSize || model.actionSize !== game.actionSize) {
    throw new Error('冻结历史 checkpoint 与 V1.4 特征编码不兼容：' + historyPath);
  }
  return { model: model, name: path.basename(historyPath), sha256: sha256 };
}

/** Restore the candidate itself from a compatible champion checkpoint. */
function loadInitialModel(game) {
  if (!config.initModel) {
    return {
      model: new PolicyValueModel({ stateSize: game.stateSize, actionSize: game.actionSize, hiddenSize: 32, actionHiddenSize: 12, seed: config.seed }),
      name: 'random-seed-' + config.seed, sha256: ''
    };
  }
  const initPath = path.resolve(config.initModel);
  if (!fs.existsSync(initPath)) throw new Error('初始 checkpoint 不存在：' + initPath);
  const bytes = fs.readFileSync(initPath);
  const sha256 = sha256Bytes(bytes);
  if (config.initSha256 && sha256.toLowerCase() !== config.initSha256.toLowerCase()) {
    throw new Error('初始 checkpoint SHA-256 不匹配：' + initPath);
  }
  const model = PolicyValueModel.fromJSON(JSON.parse(bytes.toString('utf8')));
  if (model.stateSize !== game.stateSize || model.actionSize !== game.actionSize) {
    throw new Error('初始 checkpoint 与当前特征编码不兼容：' + initPath);
  }
  return { model: model, name: path.basename(initPath), sha256: sha256 };
}

/** 当前候选轮流对阵自己、冻结历史、V0 normal 和 V0 hard。 */
function generateLeagueData(game, currentModel, currentActorSha256, history, reporter, openingSuite) {
  const samples = [], games = [];
  const schedule = buildLeagueSchedule(config.leagueGames);
  const baselineRandom = createRandom(config.seed + 7000);
  for (let gameIndex = 0; gameIndex < config.leagueGames; gameIndex++) {
    const gameId = 'league-' + String(gameIndex + 1).padStart(4, '0');
    const opening = openingForGame(openingSuite, gameIndex);
    const opponent = schedule[gameIndex];
    const candidateColor = gameIndex % 2 === 0 ? 'red' : 'blue';
    const controlledTop2 = opponent === 'explore_v0_hard';
    const current = createCandidateAgent(game, currentModel, {
      seed: config.seed + 1000 + gameIndex,
      source: controlledTop2 ? 'generation1_top2_exploration' : 'generation1_frozen_v13_hybrid',
      learnedWeight: config.learnedWeight, safeMargin: config.safeMargin,
      controlledTop2: controlledTop2, explorationRate: config.explorationRate,
      explorationMargin: config.explorationMargin,
      actorCheckpointSha256: currentActorSha256,
      searchConfigHash: searchConfigHash({
        learnedWeight: config.learnedWeight, safeMargin: config.safeMargin,
        explorationRate: controlledTop2 ? config.explorationRate : 0,
        explorationMargin: controlledTop2 ? config.explorationMargin : 0
      })
    });
    let agents;
    if (opponent === 'self') {
      const otherCurrent = createCandidateAgent(game, currentModel, {
        seed: config.seed + 3000 + gameIndex, source: 'generation1_frozen_v13_hybrid',
        learnedWeight: config.learnedWeight, safeMargin: config.safeMargin,
        actorCheckpointSha256: currentActorSha256,
        searchConfigHash: searchConfigHash({ learnedWeight: config.learnedWeight, safeMargin: config.safeMargin })
      });
      agents = candidateColor === 'red' ? { red: current, blue: otherCurrent } : { red: otherCurrent, blue: current };
    } else {
      const opponentAgent = opponent === 'history'
        ? createCandidateAgent(game, history.model, {
          seed: config.seed + 4000 + gameIndex, source: 'league_history',
          learnedWeight: config.learnedWeight, safeMargin: config.safeMargin,
          actorCheckpointSha256: history.sha256,
          searchConfigHash: searchConfigHash({ learnedWeight: config.learnedWeight, safeMargin: config.safeMargin })
        })
        : createBaselineAgent(game, opponent === 'v0_hard' || opponent === 'explore_v0_hard' ? 'hard' : 'normal', baselineRandom);
      agents = candidateColor === 'red' ? { red: current, blue: opponentAgent } : { red: opponentAgent, blue: current };
    }
    reporter.beginGame({
      phase: 'league', gameId: gameId, title: '候选联赛 · ' + opponent,
      opponent: opponent, candidateColor: candidateColor
    });
    const result = playLeagueGame(game, agents, {
      schemaVersion: 'cc-hybrid-v14',
      gameId: gameId, maxMoves: config.maxMoves, captureReplay: true,
      startState: opening.startState, openingId: opening.openingId,
      openingPairId: opening.openingPairId, openingFamilyId: opening.openingFamilyId,
      splitGroupId: opening.splitGroupId, opponentId: opponent,
      onMove: function (move) { reporter.recordMove(move); }
    });
    reporter.endGame({ winner: result.winner });
    samples.push.apply(samples, result.samples);
    games.push({
      gameId: gameId, opponent: opponent, candidateColor: candidateColor,
      openingId: opening.openingId, openingPairId: opening.openingPairId,
      openingFamilyId: opening.openingFamilyId,
      winner: result.winner, moves: result.finalPly, completed: !!result.winner, replay: result.replay
    });
    console.log(JSON.stringify({
      phase: 'league', game: gameIndex + 1, gameId: gameId, opponent: opponent,
      candidate: candidateColor, moves: result.finalPly, winner: result.winner || 'limit', samples: samples.length
    }));
  }
  return { samples: samples, games: games };
}

function addGamesToBuffer(buffer, samples) {
  const groups = new Map();
  samples.forEach(function (sample) {
    if (!groups.has(sample.gameId)) groups.set(sample.gameId, []);
    groups.get(sample.gameId).push(sample);
  });
  groups.forEach(function (gameSamples, gameId) {
    const source = String(gameSamples[0] && gameSamples[0].source || 'unknown');
    buffer.addGame(gameId, gameSamples, { source: source });
  });
}

function evaluateModel(model, samples) {
  if (!samples.length) return { samples: 0, policyTop1: 0, policyLoss: 0, valueMae: 0 };
  let top1 = 0, policyLoss = 0, valueError = 0, valueCount = 0;
  samples.forEach(function (sample) {
    const prediction = model.predict(sample.state, sample.actions);
    if (argmax(prediction.policy) === argmax(sample.policy)) top1++;
    for (let index = 0; index < sample.policy.length; index++) policyLoss -= sample.policy[index] * Math.log(Math.max(1e-9, prediction.policy[index]));
    if (Number.isFinite(Number(sample.valueMask)) ? Number(sample.valueMask) > 0 : true) {
      valueError += Math.abs(prediction.value - sample.value);
      valueCount++;
    }
  });
  return {
    samples: samples.length, policyTop1: Number((top1 / samples.length).toFixed(4)),
    policyLoss: Number((policyLoss / samples.length).toFixed(4)),
    valueMae: Number((valueError / Math.max(1, valueCount)).toFixed(4)), valueSamples: valueCount
  };
}

function runArena(game, model, reporter, openingSuite) {
  const stats = { games: config.arenaGames, candidateWins: 0, baselineWins: 0, draws: 0, completed: 0, totalMoves: 0, results: [] };
  for (let gameIndex = 0; gameIndex < config.arenaGames; gameIndex++) {
    const candidateColor = gameIndex % 2 === 0 ? 'red' : 'blue';
    const opening = openingForGame(openingSuite, gameIndex);
    const pairSeed = config.seed + 9000 + Math.floor(gameIndex / 2);
    const candidateRandom = createRandom(pairSeed + 3000);
    const baselineRandom = createRandom(pairSeed);
    const candidate = function (state) { return game.guidedBaselineAction(state, model, candidateRandom, {
      learnedMoveWeight: config.learnedWeight, safeLearnedMargin: config.safeMargin
    }); };
    const baseline = function (state) { return game.baselineAction(state, 'hard', baselineRandom); };
    const agents = candidateColor === 'red' ? { red: candidate, blue: baseline } : { red: baseline, blue: candidate };
    reporter.beginGame({
      phase: 'arena', gameId: 'arena-' + String(gameIndex + 1).padStart(4, '0'),
      title: '晋级竞技场 · V' + config.version + ' vs V0', opponent: 'v0_hard', candidateColor: candidateColor
    });
    const result = playArenaGame(game, agents, {
      maxMoves: config.maxMoves, captureReplay: true, startState: opening.startState,
      openingId: opening.openingId, openingPairId: opening.openingPairId,
      openingFamilyId: opening.openingFamilyId, splitGroupId: opening.splitGroupId,
      onMove: function (move) { reporter.recordMove(move); }
    });
    reporter.endGame({ winner: result.winner });
    stats.totalMoves += result.finalPly;
    if (result.winner) stats.completed++; else stats.draws++;
    if (result.winner === candidateColor) stats.candidateWins++;
    else if (result.winner) stats.baselineWins++;
    stats.results.push({
      candidateColor: candidateColor, winner: result.winner || 'limit', moves: result.finalPly,
      openingId: opening.openingId, openingPairId: opening.openingPairId,
      openingFamilyId: opening.openingFamilyId, replay: result.replay
    });
    console.log(JSON.stringify({ phase: 'arena', game: gameIndex + 1, candidate: candidateColor, moves: result.finalPly, winner: result.winner || 'limit' }));
  }
  stats.averageMoves = Number((stats.totalMoves / Math.max(1, stats.games)).toFixed(1));
  delete stats.totalMoves;
  return stats;
}

function summarizeGames(games) {
  const completed = games.filter(function (game) { return game.completed; }).length;
  const moves = games.reduce(function (sum, game) { return sum + game.moves; }, 0);
  return { games: games.length, completed: completed, averageMoves: Number((moves / Math.max(1, games.length)).toFixed(1)) };
}

function representativeGame(games) {
  const completed = games.filter(function (game) { return game.completed || (game.winner && game.winner !== 'limit'); });
  const pool = completed.length ? completed : games;
  return pool.slice().sort(function (left, right) { return Math.abs(left.moves - 85) - Math.abs(right.moves - 85); })[0] || null;
}

/** 本地开发实验室日志；玩家大厅不包含入口。 */
function buildRunLog(metadata, teacherGames, leagueGames, arenaDetails, histories) {
  const replays = [];
  [
    { phase: 'teacher', title: 'V0 教师示范', game: representativeGame(teacherGames) },
    { phase: 'self_play', title: 'V' + config.version + ' 联赛训练', game: representativeGame(leagueGames) },
    { phase: 'arena', title: 'V' + config.version + ' 对阵 V0', game: representativeGame(arenaDetails.results) }
  ].forEach(function (item, index) {
    if (!item.game) return;
    replays.push({
      id: item.phase + '-' + (index + 1), phase: item.phase, title: item.title,
      winner: item.game.winner || 'limit', moves: item.game.moves,
      candidateColor: item.game.candidateColor || '', actions: item.game.replay || []
    });
  });
  return {
    schemaVersion: 2,
    run: {
      name: metadata.name, createdAt: metadata.createdAt, status: metadata.status,
      algorithm: metadata.algorithm, elapsedSeconds: metadata.elapsedSeconds
    },
    summary: {
      teacher: metadata.teacher, selfPlay: metadata.league, validation: metadata.validation,
      arena: {
        games: metadata.arena.games, candidateWins: metadata.arena.candidateWins,
        baselineWins: metadata.arena.baselineWins, draws: metadata.arena.draws,
        completed: metadata.arena.completed, averageMoves: metadata.arena.averageMoves
      },
      teacherSamples: metadata.teacherSamples, selfPlaySamples: metadata.leagueSamples
    },
    trainingContract: {
      version: metadata.version, split: metadata.split, opponentPool: metadata.opponentPool,
      replayBuffer: metadata.replayBuffer, historyModel: metadata.historyModel,
      historySha256: metadata.historySha256, leagueActorSha256: metadata.leagueActorSha256
    },
    // 保留 v11 字段，旧实验室和已有自动化仍可读取同一份严格训练契约。
    v11: { split: metadata.split, opponentPool: metadata.opponentPool, replayBuffer: metadata.replayBuffer },
    histories: histories, replays: replays
  };
}

function main() {
  const startedAt = Date.now();
  const random = createRandom(config.seed);
  const reporter = new LiveTrainingReporter(config.liveOutput);
  reporter.beginRun({ runId: 'checkers-v' + config.version + '-' + config.seed, title: '中国跳棋 V' + config.version + ' 准备训练' });
  const game = new ChineseCheckersAdapter({
    maxMoves: config.maxMoves, heuristicTemperature: .9,
    featureVersion: config.featureVersion
  });
  const initial = loadInitialModel(game);
  const model = initial.model;
  console.log('[Initial] model=' + initial.name);
  // Freeze and verify the historical opponent before any candidate update.
  const history = loadHistoryModel(game);
  console.log('[History] model=' + history.name + ' sha256=' + history.sha256);

  const openingOptions = { minPlies: config.openingMinPlies, maxPlies: config.openingMaxPlies };
  const teacherOpenings = buildOpeningSuite(game, Math.ceil(config.teacherGames / 2), Object.assign({
    seed: config.seed + 10000, suiteId: 'teacher-v' + config.version
  }, openingOptions));
  const leagueOpenings = buildOpeningSuite(game, Math.ceil(config.leagueGames / 2), Object.assign({
    seed: config.seed + 20000, suiteId: 'league-v' + config.version
  }, openingOptions));
  const arenaOpenings = buildOpeningSuite(game, Math.ceil(config.arenaGames / 2), Object.assign({
    seed: config.seed + 30000, suiteId: 'arena-v' + config.version
  }, openingOptions));

  const teacher = generateTeacherData(game, random, reporter, teacherOpenings);
  const teacherSplit = splitByGroup(teacher.samples, { seed: config.seed + 11, validationFraction: .125 });
  const teacherHistory = config.skipTeacherFit ? [] : model.fit(teacherSplit.train, {
    epochs: config.teacherEpochs, learningRate: .0024, valueWeight: .55,
    policyWeight: 1, l2: .00002, seed: config.seed + 1,
    onEpoch: function (metrics) { console.log(JSON.stringify(Object.assign({ phase: 'teacher_fit' }, metrics))); }
  });
  console.log(JSON.stringify({ phase: 'teacher_validation', metrics: evaluateModel(model, teacherSplit.validation) }));

  const currentActorSha256 = config.skipTeacherFit && initial.sha256
    ? initial.sha256
    : modelSha256(model);
  const league = generateLeagueData(game, model, currentActorSha256, history, reporter, leagueOpenings);
  const leagueSplit = splitByGroup(league.samples, { seed: config.seed + 21, validationFraction: .125 });

  const buffer = new ReplayBuffer({ capacity: config.replayCapacity });
  addGamesToBuffer(buffer, teacherSplit.train);
  addGamesToBuffer(buffer, leagueSplit.train);
  const replaySamples = buffer.sample(config.replaySamples, { random: createRandom(config.seed + 2), balanceSources: true });
  const leagueHistory = config.skipLeagueFit ? [] : model.fit(replaySamples, {
    epochs: config.leagueEpochs, learningRate: .0012, valueWeight: .72,
    policyWeight: 1, l2: .000025, seed: config.seed + 3,
    onEpoch: function (metrics) { console.log(JSON.stringify(Object.assign({ phase: 'league_fit' }, metrics))); }
  });

  const validationSamples = teacherSplit.validation.concat(leagueSplit.validation);
  const validation = evaluateModel(model, validationSamples);
  const arena = runArena(game, model, reporter, arenaOpenings);
  const developmentGatePassed = arena.candidateWins > arena.baselineWins && arena.completed === arena.games && arena.averageMoves <= 110;
  const arenaMetadata = Object.assign({}, arena, {
    results: arena.results.map(function (result) { return { candidateColor: result.candidateColor, winner: result.winner, moves: result.moves }; })
  });
  const opponentPool = league.games.reduce(function (counts, item) {
    counts[item.opponent] = (counts[item.opponent] || 0) + 1;
    return counts;
  }, {});
  const metadata = {
    name: 'Chinese Checkers Policy-Value Robot V' + config.version, version: config.version,
    adapterFeatureVersion: config.featureVersion,
    game: 'chinese-checkers-2p', status: 'experimental', developmentGatePassed: developmentGatePassed,
    algorithm: 'generation-1 fixed mixture + opening-family split + masked true W/L + frozen hybrid trace distillation',
    createdAt: new Date().toISOString(), config: config,
    teacher: summarizeGames(teacher.games), league: summarizeGames(league.games),
    teacherSamples: teacher.samples.length, leagueSamples: league.samples.length,
    split: {
      mode: 'opening-family', groupField: 'splitGroupId',
      trainGroups: teacherSplit.trainGroupIds.length + leagueSplit.trainGroupIds.length,
      validationGroups: teacherSplit.validationGroupIds.length + leagueSplit.validationGroupIds.length,
      trainSamples: teacherSplit.train.length + leagueSplit.train.length,
      validationSamples: validationSamples.length, overlap: false
    },
    dataProfile: config.dataProfile, opponentPool: opponentPool, replayBuffer: buffer.stats(),
    dataMixture: {
      totalGames: teacher.games.length + league.games.length,
      v0HardAnchor: teacher.games.length,
      frozenV13HybridVsV0Hard: league.games.filter(function (item) { return item.opponent === 'v0_hard'; }).length,
      frozenV13HybridSelf: league.games.filter(function (item) { return item.opponent === 'self'; }).length,
      controlledTop2Exploration: league.games.filter(function (item) { return item.opponent === 'explore_v0_hard'; }).length
    },
    historyModel: history.name, historySha256: history.sha256,
    initModel: initial.name, initSha256: initial.sha256,
    dataGenerationMode: config.skipTeacherFit && config.skipLeagueFit ? 'frozen-actors' : 'online-fit',
    leagueActorSha256: currentActorSha256, arenaAgent: config.arenaAgent,
    validation: validation, arena: arenaMetadata,
    elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1))
  };
  const payload = model.toJSON(metadata);
  const allSamples = teacher.samples.concat(league.samples);
  if (config.datasetOutput) {
    const datasetPath = path.resolve(config.datasetOutput);
    fs.mkdirSync(path.dirname(datasetPath), { recursive: true });
    fs.writeFileSync(datasetPath, allSamples.map(function (sample) { return JSON.stringify(sample); }).join('\n') + '\n');
    console.log('[Dataset] saved=' + datasetPath);
  }
  if (config.runOutput) {
    const runPath = path.resolve(config.runOutput);
    fs.mkdirSync(path.dirname(runPath), { recursive: true });
    fs.writeFileSync(runPath, JSON.stringify(buildRunLog(metadata, teacher.games, league.games, arena, {
      teacher: teacherHistory, selfPlay: leagueHistory
    }), null, 2) + '\n');
    console.log('[Run] saved=' + runPath);
  }
  if (config.output) {
    const outputPath = path.resolve(config.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n');
    console.log('[Model] saved=' + outputPath);
  }
  reporter.complete({ title: '中国跳棋 V' + config.version + ' 训练完成', status: metadata.status });
  console.log('\nTRAINING_RESULT ' + JSON.stringify(metadata));
  if (!config.summaryOnly) {
    console.log('MODEL_JSON_START');
    console.log(JSON.stringify(payload, null, 2));
    console.log('MODEL_JSON_END');
  }
}

main();
