'use strict';

/**
 * 通用动态动作策略价值网络（零第三方依赖）。
 *
 * 数据流：
 *   state[stateSize] -> state embedding[hiddenSize] -> value[-1, 1]
 *                                               \-> movesToGo[0, 1] (v2)
 *   action[][actionSize] -> action embeddings -> dynamic policy distribution
 *
 * 与固定棋盘动作分类器不同，策略头逐个编码当前合法动作，因此同一引擎可处理
 * 不同游戏、不同局面下长度可变的合法动作列表。所有数组均使用一维 row-major
 * 布局，以便模型 JSON 可跨浏览器、Node.js 和未来的原生推理端复用。
 */

function createRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return function () {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function zeros(length) { return new Array(length).fill(0); }
function randomArray(length, fanIn, random) {
  const scale = Math.sqrt(2 / Math.max(1, fanIn));
  return Array.from({ length: length }, function () { return (random() * 2 - 1) * scale; });
}
function clamp(value, limit) { return Math.max(-limit, Math.min(limit, value)); }

function softmax(logits) {
  if (!logits.length) return [];
  const maximum = Math.max.apply(null, logits);
  const values = logits.map(function (value) { return Math.exp(Math.max(-50, value - maximum)); });
  const total = values.reduce(function (sum, value) { return sum + value; }, 0) || 1;
  return values.map(function (value) { return value / total; });
}

/**
 * 轻量策略价值模型。
 *
 * @example
 * const model = new PolicyValueModel({ stateSize: 32, actionSize: 8 });
 * const { policy, value } = model.predict(stateVector, legalActionVectors);
 */
class PolicyValueModel {
  constructor(config, weights) {
    const source = config || {};
    this.format = source.format === 'dynamic-policy-value-v2'
      ? 'dynamic-policy-value-v2'
      : 'dynamic-policy-value-v1';
    this.hasProgressHead = this.format === 'dynamic-policy-value-v2';
    this.stateSize = Math.max(1, Math.floor(Number(source.stateSize) || 1));
    this.actionSize = Math.max(1, Math.floor(Number(source.actionSize) || 1));
    this.hiddenSize = Math.max(4, Math.floor(Number(source.hiddenSize) || 32));
    this.actionHiddenSize = Math.max(4, Math.floor(Number(source.actionHiddenSize) || 12));
    this.seed = Math.floor(Number(source.seed) || 1);
    this.metadata = {};
    const random = createRandom(this.seed);
    this.weights = weights || {
      stateInput: randomArray(this.hiddenSize * this.stateSize, this.stateSize, random),
      stateInputBias: zeros(this.hiddenSize),
      stateHidden: randomArray(this.hiddenSize * this.hiddenSize, this.hiddenSize, random),
      stateHiddenBias: zeros(this.hiddenSize),
      actionInput: randomArray(this.actionHiddenSize * this.actionSize, this.actionSize, random),
      actionBias: zeros(this.actionHiddenSize),
      policyPair: randomArray(this.hiddenSize * this.actionHiddenSize, this.hiddenSize, random),
      policyAction: randomArray(this.actionHiddenSize, this.actionHiddenSize, random),
      policyBias: 0,
      value: randomArray(this.hiddenSize, this.hiddenSize, random),
      valueBias: 0
    };
    if (!weights && this.hasProgressHead) {
      this.weights.movesToGo = randomArray(this.hiddenSize, this.hiddenSize, random);
      this.weights.movesToGoBias = 0;
    }
    this.validate();
  }

  /** 校验模型维度，防止损坏或不兼容的 checkpoint 静默参与推理。 */
  validate() {
    const expected = {
      stateInput: this.hiddenSize * this.stateSize,
      stateInputBias: this.hiddenSize,
      stateHidden: this.hiddenSize * this.hiddenSize,
      stateHiddenBias: this.hiddenSize,
      actionInput: this.actionHiddenSize * this.actionSize,
      actionBias: this.actionHiddenSize,
      policyPair: this.hiddenSize * this.actionHiddenSize,
      policyAction: this.actionHiddenSize,
      value: this.hiddenSize
    };
    if (this.hasProgressHead) expected.movesToGo = this.hiddenSize;
    Object.keys(expected).forEach((name) => {
      if (!Array.isArray(this.weights[name]) || this.weights[name].length !== expected[name]) {
        throw new Error('策略价值模型权重形状错误：' + name);
      }
    });
    if (!Number.isFinite(Number(this.weights.policyBias)) || !Number.isFinite(Number(this.weights.valueBias)) ||
      (this.hasProgressHead && !Number.isFinite(Number(this.weights.movesToGoBias)))) {
      throw new Error('策略价值模型偏置不是有限数值');
    }
  }

  /**
   * @param {number[]} input 固定长度、已归一化的局面向量。
   * @returns {{first:number[], second:number[]}} 两层状态表征及训练缓存。
   */
  encodeState(input) {
    if (!Array.isArray(input) || input.length !== this.stateSize) throw new Error('状态编码维度不匹配');
    const first = new Array(this.hiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      let sum = this.weights.stateInputBias[h];
      const offset = h * this.stateSize;
      for (let i = 0; i < this.stateSize; i++) sum += this.weights.stateInput[offset + i] * input[i];
      first[h] = Math.tanh(sum);
    }
    const second = new Array(this.hiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      let sum = this.weights.stateHiddenBias[h];
      const offset = h * this.hiddenSize;
      for (let i = 0; i < this.hiddenSize; i++) sum += this.weights.stateHidden[offset + i] * first[i];
      second[h] = Math.tanh(sum);
    }
    return { first: first, second: second };
  }

  /**
   * @param {number[][]} inputs 当前局面的全部合法动作向量。
   * @returns {number[][]} 每个动作对应的低维表征。
   */
  encodeActions(inputs) {
    return inputs.map((input) => {
      if (!Array.isArray(input) || input.length !== this.actionSize) throw new Error('动作编码维度不匹配');
      const embedding = new Array(this.actionHiddenSize);
      for (let h = 0; h < this.actionHiddenSize; h++) {
        let sum = this.weights.actionBias[h];
        const offset = h * this.actionSize;
        for (let i = 0; i < this.actionSize; i++) sum += this.weights.actionInput[offset + i] * input[i];
        embedding[h] = Math.tanh(sum);
      }
      return embedding;
    });
  }

  /** 内部前向传播；除预测结果外还返回反向传播所需的中间量。 */
  forward(stateInput, actionInputs) {
    const state = this.encodeState(stateInput);
    const actions = this.encodeActions(actionInputs);
    const policyVector = new Array(this.actionHiddenSize);
    for (let a = 0; a < this.actionHiddenSize; a++) {
      let sum = this.weights.policyAction[a];
      for (let h = 0; h < this.hiddenSize; h++) sum += state.second[h] * this.weights.policyPair[h * this.actionHiddenSize + a];
      policyVector[a] = sum;
    }
    const logits = actions.map((embedding) => {
      let sum = Number(this.weights.policyBias) || 0;
      for (let a = 0; a < this.actionHiddenSize; a++) sum += embedding[a] * policyVector[a];
      return sum;
    });
    let valueLogit = Number(this.weights.valueBias) || 0;
    for (let h = 0; h < this.hiddenSize; h++) valueLogit += state.second[h] * this.weights.value[h];
    let movesToGo = null;
    if (this.hasProgressHead) {
      let progressLogit = Number(this.weights.movesToGoBias) || 0;
      for (let h = 0; h < this.hiddenSize; h++) progressLogit += state.second[h] * this.weights.movesToGo[h];
      movesToGo = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, progressLogit))));
    }
    return {
      state: state, actionEmbeddings: actions, policyVector: policyVector,
      logits: logits, policy: softmax(logits), value: Math.tanh(valueLogit), movesToGo: movesToGo
    };
  }

  /**
   * 对一个局面和它的合法动作集合执行推理。
   *
   * @param {number[]} stateInput 长度必须等于 stateSize。
   * @param {number[][]} actionInputs 每项长度必须等于 actionSize，允许数量动态变化。
   * @returns {{policy:number[], value:number, logits:number[]}}
   * policy 与动作输入一一对应且总和为 1；value 是当前行动方视角的 [-1, 1] 局面价值。
   */
  predict(stateInput, actionInputs) {
    const result = this.forward(stateInput, actionInputs);
    return { policy: result.policy, value: result.value, movesToGo: result.movesToGo, logits: result.logits };
  }

  /**
   * 只执行状态主干和价值头。搜索器在批量评估后继局面时无需构造合法动作，
   * 可显著减少模型增强 alpha-beta/DFS 的重复计算。
   */
  predictValue(stateInput) {
    const state = this.encodeState(stateInput);
    let valueLogit = Number(this.weights.valueBias) || 0;
    for (let hidden = 0; hidden < this.hiddenSize; hidden++) {
      valueLogit += state.second[hidden] * this.weights.value[hidden];
    }
    return Math.tanh(valueLogit);
  }

  /** Return normalized expected remaining plies for a v2 checkpoint. */
  predictMovesToGo(stateInput) {
    if (!this.hasProgressHead) return null;
    const state = this.encodeState(stateInput);
    let logit = Number(this.weights.movesToGoBias) || 0;
    for (let hidden = 0; hidden < this.hiddenSize; hidden++) {
      logit += state.second[hidden] * this.weights.movesToGo[hidden];
    }
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))));
  }

  /** A v2 head is deployable only when its checkpoint declares supervised MTG training. */
  hasTrainedProgressHead() {
    const trainer = this.metadata && this.metadata.trainer;
    const weights = trainer && trainer.lossWeights;
    return this.hasProgressHead && Number(weights && weights.movesToGo) > 0;
  }

  /**
   * 使用单条样本执行一次 SGD 更新。
   *
   * @param {{state:number[], actions:number[][], policy:number[], value:number}} sample
   * policy 是合法动作上的目标分布；value 为样本行动方最终结果，范围 [-1, 1]。
   * @param {{learningRate?:number, valueWeight?:number, policyWeight?:number,
   *   l2?:number, gradientClip?:number}} [options]
   * @returns {{policyLoss:number, valueLoss:number, value:number}}
   */
  trainSample(sample, options) {
    const settings = options || {};
    const learningRate = Number(settings.learningRate) || 0.003;
    const configuredValueWeight = Number.isFinite(Number(settings.valueWeight)) ? Number(settings.valueWeight) : 1;
    const valueMask = Number.isFinite(Number(sample.valueMask)) ? Math.max(0, Math.min(1, Number(sample.valueMask))) : 1;
    const valueWeight = configuredValueWeight * valueMask;
    const progressMask = this.hasProgressHead && Number(sample.progressMask) > 0 ? 1 : 0;
    const progressWeight = (Number.isFinite(Number(settings.progressWeight)) ? Number(settings.progressWeight) : .1) * progressMask;
    const policyWeight = Number.isFinite(Number(settings.policyWeight)) ? Number(settings.policyWeight) : 1;
    const l2 = Number(settings.l2) || 0.00002;
    const clip = Number(settings.gradientClip) || 0.5;
    const result = this.forward(sample.state, sample.actions);
    if (!Array.isArray(sample.policy) || sample.policy.length !== result.policy.length || !result.policy.length) throw new Error('训练策略目标维度不匹配');

    const targetValue = Math.max(-1, Math.min(1, Number(sample.value) || 0));
    const valueError = result.value - targetValue;
    const dValueLogit = clamp(valueWeight * valueError * (1 - result.value * result.value), clip);
    const dHidden = zeros(this.hiddenSize);
    const gradValue = new Array(this.hiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      gradValue[h] = dValueLogit * result.state.second[h];
      dHidden[h] += dValueLogit * this.weights.value[h];
    }
    const progressTarget = Math.max(0, Math.min(1, Number(sample.movesToGo) || 0));
    const progressError = this.hasProgressHead ? result.movesToGo - progressTarget : 0;
    const huberDelta = .1;
    const huberGradient = Math.abs(progressError) <= huberDelta
      ? progressError
      : huberDelta * Math.sign(progressError);
    const dProgressLogit = this.hasProgressHead
      ? clamp(progressWeight * huberGradient * result.movesToGo * (1 - result.movesToGo), clip)
      : 0;
    const gradMovesToGo = this.hasProgressHead ? new Array(this.hiddenSize) : null;
    if (this.hasProgressHead) {
      for (let h = 0; h < this.hiddenSize; h++) {
        gradMovesToGo[h] = dProgressLogit * result.state.second[h];
        dHidden[h] += dProgressLogit * this.weights.movesToGo[h];
      }
    }

    // softmax + 交叉熵的合并梯度为 prediction - target。
    const dLogits = result.policy.map(function (probability, index) { return clamp(policyWeight * (probability - (Number(sample.policy[index]) || 0)), clip); });
    const gradPolicyVector = zeros(this.actionHiddenSize);
    const dActionEmbeddings = result.actionEmbeddings.map(() => zeros(this.actionHiddenSize));
    let gradPolicyBias = 0;
    for (let k = 0; k < dLogits.length; k++) {
      gradPolicyBias += dLogits[k];
      for (let a = 0; a < this.actionHiddenSize; a++) {
        gradPolicyVector[a] += dLogits[k] * result.actionEmbeddings[k][a];
        dActionEmbeddings[k][a] += dLogits[k] * result.policyVector[a];
      }
    }

    const gradPolicyAction = gradPolicyVector.slice();
    const gradPolicyPair = new Array(this.hiddenSize * this.actionHiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      for (let a = 0; a < this.actionHiddenSize; a++) {
        const index = h * this.actionHiddenSize + a;
        gradPolicyPair[index] = result.state.second[h] * gradPolicyVector[a];
        dHidden[h] += this.weights.policyPair[index] * gradPolicyVector[a];
      }
    }

    const gradActionInput = zeros(this.actionHiddenSize * this.actionSize);
    const gradActionBias = zeros(this.actionHiddenSize);
    for (let k = 0; k < sample.actions.length; k++) {
      for (let a = 0; a < this.actionHiddenSize; a++) {
        const dz = dActionEmbeddings[k][a] * (1 - result.actionEmbeddings[k][a] * result.actionEmbeddings[k][a]);
        gradActionBias[a] += dz;
        const offset = a * this.actionSize;
        for (let i = 0; i < this.actionSize; i++) gradActionInput[offset + i] += dz * sample.actions[k][i];
      }
    }

    const dSecond = dHidden.map(function (gradient, index) { return gradient * (1 - result.state.second[index] * result.state.second[index]); });
    const gradStateHidden = zeros(this.hiddenSize * this.hiddenSize);
    const gradStateHiddenBias = dSecond.slice();
    const dFirst = zeros(this.hiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      const offset = h * this.hiddenSize;
      for (let i = 0; i < this.hiddenSize; i++) {
        gradStateHidden[offset + i] = dSecond[h] * result.state.first[i];
        dFirst[i] += this.weights.stateHidden[offset + i] * dSecond[h];
      }
    }
    const gradStateInput = zeros(this.hiddenSize * this.stateSize);
    const gradStateInputBias = zeros(this.hiddenSize);
    for (let h = 0; h < this.hiddenSize; h++) {
      const dz = dFirst[h] * (1 - result.state.first[h] * result.state.first[h]);
      gradStateInputBias[h] = dz;
      const offset = h * this.stateSize;
      for (let i = 0; i < this.stateSize; i++) gradStateInput[offset + i] = dz * sample.state[i];
    }

    const updateArray = (name, gradient) => {
      const weights = this.weights[name];
      for (let i = 0; i < weights.length; i++) weights[i] -= learningRate * (clamp(gradient[i], clip) + l2 * weights[i]);
    };
    updateArray('stateInput', gradStateInput);
    updateArray('stateInputBias', gradStateInputBias);
    updateArray('stateHidden', gradStateHidden);
    updateArray('stateHiddenBias', gradStateHiddenBias);
    updateArray('actionInput', gradActionInput);
    updateArray('actionBias', gradActionBias);
    updateArray('policyPair', gradPolicyPair);
    updateArray('policyAction', gradPolicyAction);
    // A truncated sample trains policy only. Do not even apply L2 decay to the
    // value head, otherwise valueMask=0 would still mutate value parameters.
    if (valueMask > 0) updateArray('value', gradValue);
    if (progressMask > 0) updateArray('movesToGo', gradMovesToGo);
    this.weights.policyBias -= learningRate * clamp(gradPolicyBias, clip);
    if (valueMask > 0) this.weights.valueBias -= learningRate * dValueLogit;
    if (progressMask > 0) this.weights.movesToGoBias -= learningRate * dProgressLogit;

    let policyLoss = 0;
    for (let i = 0; i < sample.policy.length; i++) policyLoss -= (Number(sample.policy[i]) || 0) * Math.log(Math.max(1e-9, result.policy[i]));
    return {
      policyLoss: policyLoss,
      valueLoss: valueMask > 0 ? valueError * valueError : 0,
      valueSamples: valueMask > 0 ? 1 : 0,
      progressLoss: progressMask > 0
        ? (Math.abs(progressError) <= huberDelta
          ? .5 * progressError * progressError
          : huberDelta * (Math.abs(progressError) - .5 * huberDelta))
        : 0,
      progressSamples: progressMask,
      value: result.value
    };
  }

  /**
   * 训练一组样本。每轮使用确定性随机种子洗牌，保证实验可复现。
   * @returns {{epoch:number, policyLoss:number, valueLoss:number}[]} 每轮训练指标。
   */
  fit(samples, options) {
    const settings = options || {};
    const epochs = Math.max(1, Math.floor(Number(settings.epochs) || 1));
    const random = createRandom(Number(settings.seed) || this.seed + 1);
    const order = samples.slice();
    const history = [];
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const value = order[i]; order[i] = order[j]; order[j] = value;
      }
      let policyLoss = 0, valueLoss = 0, valueSamples = 0, progressLoss = 0, progressSamples = 0;
      order.forEach((sample) => {
        const losses = this.trainSample(sample, settings);
        policyLoss += losses.policyLoss; valueLoss += losses.valueLoss;
        valueSamples += losses.valueSamples;
        progressLoss += losses.progressLoss; progressSamples += losses.progressSamples;
      });
      const metrics = {
        epoch: epoch + 1,
        policyLoss: policyLoss / Math.max(1, order.length),
        valueLoss: valueLoss / Math.max(1, valueSamples),
        valueSamples: valueSamples,
        progressLoss: progressLoss / Math.max(1, progressSamples),
        progressSamples: progressSamples
      };
      history.push(metrics);
      if (typeof settings.onEpoch === 'function') settings.onEpoch(metrics);
    }
    return history;
  }

  /** 导出带格式版本和元数据的可移植 checkpoint。 */
  toJSON(metadata) {
    const round = function (value) { return Number(Number(value).toFixed(7)); };
    const weights = {};
    Object.keys(this.weights).forEach((name) => { weights[name] = Array.isArray(this.weights[name]) ? this.weights[name].map(round) : round(this.weights[name]); });
    return {
      format: this.format,
      config: {
        stateSize: this.stateSize, actionSize: this.actionSize, hiddenSize: this.hiddenSize,
        actionHiddenSize: this.actionHiddenSize, seed: this.seed, format: this.format
      },
      weights: weights,
      metadata: metadata || this.metadata || {}
    };
  }

  /** 从 checkpoint 恢复模型；不兼容的格式会显式报错。 */
  static fromJSON(payload) {
    if (!payload || (payload.format !== 'dynamic-policy-value-v1' && payload.format !== 'dynamic-policy-value-v2')) {
      throw new Error('不支持的策略价值模型格式');
    }
    const model = new PolicyValueModel(Object.assign({}, payload.config, { format: payload.format }), payload.weights);
    model.metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    return model;
  }
}

module.exports = { PolicyValueModel: PolicyValueModel, createRandom: createRandom, softmax: softmax };
