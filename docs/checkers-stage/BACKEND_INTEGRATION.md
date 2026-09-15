# 联机后端接入边界

原 ZIP 没有 `/checkers-ws`、`/ai-lab/run`、`/ai-lab/live` 服务端。本包没有假造可用在线房间，也没有更改服务端身份/房间权威状态。

客户端本地 AI 已统一接入新引擎。服务端复用时：

```js
const Core = require('./checkers/checkers_core.js');
const AI = require('./checkers/checkers_ai_engine.js');
const model = require('./checkers/checkers_ai_model_v3.js');
const result = AI.chooseMove(authoritativeState.pieces, authoritativeState.turn, {
  seats: authoritativeSeats.map(s => s.color), // 必须是实际顺时针回合顺序
  level: 'hard',
  model,
  recentPositions, // 棋盘键 + '|' + 行动者，来自权威历史
});
if (result.move) {
  const checked = Core.applyMove(authoritativeState.pieces, authoritativeState.turn,
    result.move.from, result.move.target);
  // 检查房间版本仍与搜索快照一致，然后才提交权威状态。
}
```

以上是调用示意，不是可部署的 WebSocket 服务。服务器应放进 worker_threads / 独立计算进程，避免同步搜索阻塞整个 WebSocket 事件循环；搜索返回后仍需校验房间版本、回合及动作。用户身份鉴权、座位权限、消息限流与重连由原后端负责，不能由浏览器替代。

本地 `start_local.py` 仅提供静态文件，不接受联机或训练 API 请求。
