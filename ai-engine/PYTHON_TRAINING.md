# Python 数值训练后端

规则、合法动作和 PUCT 仍由 Node.js 端生成，Python 只处理标准训练样本：

```text
Node GameAdapter -> JSONL(state, actions, policy, value) -> Python/NumPy -> dynamic-policy-value-v1 -> JS inference
```

这样新增游戏时只需实现一个适配器，不必在 Python 中重复移植规则。NumPy 训练器使用带掩码的动态动作批次、Adam 和向量化矩阵运算；未来切换 PyTorch/GPU 时可继续使用同一 JSONL 和 checkpoint 契约。

V1.4 要求 JSONL 每条样本同时包含 `gameId` 与 `splitGroupId`。`splitGroupId` 对中国跳棋
等于规范化的 `openingFamilyId`；同一开局的换色镜像、不同对手和所有派生局面必须处于同一
分区。NumPy 默认 fail-closed，缺少该字段的数据不会静默退回按单局切分。

截止样本必须为 `value=0,valueMask=0`。它们继续训练策略头，但不参与价值损失；当一个
mini-batch 没有任何真实完成局时，价值头也不会通过 L2 正则发生参数变化。

V1.2 可用 `--hidden-size 96 --action-hidden-size 24` 扩大状态主干和动态动作头；checkpoint
仍采用同一个 `dynamic-policy-value-v1` 格式，因此 Node.js 推理和后续其他回合制游戏无需
改接口。网络变大只增加候选容量，不会绕过独立竞技场门禁。

```bash
npm run train:checkers-robot -- --dataset-output models/checkers-training-next.jsonl --run-output public/checkers/training/latest.json --output models/checkers-candidate-generator.json --summary-only
npm run train:checkers-robot:scratch -- --dataset models/checkers-training-next.jsonl --output models/checkers-v1_4-scratch.json
npm run train:checkers-robot:policy-warm -- --dataset models/checkers-training-next.jsonl --output models/checkers-v1_4-policy-warm.json --run-log public/checkers/training/latest.json
npm run eval:checkers-robot -- --model models/checkers-candidate.json --agent hybrid --run-output public/checkers/training/latest.json
```

`--init-components` 是必填契约，避免默认路径静默继承旧价值头。`scratch` 只从可选的
`--init-model` 读取网络尺寸，不复制任何权重；`policy` 复制状态塔、动作塔与策略头，但使用
同一种子重新初始化 `value/valueBias`；`all` 仅用于明确要求的完整续训。每个输出 checkpoint
都会记录数据集 SHA-256、源 checkpoint SHA-256、逐组件来源和已清零的优化器状态。

hybrid 样本的 `candidateMask` 会直接限制 listwise softmax 与策略交叉熵；教师样本没有候选
掩码时才使用全部合法动作。完成局验证额外报告 W/L Brier 分数及开局、中局、残局校准，
截止局不会进入这些指标。

Generation 1 的默认 Node 数据配比为 48/160/80/32 局（V0 hard 锚定、冻结 V1.3 对
V0 hard、冻结 V1.3 镜像自对弈、top-2 受控探索），共 320 局。开发筛选可按同一比例缩小
为 20 opening pairs；正式结论仍需使用完整冻结数据与独立竞技场。

`--progress-weight 0.1` 可训练 completed-only MTG 辅助头并输出
`dynamic-policy-value-v2`；JS 同时保持 v1 只读兼容。MTG 默认仅报告 MAE，不参与选步，
评估器只有显式传入 `--enable-mtg` 才启用安全集合 tie-break。

如 Python 不在 PATH，可先设置 `PYTHON_BIN` 为 Python 3 可执行文件。运行环境至少需要 NumPy。
