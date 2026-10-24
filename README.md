# 五子棋 | Gomoku

一款基于原生 HTML、CSS 与 JavaScript 的 15×15 五子棋。玩家执黑先行，白方由 AI 控制。无需 CDN 或第三方运行时依赖。

A 15×15 Gomoku game built with native HTML, CSS, and JavaScript. The player takes Black and moves first; the AI plays White. No CDN or third-party runtime dependencies are required.

## 启动 | Run

需要 Python 3。进入项目目录并运行：

Python 3 is required. From the project directory, run:

```powershell
python -m http.server 8000
```

浏览器打开 <http://localhost:8000/>。建议通过本地 HTTP 启动，以启用 Web Worker 并行计算。仓库忽略 `start.bat`，因此克隆后请使用上面的命令。

Open <http://localhost:8000/> in a browser. Use the local HTTP server to enable Web Worker parallelism. `start.bat` is intentionally ignored, so use the command above after cloning.

## 对局操作 | Game Controls

- 黑方玩家先行，白方由 AI 控制。
- 点击棋盘交叉点落子；支持重新开始、悔棋、计时、步数统计和胜负提示。
- 可在“评估函数”与“蒙特卡洛树搜索”之间切换。

- The human plays Black and moves first; the AI plays White.
- Click an intersection to place a stone. Restart, undo, timer, move count, and win/draw feedback are supported.
- Choose between **Evaluation + Minimax** and **Monte Carlo Tree Search**.

## 评估函数与极大极小搜索 | Evaluation and Minimax

评估模式采用两阶段流程：先对棋盘上的**全部空位**并行评分，再对排名靠前的根着运行极大极小搜索。己方立即成五和必须阻挡对手成五的着法会优先处理。

Evaluation mode has two stages: score **every empty point** in parallel, then run minimax searches for the highest-ranked root moves. An immediate win or a move that blocks an opponent's immediate win is handled first.

### 棋形评分 | Pattern Scores

对一个候选点，程序分别试算己方与对手在该点落子后，横、竖及两条斜线上的连续棋形。基本分如下；每个方向的分数会累加：

For each candidate, the engine evaluates contiguous patterns for both players along horizontal, vertical, and diagonal lines. Scores below are added across directions:

| 棋形 / Pattern | 分值 / Score |
| --- | ---: |
| 连五及以上 / Five or more | 1,000,000,000 |
| 活四 / Open four | 100,000 |
| 双活四额外奖励 / Double-open-four bonus | +500,000 |
| 冲四 / One end blocked, four in a row | 10,000 |
| 活三 / Open three | 10,000 |
| 双活三额外奖励 / Double-open-three bonus | +30,000 |
| 眠三 / One end blocked, three in a row | 1,000 |
| 活二 / Open two | 1,000 |
| 眠二 / One end blocked, two in a row | 100 |

最终落点评分为：己方棋形分 + 对手棋形分 × 1.2 + 原版位置表分。位置表提高中心区域的优先级；双活三/双活四奖励在同一落点的多个方向形成相应棋形时触发。当前模式识别连续棋形，不会把 `XX_XX` 这类隔空棋形直接当作连续四子。

Final move score = own pattern score + opponent pattern score × 1.2 + the original positional-table score. The positional table favors central points. Double-threat bonuses apply when a move creates the corresponding patterns in multiple directions. The evaluator currently scores contiguous patterns; a gap such as `XX_XX` is not treated as a contiguous four.

### 极大极小与 Alpha-Beta | Minimax and Alpha-Beta

搜索深度按当前棋谱总步数设定，根着也计为一层：

Search depth is selected from the current total move count; the root move counts as one ply:

| 总步数 / Total moves | 搜索深度 / Search depth |
| ---: | ---: |
| ≤4 | 4 层 / plies |
| 5–20 | 8 层 / plies |
| >20 | 10 层 / plies |

白方节点最大化局面分，黑方节点最小化局面分。每层只考虑靠近已有棋子的候选点，并按棋形分排序后保留前 4 个，以限制分支数。到达叶节点时，用双方当前最佳候选威胁分之差评估局面。

White nodes maximize the position score; Black nodes minimize it. At each ply, only empty points near existing stones are considered, ordered by pattern score, and the top four are retained to limit branching. Leaf positions are evaluated by the difference between each side's strongest current candidate threat.

Alpha-Beta 维护当前路径上的上界 `alpha` 与下界 `beta`。当 `beta <= alpha` 时，剩余兄弟分支不可能改变已选结果，因此提前停止该分支搜索。根着先经过全盘评分筛选，再分配给最多 8 个 Worker；Worker 上限还会受设备可用并发数约束。

Alpha-Beta tracks the current path's lower bound (`alpha`) and upper bound (`beta`). When `beta <= alpha`, remaining sibling branches cannot change the decision, so that branch is pruned. Root moves are pre-ranked by full-board evaluation and distributed across up to eight Workers, subject to the device's available concurrency.

## 蒙特卡洛树搜索 | Monte Carlo Tree Search

MCTS 模式最多启动 8 个 Worker；每个 Worker 针对同一局面快照独立运行一棵树，每棵树执行 90 次迭代。主线程汇总各树的根着访问次数，优先选择访问次数最多的着法。

MCTS mode starts up to eight Workers. Each Worker builds an independent tree from the same position snapshot and runs 90 iterations. The main thread aggregates root-move visit counts and selects the most-visited move.

一次迭代依次进行：

Each iteration performs:

1. **选择 / Selection**：使用 UCT，在胜率利用与探索新分支之间权衡；当前走棋方会选择对自己有利的分支。
2. **扩展 / Expansion**：从附近候选点中加入一个尚未展开的着法。树节点候选最多 14 个。
3. **模拟 / Rollout**：最多模拟 20 手；发现立即获胜或必须阻挡的着法时优先采用，否则从高评分候选中随机选择。
4. **回传 / Backpropagation**：将胜负结果及访问次数沿路径回传。达到模拟步数上限时，以双方威胁分差估计结果。

MCTS 使用 UCT 树策略与启发式模拟，不是极大极小搜索，也不使用 Alpha-Beta 剪枝。若浏览器无法创建 Worker（例如直接通过 `file://` 打开），程序会回退到单线程决策；完整并行搜索请通过本地 HTTP 启动。

MCTS uses UCT and heuristic rollouts; it is not minimax and does not use Alpha-Beta pruning. If the browser cannot create Workers (for example, when opened via `file://`), the game falls back to single-threaded decision-making. Use the local HTTP server for full parallel search.

## 项目结构 | Project Structure

| 路径 / Path | 说明 / Description |
| --- | --- |
| `index.html` | 页面结构 / Page markup |
| `css/gomoku.css` | 响应式界面 / Responsive styles |
| `js/gomoku-app.js` | Canvas、对局控制与 Worker 调度 / Canvas, game control, and Worker orchestration |
| `js/gomoku-engine.js` | 规则、评分、Minimax 与 MCTS / Rules, scoring, minimax, and MCTS |
| `js/gomoku-worker.js` | 并行任务入口 / Parallel task entry point |
| `test/gomoku-engine.test.mjs` | 回归测试 / Regression tests |
| `.gitignore` | 忽略本机启动脚本 / Excludes the local launcher |

## 测试 | Tests

需要 Node.js 18 或更新版本。在项目目录运行：

Node.js 18 or later is required. From the project directory, run:

```powershell
node --test test/gomoku-engine.test.mjs
```