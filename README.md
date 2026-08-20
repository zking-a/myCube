# 轻量游戏站 · 24点 + 数独

一个 Node 服务同时承载三件事：

| 能力 | 路径 |
|---|---|
| 游戏大厅 | `/`、`/index.html` |
| 24点（单机 / 联机） | `/24/`；邀请链接使用 `/24/#r=房间码` |
| 数独挑战 | `/sudoku/` |
| 联机 WebSocket 中转 | `/ws` |
| 健康检查 | `/health` |

部署后得到一个永久免费域名 `https://xxx.onrender.com`，前端与中转**同域**，打开即玩，联机**零配置**（不用填服务器地址）。

---

## 一、一键部署到 Render（免费，无需信用卡）

### 方法 A：Blueprint（推荐，最省事）

1. 把整个 `server/` 目录的内容作为一个 **Git 仓库**推到 GitHub（仓库根 = `server.js`、`package.json`、`render.yaml`、`public/`）。
2. 打开 https://render.com → 用 GitHub 登录 → **New → Blueprint** → 连接你刚建的仓库。
3. Render 自动读取 `render.yaml`，按 **Free** 层建好 Web Service（Build `npm install`、Start `node server.js`、健康检查 `/health`）。
4. 等 1–2 分钟部署变绿，拿到地址 `https://xxx.onrender.com`。

### 方法 B：手动 Web Service

1. Render → **New → Web Service** → 连接仓库。
2. 若仓库根就是 server 内容：Root Directory 留空；若 server 是子目录：填 `server`。
3. Build Command：`npm install`；Start Command：`node server.js`；Plan：**Free**。
4. 点部署，等变绿。

---

## 二、部署后怎么玩

1. 打开 `https://xxx.onrender.com`，在游戏大厅选择「24点大挑战」或「数独挑战」。
2. 24点联机：房主点「联机对战」→「创建房间」→「分享邀请」；朋友打开链接即可加入，不会被游戏大厅拦截。
3. 客人点「我准备好了」，房主看到全员准备后同步开局。
4. 双方实时看到对手进度；短暂掉线会自动重连并恢复当前轮次、题号和计时，答完自动排名。
5. 数独支持五档难度、候选笔记、提示、撤销、自动存档、统计和深色模式。

**不需要填服务器地址**：游戏检测到是网页（非本地文件）时，会自动把「当前域名」当作中转服务器（同域 `/ws`），零配置直接联机。

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
- **房间状态存内存**：适合 2–4 人小局。重启/休眠会清空房间，但对局通常几分钟内结束，无影响。
- **题目公平性不依赖服务器**：房间码即随机种子，双方题目天然一致，服务器只中转进度、不算题、不判答案。
- **容量可调**：默认最多 2 个房间、4 个 WebSocket 连接、同一 IP 最多 2 条连接；可用 `MAX_ROOMS`、`MAX_CONNECTIONS`、`MAX_CONNECTIONS_PER_IP`、`MAX_PLAYERS_PER_ROOM` 环境变量调整。
- **自动释放**：等待大厅默认 5 分钟无操作后关闭，进行中或结算房间默认 15 分钟无操作后关闭；可通过 `LOBBY_IDLE_MS`、`ONLINE_ROOM_IDLE_MS` 修改。
- **跨域中转**：CSP 默认只允许当前站点的 WebSocket。确需自定义中转时，用 `ALLOWED_CONNECT_SRC=wss://relay.example.com` 显式放行；中转服务同时应设置 `ALLOWED_ORIGIN=https://game.example.com`。

---

## 五、本地验证

```bash
npm test
npm run test:sudoku
```

第一项检查默认同域联机、建/加房意图、服务器时钟换算、准备协议和主动离房；第二项检查数独终盘规则、随机性、唯一解、难度、计时和撤销。

需要验证完整双人流程时，先启动服务，再在另一个终端运行：

```bash
npm run test:e2e
```

端到端测试覆盖双人加入、准备、同步开局、实时进度、掉线续局、结算和下一局回大厅。

---

## 六、目录结构

```
server/
├── server.js          # 一体化服务：静态托管 public/ + WebSocket 中转 + /health
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
│   └── sudoku/        # 数独独立页面、样式与玩法逻辑
│       ├── index.html
│       ├── sudoku.css
│       └── sudoku.js
├── test_local.js      # 24点联机协议单元测试
├── test_e2e.js        # 24点双人联机端到端测试
└── test_sudoku.js     # 数独核心规则回归测试
```
