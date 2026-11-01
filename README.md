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

评估模式采用两阶段流程：先对棋盘上的**全部空位**并行评分，再对排名靠前的根着运行极大极小搜索。己方立即成五和必须阻挡对手成五的着法会优先处理；两者都不存在时，先尝试一次连续冲四（VCF）强制搜索，见下文。

Evaluation mode has two stages: score **every empty point** in parallel, then run minimax searches for the highest-ranked root moves. An immediate win or a move that blocks an opponent's immediate win is handled first; when neither exists, a continuous-four (VCF) search runs before the minimax stage.

### 棋形评分 | Pattern Scores

对一个候选点，程序分别试算己方与对手在该点落子后，横、竖及两条斜线上的连续棋形。基本分如下；每个方向的分数会累加：

For each candidate, the engine evaluates contiguous patterns for both players along horizontal, vertical, and diagonal lines. Scores below are added across directions:

| 棋形 / Pattern | 分值 / Score |
| --- | ---: |
| 连五及以上 / Five or more | 1,000,000,000 |
| 活四 / Open four | 100,000 |
| 双活四额外奖励 / Double-open-four bonus | +500,000 |
| 双四额外奖励（双冲四，或活四+冲四） / Double-four bonus | +400,000 |
| 四三额外奖励（冲四+活三） / Four-plus-open-three bonus | +300,000 |
| 冲四 / One end blocked, four in a row | 10,000 |
| 活三 / Open three | 10,000 |
| 双活三额外奖励 / Double-open-three bonus | +30,000 |
| 眠三 / One end blocked, three in a row | 1,000 |
| 活二 / Open two | 1,000 |
| 眠二 / One end blocked, two in a row | 100 |

最终落点评分为：己方棋形分 + 对手棋形分 × 1.2 + 原版位置表分。位置表提高中心区域的优先级；双活三/双活四/双四/四三奖励在同一落点的多个方向形成相应棋形时触发（双四与四三都是必胜形，因此排在单个活四之上）。当前模式识别连续棋形，不会把 `XX_XX` 这类隔空棋形直接当作连续四子。

Final move score = own pattern score + opponent pattern score × 1.2 + the original positional-table score. The positional table favors central points. Double-threat bonuses apply when a move creates the corresponding patterns in multiple directions; a double four and a four-plus-open-three are forced wins, so both rank above a lone open four. The evaluator currently scores contiguous patterns; a gap such as `XX_XX` is not treated as a contiguous four.

### 极大极小与 Alpha-Beta | Minimax and Alpha-Beta

搜索深度按当前棋谱总步数设定，根着也计为一层：

Search depth is selected from the current total move count; the root move counts as one ply:

| 总步数 / Total moves | 搜索深度 / Search depth |
| ---: | ---: |
| ≤20 | 8 层 / plies |
| >20 | 10 层 / plies |

开局曾经只搜 4 层，比"放任对手做出活三就会输"正好少一层：白方会在前几手先做自己的形，等对手成三之后整局都在挨打。现在开局同样是 8 层，代价是前几手每步多几百毫秒。此外分数完全相同的根着会随机挑一个，否则同一开局每次都会重演同一盘棋，一条输棋线路会反复出现。

The opening used to get only four plies, exactly one short of seeing that letting the opponent build an open three loses; White would develop its own shape for a few moves and then spend the rest of the game answering threats. It now gets the same eight plies, at a cost of a few hundred milliseconds per early move. Root moves with identical scores are also picked at random, because otherwise every game replays the same line and a single losing line repeats forever.

白方节点最大化局面分，黑方节点最小化局面分。每层只考虑靠近已有棋子的候选点。候选生成是威胁优先的：能让己方成五的着点只搜索它自己，对手的成五点只搜索挡点；能形成「四」级威胁的着点（活四、双四、四三，以及对手在这些点上的同类威胁）无论评分排名第几都一定进入候选，其余候选按棋形分排序补足到前 4 个，因此分支数通常仍是 4，最多 6。叶节点用「己方最强棋形分 − 1.1 × 对手最强棋形分」评估，两侧分别只按自己的棋形计算，互不掺入；结果被夹在 ±`WIN_SCORE / 2` 之内，保证任何静态局面都不会超过真实的连五分。

只要叶节点的评估绝对值达到「冲四」量级（10,000，即棋盘上已经出现三级以上棋形），就进入**静止搜索**：先处理成五威胁——轮走方能成五直接判胜，对手只有一个成五点就必须挡掉（最多延伸 4 手），有两个成五点则判负；没有成五威胁时再看「四」这一层，只在对手的造四点、以及自己的造四点里各挑一到两个，各补一手后静态评估取最优。四这一层只做一层：递归版本实测要贵约 8 倍，而在没有时间预算的前提下付不起。

没有这层时，被夹到边界的叶子全都等于同一个 −`WIN_SCORE / 2`，搜索在视界边缘分不出"必败"和"还挡得住"，只能按着法顺序瞎选。

A leaf whose score reaches the four level (10,000, i.e. a three or better already exists) runs a **quiescence search**. Five threats come first: a side to move that can complete a five wins, a single opponent five point must be blocked (up to four extra plies), and two opponent five points are a loss. With no five threat left, one four layer follows: the opponent's four-making points and the engine's own are each tried (one or two of them) with a single static ply. The four layer is deliberately one ply deep — the recursive version measured about eight times slower, which is unaffordable without a time budget.

Without this layer every clamped leaf equals the same −`WIN_SCORE / 2`, and the search cannot tell "lost" from "still defendable" at the horizon, so it picks by move order.

Alpha-Beta 维护当前路径上的上界 `alpha` 与下界 `beta`。当 `beta <= alpha` 时，剩余兄弟分支不可能改变已选结果，因此提前停止该分支搜索。根着先经过全盘评分筛选，再分配给最多 8 个 Worker；Worker 上限还会受设备可用并发数约束。

Alpha-Beta tracks the current path's lower bound (`alpha`) and upper bound (`beta`). When `beta <= alpha`, remaining sibling branches cannot change the decision, so that branch is pruned. Root moves are pre-ranked by full-board evaluation and distributed across up to eight Workers, subject to the device's available concurrency.

### 连续冲四搜索（VCF）| Continuous Fours (VCF)

极大极小最多看 10 层，而连续冲四的胜负手经常在 10 层以外。VCF 只走能形成「四」的着法，对手每一步都只有一个合法应手，所以整条线全程都是逼着，可以在很窄的分支下看到十几次冲四之后。找到即证明，不是估计。单次搜索约 1 ms。

- **进攻**：轮到 AI 时先跑己方 VCF，找到就按线路第一手下，不再进入极大极小。
- **防守**：每个根着在进入搜索前，先检查这手棋下完之后对手是否仍有 VCF 必胜线；有的话该根着直接判负（按线路长度折算延迟），避免把一手必败的棋排在前面。
- **正确性**：己方落子后若对手仍能直接成五，这手棋不成线（对手会先一步取胜）；对手的被迫应手也不能构成他自己的连五或新连五威胁，否则这条线作废；双四/活四（两个成五点）直接判胜。找不到只代表没找到，不代表一定没有。

Minimax only reaches ten plies, while forcing sequences often decide the game beyond that. VCF plays only moves that create a four, so the opponent has a single legal reply at every step and the line stays forcing; narrow branching makes a dozen consecutive fours reachable. A hit is a proof, not an estimate, and one search costs about a millisecond.

- **Attack**: on the AI's turn White's own VCF runs first; a hit is played immediately without minimax.
- **Defense**: before searching, each root move is checked for whether the opponent still has a VCF win afterwards. If so the root move is scored as a loss (delayed by the line length), so a dead move is not ranked first.
- **Correctness**: a move is not forcing if the opponent can still complete a five afterwards (he would strike first), and the forced reply must neither complete a five for him nor create a new five threat; two five points (open four or double four) are an instant win. A miss only means nothing was found, not that nothing exists.

## 蒙特卡洛树搜索 | Monte Carlo Tree Search

MCTS 模式最多启动 8 个 Worker；每个 Worker 针对同一局面快照独立运行一棵树，每棵树执行 90 次迭代。主线程汇总各树的根着访问次数，优先选择访问次数最多的着法。

MCTS mode starts up to eight Workers. Each Worker builds an independent tree from the same position snapshot and runs 90 iterations. The main thread aggregates root-move visit counts and selects the most-visited move.

一次迭代依次进行：

Each iteration performs:

1. **选择 / Selection**：使用 UCT，在胜率利用与探索新分支之间权衡；当前走棋方会选择对自己有利的分支。
2. **扩展 / Expansion**：从附近候选点中加入一个尚未展开的着法。树节点候选最多 14 个。
3. **模拟 / Rollout**：最多模拟 20 手；发现立即获胜或必须阻挡的着法时优先采用，否则从高评分候选中随机选择。
4. **回传 / Backpropagation**：将胜负结果及访问次数沿路径回传。达到模拟步数上限时，以双方威胁分差估计结果。

MCTS 使用 UCT 树策略与启发式模拟，不是极大极小搜索，也不使用 Alpha-Beta 剪枝。若浏览器无法创建 Worker（例如直接通过 `file://` 打开），程序会回退到单线程决策；完整并行搜索请通过本地 HTTP 启动。回退模式下「评估函数」不再做 Alpha-Beta，只按全盘空位评分取最高分（仍然优先成五与必挡），「蒙特卡洛树搜索」则只跑一棵 28 次迭代的树，棋力明显弱于并行模式。

MCTS uses UCT and heuristic rollouts; it is not minimax and does not use Alpha-Beta pruning. If the browser cannot create Workers (for example, when opened via `file://`), the game falls back to single-threaded decision-making. Use the local HTTP server for full parallel search. In fallback mode the evaluation branch drops Alpha-Beta and simply takes the highest-scoring empty point (immediate wins and blocks still come first), while the MCTS branch runs a single 28-iteration tree, so both are noticeably weaker than the parallel path.

## 项目结构 | Project Structure

| 路径 / Path | 说明 / Description |
| --- | --- |
| `index.html` | 页面结构 / Page markup |
| `css/gomoku.css` | 响应式界面 / Responsive styles |
| `js/gomoku-app.js` | Canvas、对局控制与 Worker 调度 / Canvas, game control, and Worker orchestration |
| `js/gomoku-engine.js` | 规则、评分、Minimax 与 MCTS / Rules, scoring, minimax, and MCTS |
| `js/gomoku-worker.js` | 并行任务入口 / Parallel task entry point |
| `test/gomoku-engine.test.mjs` | 引擎回归测试 / Engine regression tests |
| `test/gomoku-tactics.test.mjs` | 战术测试（用例来自 `bench/cases.mjs`） / Tactics tests driven by `bench/cases.mjs` |
| `bench/cases.mjs` | 共享战术用例库 / Shared tactical case list |
| `bench/tactics.mjs` | 战术通过率基准 / Scored tactical benchmark |
| `bench/match.mjs` | 配置对比基准（裁判模式 / 对局模式） / Profile comparison (judge / play) |
| `bench/positions.mjs` | 确定性局面生成器 / Deterministic position generator |
| `.gitignore` | 忽略本机启动脚本 / Excludes the local launcher |

## 测试 | Tests

需要 Node.js 18 或更新版本。在项目目录运行全部测试：

Node.js 18 or later is required. From the project directory, run the whole suite:

```powershell
node --test test/
```

也可以单独运行某个文件：

A single file can also be run on its own:

```powershell
node test/gomoku-engine.test.mjs
node test/gomoku-tactics.test.mjs
```

## 基准测试 | Benchmarks

`bench/tactics.mjs` 跑同一套战术用例并给出通过率，作为回归闸门：

`bench/tactics.mjs` runs the shared tactical cases and reports a pass rate:

```powershell
node bench/tactics.mjs            # 20+ 用例，约 0.2 s
node bench/tactics.mjs --verbose  # 逐条列出
```

`bench/match.mjs` 在相同局面上用同一套更深搜索给两个配置的选点打分，报告平均损失、中位数、命中参考最佳的比例和"大漏着"次数：

`bench/match.mjs` scores two profiles' moves on the same positions with one shared, deeper reference search:

```powershell
node bench/match.mjs                                  # 随机中盘，参考深度 10
node bench/match.mjs --positions 12 --ref-depth 10    # 更稳的样本
node bench/match.mjs --tactical                       # 只取需要多步冲四取胜的局面
node bench/match.mjs --a depth=10,vcf=1,name=hard --b depth=6,vcf=1,name=normal
node bench/match.mjs --mode play                      # 直接对局（交换执黑），仅作参考
```

判读须知：

- `--mode play` 的胜负会被先手优势吞掉，接近 50% 只说明"分不出"，不代表"一样强"；小差距请用默认的裁判模式。
- 随机中盘里两个配置常常选出同一手（选点一致率很高），此时列表中全 0 是正常结果；要拉开差距用 `--tactical` 或更多样本。
- 战术通过率是硬指标，任何改动都不应该让它下降。

Reading the numbers:

- `--mode play` results are dominated by the first-player advantage: a score near 50% means "indistinguishable", not "equally strong". Use the default judge mode for small gaps.
- On random mid-game positions the two profiles often pick the same move, so an all-zero table is expected; use `--tactical` or more positions to separate them.
- The tactical pass rate is a hard gate: no change should lower it.