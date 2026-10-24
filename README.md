# 五子棋

一款基于原生 HTML、CSS 与 JavaScript 的 15×15 五子棋。玩家执黑先行，白方由 AI 控制。项目无 CDN 和第三方运行时依赖。

## 启动

需要 Python 3。进入项目目录后运行：

```powershell
python -m http.server 8000
```

然后在浏览器打开 <http://localhost:8000/>。通过本地 HTTP 访问才能可靠启用 Web Worker 并行计算。仓库忽略 `start.bat`，因此它只适合作为本机辅助脚本；克隆后请使用上面的命令启动。

## 对局与 AI

- 黑方玩家先行，白方为 AI。
- “评估函数”模式会并行评估棋盘上的空位，再用极大极小搜索选择落点；搜索深度按总步数设置为 4、8 或 10 层，并使用 Alpha-Beta 剪枝。
- “蒙特卡洛树搜索”模式会并行运行多棵搜索树，并汇总根节点访问统计。
- 两种模式都会优先处理立即获胜和必须防守的着法。Worker 数量最多为 8，并按设备可用并发数限制。
- 支持重新开始、悔棋、计时与胜负提示。

## 项目结构

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构 |
| `css/gomoku.css` | 响应式界面样式 |
| `js/gomoku-app.js` | Canvas 绘制、对局交互与 Worker 调度 |
| `js/gomoku-engine.js` | 棋盘规则、评估函数、极大极小搜索与 MCTS |
| `js/gomoku-worker.js` | 并行评分和搜索任务 |
| `test/gomoku-engine.test.mjs` | 规则与 AI 回归测试 |

## 测试

需要 Node.js 18 或更新版本。在项目目录运行：

```powershell
node --test test/gomoku-engine.test.mjs
```
