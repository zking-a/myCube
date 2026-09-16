# 轻量游戏站 · 五款即开即玩的轻量游戏

一个 Node 服务同时承载五款游戏、静态页面与各自独立的实时联机房间：

| 能力 | 路径 |
|---|---|
| 游戏大厅 | `/`、`/index.html` |
| 24点（单机 / 联机） | `/24/`；邀请链接使用 `/24/#r=房间码` |
| 数独挑战（单机 / 好友协作） | `/sudoku/`；邀请链接使用 `/sudoku/?join=房间码` |
| 中国跳棋（人机 / 2–6 人本地 / 联机） | 大厅 `/checkers/`；棋局 `/checkers/play.html` |
| 五子棋（人机 / 联机） | 大厅 `/gomoku/`；棋局 `/gomoku/play.html`；邀请 `/gomoku/?r=房间码` |
| 飞行棋（2–4 人本地 / 联机） | 大厅 `/flight-chess/`；棋局 `/flight-chess/play.html` |
| 联机 WebSocket 中转 | 24点 `/ws`；跳棋 `/checkers-ws`；数独 `/sudoku-ws`；飞行棋 `/flight-chess-ws`；五子棋 `/gomoku-ws` |
| 健康检查 | `/health` |

部署后得到一个永久免费域名 `https://xxx.onrender.com`，前端与中转**同域**，打开即玩，联机**零配置**（不用填服务器地址）。

---

## 一、一键部署到 Render（免费，无需信用卡）

### 方法 A：Blueprint（推荐，最省事）

1. 把整个 `server/` 目录的内容作为一个 **Git 仓库**推到 GitHub（仓库根 = `server.js`、`package.json`、`render.yaml`、`public/`）。
2. 打开 https://render.com → 用 GitHub 登录 → **New → Blueprint** → 连接你刚建的仓库。
3. Render 自动读取 `render.yaml`，按 **Free** 层建好 Web Service（Build `npm install && npm run version:assets`、Start `node server.js`、健康检查 `/health`）。构建阶段会按 JS/CSS 内容自动刷新资源版本，确保长期缓存安全失效。
4. 等 1–2 分钟部署变绿，拿到地址 `https://xxx.onrender.com`。

### 方法 B：手动 Web Service

1. Render → **New → Web Service** → 连接仓库。
2. 若仓库根就是 server 内容：Root Directory 留空；若 server 是子目录：填 `server`。
3. Build Command：`npm install && npm run version:assets`；Start Command：`node server.js`；Plan：**Free**。
4. 点部署，等变绿。

---

## 二、部署后怎么玩

1. 打开 `https://xxx.onrender.com`，在游戏大厅选择「24点大挑战」「数独挑战」「中国跳棋」「五子棋」或「飞行棋」。
2. 24点联机：房主点「联机对战」→「创建房间」→「分享邀请」；朋友打开链接即可加入，不会被游戏大厅拦截。
3. 客人点「我准备好了」，房主看到全员准备后同步开局。
4. 双方实时看到对手进度；短暂掉线会自动重连并恢复当前轮次、题号和计时，答完自动排名。
5. 数独先进入独立挑战大厅，可继续存档或选择五档难度开局；游戏页支持手机沉浸全屏、大字号棋盘、候选笔记、提示、整盘撤销、自动存档、统计和深色模式。
6. 跳棋先在独立大厅选择人机、本地或联机模式，再进入专用棋局页；联机会同步上一步的起点、完整跳跃路线和落点。
7. 五子棋在大厅选择三档单机人机或好友对战；好友对战创建房间后，把房间码或邀请链接发给朋友，两人到齐自动开局，黑先白后，五子连珠由服务端判定胜负，断线可带着原身份续局。
8. 飞行棋支持 2–4 人本地轮流或好友联机；联机骰点、回合、连跳、撞机与胜负均由服务端统一判定。

**不需要填服务器地址**：游戏检测到是网页（非本地文件）时，会自动把「当前域名」当作中转服务器（同域 `/ws`、`/gomoku-ws` 等），零配置直接联机。

---

## 三、本地运行（可选，验证用）

```bash
cd myCube
npm install
node server.js
# 打开 http://localhost:3000
```

---

## 四、注意事项

- **Render 免费层可能休眠**：下次访问会经历冷启动。房间页会明确显示「连接中」，服务恢复后自动加入，不会悄悄退成假联机。
- **房间状态存内存**：默认适合两个双人房间。重启/休眠会清空房间，但对局通常几分钟内结束，无影响。
- **服务端校验成绩**：房间码仍是确定性题目种子；客户端逐题提交运算表达式，服务端验证是否正确，并自行累计用时、正确、错误、跳过和罚时。
- **身份与重连**：服务端为每个座位签发私密重连令牌，令牌只发给本人、不向房间广播；有效令牌可立即替换移动网络留下的旧半开连接。
- **容量可调**：默认最多 2 个房间、每房 2 人、全服 4 个玩家席位；底层允许 8 条 Socket，为握手和重连留余量。同一 IP 默认最多创建 1 个房间、占用 2 个玩家席位和 4 条 Socket。分别通过 `MAX_ROOMS`、`MAX_ROOMS_PER_IP`、`MAX_PLAYERS_PER_ROOM`、`MAX_CONNECTIONS`、`MAX_SOCKET_CONNECTIONS`、`MAX_CONNECTIONS_PER_IP`、`MAX_SOCKET_CONNECTIONS_PER_IP` 调整。
- **可信代理**：本地默认不信任任何转发 IP 头；Render Blueprint 显式设置 `TRUST_PROXY_HOPS=1`。部署到其他代理层时，应按实际代理跳数配置，切勿直接信任客户端提供的 `CF-Connecting-IP`。
- **自动释放**：只有一名玩家的未匹配房间默认在创建 2 分钟后强制释放，心跳或无效消息不能续期；其他等待大厅默认 5 分钟无操作后关闭，进行中或结算房间默认 15 分钟无操作后关闭。可通过 `UNMATCHED_ROOM_TTL_MS`、`LOBBY_IDLE_MS`、`ONLINE_ROOM_IDLE_MS` 修改。
- **跨域中转**：CSP 默认只允许当前站点的 WebSocket。确需自定义中转时，用 `ALLOWED_CONNECT_SRC=wss://relay.example.com` 显式放行；中转服务同时应设置 `ALLOWED_ORIGIN=https://game.example.com`。

---

## 五、本地验证

```bash
npm test
npm run test:sudoku
npm run test:checkers
npm run test:checkers:e2e
npm run test:flight-chess
npm run test:flight-chess:e2e
npm run test:gomoku
npm run test:gomoku:e2e
npm run test:gomoku:ui
npm run test:all
npm run test:security
```

这些测试分别检查网络协议、数独核心规则、跳棋与飞行棋的规则和联机同步、五子棋规则与联机（含前端端到端），以及 Origin、伪造代理 IP、重连容量和 gzip/ETag 缓存。

### 重新训练跳棋困难电脑

困难难度会将受预算保护的 DFS/alpha-beta 搜索与一个浏览器内价值网络混合，并在独立 Web Worker 中计算以避免阻塞棋盘交互。未通过跨种子竞技场门槛的 hard+ 与 A* 对抗代理已经从产品和评测入口移除。仓库中的轻量模型由固定随机种子完成 96 局本地自我对弈生成，不依赖 Python 或 GPU。重新训练时运行：

```bash
npm run train:checkers-ai
```

训练器会输出每代误差、自我对弈统计、与无模型基线的固定时长竞赛、困难搜索的完整对局速度，以及 `MODEL_JSON_START` 到 `MODEL_JSON_END` 之间的可部署权重。训练参数可以用 `--seed`、`--generations`、`--games`、`--max-moves`、`--benchmark-games` 和 `--speed-games` 调整。生成模型应同时通过胜率与平均手数门槛，再更新 `public/checkers/checkers_ai_model.js`。

#### 困难机器人的强度升级（2026.08 在线版）

搜索预算与形态的升级（评估公式与旧版保持逐位一致，经差分测试验证；竞技场拆解表明
评估微调与过早加深均为负收益，已回退）：

1. **决策时间预算替代固定节点数**：困难搜索从固定 3600 节点改为 Worker 内 420ms
   墙钟预算——按根候选均分、未用份额留给后续候选、超时立即中止整棵子树。旧版在
   尖锐局面下经常连 depth-3 都搜不完。
2. **终局自适应加深 + 置换表**：只在真正的终局（双方合计营外棋子 ≤ 8）加深到
   5/7 层，让搜索看到更远的强制获胜序列；中局保持 depth-3。加深阈值经过竞技场
   修正——过早加深会在时间预算下产生半截搜索噪声。
3. **威胁驱动阻挡**：对手一步可赢时，把"进入对手营地"的合法走法强制纳入根候选，
   让机器人能在对手最后一子入营前找到唯一的拖延手段；不做静态阻挡偏好（阻挡是
   亏节奏战术，竞技场验证静态偏置会打成死锁）。

竞技场验证（paired 换色、固定种子，旧版 = git HEAD 的线上机器人）：两批种子合计
**24 局 15-9（62.5% 胜率）**，无死锁局，平均手数与旧版相当（98 vs 95-100 手）。

已实证为净负收益并回退的改动（评估公式始终与旧版逐位一致）：跳链机动性项、营外
竞速分支（≤12 阈值过早）、静态阻挡偏好（打成死锁）、营内挪动排序惩罚（-40 会砍掉
"腾出营地空孔让营外棋子跳入"的关键战术，同种子 0-7）、真终局"距完成步数下界"
竞速项（同种子 7-9）、真终局最短路求解器决策辅助（单人最优 ≠ 双人最优，对手会
干扰路径中段，同种子 6-10）。评测口径见 `scripts/arena_vs_old.js` 与
`scripts/bench_checkers_robot.js`。

### 策略价值机器人与训练实验室

新引擎把游戏规则与数值训练分离：Node.js 游戏适配器生成标准
`state + dynamic actions + policy + value` 样本，Python/NumPy 使用向量化小批量训练，
再导出与 JS 推理端兼容的 `dynamic-policy-value-v1` checkpoint。候选模型必须通过独立
换边竞技场，不会因为离线 loss 下降就自动替换线上 V0。

```bash
npm run test:ai-engine
npm run train:checkers-robot -- --output models/checkers-candidate-generator.json --dataset-output models/checkers-training-next.jsonl --run-output public/checkers/training/latest.json --summary-only
npm run train:checkers-robot:scratch -- --dataset models/checkers-training-next.jsonl --output models/checkers-v1_4-scratch.json
npm run train:checkers-robot:policy-warm -- --dataset models/checkers-training-next.jsonl --output models/checkers-v1_4-policy-warm.json
npm run eval:checkers-robot -- --model models/checkers-candidate.json --agent hybrid --run-output public/checkers/training/latest.json
```

启动服务后直接打开开发地址 `/checkers/lab.html`。训练器通过本机专用接口逐手写入
当前对局，实验室每 0.8 秒自动跟随最新落子，同时保留已结束的教师、联赛与竞技场
对局。玩家大厅不会展示该入口；非本机请求默认也不能读取训练状态。

V1.2 在 V1.1 的整盘切分、阶段价值标签、对手池和整局回放缓冲区之上加入 DAgger
教师重标注，并使用 V1.1 checkpoint、当前候选、V0 normal/hard 组成跨代对手池。
最终 NumPy checkpoint 可通过 `--hidden-size` 与 `--action-hidden-size` 扩大网络容量，
仍需通过独立换边竞技场后才允许进入线上接入评审。

V1.3 进一步把目标营占位、唯一目标孔分配距离、整体进度、轴线偏移和拖后棋子等
结构特征加入适配器，并支持“稳定 V0 DFS + 新模型根节点重排”的混合代理。当前正式
16 局结果为 9 胜 6 负 1 截止、平均 100.8 手：已经对战领先，但因并非全部完成而仍
保留为实验 checkpoint，不会自动替换线上困难电脑。

V1.4 的第一阶段只修复训练契约，不扩大网络：所有数据生成器统一通过显式
`trainingOutcome` 写入真实 W/L 与 `valueMask`；历史 V1.3 checkpoint 缺失或 SHA 不符时
立即失败；联赛和竞技场强制使用 deployment-aligned hybrid。每步样本保存 DFS、模型信号、
最终组合分数与选择索引，并使用确定性的换色开局族按 `openingFamilyId` 划分训练/验证。
独立竞技场也使用 paired openings 与 pair-cluster bootstrap，仍不会自动晋级线上模型。

V1.4 P1 的初始化消融使用同一份带 SHA-256 的冻结数据集和相同随机种子。`scratch` 组仅从
V1.3 读取 128/32 网络尺寸，所有参数随机初始化；`policy-warm` 组只复制共享状态塔、动作塔
和策略头，价值头按与 scratch 完全相同的种子重置，Adam 动量也统一清零。checkpoint 会逐项
记录组件来源，验证报告只在完成局上计算价值 MAE、Brier 分数和开/中/残局校准。

第一代正式数据固定为 320 局：48 局 V0 hard 锚定、160 局冻结 V1.3 hybrid 对 V0 hard、
80 局冻结 V1.3 hybrid 镜像自对弈、32 局 safe-margin 内 top-2 受控探索。采样期间 actor
权重不可更新；NumPy 每局从开/中/残局等量抽样，避免长局在梯度中天然获得更高权重。

MTG 头只作为 completed-only 诊断指标训练，默认不参与选步。开发消融中 40 分强度安全带
虽消除了截止局，却把同套 40 局胜率从 63.75% 降到 47.5%，因此严格按停止条件关闭；只有
离线研究显式传入 `--enable-mtg` 才会启用该 tie-break，不影响当前候选默认行为。

S1 transposition table 同样默认关闭。它使用局面、行动方、评估视角和 evaluator 版本组成
完整 key，并禁止预算截断结果写为 `EXACT`。同套 40 局中 TT on/off 逐局一致，都是
25–14–1；但 depth-3 的 543,140 次 probe 为零命中，节点数不变、耗时略增，因此当前浅层
搜索没有可利用的转置收益。

后续 S2/S3 已完成离线消融但未保留失败实现：TT＋迭代加深/PV 的 40 局结果为 25–15–0，
把 S1 唯一平局变成败局；加入内部模型排序后逐局完全相同，只增加 37,234 次模型调用。
全局 depth-4 在 8 局中为 5–2–1，但平均 110.6 手、完成率 87.5%；受限 9/10 战术延伸在
40 局中仍为 25–15–0，并发生 2 次扩展预算回退。三项均未满足胜率、步数与成本门禁，相关
实验开关和测试已从提交内容移除，线上 Worker 与当前最强候选保持 S1 默认行为。

最短路后端把标准双人跳棋投影为 81 孔单人搬运问题，复用完整连续跳跃后继生成，
并使用“目标营外棋子数 + 唯一目标孔最小权匹配”的可采纳下界执行受预算保护的双向 A*。
27 步是无对手单人搬运的已知最优值，不代表双人对抗局应在 27 个总回合内结束。

```bash
npm run solve:checkers-shortest -- --max-nodes 5000 --time-limit-ms 3000 --output models/checkers-shortest-path.json
```

预算内未找到完整路径时，报告会明确返回 `optimal: false` 和前沿建议，不会将有界搜索冒充为
27 步最优性证明。当前它只输出训练后端建议，不接管玩家对抗落子；以后若重新接入，仍须先通过独立跨种子竞技场。

需要验证完整双人流程时，先启动服务，再在另一个终端运行：

```bash
npm run test:e2e
```

端到端测试覆盖双人加入、私密重连令牌、座位防冒用、同步开局、表达式证明、服务端权威成绩、半开连接替换、结算和下一局回大厅。

---

## 六、目录结构

```
server/
├── server.js          # 一体化服务：静态托管 public/ + WebSocket 中转 + /health
├── server_questions.js # 服务端确定性出题与运算证明校验
├── package.json       # 依赖、启动与测试脚本
├── render.yaml        # Render Blueprint 一键部署配置
├── public/            # 小游戏平台前端
│   ├── index.html     # 纯游戏大厅
│   ├── platform.css
│   ├── platform.js    # 兼容旧首页邀请链接
│   ├── 24/            # 24点独立页面、题库、联机与玩法逻辑
│   │   ├── index.html
│   │   ├── core.js
│   │   ├── data.js
│   │   ├── net.js
│   │   └── game.js
│   ├── sudoku/        # 数独独立页面、样式与玩法逻辑
│   │   ├── index.html
│   │   ├── sudoku.css
│   │   └── sudoku.js
│   ├── checkers/      # 中国跳棋大厅、棋局、规则核心与训练实验室
│   ├── gomoku/        # 五子棋大厅、本地/人机/联机棋局、规则核心与联机客户端
│   │   ├── index.html
│   │   ├── play.html
│   │   ├── gomoku_core.js   # 15×15 规则核心（服务端与浏览器共用）
│   │   ├── gomoku_net.js    # 联机客户端（重连身份与消息收发）
│   │   ├── gomoku-index.js
│   │   ├── gomoku.js
│   │   └── gomoku.css
│   └── flight-chess/  # 2–4 人飞行棋大厅、本地/联机棋局与可复用规则核心
│       ├── index.html
│       ├── play.html
│       ├── flight_chess_core.js
│       ├── flight_chess_net.js
│       ├── lobby.js
│       ├── game.js
│       └── flight_chess.css
├── tests/                         # 自动化测试
│   ├── test_local.js      # 24点联机协议单元测试
│   ├── test_sudoku.js     # 数独核心规则回归测试
│   ├── test_sudoku_online.js # 数独联机协议测试
│   ├── test_net.js        # 网络层与房间协议回归测试
│   ├── test_checkers.js   # 中国跳棋规则、AI 与页面契约测试
│   ├── test_ai_engine.js  # 可复用 AI 引擎与训练管线测试
│   ├── test_flight_chess.js # 飞行棋规则与页面契约测试
│   ├── test_gomoku.js     # 五子棋规则、AI 与本地存档测试
│   ├── test_gomoku_online.js    # 五子棋联机协议集成测试（建房/落子/胜负/重连）
│   ├── test_gomoku_online_ui.js # 五子棋联机前端端到端测试（DOM 桩驱动真实页面脚本）
│   ├── test_checkers_online.js # 中国跳棋联机与大厅协议测试
│   ├── test_flight_chess_online.js # 飞行棋联机与重连流程测试
│   └── test_security.js   # 代理 IP、Origin、连接余量与静态缓存回归
```
