'use strict';

/**
 * 训练数据与竞技场编排层。
 * 本文件只依赖通用 GameAdapter，不包含任何中国跳棋规则，可直接用于后续棋类。
 */

const { PuctMcts } = require('./puct_mcts');
const { createRandom } = require('./policy_value_model');

/** 按离散概率分布采样动作；尾项兜底用于吸收浮点累计误差。 */
function chooseFromDistribution(actions, probabilities, random) {
  let cursor = random();
  for (let index = 0; index < probabilities.length; index++) {
    cursor -= probabilities[index];
    if (cursor <= 0) return actions[index];
  }
  return actions[actions.length - 1];
}

/** 将任意非负权重归一化为概率分布。 */
function normalize(values) {
  const total = values.reduce(function (sum, value) { return sum + Math.max(0, Number(value) || 0); }, 0) || 1;
  return values.map(function (value) { return Math.max(0, Number(value) || 0) / total; });
}

/**
 * Training labels are an explicit adapter contract. Search evaluation is not
 * a valid substitute: a truncated game must carry valueMask=0 even when the
 * search adapter can still estimate the position heuristically.
 */
function requireTrainingOutcome(game, finalState, player) {
  if (!game || typeof game.trainingOutcome !== 'function') {
    throw new Error('训练数据生成要求 GameAdapter 实现 trainingOutcome(finalState, player)');
  }
  const outcome = game.trainingOutcome(finalState, player);
  const value = Number(outcome && outcome.value);
  const valueMask = Number(outcome && outcome.valueMask);
  if (!Number.isFinite(value) || value < -1 || value > 1 || (valueMask !== 0 && valueMask !== 1)) {
    throw new Error('trainingOutcome 必须返回 value∈[-1,1] 与 valueMask∈{0,1}');
  }
  if (valueMask === 0 && value !== 0) throw new Error('未监督的训练结果必须使用中性 value=0');
  return { value: value, valueMask: valueMask, completed: valueMask === 1 };
}

function initialStateFor(game, settings) {
  return settings.startState || game.initialState();
}

function sampleMetadata(settings) {
  return {
    schemaVersion: String(settings.schemaVersion || 'dynamic-policy-v1'),
    openingId: String(settings.openingId || ''),
    openingPairId: String(settings.openingPairId || ''),
    openingFamilyId: String(settings.openingFamilyId || ''),
    splitGroupId: String(settings.splitGroupId || '')
  };
}

/**
 * 完成一盘 PUCT 自我博弈并生成 AlphaZero 风格训练样本。
 * 样本的 policy 来自搜索访问次数，value 在对局结束后按记录时的玩家视角回填。
 *
 * @returns {{state:*, samples:Object[], moves:number, winner:string, replay:Object[]}}
 */
function playSelfGame(game, model, options) {
  const settings = Object.assign({ gameId: '', simulations: 24, maxMoves: 140, temperatureMoves: 14, seed: 1, heuristicPriorWeight: 0.55, heuristicValueWeight: 0.35, captureReplay: false }, options || {});
  if (!settings.gameId || !settings.splitGroupId) throw new Error('自我博弈训练要求 gameId 与 splitGroupId');
  const random = typeof settings.random === 'function' ? settings.random : createRandom(settings.seed);
  const mcts = new PuctMcts(game, model, {
    simulations: settings.simulations,
    cPuct: settings.cPuct || 2.2,
    dirichletAlpha: settings.dirichletAlpha || 0.3,
    dirichletWeight: Number.isFinite(Number(settings.dirichletWeight)) ? Number(settings.dirichletWeight) : 0.2,
    heuristicPriorWeight: settings.heuristicPriorWeight,
    heuristicValueWeight: settings.heuristicValueWeight,
    random: random
  });
  let state = initialStateFor(game, settings);
  const records = [];
  const replay = [];
  let moves = 0;
  for (; moves < settings.maxMoves && !game.isTerminal(state); moves++) {
    const player = game.currentPlayer(state);
    const actions = game.legalActions(state);
    if (!actions.length) break;
    const result = mcts.choose(state, moves < settings.temperatureMoves ? 1 : 0.08);
    if (!result.action) break;
    const policyByKey = new Map(result.policy.map(function (item) { return [game.actionKey(item.action), item.probability]; }));
    const policy = normalize(actions.map(function (action) { return policyByKey.get(game.actionKey(action)) || 0; }));
    records.push({
      state: game.encodeState(state, player),
      actions: actions.map(function (action) { return game.encodeAction(state, action, player); }),
      actionKeys: actions.map(function (action) { return game.actionKey(action); }),
      policy: policy,
      player: player,
      ply: Math.max(0, Math.floor(Number(state.ply) || moves)),
      searchValue: result.value
    });
    if (settings.captureReplay) {
      replay.push({
        ply: moves + 1,
        player: player,
        from: result.action.from,
        target: result.action.target,
        kind: result.action.kind || '',
        searchValue: Number(Number(result.value || 0).toFixed(4))
      });
    }
    state = game.applyAction(state, result.action);
  }
  const samples = records.map(function (record) {
    const outcome = requireTrainingOutcome(game, state, record.player);
    return Object.assign({
      gameId: String(settings.gameId), state: record.state, actions: record.actions,
      actionKeys: record.actionKeys, policy: record.policy, player: record.player,
      ply: record.ply, finalPly: Math.max(0, Math.floor(Number(state.ply) || 0)),
      value: outcome.value, valueMask: outcome.valueMask,
      movesToGo: outcome.valueMask === 1
        ? Math.max(0, Math.min(1, (Math.floor(Number(state.ply) || 0) - record.ply) / Math.max(1, settings.maxMoves)))
        : 0,
      progressMask: outcome.valueMask,
      progressScale: Math.max(1, settings.maxMoves),
      completed: outcome.completed, actorType: 'puct', candidateMask: [],
      baseDfsScores: [], learnedScores: [], finalHybridScores: [], selectedIndex: -1,
      source: 'self_play'
    }, sampleMetadata(settings));
  });
  return Object.assign({ state: state, samples: samples, moves: moves, finalPly: Math.max(moves, Math.floor(Number(state.ply) || 0)), winner: state.winner || '', replay: replay }, sampleMetadata(settings));
}

/**
 * 在两个无状态代理之间运行一盘对局。代理按玩家标识注入，便于交换先后手消除偏差。
 */
function playArenaGame(game, agents, options) {
  const settings = Object.assign({ maxMoves: 140, captureReplay: false }, options || {});
  let state = initialStateFor(game, settings);
  const replay = [];
  let moves = 0;
  for (; moves < settings.maxMoves && !game.isTerminal(state); moves++) {
    const player = game.currentPlayer(state);
    const agent = agents[player];
    if (typeof agent !== 'function') throw new Error('竞技场缺少玩家代理：' + player);
    const action = agent(state, player, moves);
    if (!action) break;
    if (settings.captureReplay) replay.push({ ply: moves + 1, player: player, from: action.from, target: action.target, kind: action.kind || '' });
    state = game.applyAction(state, action);
    if (typeof settings.onMove === 'function') settings.onMove({
      ply: moves + 1, player: player, from: action.from, target: action.target,
      kind: action.kind || '', state: state
    });
  }
  return Object.assign({ state: state, moves: moves, finalPly: Math.max(moves, Math.floor(Number(state.ply) || 0)), winner: state.winner || '', replay: replay }, sampleMetadata(settings));
}

/**
 * Run one opponent-pool game and produce training samples for both sides.
 * Each injected agent returns {action, policy, source}; this keeps search,
 * teacher and frozen-checkpoint agents interchangeable.
 */
function playLeagueGame(game, agents, options) {
  const settings = Object.assign({ maxMoves: 140, gameId: '', captureReplay: false }, options || {});
  if (!settings.gameId || !settings.splitGroupId) throw new Error('联赛训练对局需要 gameId 与 splitGroupId');
  let state = initialStateFor(game, settings);
  const records = [];
  const replay = [];
  let moves = 0;
  for (; moves < settings.maxMoves && !game.isTerminal(state); moves++) {
    const player = game.currentPlayer(state);
    const actions = game.legalActions(state);
    if (!actions.length) break;
    const agent = agents[player];
    if (typeof agent !== 'function') throw new Error('联赛缺少玩家代理：' + player);
    const decision = agent(state, player, moves, actions);
    if (!decision || !decision.action) break;
    let policy = Array.isArray(decision.policy) && decision.policy.length === actions.length
      ? normalize(decision.policy) : actions.map(function (action) { return game.actionKey(action) === game.actionKey(decision.action) ? 1 : 0; });
    if (policy.reduce(function (sum, value) { return sum + value; }, 0) <= 0) {
      policy = actions.map(function (action) { return game.actionKey(action) === game.actionKey(decision.action) ? 1 : 0; });
    }
    const opponentAgent = Object.keys(agents).filter(function (key) { return key !== player; })
      .map(function (key) { return agents[key]; })
      .find(function (candidate) { return typeof candidate === 'function'; });
    records.push({
      gameId: settings.gameId, state: game.encodeState(state, player),
      actions: actions.map(function (action) { return game.encodeAction(state, action, player); }),
      actionKeys: actions.map(function (action) { return game.actionKey(action); }),
      policy: policy, player: player,
      ply: Math.max(0, Math.floor(Number(state.ply) || moves)),
      decisionTrace: decision.trace || null,
      actorType: String(decision.actorType || ''),
      actorCheckpointSha256: String(decision.actorCheckpointSha256 || ''),
      opponentId: String(opponentAgent && opponentAgent.actorId || settings.opponentId || ''),
      opponentCheckpointSha256: String(opponentAgent && opponentAgent.checkpointSha256 || ''),
      searchConfigHash: String(decision.searchConfigHash || ''),
      source: String(decision.source || 'league')
    });
    if (settings.captureReplay) replay.push({
      ply: moves + 1, player: player, from: decision.action.from,
      target: decision.action.target, kind: decision.action.kind || '',
      searchValue: Number(Number(decision.value || 0).toFixed(4))
    });
    state = game.applyAction(state, decision.action);
    if (typeof settings.onMove === 'function') settings.onMove({
      ply: moves + 1, player: player, from: decision.action.from,
      target: decision.action.target, kind: decision.action.kind || '',
      searchValue: decision.value, state: state
    });
  }
  const samples = records.map(function (record) {
    const outcome = requireTrainingOutcome(game, state, record.player);
    const trace = record.decisionTrace || {};
    return Object.assign({
      gameId: record.gameId, state: record.state, actions: record.actions,
      actionKeys: record.actionKeys, policy: record.policy, ply: record.ply,
      player: record.player, finalPly: Math.max(0, Math.floor(Number(state.ply) || 0)),
      value: outcome.value, valueMask: outcome.valueMask, completed: outcome.completed,
      movesToGo: outcome.valueMask === 1
        ? Math.max(0, Math.min(1, (Math.floor(Number(state.ply) || 0) - record.ply) / Math.max(1, settings.maxMoves)))
        : 0,
      progressMask: outcome.valueMask,
      progressScale: Math.max(1, settings.maxMoves),
      actorType: record.actorType, actorCheckpointSha256: record.actorCheckpointSha256,
      opponentId: record.opponentId, searchConfigHash: record.searchConfigHash,
      opponentCheckpointSha256: record.opponentCheckpointSha256,
      candidateMask: trace.candidateMask || [], baseDfsScores: trace.baseDfsScores || [],
      learnedScores: trace.learnedScores || [], finalHybridScores: trace.finalHybridScores || [],
      selectedIndex: Number.isInteger(trace.selectedIndex) ? trace.selectedIndex : -1,
      bestBaseMargin: Number.isFinite(Number(trace.bestBaseMargin)) ? Number(trace.bestBaseMargin) : null,
      searchNodes: Number.isFinite(Number(trace.searchNodes)) ? Number(trace.searchNodes) : 0,
      source: record.source
    }, sampleMetadata(settings));
  });
  return Object.assign({ state: state, samples: samples, moves: moves, finalPly: Math.max(moves, Math.floor(Number(state.ply) || 0)), winner: state.winner || '', replay: replay }, sampleMetadata(settings));
}

module.exports = {
  playSelfGame: playSelfGame, playArenaGame: playArenaGame, playLeagueGame: playLeagueGame,
  chooseFromDistribution: chooseFromDistribution, normalize: normalize,
  requireTrainingOutcome: requireTrainingOutcome
};
