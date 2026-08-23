(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CheckersCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROW_COUNTS = [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1];
  const DIRECTIONS = [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]];
  const VALUE_FEATURE_VERSION = 'cc-value-v2';
  function keyOf(row, unit) { return row + ':' + unit; }

  function buildBoardCells() {
    const cells = [];
    ROW_COUNTS.forEach(function (count, row) {
      for (let column = 0; column < count; column++) {
        const unit = -(count - 1) + column * 2;
        cells.push({
          key: keyOf(row, unit), row: row, unit: unit,
          x: 160 + unit * 10.8, y: 16 + row * 18,
          camp: row <= 3 ? 'top' : (row >= 13 ? 'bottom' : '')
        });
      }
    });
    return cells;
  }

  const BOARD_CELLS = buildBoardCells();
  const CELL_MAP = new Map(BOARD_CELLS.map(function (cell) { return [cell.key, cell]; }));
  const TOP_CAMP = new Set(BOARD_CELLS.filter(function (cell) { return cell.camp === 'top'; }).map(function (cell) { return cell.key; }));
  const BOTTOM_CAMP = new Set(BOARD_CELLS.filter(function (cell) { return cell.camp === 'bottom'; }).map(function (cell) { return cell.key; }));

  function createInitialPieces() {
    const pieces = {};
    TOP_CAMP.forEach(function (key) { pieces[key] = 'red'; });
    BOTTOM_CAMP.forEach(function (key) { pieces[key] = 'blue'; });
    return pieces;
  }

  function getLegalMoves(pieces, fromKey) {
    const from = CELL_MAP.get(fromKey);
    if (!from || !pieces || !pieces[fromKey]) return { steps: [], jumps: [], all: [] };
    const steps = [];
    DIRECTIONS.forEach(function (direction) {
      const targetKey = keyOf(from.row + direction[0], from.unit + direction[1]);
      if (CELL_MAP.has(targetKey) && !pieces[targetKey]) steps.push(targetKey);
    });

    const jumps = [];
    const visited = new Set([fromKey]);
    const queue = [fromKey];
    const occupied = function (key) { return key !== fromKey && !!pieces[key]; };
    while (queue.length) {
      const current = CELL_MAP.get(queue.shift());
      DIRECTIONS.forEach(function (direction) {
        const overKey = keyOf(current.row + direction[0], current.unit + direction[1]);
        const landingKey = keyOf(current.row + direction[0] * 2, current.unit + direction[1] * 2);
        if (!CELL_MAP.has(landingKey) || !occupied(overKey) || occupied(landingKey) || visited.has(landingKey)) return;
        visited.add(landingKey);
        jumps.push(landingKey);
        queue.push(landingKey);
      });
    }
    return { steps: steps, jumps: jumps, all: steps.concat(jumps) };
  }

  function goalFor(player) { return player === 'red' ? BOTTOM_CAMP : TOP_CAMP; }
  function countInGoal(pieces, player) {
    let count = 0;
    goalFor(player).forEach(function (key) { if (pieces[key] === player) count++; });
    return count;
  }
  function hasWon(pieces, player) { return countInGoal(pieces, player) === 10; }

  function findMovePath(pieces, fromKey, targetKey) {
    const from = CELL_MAP.get(fromKey);
    if (!from || !CELL_MAP.has(targetKey) || !pieces || !pieces[fromKey] || pieces[targetKey]) return null;
    const legal = getLegalMoves(pieces, fromKey);
    if (legal.steps.includes(targetKey)) return [fromKey, targetKey];
    if (!legal.jumps.includes(targetKey)) return null;

    const visited = new Set([fromKey]);
    const parents = new Map();
    const queue = [fromKey];
    const occupied = function (key) { return key !== fromKey && !!pieces[key]; };
    while (queue.length) {
      const currentKey = queue.shift();
      const current = CELL_MAP.get(currentKey);
      for (let i = 0; i < DIRECTIONS.length; i++) {
        const direction = DIRECTIONS[i];
        const overKey = keyOf(current.row + direction[0], current.unit + direction[1]);
        const landingKey = keyOf(current.row + direction[0] * 2, current.unit + direction[1] * 2);
        if (!CELL_MAP.has(landingKey) || !occupied(overKey) || occupied(landingKey) || visited.has(landingKey)) continue;
        visited.add(landingKey);
        parents.set(landingKey, currentKey);
        if (landingKey === targetKey) {
          const path = [targetKey];
          let cursor = targetKey;
          while (cursor !== fromKey) { cursor = parents.get(cursor); path.push(cursor); }
          return path.reverse();
        }
        queue.push(landingKey);
      }
    }
    return null;
  }

  function applyMove(pieces, player, fromKey, targetKey) {
    if (!pieces || pieces[fromKey] !== player || pieces[targetKey] || !CELL_MAP.has(targetKey)) return null;
    const path = findMovePath(pieces, fromKey, targetKey);
    if (!path) return null;
    const next = Object.assign({}, pieces);
    delete next[fromKey];
    next[targetKey] = player;
    const from = CELL_MAP.get(fromKey);
    const target = CELL_MAP.get(targetKey);
    const isStep = DIRECTIONS.some(function (direction) {
      return from.row + direction[0] === target.row && from.unit + direction[1] === target.unit;
    });
    return {
      pieces: next,
      winner: hasWon(next, player) ? player : '',
      kind: isStep ? 'step' : 'jump',
      path: path
    };
  }

  function orientPoint(cell, perspective) {
    if (perspective === 'red') return { x: 320 - cell.x, y: 320 - cell.y };
    return { x: cell.x, y: cell.y };
  }

  function sanitizePieces(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pieces = {};
    let red = 0, blue = 0;
    Object.keys(raw).forEach(function (key) {
      const owner = raw[key];
      if (!CELL_MAP.has(key) || (owner !== 'red' && owner !== 'blue') || pieces[key]) return;
      pieces[key] = owner;
      if (owner === 'red') red++;
      else blue++;
    });
    return red === 10 && blue === 10 ? pieces : null;
  }

  function sanitizeState(raw) {
    if (!raw || (raw.turn !== 'red' && raw.turn !== 'blue')) return null;
    const pieces = sanitizePieces(raw.pieces);
    if (!pieces) return null;
    const claimedWinner = raw.winner === 'red' || raw.winner === 'blue' ? raw.winner : '';
    return {
      pieces: pieces,
      turn: raw.turn,
      moveNumber: Math.max(1, Math.min(9999, Math.floor(Number(raw.moveNumber) || 1))),
      winner: claimedWinner && hasWon(pieces, claimedWinner) ? claimedWinner : '',
      lastMove: sanitizeLastMove(raw.lastMove, pieces)
    };
  }

  function sanitizeLastMove(raw, pieces) {
    if (!raw) return null;
    if (!raw || (raw.player !== 'red' && raw.player !== 'blue')) return null;
    const from = typeof raw.from === 'string' && CELL_MAP.has(raw.from) ? raw.from : '';
    const target = typeof raw.target === 'string' && CELL_MAP.has(raw.target) ? raw.target : '';
    if (!from || !target || !pieces || pieces[target] !== raw.player || pieces[from]) return null;
    const path = Array.isArray(raw.path) ? raw.path.filter(function (key) { return typeof key === 'string' && CELL_MAP.has(key); }) : [];
    if (path.length < 2 || path.length > 20 || path[0] !== from || path[path.length - 1] !== target) return null;
    return {
      player: raw.player,
      from: from,
      target: target,
      kind: raw.kind === 'jump' ? 'jump' : 'step',
      path: path,
      moveNumber: Math.max(1, Math.min(9999, Math.floor(Number(raw.moveNumber) || 1)))
    };
  }

  function listMoves(pieces, player) {
    const moves = [];
    Object.keys(pieces).forEach(function (from) {
      if (pieces[from] !== player) return;
      const legal = getLegalMoves(pieces, from);
      legal.steps.forEach(function (target) { moves.push({ from: from, target: target, kind: 'step' }); });
      legal.jumps.forEach(function (target) { moves.push({ from: from, target: target, kind: 'jump' }); });
    });
    return moves;
  }

  function moveScore(pieces, player, move) {
    const from = CELL_MAP.get(move.from);
    const target = CELL_MAP.get(move.target);
    const forward = player === 'red' ? target.row - from.row : from.row - target.row;
    const fromGoal = goalFor(player).has(move.from);
    const targetGoal = goalFor(player).has(move.target);
    const enteringGoal = !fromGoal && targetGoal ? 1 : 0;
    const leavingGoal = fromGoal && !targetGoal ? 1 : 0;
    const centerGain = Math.abs(from.unit) - Math.abs(target.unit);
    // 历史教训（2026.08）：不要为“营内挪动”加排序惩罚——腾出营地空孔让营外
    // 棋子跳入是终局关键战术，惩罚会把这类获胜计划挤出根候选窗口（拆解竞技场
    // 0–7 惨败）。营内挪动是否浪费由搜索与评估自行判断。
    return forward * 9 + enteringGoal * 120 - leavingGoal * 180 + centerGain * .7 + (move.kind === 'jump' ? 5 : 0);
  }

  function opposite(player) { return player === 'red' ? 'blue' : 'red'; }

  function distanceToGoal(cell, player) {
    let shortest = Infinity;
    goalFor(player).forEach(function (goalKey) {
      const goal = CELL_MAP.get(goalKey);
      const rowDistance = Math.abs(cell.row - goal.row);
      const unitDistance = Math.abs(cell.unit - goal.unit) / 2;
      shortest = Math.min(shortest, rowDistance * 1.25 + unitDistance * .58);
    });
    return shortest;
  }

  function hexDistance(a, b) {
    const aq = (a.unit - a.row) / 2;
    const bq = (b.unit - b.row) / 2;
    const dq = aq - bq;
    const dr = a.row - b.row;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }

  // Hungarian assignment: every checker is matched to a different target hole.
  // This prevents all remaining checkers from being evaluated against the same nearest hole at 9/10 endgames.
  function goalAssignmentDistance(pieceCells, player) {
    const goals = Array.from(goalFor(player)).map(function (key) { return CELL_MAP.get(key); });
    const size = Math.min(pieceCells.length, goals.length);
    if (!size) return 0;
    const u = new Array(size + 1).fill(0);
    const v = new Array(size + 1).fill(0);
    const matching = new Array(size + 1).fill(0);
    const previous = new Array(size + 1).fill(0);
    for (let row = 1; row <= size; row++) {
      matching[0] = row;
      let column = 0;
      const minValue = new Array(size + 1).fill(Infinity);
      const used = new Array(size + 1).fill(false);
      do {
        used[column] = true;
        const currentRow = matching[column];
        let delta = Infinity;
        let nextColumn = 0;
        for (let candidate = 1; candidate <= size; candidate++) {
          if (used[candidate]) continue;
          const cost = hexDistance(pieceCells[currentRow - 1], goals[candidate - 1]);
          const current = cost - u[currentRow] - v[candidate];
          if (current < minValue[candidate]) { minValue[candidate] = current; previous[candidate] = column; }
          if (minValue[candidate] < delta) { delta = minValue[candidate]; nextColumn = candidate; }
        }
        for (let candidate = 0; candidate <= size; candidate++) {
          if (used[candidate]) { u[matching[candidate]] += delta; v[candidate] -= delta; }
          else minValue[candidate] -= delta;
        }
        column = nextColumn;
      } while (matching[column] !== 0);
      do {
        const nextColumn = previous[column];
        matching[column] = matching[nextColumn];
        column = nextColumn;
      } while (column !== 0);
    }
    return -v[0];
  }

  /**
   * 每方局面快照。position 字段与公开 playerPosition 完全一致；progress 供价值
   * 特征复用，避免静态评估与价值网络各算一遍棋子进度。
   */
  function positionData(pieces, player) {
    let forward = 0;
    let distance = 0;
    let inGoal = 0;
    let axisOffset = 0;
    let tailProgress = Infinity;
    const pieceCells = [];
    const progress = [];
    Object.keys(pieces).forEach(function (key) {
      if (pieces[key] !== player) return;
      const cell = CELL_MAP.get(key);
      pieceCells.push(cell);
      const cellProgress = player === 'red' ? cell.row : (16 - cell.row);
      progress.push(cellProgress);
      forward += cellProgress;
      distance += distanceToGoal(cell, player);
      axisOffset += Math.abs(cell.unit);
      tailProgress = Math.min(tailProgress, cellProgress);
      if (goalFor(player).has(key)) inGoal++;
    });
    return {
      position: {
        forward: forward,
        distance: distance,
        assignmentDistance: goalAssignmentDistance(pieceCells, player),
        inGoal: inGoal,
        axisOffset: axisOffset,
        tailProgress: tailProgress
      },
      progress: progress
    };
  }

  function playerPosition(pieces, player) {
    return positionData(pieces, player).position;
  }

  /** 与旧 extractValueFeatures 数值完全一致，只是内部共享 positionData。 */
  function featuresFromData(mine, theirs, perspective) {
    const myPosition = mine.position;
    const theirPosition = theirs.position;
    const myProgress = mine.progress.slice().sort(function (a, b) { return a - b; });
    const theirProgress = theirs.progress.slice().sort(function (a, b) { return a - b; });
    const features = [
      1,
      (myPosition.inGoal - theirPosition.inGoal) / 10,
      (myPosition.forward - theirPosition.forward) / 160,
      (theirPosition.distance - myPosition.distance) / 130,
      (theirPosition.assignmentDistance - myPosition.assignmentDistance) / 120,
      (theirPosition.axisOffset - myPosition.axisOffset) / 120,
      (myPosition.tailProgress - theirPosition.tailProgress) / 16
    ];
    for (let i = 0; i < 10; i++) features.push(((myProgress[i] || 0) - (theirProgress[i] || 0)) / 16);
    features.push((myPosition.inGoal * myPosition.inGoal - theirPosition.inGoal * theirPosition.inGoal) / 100);
    features.push(((myProgress[0] || 0) * (myProgress[1] || 0) - (theirProgress[0] || 0) * (theirProgress[1] || 0)) / 256);
    features.push((((theirProgress[9] || 0) - (theirProgress[0] || 0)) - ((myProgress[9] || 0) - (myProgress[0] || 0))) / 16);
    return features;
  }

  // 价值网络不直接读取 DOM 棋盘，而是读取一组关于双方相对进度的对称特征。
  // 对红蓝交换视角时，除常量项外特征会反号，便于用少量自我对弈样本学习。
  function extractValueFeatures(pieces, perspective) {
    const mine = positionData(pieces, perspective);
    const theirs = positionData(pieces, opposite(perspective));
    return featuresFromData(mine, theirs, perspective);
  }

  /** 价值网络 MLP 推理主体，供 predictValueModel 与混合评估共享。 */
  function predictFromFeatures(input, model) {
    const hiddenSize = Math.max(0, Math.floor(Number(model.hiddenSize) || 0));
    const inputSize = input.length;
    const w1 = model.weights.input;
    const b1 = model.weights.hiddenBias;
    const w2 = model.weights.output;
    if (Number(model.inputSize) !== inputSize || !hiddenSize || !Array.isArray(w1) || w1.length !== inputSize * hiddenSize ||
      !Array.isArray(b1) || b1.length !== hiddenSize || !Array.isArray(w2) || w2.length !== hiddenSize) return 0;
    let output = Number(model.weights.outputBias) || 0;
    for (let hidden = 0; hidden < hiddenSize; hidden++) {
      let activation = Number(b1[hidden]) || 0;
      const offset = hidden * inputSize;
      for (let feature = 0; feature < inputSize; feature++) activation += input[feature] * w1[offset + feature];
      output += Math.tanh(activation) * w2[hidden];
    }
    return Math.tanh(output);
  }

  function predictValueModel(pieces, perspective, model) {
    if (!model || model.featureVersion !== VALUE_FEATURE_VERSION || !model.weights) return 0;
    const mine = positionData(pieces, perspective);
    const theirs = positionData(pieces, opposite(perspective));
    return predictFromFeatures(featuresFromData(mine, theirs, perspective), model);
  }

  /**
   * 静态局面分：优先把棋子送进目标营地，其次压缩到目标营地的总距离。
   * 中轴偏移和最后一枚棋子的进度分别避免在边线绕路、把少量棋子远远甩在后方。
   *
   * 历史教训（2026.08）：机动性、营外竞速分支、静态阻挡、营内挪动排序惩罚、
   * 真终局“距完成步数下界”竞速项（同种子竞技场 7–9 vs 9–7）均已验证为净负
   * 收益并回退——评估公式与旧版完全一致，强度提升全部来自搜索侧。
   */
  function staticScore(pieces, perspective, minePosition, theirsPosition) {
    const mine = minePosition;
    const theirs = theirsPosition;
    return (mine.inGoal - theirs.inGoal) * 320 +
      (mine.inGoal * mine.inGoal - theirs.inGoal * theirs.inGoal) * 18 +
      (mine.forward - theirs.forward) * 3 +
      (theirs.distance - mine.distance) * 2 +
      (theirs.assignmentDistance - mine.assignmentDistance) * 22 +
      (mine.tailProgress - theirs.tailProgress) * 35 +
      (theirs.axisOffset - mine.axisOffset) * .7;
  }

  function evaluatePosition(pieces, perspective) {
    const mine = positionData(pieces, perspective);
    const theirs = positionData(pieces, opposite(perspective));
    return staticScore(pieces, perspective, mine.position, theirs.position);
  }

  function evaluateHybridPosition(pieces, perspective, model) {
    const mine = positionData(pieces, perspective);
    const theirs = positionData(pieces, opposite(perspective));
    const base = staticScore(pieces, perspective, mine.position, theirs.position);
    if (!model || model.featureVersion !== VALUE_FEATURE_VERSION || !model.weights) return base;
    const scale = Math.max(0, Math.min(260, Number(model.scale) || 0));
    return base + predictFromFeatures(featuresFromData(mine, theirs, perspective), model) * scale;
  }

  function positionKey(pieces) {
    return BOARD_CELLS.map(function (cell) {
      return pieces[cell.key] === 'red' ? 'r' : (pieces[cell.key] === 'blue' ? 'b' : '.');
    }).join('');
  }

  // 静态局面分：优先把棋子送进目标营地，其次压缩到目标营地的总距离。
  // 中轴偏移和最后一枚棋子的进度分别避免在边线绕路、把少量棋子远远甩在后方。
  function evaluatePosition(pieces, perspective) {
    const mine = playerPosition(pieces, perspective);
    const theirs = playerPosition(pieces, opposite(perspective));
    return (mine.inGoal - theirs.inGoal) * 320 +
      (mine.inGoal * mine.inGoal - theirs.inGoal * theirs.inGoal) * 18 +
      (mine.forward - theirs.forward) * 3 +
      (theirs.distance - mine.distance) * 2 +
      (theirs.assignmentDistance - mine.assignmentDistance) * 22 +
      (mine.tailProgress - theirs.tailProgress) * 35 +
      (theirs.axisOffset - mine.axisOffset) * .7;
  }

  function orderedMoves(pieces, player, limit) {
    return listMoves(pieces, player)
      .map(function (move) { return { move: move, score: moveScore(pieces, player, move) }; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, Math.max(1, limit))
      .map(function (item) { return item.move; });
  }

  const TT_EXACT = 'EXACT';
  const TT_LOWER = 'LOWER';
  const TT_UPPER = 'UPPER';

  /**
   * TT values are perspective-sensitive minimax scores. Side-to-move and the
   * evaluator contract therefore belong to the key; omitting either silently
   * reuses a score with different semantics.
   */
  function transpositionKey(pieces, activePlayer, perspective, evaluatorVersion) {
    return positionKey(pieces) + '|' + activePlayer + '|' + perspective + '|' + String(evaluatorVersion || 'static-v2');
  }

  /**
   * 叶子评估：优先复用同一决策内的评估缓存（置换局面只算一次），
   * 再退回静态+价值混合评估。缓存对同一决策内的多次评估是确定性的。
   */
  function evaluateLeaf(context, pieces, perspective) {
    const cache = context.evalCache;
    if (cache) {
      const key = positionKey(pieces) + '|' + perspective;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const value = evaluateHybridPosition(pieces, perspective, context.model);
      if (cache.size < context.evalCacheLimit) cache.set(key, value);
      return value;
    }
    return evaluateHybridPosition(pieces, perspective, context.model);
  }

  // 受预算保护的深度优先极大极小搜索。跳棋分支会在中局膨胀，
  // 因而结合 alpha-beta 剪枝、走法排序、节点上限与可选的决策时间预算。
  function dfsSearch(pieces, activePlayer, perspective, depth, alpha, beta, context) {
    if (depth <= 0) {
      return { score: evaluateLeaf(context, pieces, perspective), complete: true, boundType: TT_EXACT };
    }
    if (context.nodes >= context.maxNodes) {
      context.budgetCutoffs++;
      return { score: evaluateLeaf(context, pieces, perspective), complete: false, boundType: null };
    }
    const originalAlpha = alpha;
    const originalBeta = beta;
    const key = context.tt
      ? transpositionKey(pieces, activePlayer, perspective, context.evaluatorVersion)
      : '';
    if (context.tt) {
      context.ttProbes++;
      const entry = context.tt.get(key);
      if (entry && entry.complete && entry.searchedDepth >= depth) {
        context.ttHits++;
        if (entry.boundType === TT_EXACT) {
          context.ttExactHits++;
          return { score: entry.score, complete: true, boundType: TT_EXACT, bestMove: entry.bestMove || null, fromTable: true };
        }
        if (entry.boundType === TT_LOWER) alpha = Math.max(alpha, entry.score);
        else if (entry.boundType === TT_UPPER) beta = Math.min(beta, entry.score);
        if (alpha >= beta) {
          context.ttCutoffs++;
          return { score: entry.score, complete: true, boundType: entry.boundType, bestMove: entry.bestMove || null, fromTable: true };
        }
      }
    }
    context.nodes++;
    // 决策时间预算：逐节点检查墙钟（Date.now 约几十纳秒，开销可忽略），
    // 超时立即中止整个候选的搜索（设置 timedOut 标志并向上传播）。
    if (context.timeLimitMs > 0 && Date.now() - context.startTime >= context.timeLimitMs) {
      context.budgetCutoffs++;
      context.timedOut = true;
      return { score: evaluateLeaf(context, pieces, perspective), complete: false, boundType: null };
    }
    const moves = orderedMoves(pieces, activePlayer, context.widths[Math.min(context.widths.length - 1, context.ply)]);
    if (!moves.length) {
      const score = evaluateLeaf(context, pieces, perspective);
      if (context.tt) {
        context.tt.set(key, { searchedDepth: depth, score: score, boundType: TT_EXACT, bestMove: null, complete: true });
        context.ttStores++;
      }
      return { score: score, complete: true, boundType: TT_EXACT, bestMove: null };
    }
    const maximizing = activePlayer === perspective;
    let best = maximizing ? -Infinity : Infinity;
    let bestMove = null;
    let complete = true;
    for (let i = 0; i < moves.length; i++) {
      if (context.nodes >= context.maxNodes || context.timedOut) { complete = false; context.budgetCutoffs++; break; }
      const result = applyMove(pieces, activePlayer, moves[i].from, moves[i].target);
      if (!result) continue;
      let child;
      if (result.winner) {
        child = { score: result.winner === perspective ? 100000 + depth : -100000 - depth, complete: true };
      } else {
        context.ply++;
        child = dfsSearch(result.pieces, opposite(activePlayer), perspective, depth - 1, alpha, beta, context);
        context.ply--;
      }
      const score = child.score;
      if (!child.complete) complete = false;
      if (maximizing) {
        if (score > best) { best = score; bestMove = moves[i]; }
        alpha = Math.max(alpha, best);
      } else {
        if (score < best) { best = score; bestMove = moves[i]; }
        beta = Math.min(beta, best);
      }
      if (beta <= alpha) break;
    }
    if (best === Infinity || best === -Infinity) {
      best = evaluateLeaf(context, pieces, perspective);
      complete = false;
    }
    let boundType = null;
    if (complete) {
      boundType = best <= originalAlpha ? TT_UPPER : (best >= originalBeta ? TT_LOWER : TT_EXACT);
      if (context.tt) {
        const previous = context.tt.get(key);
        if (!previous || previous.searchedDepth <= depth || previous.boundType !== TT_EXACT) {
          context.tt.set(key, {
            searchedDepth: depth, score: best, boundType: boundType,
            bestMove: bestMove, complete: true
          });
          context.ttStores++;
        }
      }
    }
    return { score: best, complete: complete, boundType: boundType, bestMove: bestMove };
  }

  function aiSearchOptions(level) {
    if (level === 'hard') return { depth: 3, maxNodes: 3600, widths: [20, 14, 12] };
    return { depth: 2, maxNodes: 1200, widths: [16, 12] };
  }

  /**
   * 终局自适应加深。历史教训（2026.08 竞技场 + S2 消融）：中后局（合计营外棋子
   * 超过 8）盲目加深会在时间预算下产生半截搜索噪声，比稳定的 depth-3 更差；
   * 只有真正的终局（每方 ≤ 4 子在外，分支大幅收缩）才能安全加深，
   * 让搜索看到更远的强制获胜序列。节点预算只做安全网，真正的限制是决策时间预算。
   */
  function adaptiveSearchProfile(pieces) {
    const redRemaining = 10 - countInGoal(pieces, 'red');
    const blueRemaining = 10 - countInGoal(pieces, 'blue');
    const total = redRemaining + blueRemaining;
    if (total <= 4) return { depth: 7, widths: [20, 14, 12, 10, 8, 8] };
    if (total <= 8) return { depth: 5, widths: [20, 14, 12, 10] };
    return { depth: 3, widths: [24, 16, 12] };
  }

  /**
   * Run the deterministic DFS part once and expose root score margins. The
   * selector and model arena can therefore share exactly the same deployed
   * hard-search contract instead of duplicating it.
   */
  function analyzeAiMoves(pieces, player, level, searchOptions) {
    const moves = listMoves(pieces, player);
    if (!moves.length) return { moves: [], candidates: [], winningMoves: [], bestBaseScore: -Infinity };
    const options = aiSearchOptions(level);
    const advanced = searchOptions && typeof searchOptions === 'object' ? searchOptions : {};
    const strategicLevel = level === 'hard';
    const learnedModel = strategicLevel && advanced.model ? advanced.model : null;
    const requestedTempo = Number(advanced.tempoWeight);
    const tempoWeight = strategicLevel && Number.isFinite(requestedTempo) ? Math.max(0, Math.min(4, requestedTempo)) : 0;
    const requestedRootWidth = Math.floor(Number(advanced.rootWidth));
    const requestedMaxNodes = Math.floor(Number(advanced.maxNodes));
    if (strategicLevel && Number.isFinite(requestedMaxNodes)) {
      options.maxNodes = Math.max(100, Math.min(100000, requestedMaxNodes));
    }
    // 自适应配置：终局加深，中局保持 3 层；节点上限只做安全网，时间预算主导。
    const adaptive = strategicLevel && advanced.adaptive === true;
    if (adaptive) {
      const profile = adaptiveSearchProfile(pieces);
      options.depth = profile.depth;
      options.widths = profile.widths.slice();
      options.maxNodes = Math.max(options.maxNodes, 30000);
    }
    const requestedTimeLimit = Number(advanced.timeLimitMs);
    const timeLimitMs = strategicLevel && Number.isFinite(requestedTimeLimit) && requestedTimeLimit > 0
      ? Math.max(20, Math.min(20000, requestedTimeLimit))
      : 0;
    const widths = options.widths.slice();
    if (strategicLevel && Number.isFinite(requestedRootWidth)) {
      widths[0] = Math.max(8, Math.min(24, requestedRootWidth));
    }
    // 可复用策略价值引擎可以为根节点候选提供归一化增益；原 DFS、合法性和
    // 胜棋检查仍是最终保护层。默认权重为 0，因此不会改变现有线上机器人。
    const learnedMoveScores = advanced.learnedMoveScores && typeof advanced.learnedMoveScores === 'object'
      ? advanced.learnedMoveScores : null;
    const requestedLearnedWeight = Number(advanced.learnedMoveWeight);
    const learnedMoveWeight = strategicLevel && Number.isFinite(requestedLearnedWeight)
      ? Math.max(0, Math.min(600, requestedLearnedWeight)) : 0;
    const recentPositions = new Set(Array.isArray(advanced.recentPositions) ? advanced.recentPositions.slice(-20) : []);
    const candidates = orderedMoves(pieces, player, widths[0]);
    // Scan every legal root move. Candidate-width pruning must never hide a win.
    const winningMoves = moves.filter(function (move) {
      const result = applyMove(pieces, player, move.from, move.target);
      return result && result.winner === player;
    });
    // 对手一步可赢：把“进入对手营地”的全部合法走法强制纳入根候选——
    // 这是唯一可能拖延对手完成的手段，不能因为走法排序被宽度剪枝排除。
    // 阻挡是亏节奏的战术，因此只在该威胁真实存在时才会被考虑。
    if (!winningMoves.length) {
      const opponent = opposite(player);
      const opponentCanWinNext = listMoves(pieces, opponent).some(function (opponentMove) {
        const result = applyMove(pieces, opponent, opponentMove.from, opponentMove.target);
        return result && result.winner === opponent;
      });
      if (opponentCanWinNext) {
        const theirGoal = goalFor(opponent);
        moves.forEach(function (move) {
          if (!theirGoal.has(move.target)) return;
          if (candidates.some(function (candidate) { return candidate.from === move.from && candidate.target === move.target; })) return;
          candidates.push(move);
        });
      }
    }
    const requestedCandidateBudget = Math.floor(Number(advanced.candidateNodeBudget));
    const candidateBudget = Number.isFinite(requestedCandidateBudget)
      ? Math.max(1, Math.min(100000, requestedCandidateBudget))
      : Math.max(24, Math.floor(options.maxNodes / Math.max(1, candidates.length)));
    const useTranspositionTable = strategicLevel && advanced.enableTranspositionTable === true;
    const transpositionTable = useTranspositionTable ? new Map() : null;
    const evaluatorVersion = learnedModel && learnedModel.featureVersion
      ? learnedModel.featureVersion
      : 'cc-static-v2';
    // 同一决策内共享叶子评估缓存：置换局面只计算一次静态+价值分。
    const evalCache = new Map();
    const evalCacheLimit = 10000;
    const analyzed = [];
    let timePoolMs = timeLimitMs;
    candidates.forEach(function (move, candidateIndex) {
      // 时间预算按剩余候选均分，前面的候选用不完的份额会留给后面的候选。
      const shareMs = timeLimitMs > 0
        ? Math.max(3, Math.floor(timePoolMs / Math.max(1, candidates.length - candidateIndex)))
        : 0;
      const context = {
        nodes: 0, maxNodes: candidateBudget, widths: widths, ply: 1, model: learnedModel,
        tt: transpositionTable, evaluatorVersion: evaluatorVersion,
        ttProbes: 0, ttHits: 0, ttExactHits: 0, ttCutoffs: 0, ttStores: 0,
        budgetCutoffs: 0, startTime: Date.now(), timeLimitMs: shareMs,
        evalCache: evalCache, evalCacheLimit: evalCacheLimit
      };
      const result = applyMove(pieces, player, move.from, move.target);
      if (!result) return;
      const searchResult = result.winner
        ? { score: 100000, complete: true, boundType: TT_EXACT }
        : dfsSearch(result.pieces, opposite(player), player, options.depth - 1, -Infinity, Infinity, context);
      if (timeLimitMs > 0) timePoolMs = Math.max(0, timePoolMs - (Date.now() - context.startTime));
      let baseScore = searchResult.score;
      // 价值接近时优先长跳和真正进入目标营地的走法，避免过度防守拖慢竞速局。
      baseScore += moveScore(pieces, player, move) * tempoWeight;
      // 根节点避免回到最近已经出现过的完整局面，减少两枚棋子反复横跳。
      if (!result.winner && recentPositions.has(positionKey(result.pieces))) baseScore -= 900;
      analyzed.push({
        action: move, baseDfsScore: baseScore, nodes: context.nodes,
        searchComplete: searchResult.complete, boundType: searchResult.boundType,
        ttProbes: context.ttProbes, ttHits: context.ttHits,
        ttExactHits: context.ttExactHits, ttCutoffs: context.ttCutoffs,
        ttStores: context.ttStores, budgetCutoffs: context.budgetCutoffs,
        directWin: !!result.winner, repeated: !result.winner && recentPositions.has(positionKey(result.pieces)),
        moveScore: moveScore(pieces, player, move)
      });
    });
    const bestBaseScore = analyzed.reduce(function (best, item) { return Math.max(best, item.baseDfsScore); }, -Infinity);
    return {
      moves: moves, candidates: analyzed, winningMoves: winningMoves,
      bestBaseScore: bestBaseScore, learnedMoveScores: learnedMoveScores,
      learnedMoveWeight: learnedMoveWeight, options: options,
      totalNodes: analyzed.reduce(function (sum, item) { return sum + item.nodes; }, 0),
      searchComplete: analyzed.every(function (item) { return item.searchComplete; }),
      transpositionTableEnabled: useTranspositionTable,
      transpositionTableSize: transpositionTable ? transpositionTable.size : 0,
      ttProbes: analyzed.reduce(function (sum, item) { return sum + item.ttProbes; }, 0),
      ttHits: analyzed.reduce(function (sum, item) { return sum + item.ttHits; }, 0),
      ttExactHits: analyzed.reduce(function (sum, item) { return sum + item.ttExactHits; }, 0),
      ttCutoffs: analyzed.reduce(function (sum, item) { return sum + item.ttCutoffs; }, 0),
      ttStores: analyzed.reduce(function (sum, item) { return sum + item.ttStores; }, 0),
      budgetCutoffs: analyzed.reduce(function (sum, item) { return sum + item.budgetCutoffs; }, 0)
    };
  }

  function chooseAiMove(pieces, player, level, randomFn, searchOptions) {
    const moves = listMoves(pieces, player);
    if (!moves.length) return null;
    const random = typeof randomFn === 'function' ? randomFn : Math.random;
    if (level === 'easy') return moves[Math.floor(random() * moves.length)];
    const advanced = searchOptions && typeof searchOptions === 'object' ? searchOptions : {};
    const analysis = analyzeAiMoves(pieces, player, level, advanced);
    if (analysis.winningMoves.length) return analysis.winningMoves[Math.floor(random() * analysis.winningMoves.length)];
    const requestedMargin = Number(advanced.safeLearnedMargin);
    const safeLearnedMargin = Number.isFinite(requestedMargin) ? Math.max(0, Math.min(5000, requestedMargin)) : Infinity;
    let bestScore = -Infinity;
    let bestMoves = [];
    analysis.candidates.forEach(function (candidate) {
      let score = candidate.baseDfsScore;
      if (analysis.learnedMoveScores && analysis.learnedMoveWeight > 0 &&
        analysis.bestBaseScore - candidate.baseDfsScore <= safeLearnedMargin) {
        const learnedScore = Number(analysis.learnedMoveScores[candidate.action.from + '>' + candidate.action.target]);
        if (Number.isFinite(learnedScore)) score += Math.max(-2, Math.min(2, learnedScore)) * analysis.learnedMoveWeight;
      }
      if (score > bestScore) { bestScore = score; bestMoves = [candidate.action]; }
      else if (score === bestScore) bestMoves.push(candidate.action);
    });
    return bestMoves.length ? bestMoves[Math.floor(random() * bestMoves.length)] : moves[0];
  }

  return {
    ROW_COUNTS: ROW_COUNTS.slice(), DIRECTIONS: DIRECTIONS.map(function (d) { return d.slice(); }),
    BOARD_CELLS: BOARD_CELLS.map(function (cell) { return Object.assign({}, cell); }),
    TOP_CAMP: Array.from(TOP_CAMP), BOTTOM_CAMP: Array.from(BOTTOM_CAMP),
    VALUE_FEATURE_VERSION: VALUE_FEATURE_VERSION,
    keyOf: keyOf, buildBoardCells: buildBoardCells, createInitialPieces: createInitialPieces,
    getLegalMoves: getLegalMoves, findMovePath: findMovePath, applyMove: applyMove,
    countInGoal: countInGoal, hasWon: hasWon, orientPoint: orientPoint,
    sanitizePieces: sanitizePieces, sanitizeState: sanitizeState, sanitizeLastMove: sanitizeLastMove,
    listMoves: listMoves, moveScore: moveScore, evaluatePosition: evaluatePosition,
    extractValueFeatures: extractValueFeatures, predictValueModel: predictValueModel,
    evaluateHybridPosition: evaluateHybridPosition, positionKey: positionKey,
    transpositionKey: transpositionKey,
    analyzeAiMoves: analyzeAiMoves, chooseAiMove: chooseAiMove
  };
});
