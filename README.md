# 24点大挑战 · 联机部署（一体化，Render 免费）

一个 Node 服务同时承载三件事：

| 能力 | 路径 |
|---|---|
| 游戏前端（静态页面） | `/`、`/index.html`、`/game.js` 等 |
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

1. 打开 `https://xxx.onrender.com` —— 直接进入游戏。
2. 联机：房主点「▶ 联机对战」→「创建房间」，把 5 位房间码（或邀请链接）发给朋友；朋友「加入房间」。
3. 双方实时看到对手进度条，答完自动排名。

**不需要填服务器地址**：游戏检测到是网页（非本地文件）时，会自动把「当前域名」当作中转服务器（同域 `/ws`），零配置直接联机。

---

## 三、本地运行（可选，验证用）

```bash
cd server
npm install
node server.js
# 打开 http://localhost:3000
```

---

## 四、注意事项

- **Render 免费层会休眠**：15 分钟无流量后服务进入休眠，下次访问有约几秒冷启动。游戏前端自带断线重连，不影响对战；朋友偶尔玩完全够用。
- **房间状态存内存**：适合 2–4 人小局。重启/休眠会清空房间，但对局通常几分钟内结束，无影响。
- **题目公平性不依赖服务器**：房间码即随机种子，双方题目天然一致，服务器只中转进度、不算题、不判答案。

---

## 五、目录结构

```
server/
├── server.js          # 一体化服务：静态托管 public/ + WebSocket 中转 + /health
├── package.json       # 依赖 ws（npm install 自动装）
├── render.yaml        # Render Blueprint 一键部署配置
├── public/            # 游戏前端（从 html/ 复制）
│   ├── index.html
│   ├── core.js
│   ├── data.js
│   ├── net.js
│   └── game.js
└── test_local.js      # 端到端自测脚本（7 项断言）
```
