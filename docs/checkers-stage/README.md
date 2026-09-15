# 2026-09-15 跳棋分阶段 AI 合并记录

来源：用户提供的 `public/chinese_checkers_stage_ai_20260915.zip` 和 `public/checkers_delivery_notes.md`。解压内容逐项通过包内 SHA256SUMS 校验。此目录下 DESIGN、MODEL_CARD、BACKEND_INTEGRATION 及 JSON 报告是交付方资料；以下是本仓库实际接入情况。

## 已接入

- 分阶段引擎、六色方向评价、预计算棋盘邻接关系、多色浏览器 Worker、冻结实验模型。
- 本地 2–6 人及最多 5 个电脑；开新局与继续上局分开，v2 存档读取后迁移至按配置区分的 v3 存档。
- 六色玩家栏、动画输入锁、动画取消、空闲 Worker 复用和 3 秒异常回退。
- 保留现有 DOM/SVG 棋盘、球面与落点点击热区、路线跳跃动画、重开颜色更新和公共 ui-foundation.css。
- 现有 `/checkers-ws` 的机器人改用 `scripts/checkers_bot_worker.js`，独立线程运行新引擎；房间/棋盘/回合过期时丢弃结果，退出和重开取消计算。修复无合法走法席位的轮转检查。

## 接入边界

- 不采用独立包的 Python 启动器、简化公共样式和“缺少训练后端”的实验室覆盖文件。原站点联机、训练后端及其他游戏继续保留。
- 默认使用纯分阶段搜索。交付模型随代码保留，默认策略与价值头均不启用；未重新训练，也未重新跑交付报告中的数百盘对赛，不能据此新增棋力结论。
- 完整训练数据、训练工具、基线及原始棋谱仍保存在原 ZIP 中；运行游戏不需要解压或部署这些实验产物。数值一致性测试所需小型模型及 fixture 已放入 tests/fixtures/checkers-stage。
- Core.chooseAiMove/analyzeAiMoves 已转向新引擎；旧 DFS 的 candidateNodeBudget、enableTranspositionTable 等参数不再具有旧实现语义。离线训练工具虽通过现有接口测试，重新训练时应重新建立实验基准，不能直接混用旧 DFS 的训练统计。
- 服务端及浏览器的搜索时间限制是软预算，超时 watchdog 才能中断线程。极端资源紧张时使用合法启发式走法回退。

## 本仓库验证

- `npm run test:all` 纳入原游戏回归、13 项新引擎测试和 3 项服务端线程/回合接入测试。
- `npm run test:checkers:e2e` 验证原联机身份、走法、同步及重连。
- 浏览器使用真实本地 HTTP 页面和真实 Worker 验证：六人面板、独立新局/续局、动画锁定、动画中撤销以及五电脑轮转与 Worker 复用。未将交付方 Blob Worker 测试冒充本站验证。

发布仍使用原 Node 服务。静态资源会保存在服务器内存，发布后需重启服务；新增 JS/Worker/模型文件必须一起发布。未执行部署或 Git 提交。
