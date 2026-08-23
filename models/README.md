# AI 模型产物

该目录只保存仍有继续训练价值的开发基线与竞技场证据。当前保留
`checkers-policy-value-v1_3-numpy.json` 作为未上线的开发基线；失败候选、旧代中间
checkpoint 和 JSONL 训练数据不进入提交。

模型状态分为：

- `experimental`：训练完成但尚未达到线上晋级门槛，只能用于离线继续训练与评测。
- `promoted`：换边竞技场胜率、完赛率、平均手数和延迟均达标，可进入游戏难度接入评审。

训练命令：

```bash
npm run train:checkers-robot -- --output models/checkers-candidate-generator.json --dataset-output models/checkers-training-next.jsonl
npm run train:checkers-robot:scratch -- --dataset models/checkers-training-next.jsonl --output models/checkers-v1_4-scratch.json
npm run train:checkers-robot:policy-warm -- --dataset models/checkers-training-next.jsonl --output models/checkers-v1_4-policy-warm.json
```

V1.4 的 Node 阶段只用冻结 actor 生成数据；真正候选由两个 NumPy 初始化组产生。所有候选
仍为 `experimental`，失败候选和 JSONL 数据受 `.gitignore` 保护，不进入提交。
