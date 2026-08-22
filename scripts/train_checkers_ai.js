'use strict';

// 轻量中国跳棋自我对弈训练器：不依赖 TensorFlow/PyTorch，训练出的权重可直接在浏览器推理。
const Core = require('../public/checkers/checkers_core');

function readNumber(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const config = {
  seed: readNumber('seed', 20260822),
  generations: readNumber('generations', 8),
  gamesPerGeneration: readNumber('games', 12),
  maxMoves: readNumber('max-moves', 140),
  benchmarkGames: readNumber('benchmark-games', 20),
  speedGames: readNumber('speed-games', 10),
  hiddenSize: 16,
  replayLimit: 12000
};

function createRandom(seed) {
  let state = seed >>> 0;
  return function () {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const random = createRandom(config.seed);
function opposite(player) { return player === 'red' ? 'blue' : 'red'; }
function randomWeight(fanIn) { return (random() * 2 - 1) * Math.sqrt(2 / fanIn); }

function createModel() {
  const inputSize = Core.extractValueFeatures(Core.createInitialPieces(), 'red').length;
  return {
    featureVersion: Core.VALUE_FEATURE_VERSION,
    inputSize: inputSize,
    hiddenSize: config.hiddenSize,
    scale: 220,
    weights: {
      input: Array.from({ length: inputSize * config.hiddenSize }, function () { return randomWeight(inputSize); }),
      hiddenBias: Array(config.hiddenSize).fill(0),
      output: Array.from({ length: config.hiddenSize }, function () { return randomWeight(config.hiddenSize); }),
      outputBias: 0
    }
  };
}

function forward(model, input) {
  const hidden = new Array(model.hiddenSize);
  for (let h = 0; h < model.hiddenSize; h++) {
    let sum = model.weights.hiddenBias[h];
    const offset = h * model.inputSize;
    for (let i = 0; i < model.inputSize; i++) sum += input[i] * model.weights.input[offset + i];
    hidden[h] = Math.tanh(sum);
  }
  let sum = model.weights.outputBias;
  for (let h = 0; h < model.hiddenSize; h++) sum += hidden[h] * model.weights.output[h];
  return { hidden: hidden, value: Math.tanh(sum) };
}

function trainSample(model, sample, learningRate) {
  const result = forward(model, sample.input);
  const error = result.value - sample.target;
  const outputGradient = Math.max(-0.4, Math.min(0.4, error * (1 - result.value * result.value)));
  const previousOutput = model.weights.output.slice();
  for (let h = 0; h < model.hiddenSize; h++) {
    model.weights.output[h] -= learningRate * (outputGradient * result.hidden[h] + 0.00008 * model.weights.output[h]);
  }
  model.weights.outputBias -= learningRate * outputGradient;
  for (let h = 0; h < model.hiddenSize; h++) {
    const hiddenGradient = outputGradient * previousOutput[h] * (1 - result.hidden[h] * result.hidden[h]);
    const offset = h * model.inputSize;
    for (let i = 0; i < model.inputSize; i++) {
      const index = offset + i;
      model.weights.input[index] -= learningRate * (hiddenGradient * sample.input[i] + 0.00008 * model.weights.input[index]);
    }
    model.weights.hiddenBias[h] -= learningRate * hiddenGradient;
  }
  return error * error;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const value = items[i]; items[i] = items[j]; items[j] = value;
  }
}

function terminalValue(pieces, winner) {
  if (winner) return winner === 'red' ? 1 : -1;
  const features = Core.extractValueFeatures(pieces, 'red');
  const raceAdvantage = features[1] * 1.5 + features[4] * 0.9 + features[6] * 0.22 + features[17] * 0.62 + features[18] * 0.12;
  return Math.tanh(raceAdvantage);
}

function choosePolicyMove(pieces, player, model, epsilon, recentPositions, modelInfluence) {
  const moves = Core.listMoves(pieces, player);
  if (!moves.length) return null;
  const currentScore = Core.evaluatePosition(pieces, player);
  const ranked = moves.map(function (move) {
    const result = Core.applyMove(pieces, player, move.from, move.target);
    const nextKey = Core.positionKey(result.pieces);
    const immediate = Core.evaluatePosition(result.pieces, player) - currentScore;
    const learned = model ? forward(model, Core.extractValueFeatures(result.pieces, player)).value : 0;
    const repeatCount = recentPositions.get(nextKey) || 0;
    return {
      move: move,
      result: result,
      score: immediate * 0.72 + Core.moveScore(pieces, player, move) * 0.34 + learned * modelInfluence - repeatCount * 260 + random() * 1.5
    };
  }).sort(function (a, b) { return b.score - a.score; });
  if (random() < epsilon) {
    const explorationWidth = Math.max(2, Math.ceil(ranked.length * 0.28));
    return ranked[Math.floor(random() * Math.min(explorationWidth, ranked.length))];
  }
  return ranked[0];
}

function playSelfGame(model, generation) {
  let pieces = Core.createInitialPieces();
  let player = 'red';
  let winner = '';
  const snapshots = [];
  const recent = new Map([[Core.positionKey(pieces), 1]]);
  const epsilon = Math.max(0.08, 0.28 - generation * 0.026);
  const influence = generation === 0 ? 0 : Math.min(95, 28 + generation * 11);
  let movesPlayed = 0;
  for (; movesPlayed < config.maxMoves && !winner; movesPlayed++) {
    if (movesPlayed % 3 === 0) snapshots.push({ pieces: pieces, ply: movesPlayed });
    const choice = choosePolicyMove(pieces, player, generation === 0 ? null : model, epsilon, recent, influence);
    if (!choice) break;
    pieces = choice.result.pieces;
    winner = choice.result.winner;
    const key = Core.positionKey(pieces);
    recent.set(key, (recent.get(key) || 0) + 1);
    player = opposite(player);
  }
  const outcome = terminalValue(pieces, winner);
  const samples = [];
  snapshots.forEach(function (snapshot) {
    const redInput = Core.extractValueFeatures(snapshot.pieces, 'red');
    const shapedRed = Math.tanh(Core.evaluatePosition(snapshot.pieces, 'red') / 1450);
    const remainingPlies = Math.max(0, movesPlayed - snapshot.ply);
    const discountedOutcome = winner
      ? (winner === 'red' ? 1 : -1) * Math.pow(0.986, remainingPlies)
      : outcome * Math.pow(0.994, remainingPlies);
    // 折扣终局奖励让同样的胜局越快到达，越早获得更高价值。
    const target = Math.max(-1, Math.min(1, discountedOutcome * .84 + shapedRed * .16));
    samples.push({ input: redInput, target: target });
    samples.push({ input: Core.extractValueFeatures(snapshot.pieces, 'blue'), target: -target });
  });
  return { samples: samples, outcome: outcome, winner: winner, moves: movesPlayed };
}

function meanSquaredError(model, samples) {
  if (!samples.length) return 0;
  let total = 0;
  samples.forEach(function (sample) {
    const error = forward(model, sample.input).value - sample.target;
    total += error * error;
  });
  return total / samples.length;
}

function runBenchmark(model) {
  let modelWins = 0, baselineWins = 0, draws = 0, scoreTotal = 0, repeatedStates = 0, completedGames = 0, totalPlies = 0;
  for (let game = 0; game < config.benchmarkGames; game++) {
    const modelColor = game % 2 === 0 ? 'red' : 'blue';
    let pieces = Core.createInitialPieces();
    let player = 'red', winner = '';
    const recent = new Map([[Core.positionKey(pieces), 1]]);
    let turn = 0;
    for (; turn < config.maxMoves && !winner; turn++) {
      const useModel = player === modelColor;
      const choice = choosePolicyMove(pieces, player, useModel ? model : null, turn < 10 ? 0.12 : 0.015, recent, useModel ? model.scale : 0);
      if (!choice) break;
      pieces = choice.result.pieces; winner = choice.result.winner;
      const key = Core.positionKey(pieces);
      const previous = recent.get(key) || 0;
      if (previous) repeatedStates++;
      recent.set(key, previous + 1);
      player = opposite(player);
    }
    totalPlies += turn;
    if (winner) completedGames++;
    const redOutcome = terminalValue(pieces, winner);
    const modelOutcome = modelColor === 'red' ? redOutcome : -redOutcome;
    scoreTotal += modelOutcome;
    if (modelOutcome > 0.045) modelWins++;
    else if (modelOutcome < -0.045) baselineWins++;
    else draws++;
  }
  return {
    games: config.benchmarkGames,
    modelWins: modelWins,
    baselineWins: baselineWins,
    draws: draws,
    averageRaceAdvantage: Number((scoreTotal / config.benchmarkGames).toFixed(4)),
    completedGames: completedGames,
    averagePlies: Number((totalPlies / config.benchmarkGames).toFixed(1)),
    repeatedStates: repeatedStates
  };
}

function runHardSpeedBenchmark(model) {
  let completedGames = 0, totalPlies = 0, cappedGames = 0;
  const winners = { red: 0, blue: 0 };
  for (let game = 0; game < config.speedGames; game++) {
    let pieces = Core.createInitialPieces();
    let player = 'red', winner = '';
    const recent = [];
    let ply = 0;
    for (; ply < config.maxMoves && !winner; ply++) {
      const tieRandom = function () { return ((game * 193 + ply * 47) % 991) / 991; };
      const move = Core.chooseAiMove(pieces, player, 'hard', tieRandom, { model: model, recentPositions: recent });
      if (!move) break;
      const result = Core.applyMove(pieces, player, move.from, move.target);
      pieces = result.pieces; winner = result.winner;
      recent.push(Core.positionKey(pieces));
      if (recent.length > 20) recent.shift();
      player = opposite(player);
    }
    totalPlies += ply;
    if (winner) { completedGames++; winners[winner]++; }
    else cappedGames++;
  }
  return {
    games: config.speedGames,
    completedGames: completedGames,
    cappedGames: cappedGames,
    averagePlies: Number((totalPlies / config.speedGames).toFixed(1)),
    winners: winners
  };
}

function roundedModel(model, metadata) {
  function rounded(values) { return values.map(function (value) { return Number(value.toFixed(7)); }); }
  return {
    name: '轻量自我对弈价值网络',
    version: '2026.08.22-rl2',
    featureVersion: model.featureVersion,
    inputSize: model.inputSize,
    hiddenSize: model.hiddenSize,
    scale: model.scale,
    weights: {
      input: rounded(model.weights.input),
      hiddenBias: rounded(model.weights.hiddenBias),
      output: rounded(model.weights.output),
      outputBias: Number(model.weights.outputBias.toFixed(7))
    },
    training: metadata
  };
}

function main() {
  const model = createModel();
  const replay = [];
  let totalGames = 0, totalMoves = 0, actualWins = 0;
  for (let generation = 0; generation < config.generations; generation++) {
    for (let game = 0; game < config.gamesPerGeneration; game++) {
      const episode = playSelfGame(model, generation);
      totalGames++; totalMoves += episode.moves; if (episode.winner) actualWins++;
      replay.push.apply(replay, episode.samples);
      if (replay.length > config.replayLimit) replay.splice(0, replay.length - config.replayLimit);
    }
    const trainingSet = replay.filter(function (_, index) { return index % 8 !== 0; });
    const validationSet = replay.filter(function (_, index) { return index % 8 === 0; });
    const learningRate = 0.013 * Math.pow(0.86, generation);
    let trainingLoss = 0;
    for (let epoch = 0; epoch < 3; epoch++) {
      shuffle(trainingSet);
      trainingSet.forEach(function (sample) { trainingLoss += trainSample(model, sample, learningRate); });
    }
    console.log(JSON.stringify({
      generation: generation + 1,
      selfPlayGames: totalGames,
      replaySamples: replay.length,
      trainingMse: Number((trainingLoss / Math.max(1, trainingSet.length * 3)).toFixed(5)),
      validationMse: Number(meanSquaredError(model, validationSet).toFixed(5))
    }));
  }
  const validation = replay.filter(function (_, index) { return index % 8 === 0; });
  const benchmark = runBenchmark(model);
  const hardSpeedBenchmark = runHardSpeedBenchmark(model);
  const metadata = {
    algorithm: 'self-play Monte Carlo value learning + discounted speed reward',
    seed: config.seed,
    generations: config.generations,
    games: totalGames,
    moves: totalMoves,
    completedWins: actualWins,
    samples: replay.length,
    validationMse: Number(meanSquaredError(model, validation).toFixed(5)),
    benchmark: benchmark,
    hardSpeedBenchmark: hardSpeedBenchmark
  };
  const exported = roundedModel(model, metadata);
  console.log('\nTRAINING_RESULT ' + JSON.stringify(metadata));
  console.log('MODEL_JSON_START');
  console.log(JSON.stringify(exported, null, 2));
  console.log('MODEL_JSON_END');
}

main();
