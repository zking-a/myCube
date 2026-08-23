'use strict';

/**
 * Deterministic paired-opening generator for Chinese Checkers experiments.
 * Each family contains one sampled opening and its exact 180° color-swapped
 * mirror. Keeping this outside the trainer makes arena and dataset generation
 * share the same reproducible opening contract.
 */

const { createRandom } = require('../policy_value_model');

function sampleIndex(probabilities, random) {
  let cursor = random();
  for (let index = 0; index < probabilities.length; index++) {
    cursor -= Math.max(0, Number(probabilities[index]) || 0);
    if (cursor <= 0) return index;
  }
  return Math.max(0, probabilities.length - 1);
}

function normalized(values) {
  const total = values.reduce(function (sum, value) { return sum + Math.max(0, Number(value) || 0); }, 0) || 1;
  return values.map(function (value) { return Math.max(0, Number(value) || 0) / total; });
}

function buildOpeningPair(game, pairIndex, options) {
  if (!game || typeof game.mirrorState !== 'function') throw new Error('paired opening 要求适配器实现 mirrorState');
  const settings = Object.assign({ seed: 20260823, minPlies: 4, maxPlies: 8, suiteId: 'default' }, options || {});
  const index = Math.max(0, Math.floor(Number(pairIndex) || 0));
  const random = createRandom((Math.floor(Number(settings.seed) || 1) + Math.imul(index + 1, 104729)) >>> 0);
  const minPlies = Math.max(0, Math.floor(Number(settings.minPlies) || 0));
  const maxPlies = Math.max(minPlies, Math.floor(Number(settings.maxPlies) || minPlies));
  const targetPlies = minPlies + (index % (maxPlies - minPlies + 1));
  let state = game.initialState();
  for (let ply = 0; ply < targetPlies && !game.isTerminal(state); ply++) {
    const actions = game.legalActions(state);
    if (!actions.length) break;
    const policy = typeof game.heuristicPolicy === 'function'
      ? normalized(game.heuristicPolicy(state, actions, state.turn))
      : actions.map(function () { return 1 / actions.length; });
    state = game.applyAction(state, actions[sampleIndex(policy, random)]);
  }
  state = Object.assign({}, state, { recent: [] });
  const mirrored = game.mirrorState(state);
  const stem = String(settings.suiteId || 'default') + '-' + String(index + 1).padStart(4, '0');
  return {
    openingFamilyId: 'opening-family-' + stem,
    openingPairId: 'opening-pair-' + stem,
    stateA: state,
    stateB: mirrored,
    openingIdA: 'opening-' + stem + '-a',
    openingIdB: 'opening-' + stem + '-b',
    stateHashA: game.stateKey(state),
    stateHashB: game.stateKey(mirrored),
    plies: state.ply
  };
}

function buildOpeningSuite(game, pairCount, options) {
  const count = Math.max(1, Math.floor(Number(pairCount) || 1));
  return Array.from({ length: count }, function (_value, index) {
    return buildOpeningPair(game, index, options);
  });
}

function selectOpening(pair, orientation) {
  const mirrored = String(orientation || 'a').toLowerCase() === 'b';
  return {
    startState: mirrored ? pair.stateB : pair.stateA,
    openingId: mirrored ? pair.openingIdB : pair.openingIdA,
    openingPairId: pair.openingPairId,
    openingFamilyId: pair.openingFamilyId,
    splitGroupId: pair.openingFamilyId,
    stateHash: mirrored ? pair.stateHashB : pair.stateHashA
  };
}

module.exports = {
  buildOpeningPair: buildOpeningPair,
  buildOpeningSuite: buildOpeningSuite,
  selectOpening: selectOpening
};
