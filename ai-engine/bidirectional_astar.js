'use strict';

/** 最小二叉堆；只暴露 A* 所需的 push/pop/peek，避免引入运行时依赖。 */
class MinPriorityQueue {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (items[parent].priority <= item.priority) break;
      items[index] = items[parent]; index = parent;
    }
    items[index] = item;
  }
  pop() {
    const items = this.items;
    if (!items.length) return null;
    const root = items[0];
    const tail = items.pop();
    if (!items.length) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= items.length) break;
      const child = right < items.length && items[right].priority < items[left].priority ? right : left;
      if (items[child].priority >= tail.priority) break;
      items[index] = items[child]; index = child;
    }
    items[index] = tail;
    return root;
  }
  peek() { return this.items.length ? this.items[0] : null; }
}

function requiredFunction(settings, name) {
  if (typeof settings[name] !== 'function') throw new Error('双向 A* 缺少 ' + name + ' 函数');
  return settings[name];
}

function validTop(frontier) {
  let top = frontier.open.peek();
  while (top && frontier.gScore.get(top.key) !== top.g) {
    frontier.open.pop();
    top = frontier.open.peek();
  }
  return top;
}

function popValid(frontier) {
  validTop(frontier);
  return frontier.open.pop();
}

function traceForward(key, parents) {
  const actions = [];
  let cursor = key;
  while (parents.has(cursor)) {
    const edge = parents.get(cursor);
    actions.push(edge.action); cursor = edge.parentKey;
  }
  return actions.reverse();
}

function traceBackward(key, parents, reverseAction) {
  const actions = [];
  let cursor = key;
  while (parents.has(cursor)) {
    const edge = parents.get(cursor);
    actions.push(reverseAction(edge.action)); cursor = edge.parentKey;
  }
  return actions;
}

/**
 * 在无向、非负单位代价图上执行受预算保护的双向 A*。
 *
 * heuristic 必须是相容的下界；heuristicWeight=1 且返回 optimal=true 时，
 * 路径才具有最短性证明。大于 1 的权重用于快速找可行路线，不宣称最优。
 */
function bidirectionalAStar(options) {
  const settings = options || {};
  const keyOf = requiredFunction(settings, 'key');
  const neighbors = requiredFunction(settings, 'neighbors');
  const heuristic = requiredFunction(settings, 'heuristic');
  const reverseAction = requiredFunction(settings, 'reverseAction');
  const guidance = typeof settings.guidance === 'function' ? settings.guidance : heuristic;
  const start = settings.start;
  const goal = settings.goal;
  const startKey = keyOf(start);
  const goalKey = keyOf(goal);
  const maxNodes = Math.max(1, Math.floor(Number(settings.maxNodes) || 50000));
  const timeLimitMs = Math.max(1, Math.floor(Number(settings.timeLimitMs) || 3000));
  const heuristicWeight = Math.max(1, Number(settings.heuristicWeight) || 1);
  const startedAt = Date.now();

  if (startKey === goalKey) return {
    found: true, optimal: true, cost: 0, actions: [], partialActions: [],
    expanded: 0, generated: 1, elapsedMs: 0, reason: 'solved'
  };

  function createFrontier(state, target, key) {
    const h = Math.max(0, Number(heuristic(state, target)) || 0);
    const guide = Math.max(0, Number(guidance(state, target)) || 0);
    const open = new MinPriorityQueue();
    open.push({ state: state, key: key, g: 0, h: h, priority: h * heuristicWeight });
    return {
      open: open, gScore: new Map([[key, 0]]), parents: new Map(),
      best: { key: key, h: h, guide: guide, g: 0 }
    };
  }

  const forward = createFrontier(start, goal, startKey);
  const backward = createFrontier(goal, start, goalKey);
  let expanded = 0;
  let generated = 2;
  let bestCost = Infinity;
  let meetingKey = '';
  let stopReason = 'exhausted';

  while (forward.open.size && backward.open.size) {
    if (expanded >= maxNodes) { stopReason = 'node_budget'; break; }
    if (Date.now() - startedAt >= timeLimitMs) { stopReason = 'time_budget'; break; }
    const topForward = validTop(forward);
    const topBackward = validTop(backward);
    if (!topForward || !topBackward) break;
    // 两边的最小 f 都不可能优于当前相遇解时，最短性证明完成。
    if (heuristicWeight === 1 && Number.isFinite(bestCost) &&
      topForward.priority >= bestCost && topBackward.priority >= bestCost) {
      stopReason = 'solved'; break;
    }
    // 按较小开放集扩展，减少两侧规模失衡；相等时扩展 f 较小的一侧。
    const expandForward = forward.open.size < backward.open.size ||
      (forward.open.size === backward.open.size && topForward.priority <= topBackward.priority);
    const active = expandForward ? forward : backward;
    const other = expandForward ? backward : forward;
    const target = expandForward ? goal : start;
    const current = popValid(active);
    if (!current) break;
    expanded++;

    if (other.gScore.has(current.key)) {
      const cost = current.g + other.gScore.get(current.key);
      if (cost < bestCost) { bestCost = cost; meetingKey = current.key; }
    }

    const edges = neighbors(current.state);
    for (let index = 0; index < edges.length; index++) {
      const edge = edges[index];
      const next = edge.state;
      const nextKey = keyOf(next);
      const stepCost = Math.max(0, Number(edge.cost) || 1);
      const nextG = current.g + stepCost;
      if (nextG >= (active.gScore.get(nextKey) ?? Infinity)) continue;
      const nextH = Math.max(0, Number(heuristic(next, target)) || 0);
      const nextGuide = Math.max(0, Number(guidance(next, target)) || 0);
      active.gScore.set(nextKey, nextG);
      active.parents.set(nextKey, { parentKey: current.key, action: edge.action });
      active.open.push({
        state: next, key: nextKey, g: nextG, h: nextH,
        priority: nextG + nextH * heuristicWeight
      });
      generated++;
      if (nextGuide < active.best.guide ||
        (nextGuide === active.best.guide && (nextH < active.best.h || (nextH === active.best.h && nextG < active.best.g)))) {
        active.best = { key: nextKey, h: nextH, guide: nextGuide, g: nextG };
      }
      if (other.gScore.has(nextKey)) {
        const cost = nextG + other.gScore.get(nextKey);
        if (cost < bestCost) { bestCost = cost; meetingKey = nextKey; }
      }
    }

    // 加权 A* 是“尽快找到路线”模式，首次相遇后即可返回但不标记最优。
    if (heuristicWeight > 1 && Number.isFinite(bestCost)) { stopReason = 'solved_unproven'; break; }
  }

  const found = Number.isFinite(bestCost) && !!meetingKey;
  const actions = found
    ? traceForward(meetingKey, forward.parents).concat(traceBackward(meetingKey, backward.parents, reverseAction))
    : [];
  const partialActions = found ? actions : traceForward(forward.best.key, forward.parents);
  return {
    found: found,
    optimal: found && heuristicWeight === 1 && stopReason === 'solved',
    cost: found ? bestCost : Infinity,
    actions: actions,
    partialActions: partialActions,
    expanded: expanded,
    generated: generated,
    elapsedMs: Date.now() - startedAt,
    reason: stopReason,
    bestForwardHeuristic: forward.best.h,
    bestForwardGuidance: forward.best.guide
  };
}

module.exports = {
  MinPriorityQueue: MinPriorityQueue,
  bidirectionalAStar: bidirectionalAStar
};
