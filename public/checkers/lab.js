'use strict';

/**
 * AI 训练实验室只读取已落盘的实验日志，不会在浏览器中启动训练或修改模型。
 * 回放以标准初始局面 + 动作序列存储，避免日志重复保存每一手的完整棋盘。
 */
const Core = window.CheckersCore;
const SVG_NS = 'http://www.w3.org/2000/svg';
let runData = null;
let replay = null;
let step = 0;
let timer = 0;
let liveRevision = '';
let followingLive = true;

function $(id) { return document.getElementById(id); }
function svg(name, attributes) {
  const element = document.createElementNS(SVG_NS, name);
  Object.keys(attributes || {}).forEach(function (key) { element.setAttribute(key, attributes[key]); });
  return element;
}
function percent(value) { return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) + '%' : '—'; }
function winnerText(winner) { return winner === 'red' ? '红方获胜' : (winner === 'blue' ? '蓝方获胜' : '达到训练上限'); }
function phaseText(phase) {
  if (phase === 'teacher') return '教师采样';
  if (phase === 'self_play' || phase === 'league') return '对手池联赛';
  if (phase === 'arena') return '竞技场门禁';
  if (phase === 'starting') return '准备训练';
  return '训练进程';
}

function piecesAt(targetStep) {
  let pieces = Core.createInitialPieces();
  for (let index = 0; index < targetStep && index < replay.actions.length; index++) {
    const action = replay.actions[index];
    const result = Core.applyMove(pieces, action.player, action.from, action.target);
    if (!result) break;
    pieces = result.pieces;
  }
  return pieces;
}

function renderBoard() {
  if (!replay) return;
  const board = $('labBoard');
  board.replaceChildren();
  const defs = svg('defs');
  defs.innerHTML = '<radialGradient id="labRed" cx="35%" cy="25%"><stop offset="0" stop-color="#ffaaa2"/><stop offset="1" stop-color="#c93648"/></radialGradient><radialGradient id="labBlue" cx="35%" cy="25%"><stop offset="0" stop-color="#9ab2ff"/><stop offset="1" stop-color="#304bc9"/></radialGradient>';
  board.appendChild(defs);
  const pieces = piecesAt(step);
  const cells = Core.BOARD_CELLS;
  const byKey = new Map(cells.map(function (cell) { return [cell.key, cell]; }));
  const last = step > 0 ? replay.actions[step - 1] : null;
  if (last && byKey.has(last.from) && byKey.has(last.target)) {
    const from = byKey.get(last.from), target = byKey.get(last.target);
    board.appendChild(svg('line', { x1: from.x, y1: from.y, x2: target.x, y2: target.y, class: 'last-route' }));
  }
  cells.forEach(function (cell) {
    board.appendChild(svg('circle', { cx: cell.x, cy: cell.y, r: 4.55, class: 'board-hole ' + cell.camp }));
  });
  cells.forEach(function (cell) {
    if (!pieces[cell.key]) return;
    board.appendChild(svg('circle', { cx: cell.x, cy: cell.y, r: 5.65, class: 'board-piece ' + pieces[cell.key] }));
  });
  if (last && byKey.has(last.target)) {
    const target = byKey.get(last.target);
    board.appendChild(svg('circle', { cx: target.x, cy: target.y, r: 8.4, class: 'last-ring' }));
  }
  $('plyText').textContent = step + ' / ' + replay.actions.length + ' 手';
  $('replayRange').value = String(step);
  const current = step ? replay.actions[step - 1] : null;
  $('replayDetail').textContent = current
    ? (current.player === 'red' ? '红方' : '蓝方') + ' · ' + (current.kind === 'jump' ? '跳跃' : '相邻移动') + ' · ' + current.from + ' → ' + current.target
    : (replay.live && replay.active
      ? '训练进行中 · 等待当前对局落子'
      : winnerText(replay.winner) + ' · 共 ' + replay.moves + ' 手');
}

function stopPlayback() {
  if (timer) window.clearInterval(timer);
  timer = 0;
  $('playBtn').textContent = '播放';
}
function startPlayback() {
  if (!replay) return;
  if (step >= replay.actions.length) step = 0;
  stopPlayback();
  $('playBtn').textContent = '暂停';
  timer = window.setInterval(function () {
    if (step >= replay.actions.length) { stopPlayback(); return; }
    step++;
    renderBoard();
  }, Number($('speedSelect').value) || 520);
}

function selectReplay(id) {
  stopPlayback();
  replay = runData.replays.find(function (item) { return item.id === id; }) || runData.replays[0];
  if (!replay) return;
  step = replay.live ? replay.actions.length : 0;
  $('phasePill').textContent = phaseText(replay.phase);
  $('phasePill').classList.toggle('live', !!(replay.live && replay.active));
  $('replayTitle').textContent = replay.title;
  $('replayRange').max = String(replay.actions.length);
  renderBoard();
}

/** 将训练进程写入首个选项；用户查看历史手数时不会强制跳回末尾。 */
function upsertLiveReplay(snapshot) {
  if (!runData || !snapshot || !snapshot.gameId || !Array.isArray(snapshot.actions)) return;
  const live = {
    id: 'live-training', live: true, active: !!snapshot.active,
    phase: snapshot.phase || 'training', title: snapshot.title || '训练实时对局',
    opponent: snapshot.opponent || '', candidateColor: snapshot.candidateColor || '',
    winner: snapshot.winner || '', moves: snapshot.actions.length,
    actions: snapshot.actions
  };
  const index = runData.replays.findIndex(function (item) { return item.id === live.id; });
  if (index >= 0) runData.replays[index] = live;
  else runData.replays.unshift(live);

  const select = $('replaySelect');
  let option = Array.from(select.options).find(function (item) { return item.value === live.id; });
  if (!option) {
    option = document.createElement('option');
    option.value = live.id;
    select.insertBefore(option, select.firstChild);
  }
  option.textContent = (live.active ? '● 实时训练' : '最近训练') + ' · ' + live.moves + ' 手';
  if (!replay || replay.id === live.id || followingLive) {
    replay = live;
    select.value = live.id;
    if (followingLive) step = live.actions.length;
    else step = Math.min(step, live.actions.length);
    $('phasePill').textContent = phaseText(live.phase);
    $('phasePill').classList.toggle('live', live.active);
    $('replayTitle').textContent = live.title;
    $('replayRange').max = String(live.actions.length);
    renderBoard();
  }
}

async function pollLiveTraining() {
  try {
    const response = await fetch('/ai-lab/live', { cache: 'no-store' });
    if (!response.ok) return;
    const snapshot = await response.json();
    if (!snapshot.updatedAt || snapshot.updatedAt === liveRevision) return;
    liveRevision = snapshot.updatedAt;
    upsertLiveReplay(snapshot);
  } catch (error) {
    // 训练没有运行或服务正在重启时继续保留最后一个完整快照。
  }
}

function renderChart(histories) {
  const chart = $('lossChart');
  chart.replaceChildren();
  [35, 75, 115, 155].forEach(function (y) { chart.appendChild(svg('line', { x1: 20, y1: y, x2: 400, y2: y, class: 'chart-grid' })); });
  const points = [];
  const phases = histories.numpy && histories.numpy.length ? ['numpy'] : ['teacher', 'selfPlay'];
  phases.forEach(function (phase) {
    (histories[phase] || []).forEach(function (item) { points.push(item); });
  });
  if (!points.length) return;
  const maximum = Math.max.apply(null, points.flatMap(function (item) { return [item.policyLoss, item.valueLoss]; }).map(Number)) || 1;
  function coordinates(key) {
    return points.map(function (item, index) {
      const x = points.length === 1 ? 210 : 25 + index * 370 / (points.length - 1);
      const y = 158 - Math.max(0, Number(item[key]) || 0) / maximum * 120;
      return [x, y];
    });
  }
  [['policyLoss', 'chart-policy', 'chart-dot-policy'], ['valueLoss', 'chart-value', 'chart-dot-value']].forEach(function (series) {
    const coords = coordinates(series[0]);
    chart.appendChild(svg('polyline', { points: coords.map(function (point) { return point.join(','); }).join(' '), class: series[1] }));
    coords.forEach(function (point) { chart.appendChild(svg('circle', { cx: point[0], cy: point[1], r: 3.4, class: series[2] })); });
  });
}

function renderRun(data) {
  runData = data;
  const arena = data.numpyArena || data.summary.arena;
  const promoted = (data.numpyArena && data.numpyArena.status === 'promoted') || (!data.numpyArena && data.run.status === 'promoted');
  const arenaLeading = arena.candidateWins > arena.baselineWins;
  $('runStatus').textContent = promoted ? '已通过晋级' : (arenaLeading ? '对战领先 · 尚未晋级' : '实验候选 · 未上线');
  $('runStatus').className = 'run-status ' + data.run.status;
  $('runName').textContent = data.run.name;
  $('runTime').textContent = new Date(data.run.createdAt).toLocaleString('zh-CN') + ' · ' + data.run.elapsedSeconds + ' 秒';
  $('sampleMetric').textContent = (data.summary.teacherSamples + data.summary.selfPlaySamples).toLocaleString('zh-CN');
  $('policyMetric').textContent = percent(data.numericalBackend
    ? data.numericalBackend.validation.policyTop1
    : data.summary.validation.policyTop1);
  $('arenaMetric').textContent = arena.candidateWins + ' : ' + arena.baselineWins;
  $('movesMetric').textContent = arena.averageMoves;
  $('teacherStage').textContent = data.summary.teacher.games + ' 局 · ' + data.summary.teacherSamples + ' 条样本';
  $('selfStage').textContent = data.summary.selfPlay.games + ' 局 · ' + data.summary.selfPlay.completed + ' 局完成';
  $('numpyStage').textContent = data.numericalBackend
    ? data.numericalBackend.epochs + ' epoch · ' + data.numericalBackend.elapsedSeconds + ' 秒 · Top-1 ' + percent(data.numericalBackend.validation.policyTop1)
    : '等候 Python 结果';
  $('arenaStage').textContent = arena.games + ' 局 · ' + arena.completed + ' 局完成';
  $('gateBadge').textContent = promoted ? '通过' : '拦截';
  $('decisionTitle').textContent = promoted
    ? '候选模型通过门禁'
    : (arenaLeading ? '对战领先，但尚未通过完整门禁' : '候选模型暂不晋级');
  $('decisionText').textContent = promoted
    ? '该 checkpoint 已满足胜负、完成率和平均手数门槛，可进入高难度接入评审。'
    : (arenaLeading
      ? '候选以 ' + arena.candidateWins + ':' + arena.baselineWins + ' 领先 V0，但仍有 ' + arena.draws + ' 盘达到训练上限；严格门禁要求全部完成，因此继续保留为实验模型。'
      : '本轮模型没有真正战胜 V0，已保留为实验样本；游戏继续使用当前稳定机器人。');
  $('decisionCard').classList.toggle('promoted', promoted);
  const select = $('replaySelect');
  select.replaceChildren();
  data.replays.forEach(function (item) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.title + ' · ' + item.moves + ' 手';
    select.appendChild(option);
  });
  renderChart(data.histories || {});
  $('boardLoading').hidden = true;
  selectReplay(data.replays[0] && data.replays[0].id);
}

function bindControls() {
  $('replaySelect').addEventListener('change', function () {
    followingLive = this.value === 'live-training';
    selectReplay(this.value);
  });
  $('prevBtn').addEventListener('click', function () { stopPlayback(); followingLive = false; step = Math.max(0, step - 1); renderBoard(); });
  $('nextBtn').addEventListener('click', function () { stopPlayback(); step = Math.min(replay.actions.length, step + 1); renderBoard(); });
  $('playBtn').addEventListener('click', function () { if (timer) stopPlayback(); else startPlayback(); });
  $('replayRange').addEventListener('input', function () { stopPlayback(); followingLive = false; step = Number(this.value); renderBoard(); });
  $('speedSelect').addEventListener('change', function () { if (timer) startPlayback(); });
}

async function init() {
  bindControls();
  try {
    let response = await fetch('/ai-lab/run', { cache: 'no-store' });
    if (!response.ok) response = await fetch('training/latest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('训练日志尚未生成');
    const data = await response.json();
    if (data.error) throw new Error('训练日志尚未生成');
    renderRun(data);
    await pollLiveTraining();
    window.setInterval(pollLiveTraining, 800);
  } catch (error) {
    $('boardLoading').textContent = error.message + '，请先运行本地训练命令。';
    $('runStatus').textContent = '暂无训练日志';
  }
}

window.addEventListener('DOMContentLoaded', init);
