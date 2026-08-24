'use strict';

/*
 * 飞行棋规则核心。
 *
 * 该文件不依赖 DOM，同时兼容浏览器和 Node.js。页面层只负责渲染和持久化；
 * 掷骰、合法移动、同色跳跃、跨越飞行、撞机和胜负都由这里统一判定，
 * 以后增加机器人或联机服务端时可以直接复用同一套规则。
 */
(function exposeFlightChessCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FlightChessCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createFlightChessCore() {
  const VERSION = 1;
  const HANGAR = -1;
  const OUTER_LAST = 51;
  const HOME_FIRST = 52;
  const HOME_LAST = 57;
  const FINISHED = 58;
  const PLANE_COUNT = 4;

  // 15×15 十字棋盘的 52 个公共航道坐标，按顺时针顺序排列。
  const TRACK_COORDINATES = [
    [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    [0, 7], [0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
    [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
    [7, 0],
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
    [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
    [14, 7], [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
    [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
    [7, 14], [6, 14]
  ];

  const COLOR_DEFS = [
    {
      id: 'red', name: '红方', startIndex: 22,
      bases: [[2, 2], [2, 4], [4, 2], [4, 4]],
      homeLane: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]]
    },
    {
      id: 'yellow', name: '黄方', startIndex: 9,
      bases: [[2, 10], [2, 12], [4, 10], [4, 12]],
      homeLane: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]]
    },
    {
      id: 'blue', name: '蓝方', startIndex: 48,
      bases: [[10, 10], [10, 12], [12, 10], [12, 12]],
      homeLane: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]]
    },
    {
      id: 'green', name: '绿方', startIndex: 35,
      bases: [[10, 2], [10, 4], [12, 2], [12, 4]],
      homeLane: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]]
    }
  ];

  const COLOR_BY_TRACK_MOD = ['blue', 'yellow', 'red', 'green'];
  const SAFE_TRACK_INDEXES = new Set(COLOR_DEFS.map(function (color) { return color.startIndex; }));

  function normalizePlayerCount(value) {
    const count = Number(value);
    return Number.isInteger(count) && count >= 2 && count <= 4 ? count : 4;
  }

  function colorIndexesForPlayerCount(playerCount) {
    // 双人使用对角阵营，三人和四人按棋盘顺序入场。
    if (playerCount === 2) return [0, 2];
    if (playerCount === 3) return [0, 1, 2];
    return [0, 1, 2, 3];
  }

  function createGame(playerCount, names) {
    const count = normalizePlayerCount(playerCount);
    const indexes = colorIndexesForPlayerCount(count);
    const safeNames = Array.isArray(names) ? names : [];
    return {
      version: VERSION,
      playerCount: count,
      players: indexes.map(function (colorIndex, playerIndex) {
        const color = COLOR_DEFS[colorIndex];
        const requestedName = String(safeNames[playerIndex] || '').trim().slice(0, 12);
        return {
          id: playerIndex,
          colorId: color.id,
          name: requestedName || color.name,
          planes: [HANGAR, HANGAR, HANGAR, HANGAR]
        };
      }),
      currentPlayer: 0,
      phase: 'roll',
      dice: null,
      lastRoll: null,
      turnNumber: 1,
      winner: null,
      lastMove: null
    };
  }

  function cloneGame(game) {
    return {
      version: VERSION,
      playerCount: game.playerCount,
      players: game.players.map(function (player) {
        return {
          id: player.id,
          colorId: player.colorId,
          name: player.name,
          planes: player.planes.slice()
        };
      }),
      currentPlayer: game.currentPlayer,
      phase: game.phase,
      dice: game.dice,
      lastRoll: game.lastRoll,
      turnNumber: game.turnNumber,
      winner: game.winner,
      lastMove: game.lastMove ? JSON.parse(JSON.stringify(game.lastMove)) : null
    };
  }

  function colorDefinition(colorId) {
    return COLOR_DEFS.find(function (color) { return color.id === colorId; }) || null;
  }

  function trackIndexForProgress(colorId, progress) {
    const color = colorDefinition(colorId);
    if (!color || !Number.isInteger(progress) || progress < 0 || progress > OUTER_LAST) return -1;
    return (color.startIndex - progress + TRACK_COORDINATES.length) % TRACK_COORDINATES.length;
  }

  function getPlaneCoordinate(game, playerIndex, planeIndex) {
    const player = game && game.players && game.players[playerIndex];
    const color = player && colorDefinition(player.colorId);
    const progress = player && player.planes[planeIndex];
    if (!color || !Number.isInteger(progress)) return null;
    if (progress === HANGAR) return color.bases[planeIndex] ? color.bases[planeIndex].slice() : null;
    if (progress >= 0 && progress <= OUTER_LAST) {
      return TRACK_COORDINATES[trackIndexForProgress(color.id, progress)].slice();
    }
    if (progress >= HOME_FIRST && progress <= HOME_LAST) {
      return color.homeLane[progress - HOME_FIRST].slice();
    }
    if (progress === FINISHED) return [7, 7];
    return null;
  }

  function coordinateKey(coordinate) {
    return Array.isArray(coordinate) && coordinate.length === 2 ? coordinate[0] + ':' + coordinate[1] : '';
  }

  function trackColor(trackIndex) {
    if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= TRACK_COORDINATES.length) return '';
    return COLOR_BY_TRACK_MOD[trackIndex % COLOR_BY_TRACK_MOD.length];
  }

  function shortcutTrackIndex(colorId) {
    return trackIndexForProgress(colorId, 18);
  }

  function isValidDie(value) {
    return Number.isInteger(value) && value >= 1 && value <= 6;
  }

  function getMovablePlanes(game, playerIndex, dice) {
    const player = game && game.players && game.players[playerIndex];
    if (!player || !isValidDie(dice)) return [];
    const result = [];
    player.planes.forEach(function (progress, planeIndex) {
      if (progress === HANGAR && dice === 6) result.push(planeIndex);
      else if (progress >= 0 && progress < FINISHED && progress + dice <= FINISHED) result.push(planeIndex);
    });
    return result;
  }

  function advanceTurn(game) {
    game.currentPlayer = (game.currentPlayer + 1) % game.playerCount;
    game.turnNumber += 1;
  }

  function rollDice(game, forcedValue, randomFn) {
    if (!game || game.phase !== 'roll' || game.winner !== null) throw new Error('当前状态不能掷骰子');
    const rng = typeof randomFn === 'function' ? randomFn : Math.random;
    const dice = forcedValue === undefined ? Math.floor(rng() * 6) + 1 : Number(forcedValue);
    if (!isValidDie(dice)) throw new Error('骰子点数必须是 1 到 6 的整数');

    const next = cloneGame(game);
    const playerIndex = next.currentPlayer;
    const movablePlanes = getMovablePlanes(next, playerIndex, dice);
    next.dice = dice;
    next.lastRoll = dice;

    if (movablePlanes.length) {
      next.phase = 'move';
      next.lastMove = {
        type: 'roll', player: playerIndex, colorId: next.players[playerIndex].colorId,
        roll: dice, movablePlanes: movablePlanes.slice()
      };
      return next;
    }

    next.lastMove = {
      type: 'pass', player: playerIndex, colorId: next.players[playerIndex].colorId,
      roll: dice, extraTurn: dice === 6
    };
    next.dice = null;
    next.phase = 'roll';
    if (dice !== 6) advanceTurn(next);
    return next;
  }

  function applyFlightBonus(progress) {
    if (progress === 18) return { progress: 30, type: 'shortcut', distance: 12 };
    if (progress > 0 && progress <= 47 && progress % 4 === 0) {
      return { progress: progress + 4, type: 'color-hop', distance: 4 };
    }
    return { progress: progress, type: '', distance: 0 };
  }

  function captureOpponents(game, movingPlayerIndex, destinationProgress) {
    if (destinationProgress < 0 || destinationProgress > OUTER_LAST) return [];
    const movingPlayer = game.players[movingPlayerIndex];
    const destinationIndex = trackIndexForProgress(movingPlayer.colorId, destinationProgress);
    if (SAFE_TRACK_INDEXES.has(destinationIndex)) return [];

    const captured = [];
    game.players.forEach(function (player, playerIndex) {
      if (playerIndex === movingPlayerIndex) return;
      player.planes.forEach(function (progress, planeIndex) {
        if (progress < 0 || progress > OUTER_LAST) return;
        if (trackIndexForProgress(player.colorId, progress) !== destinationIndex) return;
        player.planes[planeIndex] = HANGAR;
        captured.push({ player: playerIndex, plane: planeIndex, colorId: player.colorId });
      });
    });
    return captured;
  }

  function movePlane(game, planeIndex) {
    if (!game || game.phase !== 'move' || !isValidDie(game.dice) || game.winner !== null) {
      throw new Error('当前状态不能移动飞机');
    }
    const index = Number(planeIndex);
    const legalPlanes = getMovablePlanes(game, game.currentPlayer, game.dice);
    if (!Number.isInteger(index) || !legalPlanes.includes(index)) throw new Error('这架飞机当前不能移动');

    const next = cloneGame(game);
    const playerIndex = next.currentPlayer;
    const player = next.players[playerIndex];
    const from = player.planes[index];
    const rolled = next.dice;
    const rawProgress = from === HANGAR ? 0 : from + rolled;
    const bonus = rawProgress <= OUTER_LAST ? applyFlightBonus(rawProgress) : { progress: rawProgress, type: '', distance: 0 };
    const to = bonus.progress;
    player.planes[index] = to;
    const captured = captureOpponents(next, playerIndex, to);
    const won = player.planes.every(function (progress) { return progress === FINISHED; });
    const extraTurn = rolled === 6 && !won;

    next.lastMove = {
      type: 'move', player: playerIndex, colorId: player.colorId, plane: index,
      from: from, rawTo: rawProgress, to: to, roll: rolled,
      bonus: bonus.type, bonusDistance: bonus.distance,
      captured: captured, extraTurn: extraTurn
    };
    next.dice = null;

    if (won) {
      next.winner = playerIndex;
      next.phase = 'gameover';
      return next;
    }
    next.phase = 'roll';
    if (!extraTurn) advanceTurn(next);
    return next;
  }

  function hydrateGame(raw) {
    if (!raw || Number(raw.version) !== VERSION) return null;
    const count = normalizePlayerCount(raw.playerCount);
    if (count !== Number(raw.playerCount) || !Array.isArray(raw.players) || raw.players.length !== count) return null;
    const expectedColors = colorIndexesForPlayerCount(count).map(function (index) { return COLOR_DEFS[index].id; });
    const game = createGame(count);

    for (let i = 0; i < count; i++) {
      const sourcePlayer = raw.players[i];
      if (!sourcePlayer || sourcePlayer.colorId !== expectedColors[i] || !Array.isArray(sourcePlayer.planes) || sourcePlayer.planes.length !== PLANE_COUNT) return null;
      if (!sourcePlayer.planes.every(function (progress) {
        return Number.isInteger(progress) && progress >= HANGAR && progress <= FINISHED;
      })) return null;
      game.players[i].planes = sourcePlayer.planes.slice();
      game.players[i].name = String(sourcePlayer.name || COLOR_DEFS[colorIndexesForPlayerCount(count)[i]].name).trim().slice(0, 12) || COLOR_DEFS[colorIndexesForPlayerCount(count)[i]].name;
    }

    if (!Number.isInteger(raw.currentPlayer) || raw.currentPlayer < 0 || raw.currentPlayer >= count) return null;
    if (!['roll', 'move', 'gameover'].includes(raw.phase)) return null;
    const winner = raw.winner === null || raw.winner === undefined ? null : Number(raw.winner);
    if (winner !== null && (!Number.isInteger(winner) || winner < 0 || winner >= count)) return null;
    if (raw.phase === 'gameover' && (winner === null || !game.players[winner].planes.every(function (progress) { return progress === FINISHED; }))) return null;
    if (raw.phase !== 'gameover' && winner !== null) return null;
    if (raw.phase === 'move' && !isValidDie(Number(raw.dice))) return null;

    game.currentPlayer = raw.currentPlayer;
    game.phase = raw.phase;
    game.dice = raw.phase === 'move' ? Number(raw.dice) : null;
    game.lastRoll = isValidDie(Number(raw.lastRoll)) ? Number(raw.lastRoll) : null;
    game.turnNumber = Number.isInteger(raw.turnNumber) && raw.turnNumber > 0 ? raw.turnNumber : 1;
    game.winner = winner;
    game.lastMove = raw.lastMove && typeof raw.lastMove === 'object' ? JSON.parse(JSON.stringify(raw.lastMove)) : null;
    if (game.phase === 'move' && getMovablePlanes(game, game.currentPlayer, game.dice).length === 0) return null;
    return game;
  }

  return Object.freeze({
    VERSION: VERSION,
    HANGAR: HANGAR,
    OUTER_LAST: OUTER_LAST,
    HOME_FIRST: HOME_FIRST,
    HOME_LAST: HOME_LAST,
    FINISHED: FINISHED,
    PLANE_COUNT: PLANE_COUNT,
    TRACK_COORDINATES: TRACK_COORDINATES.map(function (coordinate) { return coordinate.slice(); }),
    COLOR_DEFS: COLOR_DEFS.map(function (color) {
      return {
        id: color.id, name: color.name, startIndex: color.startIndex,
        bases: color.bases.map(function (coordinate) { return coordinate.slice(); }),
        homeLane: color.homeLane.map(function (coordinate) { return coordinate.slice(); })
      };
    }),
    SAFE_TRACK_INDEXES: Array.from(SAFE_TRACK_INDEXES),
    normalizePlayerCount: normalizePlayerCount,
    createGame: createGame,
    cloneGame: cloneGame,
    colorDefinition: colorDefinition,
    trackIndexForProgress: trackIndexForProgress,
    trackColor: trackColor,
    shortcutTrackIndex: shortcutTrackIndex,
    getPlaneCoordinate: getPlaneCoordinate,
    coordinateKey: coordinateKey,
    getMovablePlanes: getMovablePlanes,
    rollDice: rollDice,
    movePlane: movePlane,
    hydrateGame: hydrateGame,
    applyFlightBonus: applyFlightBonus
  });
});
