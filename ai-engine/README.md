# 可复用策略价值 AI 引擎

该目录不依赖具体游戏规则，提供三项能力：

- `PolicyValueModel`：读取游戏适配器生成的原始状态和动态合法动作，输出策略概率与局面价值。
- `PuctMcts`：用策略先验和价值估计执行 PUCT 搜索，可渐进混合启发式教师。
- `playSelfGame` / `playArenaGame`：生成强化学习样本和运行候选模型竞技场。
- `playLeagueGame`：让当前、历史和规则代理在同一训练契约下组成对手池。
- `ReplayBuffer` / `splitByGame`：按完整对局缓存、淘汰和切分，防止轨迹泄漏。
- `bidirectionalAStar`：受节点/时间预算保护的通用双向 A*，只在可采纳下界与完整终止条件成立时标记最优。

## 游戏适配器契约

接入新游戏需要实现：

```js
initialState()
currentPlayer(state)
legalActions(state)
applyAction(state, action)
isTerminal(state)
terminalValue(state, perspective) // 仅供搜索，可在截止局使用启发式
trainingOutcome(finalState, player) // 仅供训练，返回 {value, valueMask}
actionKey(action)
encodeState(state, perspective)
encodeAction(state, action, perspective)
```

可选实现 `heuristicPolicy` 和 `heuristicValue`，用于模型早期训练和安全兜底。中国跳棋适配器位于 `games/chinese_checkers_adapter.js`。

模型使用动态动作头，不要求每个游戏拥有相同的固定动作空间，因此可复用于其他双人零和回合制棋类。模型文件带格式版本、维度、权重和训练元数据；候选模型应通过独立竞技场后再接入线上难度。

## 中国跳棋训练

```bash
npm run test:ai-engine
npm run train:checkers-robot -- --output models/checkers-candidate-generator.json --dataset-output models/checkers-training-next.jsonl
```

本地调试可加 `--summary-only` 只输出训练指标，避免在终端打印完整权重；正式训练用
`--output` 保存带格式版本和实验元数据的 checkpoint。

数值训练可切换到 Python/NumPy 小批量后端，接口与 JS 推理完全兼容，详见
[`PYTHON_TRAINING.md`](PYTHON_TRAINING.md)。`--run-output` 会另外生成训练实验室所需的
轻量指标与对局回放，不会把模型权重暴露到公开页面。

V1.1 训练顺序为 V0 教师模仿、整盘切分、阶段化价值标签、对手池联赛、回放缓冲训练和候选模型换边竞技场。默认不会修改游戏正在使用的 V0 模型；只有训练元数据标记为 `promoted` 的模型才可以进入线上接入评审。

训练器支持 `--init-model` 从兼容 checkpoint 暖启动；`valueMask=0` 的截止局只训练策略头，不参与真实 W/L 价值损失。部署一致的数据生成可组合 `--league-agent hybrid --skip-teacher-fit --skip-league-fit`。离线评测支持 `--safe-margin`，并要求至少 100 局、计分率、置信下界、完成率与平均手数全部过门槛后才标记 `promoted`。

V1.2 继续使用相同的通用接口，并在候选实际访问的局面上将 PUCT 访问策略与 V0 hard
教师策略混合（DAgger），减少只模仿固定教师轨迹造成的分布偏移。`--live-output` 会在
每一步原子替换一份紧凑快照，供仅限本机的训练实验室实时跟随；它不会暴露在玩家大厅。

V1.3 的中国跳棋适配器提供可选 `featureVersion: 2`：在原始孔位通道后追加双方目标营、
全局进度、唯一目标孔分配距离、轴线偏移和拖后棋子等对称结构特征，并给动作追加归一化
移动收益。该增强只属于游戏适配层，策略价值模型、回放缓冲区和训练器仍可复用于其他游戏。

V1.4 P0 把训练正确性升级为强制契约：搜索启发式与训练 outcome 使用不同 API；任何截止样本
均为 `value=0,valueMask=0`，且不会通过 L2 暗中更新价值头。历史 checkpoint 使用 SHA-256
校验并 fail-closed；训练 actor 固定为 hybrid，保存可复现动作的完整根决策 trace。确定性的
paired-opening 生成器负责精确换色镜像，`splitByGroup` 和 NumPy 后端都按 opening family
切分；竞技场在 game-level Wilson 之外增加 pair-cluster bootstrap 下界。

V1.4 P1 明确区分 `scratch` 与 `policy` 初始化。两组共享数据、网络尺寸、训练顺序和随机
种子；后者只复制 V1.3 的策略路径并重置价值头。NumPy 输出记录逐组件来源、源模型与数据集
hash，并用 hybrid `candidateMask` 训练部署一致的候选集合排序。

S1 提供可选 TT 实验路径：key 隔离 side-to-move、perspective 和 evaluator，entry 保存
depth、EXACT/LOWER/UPPER、best move 与 complete；预算截断节点不缓存。当前 depth-3
竞技场零命中，因此 `enableTranspositionTable` 默认为 false，线上 Worker 行为不变。

S2 的迭代加深/PV/内部模型排序与 S3 的 9/10 局部延伸均已按同一 paired-opening suite
评估后淘汰：前者从 S1 的 25–14–1 退化为 25–15–0，模型排序只增加调用而不改变走法；
后者同为 25–15–0 且出现扩展预算回退。depth-4 小样本也因平均 110.6 手和 87.5% 完成率
不合格。失败实现不进入仓库，避免把实验能力误当成已晋级引擎。

### V0 hard 线上机器人的升级（2026.08，与 S 系列结论不冲突）

S 系列结论只适用于“固定 depth-3 + 固定节点预算”的搜索形态；线上机器人的升级改变了
搜索形态本身。评估公式保持与旧版逐位一致（差分测试验证），强度提升全部来自搜索侧：

1. **决策时间预算替代固定节点数**：Worker 内 420ms 墙钟预算，按根候选均分、未用份额
   留给后续候选、超时立即中止整棵子树（不是逐节点截断——否则预算形同虚设）。
2. **终局自适应加深 + 置换表**：只在真正的终局（双方合计营外棋子 ≤ 8）加深到 5/7 层，
   中局保持 3 层；TT 只在加深路径启用（S1 的 depth-3 零命中结论不受影响）。加深阈值
   经竞技场修正：过早加深（≤12 即加深）会在时间预算下产生半截搜索噪声，反而不如
   稳定 depth-3；这与被否的“全局 depth-4”属于同一教训。
3. **威胁驱动阻挡**：对手一步可赢时，把“进入对手营地”的合法走法强制纳入根候选；
   不做静态阻挡偏好（阻挡是亏节奏战术，静态偏置在竞技场中验证会打成死锁）。

评估微调（跳链机动性、营外竞速分支、静态阻挡、营内挪动排序惩罚、真终局"距完成
步数下界"竞速项）与最短路求解器决策辅助（真终局无对手单人最优建议）均经 paired
竞技场拆解验证为净负收益并回退。两批种子合计 24 局 15-9（62.5%）为当前定稿，
评测口径见 `scripts/arena_vs_old.js` 与 `scripts/bench_checkers_robot.js`。
最短路求解器仍只用于训练后端，不接入线上落子——单人最优 ≠ 双人最优。

## 中国跳棋最短路后端

`games/chinese_checkers_shortest_path.js` 把标准双人通道表示为 81 孔状态，对每枚棋子生成
全部单步与可中途停止的连续跳跃终点。启发式使用唯一目标孔最小权匹配，不会把同一目标孔
分配给多枚棋子。该问题是“无对手单人搬运”，已知最优值为 27 步；它可用作双人引擎的离线教师，
但不能替代 minimax/PUCT 对对手反应的搜索。

```bash
npm run solve:checkers-shortest -- --max-nodes 5000 --time-limit-ms 3000
```

全量 10 子状态空间极大，日常开发应使用有界求解生成前沿建议，再用竞技场验证；只有报告中
`optimal: true` 的路径才具有最短性证明。
