'use strict';

const SAVE_KEYS = {
  ai: 'gomoku_save_ai_v1',
  local: 'gomoku_save_local_v1'
};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}

function loadMeta(mode) {
  try {
    const raw = safeGet(SAVE_KEYS[mode]);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    if (data.mode !== mode || data.finished) return null;
    if (!Number.isInteger(data.moveNumber) || data.moveNumber <= 0) return null;
    return data;
  } catch (error) {
    return null;
  }
}

function updateModeButton(button, meta, baseLabel) {
  if (!button) return;
  if (!meta) return;
  const label = `${baseLabel}（继续 ${meta.modeLabel || '上局'} · ${meta.moveNumber} 步）`;
  button.textContent = label;
}

function normalizeMeta(meta) {
  const created = Number.isFinite(Number(meta.createdAt)) ? new Date(meta.createdAt) : null;
  const at = Number.isFinite(Number(meta.updatedAt)) ? new Date(meta.updatedAt) : null;
  const now = Date.now();
  const stamp = at ? new Date(at).toLocaleString() : '';
  const ageText = created ? `${Math.max(1, Math.floor((now - new Date(created).getTime()) / (60 * 1000)))} 分钟前` : '';
  return {
    moveText: `${meta.moveNumber} 步`,
    updatedText: stamp || ageText || '进行中'
  };
}

function bindMode(mode, buttonId, label) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  const meta = loadMeta(mode);
  if (meta) {
    const display = normalizeMeta(meta);
    button.textContent = `继续${display.moveText}`;
    button.setAttribute('aria-label', `${label}继续上局，共 ${display.moveText}`);
  }
  button.addEventListener('click', function () {
    window.location.href = `play.html?mode=${mode}`;
  });
}

function init() {
  bindMode('ai', 'startAiBtn', '单机人机');
  bindMode('local', 'startLocalBtn', '本地双人');
}

window.addEventListener('DOMContentLoaded', init);
