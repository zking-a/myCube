'use strict';

/*
 * 五子棋规则核心：15×15 棋盘，黑棋先手，任意方向连续 5 子即胜。
 *
 * 纯函数式：placeStone 不修改入参，返回全新 game 对象。
 * 浏览器与 Node 双引用——/gomoku-ws 服务端用它做权威校验，联机客户端直接
 * 消费服务端下发的同一份结构，避免两端规则漂移。
 */
(function exposeGomokuCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GomokuCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createGomokuCore() {
  const BOARD_SIZE = 15;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function isInside(r, c) {
    return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
  }

  function createEmptyBoard() {
    const board = [];
    for (let r = 0; r < BOARD_SIZE; r++) board.push(new Array(BOARD_SIZE).fill(EMPTY));
    return board;
  }

  function cloneBoard(source) {
    return source.map(function (row) { return row.slice(); });
  }

  function normalizeBoard(input) {
    const board = createEmptyBoard();
    if (!Array.isArray(input) || input.length !== BOARD_SIZE) return board;
    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = input[r];
      if (!Array.isArray(row) || row.length !== BOARD_SIZE) return board;
      for (let c = 0; c < BOARD_SIZE; c++) {
        const value = row[c];
        board[r][c] = value === BLACK || value === WHITE ? value : EMPTY;
      }
    }
    return board;
  }

  function countRun(board, r, c, dr, dc, color) {
    let steps = 0;
    let rr = r + dr;
    let cc = c + dc;
    while (isInside(rr, cc) && board[rr][cc] === color) {
      steps++;
      rr += dr;
      cc += dc;
    }
    return steps;
  }

  function checkWin(board, r, c, color) {
    if (!isInside(r, c)) return false;
    for (let i = 0; i < DIRS.length; i++) {
      const dr = DIRS[i][0];
      const dc = DIRS[i][1];
      const total = 1 + countRun(board, r, c, dr, dc, color) + countRun(board, r, c, -dr, -dc, color);
      if (total >= 5) return true;
    }
    return false;
  }

  function seatColor(seat) {
    return seat === 0 ? BLACK : WHITE;
  }

  function otherColor(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  function normalizeColor(value) {
    return value === BLACK || value === WHITE ? value : 0;
  }

  function normalizeNick(value, fallback) {
    const text = String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      .trim().slice(0, 16);
    return text || fallback;
  }

  function createGame(playerNames) {
    const names = Array.isArray(playerNames) ? playerNames : [];
    const players = [0, 1].map(function (seat) {
      return {
        seat: seat,
        color: seatColor(seat),
        nick: normalizeNick(names[seat], seat === 0 ? '黑方' : '白方')
      };
    });
    return {
      board: createEmptyBoard(),
      turn: BLACK,
      moveNumber: 0,
      history: [],
      lastMove: null,
      winner: 0,
      finished: false,
      endReason: '',
      players: players
    };
  }

  function placeStone(game, r, c, color) {
    if (!game || typeof game !== 'object') throw new Error('GAME_INVALID');
    if (game.finished) throw new Error('GAME_OVER');
    const player = normalizeColor(color);
    if (!player) throw new Error('COLOR_INVALID');
    if (game.turn !== player) throw new Error('NOT_YOUR_TURN');
    if (!isInside(r, c)) throw new Error('OUT_OF_BOARD');
    if (game.board[r][c] !== EMPTY) throw new Error('OCCUPIED');

    const board = cloneBoard(game.board);
    board[r][c] = player;
    const moveNumber = game.moveNumber + 1;
    const win = checkWin(board, r, c, player);
    const draw = !win && moveNumber >= BOARD_SIZE * BOARD_SIZE;

    return {
      board: board,
      turn: win || draw ? player : otherColor(player),
      moveNumber: moveNumber,
      history: game.history.concat([{ r: r, c: c, player: player, n: moveNumber }]),
      lastMove: { r: r, c: c, player: player },
      winner: win ? player : 0,
      finished: win || draw,
      endReason: win ? 'five' : (draw ? 'draw' : ''),
      players: game.players
    };
  }

  function publicGame(game) {
    if (!game) return null;
    return {
      board: cloneBoard(game.board),
      turn: game.turn,
      moveNumber: game.moveNumber,
      lastMove: game.lastMove ? { r: game.lastMove.r, c: game.lastMove.c, player: game.lastMove.player } : null,
      winner: game.winner,
      finished: !!game.finished,
      endReason: game.endReason || ''
    };
  }

  return Object.freeze({
    BOARD_SIZE: BOARD_SIZE,
    EMPTY: EMPTY,
    BLACK: BLACK,
    WHITE: WHITE,
    DIRS: DIRS,
    isInside: isInside,
    createEmptyBoard: createEmptyBoard,
    cloneBoard: cloneBoard,
    normalizeBoard: normalizeBoard,
    countRun: countRun,
    checkWin: checkWin,
    seatColor: seatColor,
    otherColor: otherColor,
    normalizeColor: normalizeColor,
    normalizeNick: normalizeNick,
    createGame: createGame,
    placeStone: placeStone,
    publicGame: publicGame
  });
});
