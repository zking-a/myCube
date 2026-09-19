'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// ---- minimal DOM mock (mirrors test sandbox) ----
function hasClass(node, name) { return String(node.className).split(/\s+/).indexOf(name) >= 0; }
function addClass(node, name) { if (!hasClass(node, name)) node.className = (node.className + ' ' + name).trim(); }
function createNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', hidden: false, style: {}, dataset: {}, children: [], __attrs: {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    replaceChildren() { this.children.length = 0; },
    remove() { const p = this.parentNode; if (p) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); this.parentNode = null; } },
    setAttribute(name, value) { this.__attrs[name] = String(value); if (name === 'class') this.className = String(value); },
    getAttribute(name) { return this.__attrs[name]; },
    addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add: function (n) { addClass(node, n); }, remove: function (n) { /*noop*/ }, contains: function (n) { return hasClass(node, n); }, toggle: function () {} }
  };
  return node;
}
function escapeAttr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
function serialize(node) {
  if (typeof node === 'string') return node;
  const tag = String(node.tagName).toLowerCase();
  const attrs = Object.keys(node.__attrs || {}).map(function (k) { return ' ' + k + '="' + escapeAttr(node.__attrs[k]) + '"'; }).join('');
  if (!node.children || !node.children.length) return '<' + tag + attrs + '/>';
  return '<' + tag + attrs + '>' + node.children.map(serialize).join('') + '</' + tag + '>';
}

const sandbox = {
  console: console, Math: Math, Date: Date, JSON: JSON, Object: Object, Array: Array,
  String: String, Number: Number, Set: Set, Map: Map, RegExp: RegExp, Error: Error,
  URL: URL, URLSearchParams: URLSearchParams, setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: { createElement: createNode, createElementNS: function (_ns, t) { return createNode(t); }, getElementById: function () { return null; }, querySelector: function () { return null; } },
  location: { protocol: 'https:', host: 'game.test', href: 'https://game.test/checkers/play.html', search: '' },
  navigator: {}, localStorage: { getItem: function () { return null; }, setItem: function () {} },
  WebSocket: { OPEN: 1 }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {};
sandbox.CheckersCore = {};

const src = fs.readFileSync(path.resolve(__dirname, 'public/checkers/checkers.js'), 'utf8');
vm.createContext(sandbox);
const coreSrc = fs.readFileSync(path.resolve(__dirname, 'public/checkers/checkers_core.js'), 'utf8');
vm.runInContext(coreSrc, sandbox, { filename: 'checkers_core.js' });
vm.runInContext(src, sandbox, { filename: 'checkers.js' });
const T = sandbox.__checkersTest;

const FACS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange'];
const LABELS = { red: '红方', blue: '蓝方', green: '绿方', yellow: '黄方', purple: '紫方', orange: '橙方' };

function rowFor(tints, caption) {
  const defsSvg = T.buildPieceDefs(sandbox.document, tints);
  const defsHtml = serialize(defsSvg);
  const cells = FACS.map(function (f) {
    const piece = T.buildPieceNode(f, sandbox.document, tints);
    const pieceHtml = serialize(piece);
    return '<div class="cell"><div class="piece">' + pieceHtml + '</div><div class="lab">' + LABELS[f] + '</div></div>';
  }).join('');
  return '<h2>' + caption + '</h2><div class="row">' + defsHtml + cells + '</div>';
}

const candy = rowFor(T.BIRTHDAY_TINTS, '生日主题（?birthday=1 / 9月19日自动开）— 六色分明糖果');
const glass = rowFor(T.PIECE_TINTS, '普通模式（对照）— 玻璃珠');

const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>跳棋棋子预览</title>'
  + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#fff5fb;color:#333;margin:0;padding:28px;}'
  + 'h2{font-size:16px;margin:22px 0 10px;}'
  + '.row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end;background:#fff;border-radius:16px;padding:18px;box-shadow:0 4px 18px rgba(180,120,160,.15);}'
  + '.cell{display:flex;flex-direction:column;align-items:center;gap:8px;}'
  + '.piece{width:120px;height:120px;} .piece svg{width:100%;height:100%;display:block;}'
  + '.lab{font-size:14px;font-weight:600;}</style></head><body>'
  + '<h1 style="font-size:20px;margin:0 0 4px;">中国跳棋棋子配色预览</h1>'
  + '<p style="color:#a06;margin:0 0 8px;">生日模式已改为六方各自清晰的糖果色，可一眼区分阵营。</p>'
  + candy + glass + '</body></html>';

const out = path.resolve(__dirname, 'preview_pieces.html');
fs.writeFileSync(out, html);
console.log('WROTE', out);
