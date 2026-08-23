'use strict';

/**
 * 中国跳棋到通用 AI 引擎的适配层。
 *
 * 状态编码（当前行动方统一朝“向下”前进）：
 * - 121 维占位通道：己方=1、对方=-1、空位=0；
 * - 121 维营区通道：目标营=1、出生营=-1、普通格=0；
 * - 1 维对局阶段：ply / maxMoves，截断到 [0, 1]。
 *
 * 动作编码是 12 维起终点/位移/跳跃/目标营特征。适配器不修改规则核心，所有
 * applyAction 都返回新状态，便于搜索树安全共享父局面。
 */

const Core = require('../../public/checkers/checkers_core');
const V0Model = require('../../public/checkers/checkers_ai_model');
const { softmax } = require('../policy_value_model');
const { ChineseCheckersShortestPathSolver } = require('./chinese_checkers_shortest_path');

/** 实现通用双人零和 GameAdapter 契约的中国跳棋适配器。 */
class ChineseCheckersAdapter {
  constructor(options) {
    this.options = Object.assign({ maxMoves: 140, heuristicTemperature: 1 }, options || {});
    this.featureVersion = Math.max(1, Math.min(2, Math.floor(Number(this.options.featureVersion) || 1)));
    this.players = ['red', 'blue'];
    this.structuralFeatureSize = this.featureVersion >= 2
      ? Core.extractValueFeatures(Core.createInitialPieces(), 'red').length : 0;
    this.stateSize = Core.BOARD_CELLS.length * 2 + 1 + this.structuralFeatureSize;
    this.actionSize = this.featureVersion >= 2 ? 13 : 12;
    this.cells = Core.BOARD_CELLS;
    this.cellByKey = new Map(this.cells.map(function (cell) { return [cell.key, cell]; }));
    this.indexByKey = new Map(this.cells.map(function (cell, index) { return [cell.key, index]; }));
    this.homeCamp = { red: new Set(Core.TOP_CAMP), blue: new Set(Core.BOTTOM_CAMP) };
    this.goalCamp = { red: new Set(Core.BOTTOM_CAMP), blue: new Set(Core.TOP_CAMP) };
    this.shortestPathSolver = new ChineseCheckersShortestPathSolver({ corridorOnly: true });
  }

  opposite(player) { return player === 'red' ? 'blue' : 'red'; }
  currentPlayer(state) { return state.turn; }
  actionKey(action) { return action.from + '>' + action.target; }

  /** @returns {{pieces:Object, turn:string, winner:string, ply:number, recent:string[]}} */
  initialState() {
    return { pieces: Core.createInitialPieces(), turn: 'red', winner: '', ply: 0, recent: [] };
  }

  /** 返回当前行动方的全部合法单步或连续跳动作。 */
  legalActions(state) {
    if (this.isTerminal(state)) return [];
    return Core.listMoves(state.pieces, state.turn);
  }

  /** 执行动作并返回新局面；非法动作立即抛错，避免污染训练数据。 */
  applyAction(state, action) {
    const result = Core.applyMove(state.pieces, state.turn, action.from, action.target);
    if (!result) throw new Error('跳棋适配器收到非法走法：' + this.actionKey(action));
    const key = Core.positionKey(result.pieces);
    const recent = (state.recent || []).concat(key).slice(-20);
    return {
      pieces: result.pieces,
      turn: this.opposite(state.turn),
      winner: result.winner || '',
      ply: (state.ply || 0) + 1,
      recent: recent,
      lastAction: { from: action.from, target: action.target, kind: result.kind }
    };
  }

  isTerminal(state) { return !!state.winner || (state.ply || 0) >= this.options.maxMoves; }

  /** 返回指定玩家视角的 [-1, 1] 搜索叶价值；步数截断时允许使用启发式估值。 */
  searchTerminalValue(state, perspective) {
    if (state.winner) return state.winner === perspective ? 1 : -1;
    return Math.tanh(Core.evaluateHybridPosition(state.pieces, perspective, V0Model) / 1800);
  }

  /** PUCT 的通用 GameAdapter 契约；训练数据生成器不得把它当作胜负标签。 */
  terminalValue(state, perspective) { return this.searchTerminalValue(state, perspective); }
  stateKey(state) { return state.turn[0] + ':' + Core.positionKey(state.pieces); }

  /** 将棋盘旋转 180° 并交换双方，用于 paired-opening 的严格换色镜像。 */
  mirrorState(state) {
    const pieces = {};
    Object.keys(state.pieces || {}).forEach((key) => {
      const cell = this.cellByKey.get(key);
      if (!cell) throw new Error('无法镜像棋盘外位置：' + key);
      const mirroredKey = Core.keyOf(16 - cell.row, -cell.unit);
      pieces[mirroredKey] = this.opposite(state.pieces[key]);
    });
    const mirrored = {
      pieces: pieces,
      turn: this.opposite(state.turn),
      winner: state.winner ? this.opposite(state.winner) : '',
      ply: Math.max(0, Math.floor(Number(state.ply) || 0)),
      recent: []
    };
    if (state.lastAction) {
      const mirrorKey = (key) => {
        const cell = this.cellByKey.get(key);
        return Core.keyOf(16 - cell.row, -cell.unit);
      };
      mirrored.lastAction = {
        from: mirrorKey(state.lastAction.from), target: mirrorKey(state.lastAction.target),
        kind: state.lastAction.kind || ''
      };
    }
    return mirrored;
  }

  /** 将双方视角旋转到同一朝向，使同一模型可同时服务红蓝双方。 */
  canonicalCell(cell, perspective) {
    if (perspective === 'red') return { row: cell.row, unit: cell.unit };
    return { row: 16 - cell.row, unit: -cell.unit };
  }

  canonicalKey(cell, perspective) {
    const canonical = this.canonicalCell(cell, perspective);
    return Core.keyOf(canonical.row, canonical.unit);
  }

  /** @returns {number[]} V1 为 243 维；V2 追加 20 维对称棋理特征。 */
  encodeState(state, perspective) {
    const occupancy = new Array(this.cells.length).fill(0);
    Object.keys(state.pieces).forEach((key) => {
      const cell = this.cellByKey.get(key);
      const canonicalKey = this.canonicalKey(cell, perspective);
      const index = this.indexByKey.get(canonicalKey);
      occupancy[index] = state.pieces[key] === perspective ? 1 : -1;
    });
    const camps = this.cells.map(function (cell) {
      if (cell.row <= 3) return -1;
      if (cell.row >= 13) return 1;
      return 0;
    });
    const encoded = occupancy.concat(camps, [Math.max(0, Math.min(1, (state.ply || 0) / this.options.maxMoves))]);
    return this.featureVersion >= 2
      ? encoded.concat(Core.extractValueFeatures(state.pieces, perspective))
      : encoded;
  }

  /** @returns {number[]} 固定 12 维动作向量，与具体合法动作数量无关。 */
  encodeAction(state, action, perspective) {
    const fromCell = this.canonicalCell(this.cellByKey.get(action.from), perspective);
    const targetCell = this.canonicalCell(this.cellByKey.get(action.target), perspective);
    const deltaRow = targetCell.row - fromCell.row;
    const deltaUnit = targetCell.unit - fromCell.unit;
    const fromGoal = this.goalCamp[perspective].has(action.from);
    const targetGoal = this.goalCamp[perspective].has(action.target);
    const encoded = [
      fromCell.row / 16,
      fromCell.unit / 12,
      targetCell.row / 16,
      targetCell.unit / 12,
      deltaRow / 16,
      deltaUnit / 24,
      Math.abs(deltaRow) / 16,
      Math.abs(deltaUnit) / 24,
      action.kind === 'jump' ? 1 : 0,
      !fromGoal && targetGoal ? 1 : 0,
      fromGoal && !targetGoal ? 1 : 0,
      targetGoal ? 1 : 0
    ];
    // V2 将规则引擎中已验证的移动收益作为显式输入。它不是答案标签，模型仍需
    // 结合完整局面决定何时前进、占中、长跳或保护已进入目标营的棋子。
    if (this.featureVersion >= 2) encoded.push(Math.max(-1, Math.min(1, Core.moveScore(state.pieces, perspective, action) / 300)));
    return encoded;
  }

  /** 将现有 V0 评估器转换为合法动作上的软策略，用于冷启动和搜索保护。 */
  heuristicPolicy(state, actions, perspective) {
    if (!actions.length) return [];
    const base = Core.evaluateHybridPosition(state.pieces, perspective, V0Model);
    const recent = new Set(state.recent || []);
    const logits = actions.map((action) => {
      const result = Core.applyMove(state.pieces, perspective, action.from, action.target);
      if (result.winner === perspective) return 18;
      const delta = Core.evaluateHybridPosition(result.pieces, perspective, V0Model) - base;
      const repeatPenalty = recent.has(Core.positionKey(result.pieces)) ? 5 : 0;
      return delta / 135 + Core.moveScore(state.pieces, perspective, action) / 85 - repeatPenalty;
    });
    const temperature = Math.max(0.2, Number(this.options.heuristicTemperature) || 1);
    return softmax(logits.map(function (value) { return value / temperature; }));
  }

  heuristicValue(state, perspective) {
    return Math.tanh(Core.evaluateHybridPosition(state.pieces, perspective, V0Model) / 1800);
  }

  /**
   * 唯一训练结果入口。真实完赛局返回 W/L；截止局永远是 value=0、valueMask=0，
   * 因而搜索启发式怎样变化都不会污染监督标签。
   */
  trainingOutcome(finalState, player) {
    if (!finalState.winner) return { value: 0, valueMask: 0 };
    return { value: finalState.winner === player ? 1 : -1, valueMask: 1 };
  }

  /** 调用当前线上 V0 代理，作为教师数据来源与晋级竞技场基准。 */
  baselineAction(state, level, random) {
    return Core.chooseAiMove(state.pieces, state.turn, level || 'hard', random, {
      model: V0Model,
      recentPositions: state.recent || []
    });
  }

  /**
   * 对当前行动方做受预算保护的“无对手单人搬运”规划。建议仍须存在于真实双人
   * 合法动作中；对手占位使路线失效、或棋子进入侧营时，返回 null 而不是强行套用。
   */
  shortestPathAdvice(state, options) {
    const settings = Object.assign({ maxNodes: 200, timeLimitMs: 45, heuristicWeight: 1 }, options || {});
    try {
      const army = this.shortestPathSolver.normalizeState(state.pieces, state.turn);
      const goal = this.shortestPathSolver.goalState(state.turn);
      const result = this.shortestPathSolver.solve(army, goal, {
        maxNodes: settings.maxNodes,
        timeLimitMs: settings.timeLimitMs,
        heuristicWeight: settings.heuristicWeight
      });
      const legalKeys = new Set(this.legalActions(state).map((action) => this.actionKey(action)));
      if (!result.suggestedAction || !legalKeys.has(this.actionKey(result.suggestedAction))) return null;
      return {
        action: result.suggestedAction,
        lowerBound: result.initialEstimate.lowerBound,
        assignmentDistance: result.initialEstimate.assignmentDistance,
        solved: result.found,
        optimal: result.optimal,
        expanded: result.expanded,
        elapsedMs: result.elapsedMs
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 用通用策略价值 checkpoint 重排 V0 hard 的根候选，形成稳定的混合搜索代理。
   * 策略头负责“教师会选哪步”，价值头评估落子后的对手视角；DFS 继续负责短期
   * 战术和直接胜棋。这比完全用尚未成熟的价值头替换搜索叶评估更安全、也更快。
   */
  guidedBaselineDecision(state, model, random, options) {
    const randomFn = typeof random === 'function' ? random : Math.random;
    const actions = this.legalActions(state);
    if (!actions.length) return { action: null, policyTarget: [], trace: null };
    if (!model || typeof model.predict !== 'function' || typeof model.predictValue !== 'function' ||
      model.stateSize !== this.stateSize || model.actionSize !== this.actionSize) {
      const action = this.baselineAction(state, 'hard', randomFn);
      const selectedKey = action ? this.actionKey(action) : null;
      const selectedIndex = selectedKey === null
        ? -1
        : actions.findIndex((candidate) => this.actionKey(candidate) === selectedKey);
      const fallbackMask = actions.map(function (_candidate, index) { return index === selectedIndex ? 1 : 0; });
      return {
        action: action,
        policyTarget: actions.map(function (_candidate, index) { return index === selectedIndex ? 1 : 0; }),
        trace: {
          actorType: 'v0-hard-fallback', candidateMask: fallbackMask,
          baseDfsScores: actions.map(function () { return null; }), learnedScores: actions.map(function () { return 0; }),
          finalHybridScores: actions.map(function () { return null; }), selectedIndex: selectedIndex,
          bestBaseMargin: null, searchNodes: 0
        }
      };
    }
    const settings = Object.assign({
      learnedMoveWeight: 180, policyWeight: .58, valueWeight: .42,
      safeLearnedMargin: 100, policyTemperature: .75,
      // MTG is diagnostic by default. It must be explicitly enabled by an
      // ablation after proving that shorter games do not come from faster losses.
      movesToGoStrengthMargin: 40, enableMovesToGo: false,
      enableTranspositionTable: false
    }, options || {});
    const player = state.turn;
    const prediction = model.predict(
      this.encodeState(state, player),
      actions.map((action) => this.encodeAction(state, action, player))
    );
    const logPriors = prediction.policy.map(function (value) { return Math.log(Math.max(1e-8, value)); });
    const meanLogPrior = logPriors.reduce(function (sum, value) { return sum + value; }, 0) / logPriors.length;
    // Core hard 只搜索 moveScore 前 20 项；多保留 4 项以兼容可调 rootWidth。
    const evaluatedKeys = new Set(actions.slice().sort(function (left, right) {
      return Core.moveScore(state.pieces, player, right) - Core.moveScore(state.pieces, player, left);
    }).slice(0, 24).map((action) => this.actionKey(action)));
    const scores = {};
    const successorValues = actions.map(function () { return null; });
    const successorMovesToGo = actions.map(function () { return null; });
    actions.forEach((action, index) => {
      const key = this.actionKey(action);
      const policySignal = Math.tanh((logPriors[index] - meanLogPrior) / 2.4);
      let valueSignal = 0;
      if (evaluatedKeys.has(key)) {
        const next = this.applyAction(state, action);
        valueSignal = next.winner === player
          ? 1
          : -model.predictValue(this.encodeState(next, next.turn));
        successorValues[index] = valueSignal;
        if (next.winner === player) successorMovesToGo[index] = 0;
        else if (typeof model.predictMovesToGo === 'function') {
          const prediction = model.predictMovesToGo(this.encodeState(next, next.turn));
          successorMovesToGo[index] = Number.isFinite(Number(prediction)) ? Number(prediction) : null;
        }
      }
      scores[key] = settings.policyWeight * policySignal + settings.valueWeight * valueSignal;
    });
    const analysis = Core.analyzeAiMoves(state.pieces, player, 'hard', {
      model: V0Model, recentPositions: state.recent || [],
      learnedMoveScores: scores, learnedMoveWeight: settings.learnedMoveWeight,
      safeLearnedMargin: settings.safeLearnedMargin,
      enableTranspositionTable: settings.enableTranspositionTable === true
    });
    const actionIndex = new Map(actions.map((action, index) => [this.actionKey(action), index]));
    const candidateByKey = new Map(analysis.candidates.map((candidate) => [this.actionKey(candidate.action), candidate]));
    const candidateMask = actions.map((action) => candidateByKey.has(this.actionKey(action)) ? 1 : 0);
    const baseDfsScores = actions.map((action) => {
      const candidate = candidateByKey.get(this.actionKey(action));
      return candidate ? candidate.baseDfsScore : null;
    });
    const learnedScores = actions.map((action) => Number(scores[this.actionKey(action)]) || 0);
    const requestedMargin = Number(settings.safeLearnedMargin);
    const safeMargin = Number.isFinite(requestedMargin) ? Math.max(0, Math.min(5000, requestedMargin)) : Infinity;
    const learnedWeight = Math.max(0, Math.min(600, Number(settings.learnedMoveWeight) || 0));
    const finalHybridScores = actions.map((action, index) => {
      const baseScore = baseDfsScores[index];
      if (!Number.isFinite(baseScore)) return null;
      if (analysis.bestBaseScore - baseScore > safeMargin) return baseScore;
      return baseScore + Math.max(-2, Math.min(2, learnedScores[index])) * learnedWeight;
    });
    let action = null;
    let strengthSelectedIndex = -1;
    let movesToGoApplied = false;
    let policyTarget = actions.map(function () { return 0; });
    if (analysis.winningMoves.length) {
      action = analysis.winningMoves[Math.floor(randomFn() * analysis.winningMoves.length)];
      const winIndex = actionIndex.get(this.actionKey(action));
      if (Number.isInteger(winIndex)) {
        policyTarget[winIndex] = 1;
        // Direct wins are scanned across every legal root move and can sit
        // outside the normal root width. They must still be trainable.
        candidateMask[winIndex] = 1;
      }
    } else {
      const finiteScores = finalHybridScores.filter(Number.isFinite);
      const bestScore = finiteScores.length ? Math.max.apply(null, finiteScores) : -Infinity;
      const bestIndices = [];
      finalHybridScores.forEach(function (score, index) { if (score === bestScore) bestIndices.push(index); });
      const selectedIndex = bestIndices.length ? bestIndices[Math.floor(randomFn() * bestIndices.length)] : 0;
      strengthSelectedIndex = selectedIndex;
      action = actions[selectedIndex];
      const mean = finiteScores.reduce(function (sum, value) { return sum + value; }, 0) / Math.max(1, finiteScores.length);
      const variance = finiteScores.reduce(function (sum, value) { const delta = value - mean; return sum + delta * delta; }, 0) / Math.max(1, finiteScores.length);
      const scale = Math.max(40, Math.sqrt(variance)) * Math.max(.2, Number(settings.policyTemperature) || .75);
      const candidateIndices = finalHybridScores.map(function (score, index) { return Number.isFinite(score) ? index : -1; }).filter(function (index) { return index >= 0; });
      const candidatePolicy = softmax(candidateIndices.map(function (index) { return finalHybridScores[index] / scale; }));
      candidateIndices.forEach(function (index, offset) { policyTarget[index] = candidatePolicy[offset]; });
      const useMovesToGo = settings.enableMovesToGo !== false &&
        typeof model.hasTrainedProgressHead === 'function' && model.hasTrainedProgressHead();
      const strengthMargin = Math.max(0, Number(settings.movesToGoStrengthMargin) || 0);
      if (useMovesToGo && Number(successorValues[selectedIndex]) > 0) {
        const tempoCandidates = candidateIndices.filter(function (index) {
          return finalHybridScores[index] >= bestScore - strengthMargin &&
            Number(successorValues[index]) > 0 && Number.isFinite(successorMovesToGo[index]);
        }).sort((left, right) => {
          return successorMovesToGo[left] - successorMovesToGo[right] ||
            finalHybridScores[right] - finalHybridScores[left] ||
            this.actionKey(actions[left]).localeCompare(this.actionKey(actions[right]));
        });
        if (tempoCandidates.length) {
          movesToGoApplied = tempoCandidates[0] !== selectedIndex;
          action = actions[tempoCandidates[0]];
        }
      }
    }
    const sortedBase = analysis.candidates.map(function (candidate) { return candidate.baseDfsScore; }).sort(function (left, right) { return right - left; });
    const selectedIndex = action ? actionIndex.get(this.actionKey(action)) : -1;
    return {
      action: action, policyTarget: policyTarget,
      trace: {
        actorType: 'hybrid', candidateMask: candidateMask, baseDfsScores: baseDfsScores,
        learnedScores: learnedScores, finalHybridScores: finalHybridScores,
        successorValues: successorValues, successorMovesToGo: successorMovesToGo,
        selectedIndex: Number.isInteger(selectedIndex) ? selectedIndex : -1,
        strengthSelectedIndex: strengthSelectedIndex, movesToGoApplied: movesToGoApplied,
        bestBaseMargin: sortedBase.length > 1 ? sortedBase[0] - sortedBase[1] : null,
        searchNodes: analysis.totalNodes, searchComplete: analysis.searchComplete,
        transpositionTableEnabled: analysis.transpositionTableEnabled,
        transpositionTableSize: analysis.transpositionTableSize,
        ttProbes: analysis.ttProbes, ttHits: analysis.ttHits,
        ttExactHits: analysis.ttExactHits, ttCutoffs: analysis.ttCutoffs,
        ttStores: analysis.ttStores, budgetCutoffs: analysis.budgetCutoffs
      }
    };
  }

  /** 与玩家端兼容的动作包装；训练器使用 guidedBaselineDecision 获取完整 trace。 */
  guidedBaselineAction(state, model, random, options) {
    return this.guidedBaselineDecision(state, model, random, options).action;
  }

  /** 将教师首选动作与软启发式混合，避免只学习过度尖锐的 one-hot 标签。 */
  teacherPolicy(state, actions, options) {
    const settings = options || {};
    const heuristic = this.heuristicPolicy(state, actions, state.turn);
    const teacherMove = this.baselineAction(state, settings.level || 'normal', settings.random);
    // 教师因异常局面无法返回动作时保留归一化启发式，避免生成概率和小于 1 的坏样本。
    if (!teacherMove) return heuristic;
    const teacherIndex = actions.findIndex((action) => this.actionKey(action) === this.actionKey(teacherMove));
    if (teacherIndex < 0) return heuristic;
    const teacherWeight = Math.max(0, Math.min(1, Number(settings.teacherWeight) || 0.72));
    return heuristic.map(function (value, index) {
      return value * (1 - teacherWeight) + (index === teacherIndex ? teacherWeight : 0);
    });
  }
}

module.exports = { ChineseCheckersAdapter: ChineseCheckersAdapter, Core: Core, V0Model: V0Model };
