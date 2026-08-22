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

  function playerPosition(pieces, player) {
    let forward = 0;
    let distance = 0;
    let inGoal = 0;
    let axisOffset = 0;
    let tailProgress = Infinity;
    const pieceCells = [];
    Object.keys(pieces).forEach(function (key) {
      if (pieces[key] !== player) return;
      const cell = CELL_MAP.get(key);
      pieceCells.push(cell);
      const progress = player === 'red' ? cell.row : (16 - cell.row);
      forward += progress;
      distance += distanceToGoal(cell, player);
      axisOffset += Math.abs(cell.unit);
      tailProgress = Math.min(tailProgress, progress);
      if (goalFor(player).has(key)) inGoal++;
    });
    return {
      forward: forward,
      distance: distance,
      assignmentDistance: goalAssignmentDistance(pieceCells, player),
      inGoal: inGoal,
      axisOffset: axisOffset,
      tailProgress: tailProgress
    };
  }

  // 价值网络不直接读取 DOM 棋盘，而是读取一组关于双方相对进度的对称特征。
  // 对红蓝交换视角时，除常量项外特征会反号，便于用少量自我对弈样本学习。
  function extractValueFeatures(pieces, perspective) {
    const mine = playerPosition(pieces, perspective);
    const theirs = playerPosition(pieces, opposite(perspective));
    const myProgress = [];
    const theirProgress = [];
    Object.keys(pieces).forEach(function (key) {
      const owner = pieces[key];
      const cell = CELL_MAP.get(key);
      const progress = owner === 'red' ? cell.row : (16 - cell.row);
      if (owner === perspective) myProgress.push(progress);
      else if (owner === opposite(perspective)) theirProgress.push(progress);
    });
    myProgress.sort(function (a, b) { return a - b; });
    theirProgress.sort(function (a, b) { return a - b; });
    const features = [
      1,
      (mine.inGoal - theirs.inGoal) / 10,
      (mine.forward - theirs.forward) / 160,
      (theirs.distance - mine.distance) / 130,
      (theirs.assignmentDistance - mine.assignmentDistance) / 120,
      (theirs.axisOffset - mine.axisOffset) / 120,
      (mine.tailProgress - theirs.tailProgress) / 16
    ];
    for (let i = 0; i < 10; i++) features.push(((myProgress[i] || 0) - (theirProgress[i] || 0)) / 16);
    features.push((mine.inGoal * mine.inGoal - theirs.inGoal * theirs.inGoal) / 100);
    features.push(((myProgress[0] || 0) * (myProgress[1] || 0) - (theirProgress[0] || 0) * (theirProgress[1] || 0)) / 256);
    features.push((((theirProgress[9] || 0) - (theirProgress[0] || 0)) - ((myProgress[9] || 0) - (myProgress[0] || 0))) / 16);
    return features;
  }

  function predictValueModel(pieces, perspective, model) {
    if (!model || model.featureVersion !== VALUE_FEATURE_VERSION || !model.weights) return 0;
    const input = extractValueFeatures(pieces, perspective);
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

  function evaluateHybridPosition(pieces, perspective, model) {
    const base = evaluatePosition(pieces, perspective);
    if (!model) return base;
    const scale = Math.max(0, Math.min(260, Number(model.scale) || 0));
    return base + predictValueModel(pieces, perspective, model) * scale;
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

  // 受预算保护的深度优先极大极小搜索。跳棋分支会在中局膨胀，
  // 因而结合 alpha-beta 剪枝、走法排序和节点上限，而非全盘暴力枚举。
  function dfsSearch(pieces, activePlayer, perspective, depth, alpha, beta, context) {
    if (depth <= 0 || context.nodes >= context.maxNodes) return evaluateHybridPosition(pieces, perspective, context.model);
    context.nodes++;
    const moves = orderedMoves(pieces, activePlayer, context.widths[Math.min(context.widths.length - 1, context.ply)]);
    if (!moves.length) return evaluateHybridPosition(pieces, perspective, context.model);
    const maximizing = activePlayer === perspective;
    let best = maximizing ? -Infinity : Infinity;
    for (let i = 0; i < moves.length; i++) {
      if (context.nodes >= context.maxNodes) break;
      const result = applyMove(pieces, activePlayer, moves[i].from, moves[i].target);
      if (!result) continue;
      let score;
      if (result.winner) {
        score = result.winner === perspective ? 100000 + depth : -100000 - depth;
      } else {
        context.ply++;
        score = dfsSearch(result.pieces, opposite(activePlayer), perspective, depth - 1, alpha, beta, context);
        context.ply--;
      }
      if (maximizing) {
        best = Math.max(best, score); alpha = Math.max(alpha, best);
      } else {
        best = Math.min(best, score); beta = Math.min(beta, best);
      }
      if (beta <= alpha) break;
    }
    return best === Infinity || best === -Infinity ? evaluateHybridPosition(pieces, perspective, context.model) : best;
  }

  function aiSearchOptions(level) {
    if (level === 'hard') return { depth: 3, maxNodes: 3600, widths: [20, 14, 12] };
    return { depth: 2, maxNodes: 700, widths: [14, 12] };
  }

  function chooseAiMove(pieces, player, level, randomFn, searchOptions) {
    const moves = listMoves(pieces, player);
    if (!moves.length) return null;
    const random = typeof randomFn === 'function' ? randomFn : Math.random;
    if (level === 'easy') return moves[Math.floor(random() * moves.length)];
    const options = aiSearchOptions(level);
    const advanced = searchOptions && typeof searchOptions === 'object' ? searchOptions : {};
    const learnedModel = level === 'hard' && advanced.model ? advanced.model : null;
    const requestedTempo = Number(advanced.tempoWeight);
    const tempoWeight = level === 'hard' && Number.isFinite(requestedTempo) ? Math.max(0, Math.min(4, requestedTempo)) : 0;
    const requestedRootWidth = Math.floor(Number(advanced.rootWidth));
    const widths = options.widths.slice();
    if (level === 'hard' && Number.isFinite(requestedRootWidth)) widths[0] = Math.max(8, Math.min(24, requestedRootWidth));
    const recentPositions = new Set(Array.isArray(advanced.recentPositions) ? advanced.recentPositions.slice(-20) : []);
    const candidates = orderedMoves(pieces, player, widths[0]);
    const winningMoves = candidates.filter(function (move) {
      const result = applyMove(pieces, player, move.from, move.target);
      return result && result.winner === player;
    });
    if (winningMoves.length) return winningMoves[Math.floor(random() * winningMoves.length)];
    const candidateBudget = Math.max(24, Math.floor(options.maxNodes / Math.max(1, candidates.length)));
    let bestScore = -Infinity;
    let bestMoves = [];
    candidates.forEach(function (move) {
      const context = { nodes: 0, maxNodes: candidateBudget, widths: widths, ply: 1, model: learnedModel };
      const result = applyMove(pieces, player, move.from, move.target);
      if (!result) return;
      let score = result.winner
        ? 100000
        : dfsSearch(result.pieces, opposite(player), player, options.depth - 1, -Infinity, Infinity, context);
      // 价值接近时优先长跳和真正进入目标营地的走法，避免过度防守拖慢竞速局。
      score += moveScore(pieces, player, move) * tempoWeight;
      // 根节点避免回到最近已经出现过的完整局面，减少两枚棋子反复横跳。
      if (!result.winner && recentPositions.has(positionKey(result.pieces))) score -= 900;
      if (score > bestScore) { bestScore = score; bestMoves = [move]; }
      else if (score === bestScore) bestMoves.push(move);
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
    chooseAiMove: chooseAiMove
  };
});
