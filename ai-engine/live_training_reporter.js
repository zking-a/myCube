'use strict';

const fs = require('fs');
const path = require('path');

/**
 * File-backed live training observer for a local developer dashboard.
 * The trainer is the only writer; the HTTP endpoint is read-only. A compact
 * snapshot is replaced after every move so the dashboard can follow the game.
 */
class LiveTrainingReporter {
  constructor(outputPath) {
    this.outputPath = outputPath ? path.resolve(outputPath) : '';
    this.runId = '';
    this.current = null;
  }

  write(payload) {
    if (!this.outputPath) return;
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
    fs.writeFileSync(this.outputPath, JSON.stringify(Object.assign({
      schemaVersion: 1, runId: this.runId, updatedAt: new Date().toISOString()
    }, payload), null, 2) + '\n');
  }

  beginRun(details) {
    this.runId = String((details && details.runId) || Date.now());
    this.write({ active: true, phase: 'starting', title: (details && details.title) || '准备训练', actions: [], moves: 0 });
  }

  beginGame(details) {
    const source = details || {};
    this.current = {
      active: true, phase: source.phase || 'training', title: source.title || '训练对局',
      gameId: source.gameId || '', opponent: source.opponent || '',
      candidateColor: source.candidateColor || '', winner: '', actions: [], moves: 0
    };
    this.write(this.current);
  }

  recordMove(move) {
    if (!this.current || !move) return;
    this.current.actions.push({
      ply: this.current.actions.length + 1, player: move.player,
      from: move.from, target: move.target, kind: move.kind || '',
      searchValue: Number(Number(move.searchValue || 0).toFixed(4))
    });
    this.current.moves = this.current.actions.length;
    this.write(this.current);
  }

  endGame(result) {
    if (!this.current) return;
    this.current.active = false;
    this.current.winner = (result && result.winner) || '';
    this.current.moves = this.current.actions.length;
    this.write(this.current);
  }

  complete(details) {
    this.write(Object.assign({}, this.current || {}, {
      active: false, complete: true,
      status: (details && details.status) || 'experimental'
    }));
    this.current = null;
  }
}

module.exports = { LiveTrainingReporter: LiveTrainingReporter };
