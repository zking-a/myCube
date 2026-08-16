'use strict';
/*
 * core.js —— 浏览器版计算内核（原样搬运自 src/core/rational.js + evaluator.js）
 * 用于 HTML 测试版。无 eval / 无动态执行，分数精确。
 * 同时支持浏览器(window)与 Node(module.exports)以便自测。
 */

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

class Rational {
  constructor(numer, denom) {
    denom = denom === undefined ? 1 : denom;
    if (!Number.isInteger(numer) || !Number.isInteger(denom)) {
      throw new TypeError('Rational 仅接受整数分子/分母');
    }
    if (denom === 0) {
      throw new RangeError('Rational: 分母不能为 0');
    }
    if (denom < 0) {
      numer = -numer;
      denom = -denom;
    }
    const g = gcd(numer, denom);
    this.n = numer / g;
    this.d = denom / g;
  }
  add(o) { return new Rational(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Rational(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Rational(this.n * o.n, this.d * o.d); }
  div(o) {
    if (o.n === 0) throw new RangeError('Rational: 除以 0');
    return new Rational(this.n * o.d, this.d * o.n);
  }
  eq(o) { return this.n === o.n && this.d === o.d; }
  lt(o) { return this.n * o.d < o.n * this.d; }
  gt(o) { return this.n * o.d > o.n * this.d; }
  lte(o) { return this.n * o.d <= o.n * this.d; }
  gte(o) { return this.n * o.d >= o.n * this.d; }
  isInteger() { return this.d === 1; }
  isNegative() { return this.n < 0; }
  toNumber() { return this.n / this.d; }
  toString() { return this.d === 1 ? String(this.n) : this.n + '/' + this.d; }
}
Rational.TWENTY_FOUR = new Rational(24);

// ===== Evaluator =====
class EvalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvalError';
    this.code = code;
  }
}
const NORM = { '×': '*', '÷': '/', '−': '-', '–': '-' };
function mkErr(code, message) { return new EvalError(code, message); }

function tokenize(input) {
  if (typeof input !== 'string') throw mkErr('FORMAT_ERROR', '表达式必须为字符串');
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i, num = '';
      while (j < input.length && input[j] >= '0' && input[j] <= '9') { num += input[j]; j++; }
      tokens.push({ type: 'num', value: parseInt(num, 10), text: num });
      i = j; continue;
    }
    const norm = NORM[ch] || ch;
    if (norm === '+' || norm === '-' || norm === '*' || norm === '/') {
      tokens.push({ type: 'op', op: norm }); i++; continue;
    }
    if (ch === '(') { tokens.push({ type: 'lp' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rp' }); i++; continue; }
    throw mkErr('EXTRANEOUS_CHARACTER', '非法字符：' + JSON.stringify(ch));
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const used = [];
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseExpr() {
    let node = parseTerm();
    while (peek() && peek().type === 'op' && (peek().op === '+' || peek().op === '-')) {
      const op = next().op;
      const right = parseTerm();
      node = { kind: 'op', op, left: node, right };
    }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (peek() && peek().type === 'op' && (peek().op === '*' || peek().op === '/')) {
      const op = next().op;
      const right = parseFactor();
      node = { kind: 'op', op, left: node, right };
    }
    return node;
  }
  function parseFactor() {
    const t = peek();
    if (!t) throw mkErr('FORMAT_ERROR', '表达式意外结束');
    if (t.type === 'num') { next(); used.push(t.value); return { kind: 'num', value: new Rational(t.value), token: t.text }; }
    if (t.type === 'lp') {
      next();
      const e = parseExpr();
      const rp = peek();
      if (!rp || rp.type !== 'rp') throw mkErr('FORMAT_ERROR', '缺少右括号');
      next();
      return e;
    }
    if (t.type === 'op') throw mkErr('FORMAT_ERROR', '运算符缺少操作数');
    throw mkErr('FORMAT_ERROR', '意外符号');
  }
  const ast = parseExpr();
  if (pos < tokens.length) {
    const rem = tokens[pos];
    if (rem.type === 'rp') throw mkErr('FORMAT_ERROR', '多余的右括号');
    throw mkErr('FORMAT_ERROR', '表达式存在多余内容');
  }
  return { ast, used };
}

function evalAst(node) {
  if (node.kind === 'num') return node.value;
  const l = evalAst(node.left);
  const r = evalAst(node.right);
  if (node.op === '+') return l.add(r);
  if (node.op === '-') return l.sub(r);
  if (node.op === '*') return l.mul(r);
  if (node.op === '/') {
    if (r.n === 0) throw mkErr('DIVIDE_BY_ZERO', '表达式中出现除以 0');
    return l.div(r);
  }
  throw mkErr('ILLEGAL_OPERATOR', '不允许的运算：' + node.op);
}

function diffUsed(used, puzzle) {
  const pu = {};
  for (const n of puzzle) pu[n] = (pu[n] || 0) + 1;
  const uu = {};
  for (const n of used) uu[n] = (uu[n] || 0) + 1;
  let extraneous = false;
  for (const k in uu) if (!(k in pu)) extraneous = true;
  let missing = false, over = false;
  for (const k in pu) {
    const have = uu[k] || 0;
    if (have < pu[k]) missing = true;
    if (have > pu[k]) over = true;
  }
  if (extraneous) return { code: 'EXTRANEOUS_NUMBER', message: '使用了题目外的数字' };
  if (over) return { code: 'WRONG_USAGE_COUNT', message: '某数字使用次数错误（多用了）' };
  if (missing) return { code: 'NOT_ALL_USED', message: '未使用全部数字' };
  return null;
}

function evaluate(input, puzzle) {
  if (!Array.isArray(puzzle) || puzzle.length !== 4) {
    throw new TypeError('evaluate 需要长度为 4 的题目数组');
  }
  try {
    const tokens = tokenize(input);
    const { ast, used } = parse(tokens);
    const numErr = diffUsed(used, puzzle);
    if (numErr) {
      return { valid: false, value: null, usedNumbers: used, error: numErr, normalizedExpr: '' };
    }
    const value = evalAst(ast);
    if (!value.eq(Rational.TWENTY_FOUR)) {
      return {
        valid: false, value, usedNumbers: used,
        error: { code: 'RESULT_NOT_24', message: '结果不等于 24（得到 ' + value.toString() + '）' },
        normalizedExpr: '',
      };
    }
    return { valid: true, value, usedNumbers: used, error: null, normalizedExpr: '' };
  } catch (e) {
    if (e instanceof EvalError) {
      return { valid: false, value: null, usedNumbers: [], error: { code: e.code, message: e.message }, normalizedExpr: '' };
    }
    return { valid: false, value: null, usedNumbers: [], error: { code: 'FORMAT_ERROR', message: e.message || String(e) }, normalizedExpr: '' };
  }
}

// 导出
const Core = { Rational, gcd, evaluate, tokenize, parse, evalAst, EvalError };
if (typeof window !== 'undefined') {
  window.Rational = Rational;
  window.evaluate = evaluate;
  window.GameCore = Core;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Core;
}
