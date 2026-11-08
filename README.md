# 五子棋 | Gomoku

一款基于原生 HTML、CSS 与 JavaScript 的 15×15 五子棋。玩家可选择执黑或执白，AI 执另一方；黑方先行。无需 CDN 或第三方运行时依赖。

A 15×15 Gomoku game built with native HTML, CSS, and JavaScript. The player may take Black or White and the AI takes the other side; Black moves first. No CDN or third-party runtime dependencies are required.

## 启动 | Run

需要 Python 3。进入项目目录并运行：

Python 3 is required. From the project directory, run:

```powershell
python -m http.server 8000
```

浏览器打开 <http://localhost:8000/>。建议通过本地 HTTP 启动，以启用 Web Worker 并行计算。仓库忽略 `start.bat`，因此克隆后请使用上面的命令。

Open <http://localhost:8000/> in a browser. Use the local HTTP server to enable Web Worker parallelism. `start.bat` is intentionally ignored, so use the command above after cloning.

## 对局操作 | Game Controls

- 可选择“你执黑”或“你执白”；AI 执另一方，黑方先行。AI 执黑时首手直接下天元。
- 点击棋盘交叉点落子；支持重新开始、悔棋、计时、步数统计和胜负提示。
- “思考速度”可选快速 D8 或标准 D10；“进攻强度”是一根 0%–100% 的滑杆，0% 为均衡、100% 为强攻。默认档按设备核心数选择，并记住上次选择。
- 落子前悬停会显示半透明预览；`R` 重新开始、`U` 悔棋；AI 完成后状态栏显示深度、根着数、节点数和耗时。

- Choose **you play Black** or **you play White**; the AI takes the other side and Black moves first. When the AI is Black it opens at the centre.
- Click an intersection to place a stone. Restart, undo, timer, move count, and win/draw feedback are supported.
- **Speed** offers Fast D8 or Standard D10; **attack intensity** is a 0%–100% slider (0% balanced, 100% all-out attack). The default speed follows the device's core count and the last choice is remembered.
- Hovering shows a translucent placement preview; `R` restarts and `U` undoes; after the AI moves, the status bar shows depth, root count, nodes and elapsed time.

## 评估函数与极大极小搜索 | Evaluation and Minimax

评估模式采用两阶段流程：先在主线程对棋盘上的**全部空位**评分，再把强制着法与高分根着（12 个）交给 Worker 池运行极大极小搜索。己方立即成五和必须阻挡对手成五的着法会优先处理；两者都不存在时，先尝试一次连续冲四（VCF）强制搜索，见下文。

Evaluation mode has two stages: score **every empty point** on the main thread, then hand the forcing moves plus the best twelve roots to the Worker pool for minimax. An immediate win or a move that blocks an opponent's immediate win is handled first; when neither exists, a continuous-four (VCF) search runs before the minimax stage.

### 棋形评分 | Pattern Scores

对一个候选点，程序分别试算己方与对手在该点落子后的棋形。每个方向取落点两侧各 4 格：5 格窗口里“四枚己方子 + 一个空点”即为一个成五点，因此连四、冲四、跳四都能识别；6 格模板再识别活三与跳三（`X_XX`、`XX_X`）。基本分如下；每个方向的分数会累加：

For each candidate, the engine evaluates both players' shapes through the point. Each direction reads four cells on either side: a 5-cell window with four own stones and one empty point is a five point, so contiguous fours, closed fours and broken fours are all recognized; six-cell templates then catch live threes and jump threes (`X_XX`, `XX_X`). Scores below are added across directions:

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

最终落点评分为：己方棋形分 + 对手棋形分 × 1.2 + 原版位置表分。位置表提高中心区域的优先级；双活三/双活四/双四/四三奖励在同一落点的多个方向形成相应棋形时触发（双四与四三都是必胜形，因此排在单个活四之上）。`XX_XX` 这类隔空四按冲四计分；若两处四共用同一个成五点，只算一个威胁，不会误判成双四。

Final move score = own pattern score + opponent pattern score × 1.2 + the original positional-table score. The positional table favors central points. Double-threat bonuses apply when a move creates the corresponding patterns in multiple directions; a double four and a four-plus-open-three are forced wins, so both rank above a lone open four. A gap such as `XX_XX` is scored as a four; when two fours share the same completion point they count as one threat, not a double four.

静态局面评估不再只看“单点最强威胁”：双方各取前三威胁分，按 1 / 0.2 / 0.05 加权，再加上 4 级威胁点计数（每个 10,000）。一个活三的两个延伸点会各自形成活四，只看最高分时它们会饱和；加入计数后，两个独立活三才会明显高于一个活三。

The static evaluation no longer reads only the single strongest point threat. Each side's top three threat scores are weighted 1 / 0.2 / 0.05, and every level-4 threat point adds 10,000. Both extension points of one live three score highly and would otherwise saturate the maximum; with the count, two separate live threes clearly outrank one.

### 棋风 | Play Style

“进攻强度”滑杆把三组权重和 VCT 进攻预算从均衡线性插值到强攻：

The attack-intensity slider interpolates three weights and the VCT attack budget from Balanced to all-out Attack:

| 强度 / Intensity | 根着对手权重 / Root opp. | 叶评估对手权重 / Leaf opp. | 4 级奖励 / L4 bonus | VCT 预算 / VCT nodes |
| ---: | ---: | ---: | ---: | ---: |
| 0% | 1.2 | 1.1 | 10,000 | 1,200 |
| 50% | 1.1 | 1.0 | 12,000 | 1,500 |
| 100% | 1.0 | 0.9 | 14,000 | 1,800 |

无论滑杆在哪一档，立即成五/挡五、强制候选、VCF 与 VCT 防守都不变；改变的只是静态聚合、根着排序和进攻 VCT 预算。默认 0%，即原来的均衡行为。

At any slider position, immediate wins/blocks, forced candidates, VCF and VCT defense are unchanged; only the static aggregation, root ordering and the VCT attack budget move. The default is 0%, which is the original balanced behaviour.

进攻强度 100% 目前仍属实验区间：它更愿意做自己的三/四，但也可能忽视黑方的慢速发展；弱黑测试里 100% 明显更好（6–0 对 1–3–2），同级对抗则大致持平。

100% is still experimental: it prefers building its own threes and fours and may tolerate Black's slower build-up. Against a weaker Black the 100% setting was clearly better (6–0 versus 1–3–2), while equal-strength games were roughly even.

### 黑方第三手开局库 | Black third-move book

AI 执黑时，黑 1 走天元；如果白 2 在正交邻位，黑 3 走花月（Kagetsu）定式点；如果白 2 在对角邻位，黑 3 走浦月（Ugetsu）定式点。之后立即回到正常搜索，不套用连珠的后续必胜树。

When the AI is Black, it opens at the centre. If White's second stone is orthogonally adjacent, Black 3 follows the Kagetsu pattern; if it is diagonally adjacent, Black 3 follows Ugetsu. The game returns to normal search immediately afterwards; the later renju winning tree is not used.

这是连珠定式的简化版，而本项目是 freestyle 无禁手，所以只借用第三手，不宣称后续必胜。

This is a simplified renju book. The project is freestyle (no forbidden moves), so only the third move is borrowed; no later forced win is claimed.

### 极大极小与 Alpha-Beta | Minimax and Alpha-Beta

应用层提供两档固定深度，根着也计为一层：

The application offers two fixed depths; the root move also counts as one ply:

| 模式 / Mode | 深度 / Depth | 用途 / Use |
| --- | ---: | --- |
| 快速 / Fast | 8 层 / plies | 快棋、弱设备 / quick games, weaker devices |
| 标准 / Standard | 10 层 / plies | 默认、桌面 / default, desktop |

引擎内部仍保留 `searchDepthForMoves` 的“≤20 手 8 层、>20 手 10 层”分档，供基准测试和单线程回退使用；应用不再依赖它。同分根着仍会随机挑一个，否则同一开局每次都会重演同一盘棋。

The engine still keeps `searchDepthForMoves` ("8 plies up to move 20, 10 after") for benchmarks and the single-threaded fallback; the app no longer uses it. Root moves with identical scores are still picked at random, otherwise every game replays the same line.

白方节点最大化局面分，黑方节点最小化局面分。每层只考虑靠近已有棋子的候选点。候选生成是威胁优先的：能让己方成五的着点只搜索它自己，对手的成五点只搜索挡点；任何能造出成五点的着法（连四、冲四、跳四）、双四/四三/双活三这类 4 级必胜形，以及对手的 4 级威胁点，无论评分排名第几都一定进入候选；其余候选按棋形分排序补足到前 4 个，因此分支数通常仍是 4，最多 6。叶节点用「己方前三威胁加权 + 4 级点奖励 − 棋风系数 × 对手同项」评估，两侧分别只按自己的棋形计算，互不掺入；结果被夹在 ±`WIN_SCORE / 2` 之内，保证任何静态局面都不会超过真实的连五分。均衡棋风下对手系数是 1.1，进攻棋风降到 0.9。

只要叶节点的评估绝对值达到「冲四」量级（10,000，即棋盘上已经出现三级以上棋形），就进入**静止搜索**：先处理成五威胁——轮走方能成五直接判胜，对手只有一个成五点就必须挡掉（最多延伸 4 手），有两个成五点则判负；没有成五威胁时再看「四」这一层，只在对手的造四点、以及自己的造四点里各挑一到两个，各补一手后静态评估取最优。四这一层只做一层：递归版本实测要贵约 8 倍，而在没有时间预算的前提下付不起。

没有这层时，被夹到边界的叶子全都等于同一个 −`WIN_SCORE / 2`，搜索在视界边缘分不出"必败"和"还挡得住"，只能按着法顺序瞎选。

A leaf whose score reaches the four level (10,000, i.e. a three or better already exists) runs a **quiescence search**. Five threats come first: a side to move that can complete a five wins, a single opponent five point must be blocked (up to four extra plies), and two opponent five points are a loss. With no five threat left, one four layer follows: the opponent's four-making points and the engine's own are each tried (one or two of them) with a single static ply. The four layer is deliberately one ply deep — the recursive version measured about eight times slower, which is unaffordable without a time budget.

Without this layer every clamped leaf equals the same −`WIN_SCORE / 2`, and the search cannot tell "lost" from "still defendable" at the horizon, so it picks by move order.

Alpha-Beta 维护当前路径上的上界 `alpha` 与下界 `beta`。当 `beta <= alpha` 时，剩余兄弟分支不可能改变已选结果，因此提前停止该分支搜索。搜索还带一张 Zobrist 双键校验的置换表：同层精确值直接返回，下界/上界只在能剪枝时使用；兄弟节点用 PVS 零窗口探测，只有分数落在窗口内才重新全窗口搜索。根着先取强制着法，再按全盘评分补足到 12 个，交给常驻 Worker 池动态领取；Worker 数量受设备并发数约束，最多 8 个。

Alpha-Beta tracks the current path's lower bound (`alpha`) and upper bound (`beta`). When `beta <= alpha`, remaining sibling branches cannot change the decision, so that branch is pruned. A Zobrist-keyed transposition table returns exact values at sufficient depth and uses lower/upper bounds only when they prune; PVS probes later siblings with a null window and re-searches only when the score lands inside the window. Root moves are the forcing moves first, then the best full-board scores up to twelve, pulled by a persistent Worker pool subject to the device's available concurrency (at most eight).

若浏览器无法创建 Worker（例如直接通过 `file://` 打开），程序会回退到单线程 `chooseEvaluationMove`：先成五/挡五，再 VCF/VCT，最后按全盘评分取最高分；棋力弱于并行搜索，完整并行请通过本地 HTTP 启动。

If the browser cannot create Workers (for example, when opened via `file://`), the game falls back to the single-threaded `chooseEvaluationMove`: immediate wins/blocks first, then VCF/VCT, then the highest full-board score. It is weaker than the parallel search; use the local HTTP server for full parallelism.

### 连续冲四搜索（VCF）| Continuous Fours (VCF)

极大极小最多看 10 层，而连续冲四的胜负手经常在 10 层以外。VCF 只走能形成「四」的着法（含跳四），对手每一步都只有一个合法应手，所以整条线全程都是逼着，可以在很窄的分支下看到十几次冲四之后。找到即证明，不是估计。

- **进攻**：轮到 AI 时先跑己方 VCF，找到就按线路第一手下，不再进入极大极小。
- **防守**：每个根着在进入搜索前，先检查这手棋下完之后对手是否仍有 VCF 必胜线；有的话该根着直接判负（按线路长度折算延迟），避免把一手必败的棋排在前面。
- **正确性**：己方落子后若对手仍能直接成五，这手棋不成线（对手会先一步取胜）；对手的被迫应手也不能构成他自己的连五或新连五威胁，否则这条线作废；两个不同的成五点直接判胜。找不到只代表没找到，不代表一定没有。

Minimax only reaches ten plies, while forcing sequences often decide the game beyond that. VCF plays only moves that create a four (broken fours included), so the opponent has a single legal reply at every step and the line stays forcing; narrow branching makes a dozen consecutive fours reachable. A hit is a proof, not an estimate.

- **Attack**: on the AI's turn White's own VCF runs first; a hit is played immediately without minimax.
- **Defense**: before searching, each root move is checked for whether the opponent still has a VCF win afterwards. If so the root move is scored as a loss (delayed by the line length), so a dead move is not ranked first.
- **Correctness**: a move is not forcing if the opponent can still complete a five afterwards (he would strike first), and the forced reply must neither complete a five for him nor create a new five threat; two distinct five points are an instant win. A miss only means nothing was found, not that nothing exists.

### 连续活三搜索（VCT）| Continuous Threats (VCT)

VCF 只覆盖冲四，很多杀法是“活三 → 冲四 → 活三”的组合。VCT 把造活三也算作逼着：防守方必须落在活三的防线点（连三的两个端点，跳三的端点与断点），否则攻方下一步就是活四。搜索对每个防线点都尝试，全部失败才返回一条证明。为避免误报，攻方每次落子前先检查防守方是否已有成五点或造四点：有就放弃这条线，因为那类反先手需要另一套应对。单次预算 1200 个节点、12 层；安静的根着还会额外用 400 个节点检查对手 VCT，已经造出四/活三的根着不查，因为对手必须先应这手威胁。

VCF covers continuous fours only, while many kills are "live three → four → live three". VCT treats a live three as forcing too: the defender must play one of its defense points (the two ends of a contiguous three, or the ends and gap of a jump three), otherwise the attacker makes an open four next. Every defense is tried and only a clean sweep returns a proof. To stay sound, the attacker abandons a line whenever the defender already has a five or four threat, since those counter-threats need a different response. A run is capped at 1,200 nodes and 12 plies; a quiet root move also spends 400 nodes checking the opponent's VCT, while a move that already creates a four or live three skips that check because the opponent must answer it first.

## 项目结构 | Project Structure

| 路径 / Path | 说明 / Description |
| --- | --- |
| `index.html` | 页面结构 / Page markup |
| `css/gomoku.css` | 响应式界面 / Responsive styles |
| `js/gomoku-app.js` | Canvas、对局控制与 Worker 调度 / Canvas, game control, and Worker orchestration |
| `js/gomoku-engine.js` | 规则、评分、Minimax、VCF/VCT / Rules, scoring, minimax, VCF/VCT |
| `js/gomoku-worker.js` | 并行任务入口 / Parallel task entry point |
| `test/gomoku-engine.test.mjs` | 引擎回归测试 / Engine regression tests |
| `test/gomoku-tactics.test.mjs` | 战术测试（用例来自 `bench/cases.mjs`） / Tactics tests driven by `bench/cases.mjs` |
| `test/selfplay.mjs` | 手动自对弈模板（不属于自动化测试） / Manual self-play harness (not part of the test suite) |
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

自对弈评估用 `test/selfplay.mjs`。`node --test` 会递归执行 `test/` 下的所有 `.mjs`，所以模板检测 `NODE_TEST_CONTEXT` / `execArgv`，在测试 runner 中跳过 `main()`；只有直接运行才会真正对局：

Self-play evaluation uses `test/selfplay.mjs`. `node --test` recursively executes every `.mjs` under `test/`, so the template detects `NODE_TEST_CONTEXT` / `execArgv` and skips `main()` inside the test runner; only a direct run actually plays games:

```powershell
node test/selfplay.mjs --help
node test/selfplay.mjs --openings 6
node test/selfplay.mjs `
  --a "name=attack,depth=8,roots=12,intensity=100" `
  --b "name=weak,depth=6,roots=8,vct=0"
```

自对弈结果受先手优势影响很大，应同时看总胜负和分执黑/执白胜负；样本至少 6–20 局。它会被 `node --test` 当作一个空测试文件加载，但不会执行对局；回归计数仍以 14 条引擎测试 + 31 条战术测试为准。

Raw self-play totals are dominated by the first-player advantage: read the as-black/as-white split as well, and use at least 6–20 games. `node --test` loads the template as an empty test file but does not play games; the real regression count remains 14 engine tests + 31 tactical tests.

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