'use strict';

/**
 * 中国跳棋单人搬运（army transfer）最短路适配器。
 *
 * 研究中的 27 步结论针对没有对手棋子的单人问题。这里保持同一语义：状态只
 * 包含一方的棋子；对抗局中的对手仍由 minimax/PUCT 处理。本适配器提供精确的
 * 连续跳跃后继生成和可证明不高估的 A* 下界，供离线求解、残局表与评价特征复用。
 */
const Core = require('../../public/checkers/checkers_core');
const { bidirectionalAStar } = require('../bidirectional_astar');

const CELLS = Core.BOARD_CELLS.map(function (cell, index) {
  return Object.assign({ index: index }, cell);
});
const CELL_BY_KEY = new Map(CELLS.map(function (cell) { return [cell.key, cell]; }));
const CELL_BY_INDEX = CELLS.slice();
const INDEX_BY_KEY = new Map(CELLS.map(function (cell) { return [cell.key, cell.index]; }));

/** 标准双人棋盘去掉其余四个角后等价于 81 孔、六方向移动的 9×9 区域。 */
function isTwoPlayerCorridorCell(cell) {
  if (cell.row <= 3 || cell.row >= 13) return true;
  const maximumUnit = cell.row <= 8 ? cell.row : 16 - cell.row;
  return Math.abs(cell.unit) <= maximumUnit;
}

function hexDistance(left, right) {
  const leftQ = (left.unit - left.row) / 2;
  const rightQ = (right.unit - right.row) / 2;
  const dq = leftQ - rightQ;
  const dr = left.row - right.row;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** O(n^3) 最小权匹配；比按坐标排序后贪心配对稳定且不会重复占用目标孔。 */
function minimumAssignmentDistance(pieceIndices, targetIndices) {
  const size = pieceIndices.length;
  if (size !== targetIndices.length) throw new Error('棋子数与目标孔数不一致');
  if (!size) return 0;
  const u = new Array(size + 1).fill(0);
  const v = new Array(size + 1).fill(0);
  const matching = new Array(size + 1).fill(0);
  const previous = new Array(size + 1).fill(0);
  for (let row = 1; row <= size; row++) {
    matching[0] = row;
    let column = 0;
    const minimum = new Array(size + 1).fill(Infinity);
    const used = new Array(size + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matching[column];
      let delta = Infinity;
      let nextColumn = 0;
      for (let candidate = 1; candidate <= size; candidate++) {
        if (used[candidate]) continue;
        const cost = hexDistance(CELL_BY_INDEX[pieceIndices[currentRow - 1]], CELL_BY_INDEX[targetIndices[candidate - 1]]);
        const reduced = cost - u[currentRow] - v[candidate];
        if (reduced < minimum[candidate]) { minimum[candidate] = reduced; previous[candidate] = column; }
        if (minimum[candidate] < delta) { delta = minimum[candidate]; nextColumn = candidate; }
      }
      for (let candidate = 0; candidate <= size; candidate++) {
        if (used[candidate]) { u[matching[candidate]] += delta; v[candidate] -= delta; }
        else minimum[candidate] -= delta;
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

class ChineseCheckersShortestPathSolver {
  constructor(options) {
    this.options = Object.assign({ corridorOnly: true }, options || {});
    this.allowedCells = CELLS.filter(function (cell) {
      return !this.options.corridorOnly || isTwoPlayerCorridorCell(cell);
    }, this);
    this.allowedIndices = new Set(this.allowedCells.map(function (cell) { return cell.index; }));
    let maximumDistance = 1;
    for (let left = 0; left < this.allowedCells.length; left++) {
      for (let right = left + 1; right < this.allowedCells.length; right++) {
        maximumDistance = Math.max(maximumDistance, hexDistance(this.allowedCells[left], this.allowedCells[right]));
      }
    }
    this.maximumSingleMoveDistance = maximumDistance;
  }

  stateKey(state) { return state.join(','); }

  normalizeState(input, player) {
    let indices;
    if (Array.isArray(input)) {
      indices = input.map(function (value) {
        if (Number.isInteger(value)) return value;
        return INDEX_BY_KEY.get(String(value));
      });
    } else if (input && typeof input === 'object') {
      const owner = player === 'blue' ? 'blue' : 'red';
      indices = Object.keys(input).filter(function (key) { return input[key] === owner; })
        .map(function (key) { return INDEX_BY_KEY.get(key); });
    } else throw new Error('无法读取跳棋最短路状态');
    if (!indices.length || indices.some(function (index) { return !Number.isInteger(index); })) {
      throw new Error('最短路状态包含棋盘外坐标');
    }
    const unique = new Set(indices);
    if (unique.size !== indices.length || indices.some(function (index) { return !this.allowedIndices.has(index); }, this)) {
      throw new Error('最短路状态包含重叠棋子或非双人通道坐标');
    }
    return indices.slice().sort(function (left, right) { return left - right; });
  }

  startState(player) {
    const keys = player === 'blue' ? Core.BOTTOM_CAMP : Core.TOP_CAMP;
    return this.normalizeState(keys);
  }

  goalState(player) {
    const keys = player === 'blue' ? Core.TOP_CAMP : Core.BOTTOM_CAMP;
    return this.normalizeState(keys);
  }

  decodeState(state) {
    return state.map(function (index) { return CELL_BY_INDEX[index].key; });
  }

  reverseAction(action) {
    return {
      from: action.target,
      target: action.from,
      kind: action.kind,
      path: Array.isArray(action.path) ? action.path.slice().reverse() : [action.target, action.from]
    };
  }

  /** 生成全部单步与所有可停止的连续跳跃终点，并按结果局面去重。 */
  neighbors(state) {
    const occupied = new Set(state);
    const results = new Map();
    const addResult = function (pieceOffset, targetIndex, kind, path) {
      const next = state.slice();
      next[pieceOffset] = targetIndex;
      next.sort(function (left, right) { return left - right; });
      const key = this.stateKey(next);
      if (!results.has(key)) results.set(key, {
        state: next,
        cost: 1,
        action: {
          from: CELL_BY_INDEX[state[pieceOffset]].key,
          target: CELL_BY_INDEX[targetIndex].key,
          kind: kind,
          path: path.map(function (index) { return CELL_BY_INDEX[index].key; })
        }
      });
    }.bind(this);

    for (let pieceOffset = 0; pieceOffset < state.length; pieceOffset++) {
      const originIndex = state[pieceOffset];
      const origin = CELL_BY_INDEX[originIndex];
      const isOccupied = function (index) { return index !== originIndex && occupied.has(index); };
      for (let directionIndex = 0; directionIndex < Core.DIRECTIONS.length; directionIndex++) {
        const direction = Core.DIRECTIONS[directionIndex];
        const target = CELL_BY_KEY.get(Core.keyOf(origin.row + direction[0], origin.unit + direction[1]));
        if (target && this.allowedIndices.has(target.index) && !isOccupied(target.index)) {
          addResult(pieceOffset, target.index, 'step', [originIndex, target.index]);
        }
      }

      const visited = new Set([originIndex]);
      const queue = [originIndex];
      const parents = new Map();
      while (queue.length) {
        const currentIndex = queue.shift();
        const current = CELL_BY_INDEX[currentIndex];
        for (let directionIndex = 0; directionIndex < Core.DIRECTIONS.length; directionIndex++) {
          const direction = Core.DIRECTIONS[directionIndex];
          const over = CELL_BY_KEY.get(Core.keyOf(current.row + direction[0], current.unit + direction[1]));
          const landing = CELL_BY_KEY.get(Core.keyOf(current.row + direction[0] * 2, current.unit + direction[1] * 2));
          if (!over || !landing || !this.allowedIndices.has(landing.index) || !isOccupied(over.index) ||
            isOccupied(landing.index) || visited.has(landing.index)) continue;
          visited.add(landing.index);
          parents.set(landing.index, currentIndex);
          queue.push(landing.index);
          const path = [landing.index];
          let cursor = landing.index;
          while (cursor !== originIndex) { cursor = parents.get(cursor); path.push(cursor); }
          addResult(pieceOffset, landing.index, 'jump', path.reverse());
        }
      }
    }
    return Array.from(results.values());
  }

  /**
   * 可采纳 A* 下界：一次只移动一枚棋子，所以目标营外棋子数每步最多减 1；
   * 最优匹配六角距离每步最多减少整个棋盘的最大跨度。两者取最大仍不高估。
   */
  estimate(state, targetState) {
    const targetSet = new Set(targetState);
    const outsideGoal = state.reduce(function (count, index) { return count + (targetSet.has(index) ? 0 : 1); }, 0);
    const assignmentDistance = minimumAssignmentDistance(state, targetState);
    const distanceLowerBound = Math.ceil(assignmentDistance / this.maximumSingleMoveDistance);
    return {
      lowerBound: Math.max(outsideGoal, distanceLowerBound),
      outsideGoal: outsideGoal,
      assignmentDistance: assignmentDistance,
      distanceLowerBound: distanceLowerBound
    };
  }

  solve(startInput, goalInput, options) {
    const start = this.normalizeState(startInput);
    const goal = this.normalizeState(goalInput);
    if (start.length !== goal.length) throw new Error('起点与终点棋子数不一致');
    const heuristicCache = new Map();
    const heuristic = function (state, target) {
      const cacheKey = this.stateKey(state) + '>' + this.stateKey(target);
      if (!heuristicCache.has(cacheKey)) heuristicCache.set(cacheKey, this.estimate(state, target).lowerBound);
      return heuristicCache.get(cacheKey);
    }.bind(this);
    const guidance = function (state, target) {
      return this.estimate(state, target).assignmentDistance;
    }.bind(this);
    const result = bidirectionalAStar(Object.assign({
      start: start,
      goal: goal,
      key: this.stateKey.bind(this),
      neighbors: this.neighbors.bind(this),
      heuristic: heuristic,
      guidance: guidance,
      reverseAction: this.reverseAction.bind(this)
    }, options || {}));
    result.start = this.decodeState(start);
    result.goal = this.decodeState(goal);
    result.initialEstimate = this.estimate(start, goal);
    result.suggestedAction = result.actions[0] || result.partialActions[0] || null;
    return result;
  }

  solveInitial(player, options) {
    const owner = player === 'blue' ? 'blue' : 'red';
    return this.solve(this.startState(owner), this.goalState(owner), options);
  }
}

module.exports = {
  ChineseCheckersShortestPathSolver: ChineseCheckersShortestPathSolver,
  isTwoPlayerCorridorCell: isTwoPlayerCorridorCell,
  hexDistance: hexDistance,
  minimumAssignmentDistance: minimumAssignmentDistance
};
