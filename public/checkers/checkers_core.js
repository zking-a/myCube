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

  /** 星盘六营地（顺时针 top → ur → lr → bottom → ll → ul）；对家营地即目标营地。 */
  const CAMP_IDS = ['top', 'ur', 'lr', 'bottom', 'll', 'ul'];
  const CAMP_OPPOSITE = { top: 'bottom', bottom: 'top', ul: 'lr', lr: 'ul', ur: 'll', ll: 'ur' };
  const CAMP_COLORS = { top: 'red', bottom: 'blue', ur: 'green', lr: 'yellow', ll: 'purple', ul: 'orange' };
  const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
  const COLOR_LETTERS = { red: 'r', blue: 'b', green: 'g', yellow: 'y', purple: 'p', orange: 'o' };
  /** 各人数的座位布局。3 人取相间营地，保证每家目标营地空闲；4 人取两对对家（经典十字）；5 人空出 ul。 */
  const SEAT_LAYOUTS = {
    2: ['top', 'bottom'],
    3: ['top', 'lr', 'll'],
    4: ['top', 'ur', 'bottom', 'll'],
    5: ['top', 'ur', 'lr', 'bottom', 'll'],
    6: CAMP_IDS
  };

  /** 营地归属：上下两个三角按行号；四个侧翼是 4/3/2/1 的斜三角，按 unit 越界判定。 */
  function campOfCell(row, unit) {
    if (row <= 3) return 'top';
    if (row >= 13) return 'bottom';
    if (row <= 7) {
      if (unit < -row) return 'ul';
      if (unit > row) return 'ur';
    } else {
      if (unit < row - 16) return 'll';
      if (unit > 16 - row) return 'lr';
    }
    return '';
  }

  function buildBoardCells() {
    const cells = [];
    ROW_COUNTS.forEach(function (count, row) {
      for (let column = 0; column < count; column++) {
        const unit = -(count - 1) + column * 2;
        cells.push({
          key: keyOf(row, unit), row: row, unit: unit,
          x: 160 + unit * 10.8, y: 16 + row * 18,
          camp: campOfCell(row, unit)
        });
      }
    });
    return cells;
  }

  const BOARD_CELLS = buildBoardCells();
  const CELL_MAP = new Map(BOARD_CELLS.map(function (cell) { return [cell.key, cell]; }));
  const TOP_CAMP = new Set(BOARD_CELLS.filter(function (cell) { return cell.camp === 'top'; }).map(function (cell) { return cell.key; }));
  const BOTTOM_CAMP = new Set(BOARD_CELLS.filter(function (cell) { return cell.camp === 'bottom'; }).map(function (cell) { return cell.key; }));
  const CAMP_KEYS = {};
  CAMP_IDS.forEach(function (camp) {
    CAMP_KEYS[camp] = BOARD_CELLS.filter(function (cell) { return cell.camp === camp; }).map(function (cell) { return cell.key; });
  });

  function createInitialPieces() {
    const pieces = {};
    TOP_CAMP.forEach(function (key) { pieces[key] = 'red'; });
    BOTTOM_CAMP.forEach(function (key) { pieces[key] = 'blue'; });
    return pieces;
  }

  /** 按座位营地布置初始局面，每个营地 10 枚同色棋子；2 人布局与 createInitialPieces 等价。 */
  function createInitialPiecesForSeats(seatCamps) {
    const pieces = {};
    (Array.isArray(seatCamps) ? seatCamps : []).forEach(function (camp) {
      if (!CAMP_KEYS[camp]) return;
      CAMP_KEYS[camp].forEach(function (key) { pieces[key] = CAMP_COLORS[camp]; });
    });
    return pieces;
  }

  function seatColorsFor(seatCamps) {
    return (Array.isArray(seatCamps) ? seatCamps : [])
      .map(function (camp) { return CAMP_COLORS[camp] || ''; })
      .filter(Boolean);
  }

  function campOfColor(color) {
    return CAMP_IDS.find(function (camp) { return CAMP_COLORS[camp] === color; }) || '';
  }

  /**
   * 从 fromKey 出发的全部跳跃落点（BFS 链跳）。
   * 经典相邻跳：被跳棋子必须紧邻（相邻格有子，己方或对方均可），
   * 落点在其正后方（距离 2）且为空，可连续跳跃一气呵成。
   * 返回 Map(落点 → 链上前一位置)，getLegalMoves 与 findMovePath 共用，避免两份逻辑漂移。
   */
  // Geometry is immutable; don't recreate coordinate strings at every search edge.
  const NEIGHBORS = new Map();
  BOARD_CELLS.forEach(function (cell) {
    NEIGHBORS.set(cell.key, DIRECTIONS.map(function (d) {
      const middle = keyOf(cell.row + d[0], cell.unit + d[1]);
      const target = keyOf(cell.row + d[0] * 2, cell.unit + d[1] * 2);
      return { middle: CELL_MAP.has(middle) ? middle : '', target: CELL_MAP.has(target) ? target : '' };
    }));
  });
  function collectJumps(pieces, fromKey) {
    const parents = new Map();
    const visited = new Set([fromKey]);
    const queue = [fromKey];
    if (!CELL_MAP.has(fromKey) || !pieces || !pieces[fromKey]) return parents;
    for (let head = 0; head < queue.length; head++) {
      const currentKey = queue[head];
      NEIGHBORS.get(currentKey).forEach(function (edge) {
        // The moving checker has vacated its origin; it cannot become its own hurdle.
        if (!edge.middle || edge.middle === fromKey || !pieces[edge.middle]) return;
        const landing = edge.target;
        if (landing && landing !== fromKey && !pieces[landing] && !visited.has(landing)) {
          visited.add(landing); parents.set(landing, currentKey); queue.push(landing);
        }
      });
    }
    return parents;
  }

  function getLegalMoves(pieces, fromKey) {
    const from = CELL_MAP.get(fromKey);
    if (!from || !pieces || !pieces[fromKey]) return { steps: [], jumps: [], all: [] };
    const steps = [];
    DIRECTIONS.forEach(function (direction) {
      const targetKey = keyOf(from.row + direction[0], from.unit + direction[1]);
      if (CELL_MAP.has(targetKey) && !pieces[targetKey]) steps.push(targetKey);
    });

    const jumps = Array.from(collectJumps(pieces, fromKey).keys());
    return { steps: steps, jumps: jumps, all: steps.concat(jumps) };
  }

  /** 目标营地 = 本方营地的对家。红=bottom、蓝=top 与旧版完全一致，其余四色按对家推广。 */
  const GOAL_CACHES = {};
  function goalFor(player) {
    if (GOAL_CACHES[player]) return GOAL_CACHES[player];
    const goalCamp = CAMP_OPPOSITE[campOfColor(player)] || 'bottom';
    const cached = new Set(CAMP_KEYS[goalCamp] || []);
    GOAL_CACHES[player] = cached;
    return cached;
  }
  function countInGoal(pieces, player) {
    let count = 0;
    goalFor(player).forEach(function (key) { if (pieces[key] === player) count++; });
    return count;
  }
  function hasWon(pieces, player) { return countInGoal(pieces, player) === 10; }

  function findMovePath(pieces, fromKey, targetKey) {
    const from = CELL_MAP.get(fromKey);
    if (!from || !CELL_MAP.has(targetKey) || !pieces || !pieces[fromKey] || pieces[targetKey]) return null;
    if (NEIGHBORS.get(fromKey).some(function (edge) { return edge.middle === targetKey; })) return [fromKey, targetKey];
    const parents = collectJumps(pieces, fromKey);
    if (!parents.has(targetKey)) return null;
    const path = [targetKey];
    let cursor = targetKey;
    while (cursor !== fromKey) { cursor = parents.get(cursor); path.push(cursor); }
    return path.reverse();
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
    const counts = {};
    Object.keys(raw).forEach(function (key) {
      const owner = raw[key];
      if (!CELL_MAP.has(key) || COLORS.indexOf(owner) < 0 || pieces[key]) return;
      pieces[key] = owner;
      counts[owner] = (counts[owner] || 0) + 1;
    });
    const seats = Object.keys(counts);
    if (!seats.length) return null;
    return seats.every(function (color) { return counts[color] === 10; }) ? pieces : null;
  }

  /** 该颜色必须真实在场（恰好 10 枚）才能作为 turn / winner。 */
  function isLiveColor(pieces, color) {
    if (!pieces || COLORS.indexOf(color) < 0) return false;
    let count = 0;
    Object.keys(pieces).forEach(function (key) { if (pieces[key] === color) count++; });
    return count === 10;
  }

  function sanitizeState(raw) {
    if (!raw || !isLiveColor(raw.pieces, raw.turn)) return null;
    const pieces = sanitizePieces(raw.pieces);
    if (!pieces) return null;
    const actualWinners = COLORS.filter(function (color) { return hasWon(pieces, color); });
    if (actualWinners.length > 1) return null; // First-finisher rules cannot produce two winners.
    const claimedWinner = actualWinners[0] || '';
    return {
      pieces: pieces,
      turn: raw.turn,
      moveNumber: Math.max(1, Math.min(9999, Math.floor(Number(raw.moveNumber) || 1))),
      winner: claimedWinner,
      lastMove: sanitizeLastMove(raw.lastMove, pieces)
    };
  }

  function sanitizeLastMove(raw, pieces) {
    if (!raw) return null;
    if (!raw || COLORS.indexOf(raw.player) < 0) return null;
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
    const forward = orientedMetrics(target, player).progress - orientedMetrics(from, player).progress;
    const fromGoal = goalFor(player).has(move.from);
    const targetGoal = goalFor(player).has(move.target);
    const enteringGoal = !fromGoal && targetGoal ? 1 : 0;
    const leavingGoal = fromGoal && !targetGoal ? 1 : 0;
    const centerGain = Math.abs(orientedMetrics(from, player).axis) - Math.abs(orientedMetrics(target, player).axis);
    // 历史教训（2026.08）：不要为“营内挪动”加排序惩罚——腾出营地空孔让营外
    // 棋子跳入是终局关键战术，惩罚会把这类获胜计划挤出根候选窗口（拆解竞技场
    // 0–7 惨败）。营内挪动是否浪费由搜索与评估自行判断。
    return forward * 9 + enteringGoal * 120 - leavingGoal * 180 + centerGain * .7 + (move.kind === 'jump' ? 5 : 0);
  }

  // Rotate every camp into red's local coordinates. Preserve red/blue feature units.
  const AXES = {};
  function orientedMetrics(cell, player) {
    let axis = AXES[player];
    if (!axis) {
      const goals = Array.from(goalFor(player)).map(function (key) { return CELL_MAP.get(key); });
      let dx = 0, dy = 0;
      goals.forEach(function (c) { dx += c.unit / 2; dy += (c.row - 8) * Math.sqrt(3) / 2; });
      const norm = Math.hypot(dx, dy) || 1;
      axis = AXES[player] = { x: dx / norm, y: dy / norm };
    }
    const x = cell.unit / 2, y = (cell.row - 8) * Math.sqrt(3) / 2;
    return { progress: Math.round((8 + (x * axis.x + y * axis.y) * 2 / Math.sqrt(3)) * 1e9) / 1e9,
      axis: Math.round((x * axis.y - y * axis.x) * 2 * 1e9) / 1e9 };
  }

  function opposite(player) { return player === 'red' ? 'blue' : 'red'; }

  const DIST_CACHE = new Map();
  function distanceToGoal(cell, player) {
    const cacheKey = cell.key + '|' + player;
    if (DIST_CACHE.has(cacheKey)) return DIST_CACHE.get(cacheKey);
    let shortest = Infinity;
    goalFor(player).forEach(function (goalKey) {
      const goal = CELL_MAP.get(goalKey);
      const a = orientedMetrics(cell, player), b = orientedMetrics(goal, player);
      const rowDistance = Math.abs(a.progress - b.progress);
      const unitDistance = Math.abs(a.axis - b.axis) / 2;
      shortest = Math.min(shortest, rowDistance * 1.25 + unitDistance * .58);
    });
    DIST_CACHE.set(cacheKey, shortest);
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
      const cellProgress = orientedMetrics(cell, player).progress;
      progress.push(cellProgress);
      forward += cellProgress;
      distance += distanceToGoal(cell, player);
      axisOffset += Math.abs(orientedMetrics(cell, player).axis);
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
      const owner = pieces[cell.key];
      return owner ? (COLOR_LETTERS[owner] || '?') : '.';
    }).join('');
  }

  // Backwards-compatible public entrypoints now route to the stage engine.
  // The original DFS is kept only in /baseline for honest A/B comparisons, never in the live path.
  function stageEngine() {
    if (typeof module === 'object' && module.exports) return require('./checkers_ai_engine.js');
    if (typeof globalThis !== 'undefined' && globalThis.CheckersAI) return globalThis.CheckersAI;
    throw new Error('Load checkers_ai_engine.js before requesting AI moves');
  }
  function transpositionKey(pieces, activePlayer, perspective, evaluatorVersion) {
    return positionKey(pieces) + '|' + activePlayer + '|' + perspective + '|' + String(evaluatorVersion || 'static-v2');
  }
  function chooseAiMove(pieces, player, level, randomFn, searchOptions) {
    const opts = Object.assign({}, searchOptions || {}, {level:level});
    if (typeof randomFn === 'function' && !Number.isFinite(opts.seed)) opts.seed = Math.floor(randomFn() * 4294967296);
    return stageEngine().chooseMove(pieces, player, opts).move;
  }
  function analyzeAiMoves(pieces, player, level, searchOptions) {
    const result = stageEngine().chooseMove(pieces, player, Object.assign({}, searchOptions || {}, {level:level}));
    const candidates = (result.candidates || []).map(function (c) {
      return {action:c.move,baseDfsScore:c.score,searchComplete:result.stats.reliable === true,
        boundType:result.stats.reliable ? (result.stats.algorithm === 'iterative-alpha-beta' ? 'EXACT_WITHIN_SELECTIVE_SEARCH' : result.stats.algorithm === 'direct-win' ? 'TERMINAL' : 'HEURISTIC') : null,
        nodes:0,visits:c.visits,directWin:result.stats.algorithm === 'direct-win'};
    });
    return {moves:listMoves(pieces,player),candidates:candidates,
      winningMoves:result.stats.algorithm === 'direct-win' ? [result.move] : [],
      bestBaseScore:candidates.length ? Math.max.apply(null,candidates.map(function(c){return c.baseDfsScore;})) : -Infinity,
      totalNodes:result.stats.nodes || 0,searchComplete:result.stats.reliable === true,
      options:{depth:result.stats.completedDepth || 0},diagnostics:result.stats};
  }

  return {
    ROW_COUNTS: ROW_COUNTS.slice(), DIRECTIONS: DIRECTIONS.map(function (d) { return d.slice(); }),
    BOARD_CELLS: BOARD_CELLS.map(function (cell) { return Object.assign({}, cell); }),
    TOP_CAMP: Array.from(TOP_CAMP), BOTTOM_CAMP: Array.from(BOTTOM_CAMP),
    CAMP_IDS: CAMP_IDS.slice(), CAMP_COLORS: Object.assign({}, CAMP_COLORS),
    CAMP_OPPOSITE: Object.assign({}, CAMP_OPPOSITE), CAMP_KEYS: CAMP_KEYS,
    SEAT_LAYOUTS: SEAT_LAYOUTS, COLORS: COLORS.slice(),
    VALUE_FEATURE_VERSION: VALUE_FEATURE_VERSION,
    keyOf: keyOf, buildBoardCells: buildBoardCells, createInitialPieces: createInitialPieces,
    createInitialPiecesForSeats: createInitialPiecesForSeats, seatColorsFor: seatColorsFor,
    campOfColor: campOfColor, collectJumps: collectJumps,
    getLegalMoves: getLegalMoves, findMovePath: findMovePath, applyMove: applyMove,
    countInGoal: countInGoal, hasWon: hasWon, orientPoint: orientPoint,
    sanitizePieces: sanitizePieces, sanitizeState: sanitizeState, sanitizeLastMove: sanitizeLastMove,
    listMoves: listMoves, moveScore: moveScore, evaluatePosition: evaluatePosition,
    extractValueFeatures: extractValueFeatures, predictValueModel: predictValueModel,
    evaluateHybridPosition: evaluateHybridPosition, positionKey: positionKey,
    transpositionKey: transpositionKey,
    goalFor: goalFor, playerPosition: playerPosition, hexDistance: hexDistance, orientedMetrics: orientedMetrics,
    goalAssignmentDistance: goalAssignmentDistance,
    analyzeAiMoves: analyzeAiMoves, chooseAiMove: chooseAiMove
  };
});
