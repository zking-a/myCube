'use strict';

/**
 * 通用 PUCT 蒙特卡洛树搜索。
 *
 * GameAdapter 最小契约：
 * - currentPlayer(state): 返回稳定的玩家标识；
 * - legalActions(state) / applyAction(state, action): 枚举并执行合法动作；
 * - isTerminal(state) / terminalValue(state, perspective): 终局及指定视角价值；
 * - encodeState(state, perspective) / encodeAction(...): 模型输入。
 *
 * 价值约定：模型和节点的 value 始终属于“该节点行动方”。跨玩家边回传时翻转符号，
 * 因而适用于双人零和、轮流行动的棋类。若未来接入多人或非零和游戏，应实现独立备份器。
 */

const { createRandom } = require('./policy_value_model');

/** 搜索树节点。子状态延迟到首次访问时生成，以减少宽分支棋类的复制成本。 */
class SearchNode {
  constructor(options) {
    const source = options || {};
    this.state = source.state || null;
    this.parent = source.parent || null;
    this.action = source.action || null;
    this.prior = Number(source.prior) || 0;
    this.player = source.player || '';
    this.children = [];
    this.visits = 0;
    this.valueSum = 0;
    this.expanded = false;
  }
  value() { return this.visits ? this.valueSum / this.visits : 0; }
}

function sampleGamma(alpha, random) {
  if (alpha < 1) return sampleGamma(alpha + 1, random) * Math.pow(Math.max(1e-12, random()), 1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      const u1 = Math.max(1e-12, random());
      const u2 = random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function dirichlet(size, alpha, random) {
  const values = Array.from({ length: size }, function () { return sampleGamma(alpha, random); });
  const total = values.reduce(function (sum, value) { return sum + value; }, 0) || 1;
  return values.map(function (value) { return value / total; });
}

/** 使用策略先验引导探索、使用价值头评估叶节点的通用搜索器。 */
class PuctMcts {
  constructor(game, model, options) {
    if (!game || !model) throw new Error('PUCT 需要游戏适配器和策略价值模型');
    this.game = game;
    this.model = model;
    this.options = Object.assign({
      simulations: 32, cPuct: 2.2, dirichletAlpha: 0.3, dirichletWeight: 0,
      heuristicPriorWeight: 0, heuristicValueWeight: 0, maxDepth: 180,
      rootProgressiveWidening: true, rootMinVisits: 2, seed: 1
    }, options || {});
    this.random = typeof this.options.random === 'function' ? this.options.random : createRandom(this.options.seed);
    const hasOpposite = this.game && typeof this.game.opposite === 'function';
    this.getOpponentPlayer = function (player) {
      if (typeof player !== 'string' || !player.length) return '';
      return hasOpposite ? this.game.opposite(player) : player === 'red' ? 'blue' : 'red';
    };
  }

  actionKey(action) {
    return typeof this.game.actionKey === 'function'
      ? this.game.actionKey(action)
      : JSON.stringify(action || {});
  }

  /**
   * Search every legal root move for a forced one-ply win before applying any
   * policy pruning. A weak prior must never hide a legal immediate win.
   */
  immediateWinningActions(state, player, legalActions) {
    const actions = Array.isArray(legalActions) ? legalActions : this.game.legalActions(state);
    return actions.filter((action) => {
      const next = this.game.applyAction(state, action);
      return this.game.isTerminal(next) && this.game.terminalValue(next, player) >= 1 - 1e-9;
    }).sort((left, right) => this.actionKey(left).localeCompare(this.actionKey(right)));
  }

  /** 首次访问一条边时才执行动作并创建子状态。 */
  materialize(parent, child) {
    if (child.state) return;
    child.state = this.game.applyAction(parent.state, child.action);
    child.player = this.game.currentPlayer(child.state);
  }

  /**
   * 展开叶节点并返回该节点行动方视角的价值。
   * heuristic*Weight 可在模型尚弱时混入规则启发式，随着训练增强逐步降至 0。
   */
  expand(node) {
    if (this.game.isTerminal(node.state)) return this.game.terminalValue(node.state, node.player);
    const actions = this.game.legalActions(node.state);
    if (!actions.length) return this.game.terminalValue(node.state, node.player);
    const prediction = this.model.predict(this.game.encodeState(node.state, node.player), actions.map((action) => this.game.encodeAction(node.state, action, node.player)));
    let priors = prediction.policy.slice();
    if (this.options.heuristicPriorWeight > 0 && typeof this.game.heuristicPolicy === 'function') {
      const heuristic = this.game.heuristicPolicy(node.state, actions, node.player);
      const weight = Math.max(0, Math.min(1, this.options.heuristicPriorWeight));
      priors = priors.map(function (value, index) { return value * (1 - weight) + heuristic[index] * weight; });
    }
    const priorTotal = priors.reduce(function (sum, value) { return sum + value; }, 0) || 1;
    node.children = actions.map(function (action, index) { return new SearchNode({ parent: node, action: action, prior: priors[index] / priorTotal }); });
    node.expanded = true;
    let value = prediction.value;
    if (this.options.heuristicValueWeight > 0 && typeof this.game.heuristicValue === 'function') {
      const weight = Math.max(0, Math.min(1, this.options.heuristicValueWeight));
      value = value * (1 - weight) + this.game.heuristicValue(node.state, node.player) * weight;
    }
    return value;
  }

  /** Evaluate a depth-cutoff leaf without mutating or re-expanding the node. */
  evaluateLeaf(node) {
    if (this.options.heuristicValueWeight > 0 && typeof this.game.heuristicValue === 'function') {
      return this.game.heuristicValue(node.state, node.player);
    }
    const actions = this.game.legalActions(node.state);
    if (!actions.length) return this.game.terminalValue(node.state, node.player);
    return this.model.predict(
      this.game.encodeState(node.state, node.player),
      actions.map((action) => this.game.encodeAction(node.state, action, node.player))
    ).value;
  }

  /**
   * Keep the active root width proportional to the simulation budget. The
   * union of learned-prior and rule-prior leaders protects both weak models
   * and unconventional learned proposals from full-width visit starvation.
   */
  limitRootChildren(root, simulations) {
    const branchCount = root.children.length;
    if (!this.options.rootProgressiveWidening || branchCount <= 1) return branchCount;
    const requested = Number(this.options.rootMaxChildren) || (6 + Math.floor(1.5 * Math.sqrt(simulations)));
    const limit = Math.max(1, Math.min(branchCount, Math.floor(requested)));
    if (limit >= branchCount) return branchCount;
    const byPrior = root.children.slice().sort((left, right) =>
      right.prior - left.prior || this.actionKey(left.action).localeCompare(this.actionKey(right.action))
    );
    const selected = new Map();
    const add = (child) => selected.set(this.actionKey(child.action), child);
    const learnedQuota = Math.ceil(limit / 2);
    byPrior.slice(0, learnedQuota).forEach(add);
    if (typeof this.game.heuristicPolicy === 'function') {
      const actions = root.children.map((child) => child.action);
      const heuristic = this.game.heuristicPolicy(root.state, actions, root.player);
      root.children.map((child, index) => ({ child: child, score: Number(heuristic[index]) || 0 }))
        .sort((left, right) => right.score - left.score || this.actionKey(left.child.action).localeCompare(this.actionKey(right.child.action)))
        .slice(0, limit - learnedQuota).forEach((item) => add(item.child));
    }
    for (const child of byPrior) {
      if (selected.size >= limit) break;
      add(child);
    }
    root.children = Array.from(selected.values()).sort((left, right) => this.actionKey(left.action).localeCompare(this.actionKey(right.action)));
    const total = root.children.reduce(function (sum, child) { return sum + child.prior; }, 0) || 1;
    root.children.forEach(function (child) { child.prior /= total; });
    return limit;
  }

  /** 仅在自我博弈根节点加入 Dirichlet 噪声，增加可学习局面的覆盖率。 */
  addRootNoise(root) {
    const weight = Math.max(0, Math.min(1, Number(this.options.dirichletWeight) || 0));
    if (!weight || !root.children.length) return;
    const noise = dirichlet(root.children.length, Math.max(0.01, Number(this.options.dirichletAlpha) || 0.3), this.random);
    root.children.forEach(function (child, index) { child.prior = child.prior * (1 - weight) + noise[index] * weight; });
  }

  /** 按 Q + U 选择子节点：Q 利用已有价值，U 奖励高先验且低访问的动作。 */
  select(node) {
    let best = null, bestScore = -Infinity;
    const parentVisits = Math.max(1, node.visits);
    node.children.forEach((child) => {
      const childPlayer = child.player || this.getOpponentPlayer(node.player);
      const q = childPlayer === node.player ? child.value() : -child.value();
      const u = this.options.cPuct * child.prior * Math.sqrt(parentVisits) / (1 + child.visits);
      const score = q + u;
      const tie = Math.abs(score - bestScore) < 1e-12;
      const priorWins = tie && child.prior > (best ? best.prior : -Infinity);
      const stableTieWins = tie && best && Math.abs(child.prior - best.prior) < 1e-12 &&
        this.actionKey(child.action).localeCompare(this.actionKey(best.action)) < 0;
      if (score > bestScore || priorWins || stableTieWins) {
        bestScore = score;
        best = child;
      }
    });
    return best;
  }

  /** 沿搜索路径回传叶节点价值；行动方变化时转换观察视角。 */
  backpropagate(path, leafValue) {
    let value = leafValue;
    let perspective = path[path.length - 1].player;
    for (let index = path.length - 1; index >= 0; index--) {
      const node = path[index];
      if (node.player !== perspective) value = -value;
      node.visits++;
      node.valueSum += value;
      perspective = node.player;
    }
  }

  /**
   * @param {*} state 游戏适配器定义的不可变局面。
   * @returns {{root:SearchNode, policy:Object[]}} 访问次数策略，与原始动作一一关联。
   */
  search(state) {
    const root = new SearchNode({ state: state, player: this.game.currentPlayer(state), prior: 1 });
    const legalActions = this.game.legalActions(state);
    const immediateWins = this.immediateWinningActions(state, root.player, legalActions);
    if (immediateWins.length) {
      const forcedAction = immediateWins[0];
      return {
        root: root, forcedAction: forcedAction, value: 1,
        policy: immediateWins.map((action, index) => ({ action: action, probability: index ? 0 : 1, visits: 1, value: 1 })),
        telemetry: { branchCount: legalActions.length, activeChildren: immediateWins.length, maxVisitTieCount: 1, meanDepth: 1, modelCalls: 0, selectedPriorRank: 0 }
      };
    }
    this.expand(root);
    const simulations = Math.max(1, Math.floor(Number(this.options.simulations) || 1));
    const branchCount = this.limitRootChildren(root, simulations);
    this.addRootNoise(root);
    const rootMinVisits = Math.max(0, Math.floor(Number(this.options.rootMinVisits) || 0));
    let depthTotal = 0, modelCalls = 1;
    for (let simulation = 0; simulation < simulations; simulation++) {
      let node = root;
      const path = [root];
      let depth = 0;
      let reachedTerminal = this.game.isTerminal(node.state);
      while (node.expanded && node.children.length && depth < this.options.maxDepth) {
        let child;
        if (node === root && rootMinVisits > 0) {
          child = root.children.filter(function (candidate) { return candidate.visits < rootMinVisits; })
            .sort((left, right) => left.visits - right.visits || this.actionKey(left.action).localeCompare(this.actionKey(right.action)))[0];
        }
        if (!child) child = this.select(node);
        if (!child) break;
        this.materialize(node, child);
        node = child; path.push(node); depth++;
        if (this.game.isTerminal(node.state)) {
          reachedTerminal = true;
          break;
        }
      }
      let value = this.game.terminalValue(node.state, node.player);
      if (!reachedTerminal) {
        if (depth >= this.options.maxDepth) {
          value = this.evaluateLeaf(node);
          modelCalls++;
        } else if (!node.expanded) {
          value = this.expand(node);
          modelCalls++;
        } else if (!node.children.length) {
          value = this.game.terminalValue(node.state, node.player);
        }
      }
      this.backpropagate(path, value);
      depthTotal += depth;
    }
    const totalVisits = root.children.reduce(function (sum, child) { return sum + child.visits; }, 0);
    const policy = root.children.map((child) => {
      const childPlayer = child.player || this.getOpponentPlayer(root.player);
      return {
        action: child.action, probability: totalVisits ? child.visits / totalVisits : child.prior,
        visits: child.visits, value: child.value(),
        rootValue: childPlayer === root.player ? child.value() : -child.value()
      };
    });
    const maxVisits = policy.reduce(function (maximum, item) { return Math.max(maximum, item.visits); }, 0);
    return {
      root: root, policy: policy, value: root.value(),
      telemetry: {
        branchCount: branchCount, activeChildren: root.children.length,
        maxVisitTieCount: policy.filter(function (item) { return item.visits === maxVisits; }).length,
        meanDepth: Number((depthTotal / simulations).toFixed(2)), modelCalls: modelCalls
      }
    };
  }

  /**
   * 从访问次数策略选动作。temperature 接近 0 时确定性选择，训练早期可设为 1 增加探索。
   */
  choose(state, temperature) {
    const result = this.search(state);
    if (result.forcedAction) return { action: result.forcedAction, policy: result.policy, value: result.value, telemetry: result.telemetry };
    if (!result.policy.length) return { action: null, policy: [], value: result.value };
    const safeTemperature = Math.max(0, Number(temperature) || 0);
    let selected;
    const actionKey = function (action) {
      return action && action.from && action.target ? action.from + '>' + action.target : JSON.stringify(action || {});
    };
    if (safeTemperature <= 1e-6) {
      selected = result.policy.reduce(function (best, item) {
        if (!best) return item;
        if (item.visits > best.visits) return item;
        if (item.visits < best.visits) return best;
        if (item.rootValue > best.rootValue) return item;
        if (item.rootValue < best.rootValue) return best;
        if (item.probability > best.probability) return item;
        if (item.probability < best.probability) return best;
        return actionKey(item.action) < actionKey(best.action) ? item : best;
      }, null);
    } else {
      const weights = result.policy.map(function (item) { return Math.pow(Math.max(1e-9, item.visits || item.probability), 1 / safeTemperature); });
      const total = weights.reduce(function (sum, value) { return sum + value; }, 0) || 1;
      let cursor = this.random() * total;
      selected = result.policy[result.policy.length - 1];
      for (let index = 0; index < weights.length; index++) { cursor -= weights[index]; if (cursor <= 0) { selected = result.policy[index]; break; } }
    }
    if (result.telemetry) {
      result.telemetry.selectedPriorRank = result.policy.slice().sort(function (left, right) { return right.probability - left.probability; })
        .findIndex((item) => actionKey(item.action) === actionKey(selected.action)) + 1;
    }
    return { action: selected.action, policy: result.policy, value: result.value, telemetry: result.telemetry };
  }
}

module.exports = { PuctMcts: PuctMcts, SearchNode: SearchNode };
