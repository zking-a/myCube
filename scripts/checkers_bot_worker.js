'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const AI = require('../public/checkers/checkers_ai_engine');
const model = require('../public/checkers/checkers_ai_model_v3');

try {
  const result = AI.chooseMove(workerData.pieces, workerData.player, {
    seats: workerData.seats,
    level: workerData.level,
    seed: workerData.seed,
    recentPositions: workerData.recentPositions,
    model: model
  });
  parentPort.postMessage({ move: result.move });
} catch (error) {
  parentPort.postMessage({ error: String(error.message || error) });
}
