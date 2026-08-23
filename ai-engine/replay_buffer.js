'use strict';

/**
 * Capacity-bounded replay buffer that stores and evicts complete games.
 *
 * Keeping game boundaries is important for two reasons: a validation game must
 * never leak positions into training, and capacity eviction must not leave a
 * biased fragment containing only the opening or ending of an old game.
 */
class ReplayBuffer {
  constructor(options) {
    const settings = options || {};
    this.capacity = Math.max(1, Math.floor(Number(settings.capacity) || 50000));
    this.games = [];
    this.sampleCount = 0;
  }

  /** Add or replace one complete game and evict the oldest complete games. */
  addGame(gameId, samples, metadata) {
    const id = String(gameId || '').trim();
    if (!id) throw new Error('回放缓冲区需要稳定的 gameId');
    if (!Array.isArray(samples) || !samples.length) throw new Error('回放缓冲区不能加入空对局');
    if (samples.length > this.capacity) throw new Error('单盘样本数超过回放缓冲区容量');
    const existing = this.games.findIndex(function (game) { return game.gameId === id; });
    if (existing >= 0) {
      this.sampleCount -= this.games[existing].samples.length;
      this.games.splice(existing, 1);
    }
    const normalized = samples.map(function (sample) { return Object.assign({}, sample, { gameId: id }); });
    const sourceHint = (metadata && metadata.source) ? String(metadata.source) : String(normalized[0] && normalized[0].source || 'unknown');
    const nextMetadata = Object.assign({}, metadata || {}, { source: sourceHint });
    this.games.push({ gameId: id, samples: normalized, metadata: nextMetadata });
    this.sampleCount += normalized.length;
    while (this.sampleCount > this.capacity && this.games.length > 1) {
      const removed = this.games.shift();
      this.sampleCount -= removed.samples.length;
    }
  }

  /** Return all retained samples in chronological game order. */
  all() {
    const result = [];
    this.games.forEach(function (game) { result.push.apply(result, game.samples); });
    return result;
  }

  /**
   * Draw a deterministic shuffled subset. With balanceSources enabled, sources
   * are interleaved so a large teacher partition cannot erase league samples.
   */
  sample(count, options) {
    const settings = options || {};
    const random = typeof settings.random === 'function' ? settings.random : Math.random;
    const limit = Math.min(this.sampleCount, Math.max(1, Math.floor(Number(count) || this.sampleCount)));
    const shuffleInPlace = function (values) {
      for (let index = values.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        const value = values[index];
        values[index] = values[swap];
        values[swap] = value;
      }
      return values;
    };
    const shuffle = function (values) {
      for (let index = values.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        const value = values[index]; values[index] = values[swap]; values[swap] = value;
      }
      return values;
    };
    const all = this.all();
    if (!settings.balanceSources) return shuffle(all.slice()).slice(0, limit);
    const sourceBuckets = new Map();
    this.games.forEach(function (game) {
      const source = String(game.metadata && game.metadata.source || game.samples[0] && game.samples[0].source || 'unknown');
      if (!sourceBuckets.has(source)) sourceBuckets.set(source, []);
      sourceBuckets.get(source).push({
        gameId: game.gameId,
        samples: shuffleInPlace(game.samples.slice())
      });
    });
    const pools = shuffleInPlace(Array.from(sourceBuckets.values()).map(function (gameBuckets) {
      return {
        cursor: 0,
        games: shuffleInPlace(gameBuckets.slice())
      };
    }));
    const result = [];
    let cursor = 0;
    while (result.length < limit && pools.length) {
      const pool = pools[cursor % pools.length];
      if (!pool.games.length) { pools.splice(cursor % pools.length, 1); continue; }
      if (!pool.games.length) continue;
      const gameState = pool.games[pool.cursor % pool.games.length];
      if (!gameState.samples.length) {
        pool.games.splice(pool.cursor % pool.games.length, 1);
        if (!pool.games.length) continue;
        if (pool.cursor >= pool.games.length) pool.cursor = 0;
      } else {
        result.push(gameState.samples.pop());
        pool.cursor = (pool.cursor + 1) % pool.games.length;
        cursor++;
      }
    }
    return result;
  }

  stats() {
    const sources = {};
    this.all().forEach(function (sample) {
      const source = String(sample.source || 'unknown');
      sources[source] = (sources[source] || 0) + 1;
    });
    return { capacity: this.capacity, games: this.games.length, samples: this.sampleCount, sources: sources };
  }
}

/**
 * Split complete semantic groups, not individual positions. V1.4 uses
 * splitGroupId=openingFamilyId so mirrored colors and repeated opponents from
 * the same opening can never leak across training and validation.
 */
function splitByGroup(samples, options) {
  const settings = options || {};
  const groupField = String(settings.groupField || 'splitGroupId');
  const validationFraction = Math.max(0, Math.min(.5, Number(settings.validationFraction) || .125));
  const seed = Math.floor(Number(settings.seed) || 1) >>> 0;
  const groups = new Map();
  samples.forEach(function (sample) {
    const groupId = String(sample[groupField] || '');
    if (!groupId) throw new Error('分组切分要求每条样本包含 ' + groupField);
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(sample);
  });
  const hash = function (value) {
    let result = (2166136261 ^ seed) >>> 0;
    for (let index = 0; index < value.length; index++) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619) >>> 0;
    }
    return result;
  };
  const groupIds = Array.from(groups.keys()).sort(function (left, right) { return hash(left) - hash(right) || left.localeCompare(right); });
  const validationCount = groupIds.length > 1 ? Math.max(1, Math.round(groupIds.length * validationFraction)) : 0;
  const validationIds = new Set(groupIds.slice(0, validationCount));
  const train = [], validation = [];
  groupIds.forEach(function (groupId) {
    const target = validationIds.has(groupId) ? validation : train;
    target.push.apply(target, groups.get(groupId));
  });
  return {
    train: train, validation: validation,
    groupField: groupField,
    trainGroupIds: groupIds.filter(function (groupId) { return !validationIds.has(groupId); }),
    validationGroupIds: groupIds.filter(function (groupId) { return validationIds.has(groupId); })
  };
}

/** Backward-compatible V1.1 helper; new training code must call splitByGroup. */
function splitByGame(samples, options) {
  const result = splitByGroup(samples, Object.assign({}, options || {}, { groupField: 'gameId' }));
  return Object.assign({}, result, {
    trainGameIds: result.trainGroupIds,
    validationGameIds: result.validationGroupIds
  });
}

module.exports = { ReplayBuffer: ReplayBuffer, splitByGroup: splitByGroup, splitByGame: splitByGame };
