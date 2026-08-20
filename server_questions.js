'use strict';

// 服务端复用客户端的确定性题目规则，并验证玩家提交的运算证明。
const fs = require('fs');
const path = require('path');
const Core = require('./public/24/core.js');

function loadLevels() {
  const source = fs.readFileSync(path.join(__dirname, 'public', '24', 'data.js'), 'utf8');
  const json = source.replace(/^\s*window\.LEVELS\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(json);
}

const LEVELS = loadLevels();

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRandom(seed) {
  return mulberry32(xmur3(String(seed))());
}

function buildRoomQuestions(seed, count) {
  const rnd = seededRandom(seed);
  const ladder = LEVELS.meta && LEVELS.meta.speedLadder;
  const picked = [];
  const used = Object.create(null);
  if (ladder && ladder.length) {
    for (let i = 0; i < count; i++) {
      const bucketIndex = Math.min(Math.floor((i * ladder.length) / count), ladder.length - 1);
      const bucket = ladder[bucketIndex];
      if (!bucket || !bucket.length) continue;
      let index = -1;
      for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = bucket[Math.floor(rnd() * bucket.length)];
        if (!used[candidate]) { index = candidate; break; }
      }
      if (index < 0) continue;
      used[index] = true;
      picked.push(LEVELS.levels[index]);
    }
  }
  let guard = 0;
  while (picked.length < count && guard++ < LEVELS.levels.length * 4) {
    const index = Math.floor(rnd() * LEVELS.levels.length);
    if (used[index]) continue;
    used[index] = true;
    picked.push(LEVELS.levels[index]);
  }
  return picked.slice(0, count).map(function (item) {
    return { numbers: item.numbers.slice(), answer: item.standardAnswer };
  });
}

function verifyProof(expression, numbers, expectedCorrect) {
  if (typeof expression !== 'string' || expression.length < 3 || expression.length > 128) return false;
  const result = Core.evaluate(expression, numbers);
  if (expectedCorrect) return result.valid === true;
  return !!(result.error && result.error.code === 'RESULT_NOT_24');
}

module.exports = { buildRoomQuestions, verifyProof };
