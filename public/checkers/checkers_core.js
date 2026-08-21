(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CheckersCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROW_COUNTS = [1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1];
  const DIRECTIONS = [[0,-2],[0,2],[-1,-1],[-1,1],[1,-1],[1,1]];
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
    const targetGoal = goalFor(player).has(move.target) ? 1 : 0;
    const leavingGoal = goalFor(player).has(move.from) && !goalFor(player).has(move.target) ? 1 : 0;
    const centerGain = Math.abs(from.unit) - Math.abs(target.unit);
    return forward * 9 + targetGoal * 80 - leavingGoal * 110 + centerGain * .7 + (move.kind === 'jump' ? 5 : 0);
  }

  function chooseAiMove(pieces, player, level, randomFn) {
    const moves = listMoves(pieces, player);
    if (!moves.length) return null;
    const random = typeof randomFn === 'function' ? randomFn : Math.random;
    if (level === 'easy') return moves[Math.floor(random() * moves.length)];
    const ranked = moves.map(function (move) {
      return { move: move, score: moveScore(pieces, player, move) + random() * (level === 'hard' ? 1.5 : 7) };
    }).sort(function (a, b) { return b.score - a.score; });
    const poolSize = level === 'hard' ? Math.min(2, ranked.length) : Math.min(5, ranked.length);
    return ranked[Math.floor(random() * poolSize)].move;
  }

  return {
    ROW_COUNTS: ROW_COUNTS.slice(), DIRECTIONS: DIRECTIONS.map(function (d) { return d.slice(); }),
    BOARD_CELLS: BOARD_CELLS.map(function (cell) { return Object.assign({}, cell); }),
    TOP_CAMP: Array.from(TOP_CAMP), BOTTOM_CAMP: Array.from(BOTTOM_CAMP),
    keyOf: keyOf, buildBoardCells: buildBoardCells, createInitialPieces: createInitialPieces,
    getLegalMoves: getLegalMoves, findMovePath: findMovePath, applyMove: applyMove,
    countInGoal: countInGoal, hasWon: hasWon, orientPoint: orientPoint,
    sanitizePieces: sanitizePieces, sanitizeState: sanitizeState, sanitizeLastMove: sanitizeLastMove,
    listMoves: listMoves, chooseAiMove: chooseAiMove
  };
});
