'use strict';

const fs = require('fs');
const path = require('path');
const { PolicyValueModel, PuctMcts, ReplayBuffer, bidirectionalAStar, playSelfGame, playLeagueGame, splitByGroup, splitByGame } = require('./ai-engine');
const { ChineseCheckersAdapter, Core } = require('./ai-engine/games/chinese_checkers_adapter');
const { ChineseCheckersShortestPathSolver } = require('./ai-engine/games/chinese_checkers_shortest_path');
const { buildOpeningPair, selectOpening } = require('./ai-engine/games/chinese_checkers_openings');

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error('FAIL: ' + name);
  passed++;
  console.log('  PASS  ' + name);
}

const model = new PolicyValueModel({ stateSize: 2, actionSize: 1, hiddenSize: 8, actionHiddenSize: 6, seed: 9 });
const sample = { state: [1, 0], actions: [[1], [-1]], policy: [1, 0], value: 1 };
const before = model.predict(sample.state, sample.actions);
for (let i = 0; i < 500; i++) model.trainSample(sample, { learningRate: 0.012, l2: 0 });
const after = model.predict(sample.state, sample.actions);
ok('策略价值网络同时学习动态动作概率与局面价值',
  after.policy[0] > before.policy[0] && after.policy[0] > .82 && after.value > .72);

const restored = PolicyValueModel.fromJSON(model.toJSON({ game: 'toy' }));
const restoredPrediction = restored.predict(sample.state, sample.actions);
ok('模型格式可序列化、校验并无损恢复推理结果',
  Math.abs(restoredPrediction.policy[0] - after.policy[0]) < 1e-5 && Math.abs(restoredPrediction.value - after.value) < 1e-5);
ok('价值头可脱离动态动作头单独用于 alpha-beta/DFS 后继局面重排',
  Math.abs(restored.predictValue(sample.state) - restoredPrediction.value) < 1e-9);

const maskedModel = new PolicyValueModel({ stateSize: 2, actionSize: 1, hiddenSize: 8, actionHiddenSize: 6, seed: 19 });
const maskedValueWeights = maskedModel.weights.value.slice();
const maskedValueBias = maskedModel.weights.valueBias;
const maskedLoss = maskedModel.trainSample(Object.assign({}, sample, { value: -1, valueMask: 0 }), {
  learningRate: .01, valueWeight: 1, policyWeight: 1, l2: .1
});
ok('valueMask=0 的样本不会通过梯度、L2 或指标暗中训练价值头',
  maskedLoss.valueLoss === 0 && maskedLoss.valueSamples === 0 &&
  maskedModel.weights.valueBias === maskedValueBias &&
  maskedModel.weights.value.every(function (value, index) { return value === maskedValueWeights[index]; }));

const progressModel = new PolicyValueModel({
  format: 'dynamic-policy-value-v2', stateSize: 2, actionSize: 1,
  hiddenSize: 8, actionHiddenSize: 6, seed: 29
});
progressModel.metadata = { trainer: { lossWeights: { movesToGo: .1 } } };
const progressWeights = progressModel.weights.movesToGo.slice();
const progressBias = progressModel.weights.movesToGoBias;
const maskedProgressLoss = progressModel.trainSample(Object.assign({}, sample, {
  valueMask: 0, movesToGo: 1, progressMask: 0
}), { learningRate: .01, progressWeight: 1, l2: .1 });
const restoredProgress = PolicyValueModel.fromJSON(progressModel.toJSON(progressModel.metadata));
ok('v2 MTG 头可跨 checkpoint 推理，progressMask=0 时不会经梯度或 L2 暗中更新',
  maskedProgressLoss.progressSamples === 0 &&
  progressModel.weights.movesToGoBias === progressBias &&
  progressModel.weights.movesToGo.every(function (value, index) { return value === progressWeights[index]; }) &&
  Number.isFinite(restoredProgress.predictMovesToGo(sample.state)) && restoredProgress.hasTrainedProgressHead());

const toyGame = {
  initialState() { return { stones: 2, turn: 'a', winner: '' }; },
  currentPlayer(state) { return state.turn; },
  legalActions(state) { return state.winner ? [] : [1, 2].filter(take => take <= state.stones); },
  applyAction(state, take) {
    const remaining = state.stones - take;
    return { stones: remaining, turn: state.turn === 'a' ? 'b' : 'a', winner: remaining === 0 ? state.turn : '' };
  },
  isTerminal(state) { return !!state.winner; },
  terminalValue(state, perspective) { return state.winner ? (state.winner === perspective ? 1 : -1) : 0; },
  trainingOutcome(state, player) { return state.winner ? { value: state.winner === player ? 1 : -1, valueMask: 1 } : { value: 0, valueMask: 0 }; },
  actionKey(action) { return String(action); },
  encodeState(state, perspective) { return [state.stones / 2, perspective === 'a' ? 1 : -1]; },
  encodeAction(state, action) { return [action / 2]; }
};
const neutralModel = {
  predict(state, actions) { return { policy: actions.map(() => 1 / actions.length), value: 0 }; }
};
const search = new PuctMcts(toyGame, neutralModel, { simulations: 48, cPuct: 1.5, seed: 3 });
ok('通用 PUCT 能通过终局反向传播找到立即获胜动作', search.choose(toyGame.initialState(), 0).action === 2);

const graph = {
  A: ['B', 'C'], B: ['A', 'D'], C: ['A', 'D'], D: ['B', 'C']
};
const graphResult = bidirectionalAStar({
  start: 'A', goal: 'D', maxNodes: 20, timeLimitMs: 1000,
  key(state) { return state; },
  neighbors(state) { return graph[state].map(function (nextNode) { return { state: nextNode, action: state + '>' + nextNode }; }); },
  heuristic(state, target) { return state === target ? 0 : 1; },
  reverseAction(action) { return action.split('>').reverse().join('>'); }
});
ok('通用双向 A* 在相容下界下返回可证明的最短路',
  graphResult.found && graphResult.optimal && graphResult.cost === 2 && graphResult.actions.length === 2);

const shortestSolver = new ChineseCheckersShortestPathSolver({ corridorOnly: true });
const transferStart = shortestSolver.startState('red');
const transferGoal = shortestSolver.goalState('red');
const transferEstimate = shortestSolver.estimate(transferStart, transferGoal);
ok('跳棋最短路适配器使用文献中的 81 孔双人通道与 10 子状态',
  shortestSolver.allowedCells.length === 81 && transferStart.length === 10 && transferGoal.length === 10);
ok('A* 启发式使用唯一目标孔最小匹配，初始下界不会超过已知 27 步最优值',
  transferEstimate.assignmentDistance > 0 && transferEstimate.lowerBound >= 10 && transferEstimate.lowerBound <= 27);
const endgameStart = transferGoal.filter(function (index) {
  return shortestSolver.decodeState([index])[0] !== '14:0';
});
endgameStart.push(shortestSolver.normalizeState(['12:2'])[0]);
endgameStart.sort(function (left, right) { return left - right; });
const endgameResult = shortestSolver.solve(endgameStart, transferGoal, { maxNodes: 200, timeLimitMs: 1000 });
ok('双向 A* 能在跳棋残局中证明一步连跳最短解',
  endgameResult.found && endgameResult.optimal && endgameResult.cost === 1 &&
  endgameResult.actions[0].from === '12:2' && endgameResult.actions[0].target === '14:0');
const boundedTransfer = shortestSolver.solve(transferStart, transferGoal, { maxNodes: 30, timeLimitMs: 1000 });
ok('完整 10 子搜索超出预算时安全返回前沿建议，不伪造 27 步已求解',
  !boundedTransfer.optimal && boundedTransfer.expanded <= 30 && boundedTransfer.suggestedAction &&
  typeof boundedTransfer.suggestedAction.from === 'string');

const checkers = new ChineseCheckersAdapter({ maxMoves: 140 });
const initial = checkers.initialState();
const legal = checkers.legalActions(initial);
ok('中国跳棋适配器输出固定原始棋盘维度和动态合法动作',
  checkers.encodeState(initial, 'red').length === checkers.stateSize && legal.length > 0 &&
  checkers.encodeAction(initial, legal[0], 'red').length === checkers.actionSize);
const next = checkers.applyAction(initial, legal[0]);
ok('适配器执行动作时保持规则核心不可变并切换行动方',
  next.turn === 'blue' && next.ply === 1 && Core.positionKey(next.pieces) !== Core.positionKey(initial.pieces));
const plannerAdvice = checkers.shortestPathAdvice(initial, { maxNodes: 200, timeLimitMs: 1000 });
ok('单人 A* 规划只输出经过双人合法性校验的后端建议，不直接接管对抗落子',
  plannerAdvice && plannerAdvice.action && legal.some(function (action) {
    return checkers.actionKey(action) === checkers.actionKey(plannerAdvice.action);
  }));

const checkersV2 = new ChineseCheckersAdapter({ maxMoves: 140, featureVersion: 2 });
const v2Initial = checkersV2.initialState();
const v2Legal = checkersV2.legalActions(v2Initial);
ok('V1.3 特征编码追加对称棋理状态与移动收益且保持固定维度',
  checkersV2.stateSize === checkers.stateSize + Core.extractValueFeatures(v2Initial.pieces, 'red').length &&
  checkersV2.actionSize === checkers.actionSize + 1 &&
  checkersV2.encodeState(v2Initial, 'red').length === checkersV2.stateSize &&
  checkersV2.encodeAction(v2Initial, v2Legal[0], 'red').length === checkersV2.actionSize);

const groupedSamples = ['g1', 'g1', 'g2', 'g2', 'g3', 'g3', 'g4', 'g4'].map(function (gameId, index) {
  return { gameId: gameId, state: [index], source: index % 2 ? 'teacher' : 'league' };
});
const groupedSplit = splitByGame(groupedSamples, { seed: 17, validationFraction: .25 });
const trainIds = new Set(groupedSplit.train.map(function (sample) { return sample.gameId; }));
const validationIds = new Set(groupedSplit.validation.map(function (sample) { return sample.gameId; }));
ok('V1.1 按完整对局切分且训练集与验证集没有 gameId 交叉',
  groupedSplit.validationGameIds.length === 1 &&
  Array.from(trainIds).every(function (gameId) { return !validationIds.has(gameId); }));

const familySamples = [
  { gameId: 'a-red', splitGroupId: 'opening-a' }, { gameId: 'a-blue', splitGroupId: 'opening-a' },
  { gameId: 'b-red', splitGroupId: 'opening-b' }, { gameId: 'b-blue', splitGroupId: 'opening-b' },
  { gameId: 'c-red', splitGroupId: 'opening-c' }, { gameId: 'c-blue', splitGroupId: 'opening-c' },
  { gameId: 'd-red', splitGroupId: 'opening-d' }, { gameId: 'd-blue', splitGroupId: 'opening-d' }
];
const familySplit = splitByGroup(familySamples, { seed: 23, validationFraction: .25 });
const familyTrain = new Set(familySplit.train.map(function (sample) { return sample.splitGroupId; }));
const familyValidation = new Set(familySplit.validation.map(function (sample) { return sample.splitGroupId; }));
ok('V1.4 按 opening family 切分，换色与镜像对局不会跨训练/验证分区',
  familySplit.validationGroupIds.length === 1 &&
  Array.from(familyTrain).every(function (groupId) { return !familyValidation.has(groupId); }));

const replayBuffer = new ReplayBuffer({ capacity: 4 });
replayBuffer.addGame('old', [{ source: 'teacher' }, { source: 'teacher' }]);
replayBuffer.addGame('middle', [{ source: 'league' }, { source: 'league' }]);
replayBuffer.addGame('new', [{ source: 'history' }, { source: 'history' }]);
ok('V1.1 回放缓冲区超限时淘汰完整旧局而不残留半盘样本',
  replayBuffer.stats().samples === 4 && !replayBuffer.all().some(function (sample) { return sample.gameId === 'old'; }));

const completedTarget = checkers.trainingOutcome({ winner: 'red', ply: 100 }, 'red');
const truncatedTarget = checkers.trainingOutcome({ winner: '', ply: 100 }, 'red');
ok('完成局只使用真实 W/L，截断局显式 valueMask=0',
  completedTarget.value === 1 && completedTarget.valueMask === 1 &&
  truncatedTarget.value === 0 && truncatedTarget.valueMask === 0);

const endlessGame = {
  initialState() { return { turn: 'a', ply: 0, winner: '' }; }, currentPlayer(state) { return state.turn; },
  legalActions() { return [1]; }, applyAction(state) { return { turn: state.turn === 'a' ? 'b' : 'a', ply: state.ply + 1, winner: '' }; },
  isTerminal() { return false; }, terminalValue() { return .75; },
  trainingOutcome() { return { value: 0, valueMask: 0 }; }, actionKey() { return '1'; },
  encodeState(state) { return [state.ply, 0]; }, encodeAction() { return [1]; }
};
const truncatedSelfPlay = playSelfGame(endlessGame, neutralModel, {
  gameId: 'truncated-self', splitGroupId: 'opening-truncated', maxMoves: 1, simulations: 2, seed: 5
});
ok('PUCT 自我博弈截止时不能把搜索启发式重新写入训练价值',
  truncatedSelfPlay.samples.length === 1 && truncatedSelfPlay.samples[0].value === 0 &&
  truncatedSelfPlay.samples[0].valueMask === 0);

const wideWinGame = {
  currentPlayer(state) { return state.turn; },
  legalActions(state) { return state.winner ? [] : Array.from({ length: 64 }, function (_, index) { return index; }); },
  applyAction(state, action) { return { turn: 'b', winner: action === 63 ? 'a' : '', chosen: action }; },
  isTerminal(state) { return !!state.winner; },
  terminalValue(state, perspective) { return state.winner ? (state.winner === perspective ? 1 : -1) : 0; },
  actionKey(action) { return String(action).padStart(2, '0'); },
  encodeState() { return [0, 0]; }, encodeAction(state, action) { return [action / 64]; }
};
const lowWinPriorModel = {
  predict(state, actions) {
    const policy = actions.map(function (action) { return action[0] > .98 ? 1e-9 : 1; });
    const total = policy.reduce(function (sum, value) { return sum + value; }, 0);
    return { policy: policy.map(function (value) { return value / total; }), value: 0 };
  }
};
ok('PUCT 根节点会扫描全部合法动作并选择低先验立即胜招',
  new PuctMcts(wideWinGame, lowWinPriorModel, { simulations: 48 }).choose({ turn: 'a', winner: '' }, 0).action === 63);

function orderedTieGame(reverse) {
  return {
    currentPlayer(state) { return state.turn; },
    legalActions(state) { return state.chosen ? [] : (reverse ? ['b', 'a'] : ['a', 'b']); },
    applyAction(state, action) { return { turn: 'b', chosen: action, winner: '' }; },
    isTerminal(state) { return !!state.chosen; },
    terminalValue(state, perspective) {
      const rootValue = state.chosen === 'b' ? .6 : -.2;
      return perspective === 'a' ? rootValue : -rootValue;
    },
    actionKey(action) { return action; }, encodeState() { return [0, 0]; }, encodeAction() { return [0]; }
  };
}
const firstOrder = new PuctMcts(orderedTieGame(false), neutralModel, { simulations: 2, rootMinVisits: 1 }).choose({ turn: 'a' }, 0).action;
const reverseOrder = new PuctMcts(orderedTieGame(true), neutralModel, { simulations: 2, rootMinVisits: 1 }).choose({ turn: 'a' }, 0).action;
ok('PUCT 访问数并列时使用根视角 Q，且选择不依赖合法动作枚举顺序', firstOrder === 'b' && reverseOrder === 'b');

const leagueResult = playLeagueGame(toyGame, {
  a: function (state, player, ply, actions) { return { action: actions[actions.length - 1], policy: actions.map(function (action) { return action === 2 ? 1 : 0; }), source: 'candidate' }; },
  b: function (state, player, ply, actions) { return { action: actions[0], source: 'history' }; }
}, {
  gameId: 'toy-league', splitGroupId: 'toy-opening-family',
  openingId: 'toy-opening-a', openingPairId: 'toy-pair', openingFamilyId: 'toy-opening-family',
  maxMoves: 4, captureReplay: true
});
ok('通用联赛编排器记录对手池来源、gameId 与可回放动作',
  leagueResult.samples.length === 1 && leagueResult.samples[0].gameId === 'toy-league' &&
  leagueResult.samples[0].source === 'candidate' && leagueResult.samples[0].splitGroupId === 'toy-opening-family' &&
  leagueResult.replay.length === 1);

const openingPair = buildOpeningPair(checkersV2, 0, { seed: 31, minPlies: 4, maxPlies: 4, suiteId: 'test' });
const openingA = selectOpening(openingPair, 'a');
const openingB = selectOpening(openingPair, 'b');
const roundTripOpening = checkersV2.mirrorState(checkersV2.mirrorState(openingA.startState));
ok('paired opening 由确定性开局及精确换色镜像组成',
  openingA.openingFamilyId === openingB.openingFamilyId && openingA.openingId !== openingB.openingId &&
  openingA.startState.turn !== openingB.startState.turn &&
  Core.positionKey(roundTripOpening.pieces) === Core.positionKey(openingA.startState.pieces));

const trainerSource = fs.readFileSync(path.join(__dirname, 'scripts', 'train_checkers_robot_v11.js'), 'utf8');
const packageScripts = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).scripts;
ok('V1.4 历史模型缺失时 fail-closed，不再静默克隆当前模型',
  !/current-teacher-snapshot|fallback=current-teacher/.test(trainerSource) &&
  /冻结历史 checkpoint 不存在/.test(trainerSource));
ok('V1.4 默认训练与竞技场强制使用 hybrid 并固定历史 checkpoint hash',
  /leagueAgent: stringArg\('league-agent', 'hybrid'\)/.test(trainerSource) &&
  /arenaAgent: stringArg\('arena-agent', 'hybrid'\)/.test(trainerSource) &&
  /--league-agent hybrid --arena-agent hybrid/.test(packageScripts['train:checkers-robot']) &&
  /--history-sha256 [a-f0-9]{64}/.test(packageScripts['train:checkers-robot']) &&
  /--init-sha256 [a-f0-9]{64}/.test(packageScripts['train:checkers-robot']) &&
  /--skip-teacher-fit --skip-league-fit/.test(packageScripts['train:checkers-robot']));

const numpyTrainerSource = fs.readFileSync(path.join(__dirname, 'scripts', 'train_policy_value_numpy.py'), 'utf8');
ok('V1.4 NumPy 初始化必须显式选择 scratch/policy/all 并记录逐组件来源',
  /"--init-components", required=True/.test(numpyTrainerSource) &&
  /POLICY_COMPONENTS/.test(numpyTrainerSource) && /"componentSources"/.test(numpyTrainerSource) &&
  /"valueBrier"/.test(numpyTrainerSource) && /"valueCalibration"/.test(numpyTrainerSource) &&
  /"movesToGoMae"/.test(numpyTrainerSource) && /dynamic-policy-value-v2/.test(numpyTrainerSource));

const guidedMove = checkers.guidedBaselineAction(initial, restored, function () { return 0; });
ok('模型增强 DFS 在模型维度不兼容时安全回退到合法 V0 hard 走法',
  legal.some(function (action) { return checkers.actionKey(action) === checkers.actionKey(guidedMove); }));

['checkers-policy-value-v1_3-numpy.json'].forEach(function (fileName) {
  const checkpointPath = path.join(__dirname, 'models', fileName);
  if (!fs.existsSync(checkpointPath)) return;
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const trainedModel = PolicyValueModel.fromJSON(checkpoint);
  const adapter = trainedModel.stateSize === checkersV2.stateSize ? checkersV2 : checkers;
  const adapterInitial = adapter.initialState();
  const adapterLegal = adapter.legalActions(adapterInitial);
  const prediction = trainedModel.predict(
    adapter.encodeState(adapterInitial, adapterInitial.turn),
    adapterLegal.map(function (action) { return adapter.encodeAction(adapterInitial, action, adapterInitial.turn); })
  );
  ok(fileName + ' 可由 JS 通用模型加载并对真实合法动作推理',
    prediction.policy.length === adapterLegal.length &&
    Math.abs(prediction.policy.reduce(function (sum, value) { return sum + value; }, 0) - 1) < 1e-9 &&
    prediction.value >= -1 && prediction.value <= 1);
  const guidedDecision = adapter.guidedBaselineDecision(adapterInitial, trainedModel, function () { return 0; });
  ok(fileName + ' hybrid 决策 trace 可精确对应合法动作、候选分数与软策略标签',
    guidedDecision.action && guidedDecision.trace &&
    guidedDecision.trace.candidateMask.length === adapterLegal.length &&
    guidedDecision.trace.finalHybridScores.length === adapterLegal.length &&
    guidedDecision.trace.selectedIndex >= 0 &&
    adapter.actionKey(adapterLegal[guidedDecision.trace.selectedIndex]) === adapter.actionKey(guidedDecision.action) &&
    Math.abs(guidedDecision.policyTarget.reduce(function (sum, value) { return sum + value; }, 0) - 1) < 1e-9);
});

console.log('\n✅ 可复用 AI 引擎测试全部通过（' + passed + ' 项）');
