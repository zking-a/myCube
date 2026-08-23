'use strict';

// 困难搜索在独立线程运行，避免 DFS 阻塞棋盘动画和按钮交互。
// Worker 只加载玩家页面已经使用的规则核心与轻量价值模型，不连接训练实验室。
// 历史教训（2026.08）：真终局最短路求解器建议（无对手单人最优）经竞技场验证
// 为负收益（6-10 vs 9-7），对手会干扰路径中段，单人最优 ≠ 双人最优，已回退。
importScripts('checkers_core.js', 'checkers_ai_model.js');

const Core = self.CheckersCore;
const Model = self.CheckersAiModel;
const LEVELS = ['easy', 'normal', 'hard'];

self.onmessage = function (event) {
  const message = event && event.data && typeof event.data === 'object' ? event.data : {};
  const requestId = Number(message.requestId);
  try {
    const player = message.player === 'red' ? 'red' : 'blue';
    const level = LEVELS.includes(message.level) ? message.level : 'normal';
    const clean = Core.sanitizeState({
      pieces: message.pieces,
      turn: player,
      moveNumber: 1,
      winner: ''
    });
    if (!clean) throw new Error('棋局快照不合法');
    const recentPositions = Array.isArray(message.recentPositions)
      ? message.recentPositions.filter(function (key) { return typeof key === 'string'; }).slice(-20)
      : [];
    const searchOptions = level === 'hard'
      ? {
          model: Model || null,
          recentPositions: recentPositions,
          // 自适应加深：终局自动切到 5-7 层；置换表减少终局重复局面；
          // 时间预算保证困难搜索在 Worker 中不超过 420ms，UI 不卡顿。
          adaptive: true,
          enableTranspositionTable: true,
          timeLimitMs: 420
        }
      : null;
    const move = Core.chooseAiMove(clean.pieces, player, level, null, searchOptions);
    self.postMessage({ requestId: requestId, move: move || null });
  } catch (error) {
    self.postMessage({ requestId: requestId, move: null, error: String(error && error.message || error) });
  }
};
