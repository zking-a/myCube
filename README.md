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
- **房间状态存内存**：默认适合两个双人房间。重启/休眠会清空房间，但对局通常几分钟内结束，无影响。
- **服务端校验成绩**：房间码仍是确定性题目种子；客户端逐题提交运算表达式，服务端验证是否正确，并自行累计用时、正确、错误、跳过和罚时。
- **身份与重连**：服务端为每个座位签发私密重连令牌，令牌只发给本人、不向房间广播；有效令牌可立即替换移动网络留下的旧半开连接。
- **容量可调**：默认最多 2 个房间、每房 2 人、全服 4 个玩家席位；底层允许 8 条 Socket，为握手和重连留余量。同一 IP 默认最多 2 个玩家席位、4 条 Socket。分别通过 `MAX_ROOMS`、`MAX_PLAYERS_PER_ROOM`、`MAX_CONNECTIONS`、`MAX_SOCKET_CONNECTIONS`、`MAX_CONNECTIONS_PER_IP`、`MAX_SOCKET_CONNECTIONS_PER_IP` 调整。
- **可信代理**：本地默认不信任任何转发 IP 头；Render Blueprint 显式设置 `TRUST_PROXY_HOPS=1`。部署到其他代理层时，应按实际代理跳数配置，切勿直接信任客户端提供的 `CF-Connecting-IP`。
- **自动释放**：等待大厅默认 5 分钟无操作后关闭，进行中或结算房间默认 15 分钟无操作后关闭；可通过 `LOBBY_IDLE_MS`、`ONLINE_ROOM_IDLE_MS` 修改。
- **跨域中转**：CSP 默认只允许当前站点的 WebSocket。确需自定义中转时，用 `ALLOWED_CONNECT_SRC=wss://relay.example.com` 显式放行；中转服务同时应设置 `ALLOWED_ORIGIN=https://game.example.com`。

---

## 五、本地验证

```bash
npm test
npm run test:sudoku
npm run test:security
```

三项分别检查网络协议、数独核心规则，以及 Origin、伪造代理 IP、重连容量和 gzip/ETag 缓存。

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
│   └── sudoku/        # 数独独立页面、样式与玩法逻辑
│       ├── index.html
│       ├── sudoku.css
│       └── sudoku.js
├── test_local.js      # 24点联机协议单元测试
├── test_e2e.js        # 24点双人联机端到端测试
├── test_sudoku.js     # 数独核心规则回归测试
└── test_security.js   # 代理 IP、Origin、连接余量与静态缓存回归
```
