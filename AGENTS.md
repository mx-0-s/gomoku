# AGENTS.md — 跨 Session 开发指南

本文件给后续接手本项目的 agent / 开发者使用。开始改代码前，先读：

1. `README.md`（用户文档与算法说明）
2. 本文件（工程约束与当前状态）
3. `git status` + `git diff`（当前工作区可能有未提交的改动，不要覆盖）

---

## 1. 项目定位

纯前端、零运行时依赖的 15×15 五子棋。玩家执黑先行，AI 执白。

- 无构建步骤、无 npm 依赖、无 CDN；
- 引擎同时支持浏览器 `<script>` / Worker `importScripts` / Node `require`（UMD）；
- 全部逻辑在浏览器本地运行；
- 设计目标：白方（后手）能防住人类的 VCF/VCT/双三，并抓住对手失误，而不是追求理论必胜（五子棋先手理论必胜）。

启动：

```powershell
python -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

直接 `file://` 打开会失去 Worker 并行，只剩单线程回退，棋力明显下降。

---

## 2. 常用命令

```powershell
# 引擎回归
node test/gomoku-engine.test.mjs

# 战术回归（当前 31 条，硬门槛）
node test/gomoku-tactics.test.mjs

# 战术基准 / 逐条输出
node bench/tactics.mjs
node bench/tactics.mjs --verbose

# 裁判基准：两个配置在同一局面上的选点质量
node bench/match.mjs --positions 12 --ref-depth 10
node bench/match.mjs --positions 12 --tactical

# 语法检查
node --check js/gomoku-engine.js
node --check js/gomoku-app.js
node --check js/gomoku-worker.js
```

注意：在某些沙箱/受限环境里，`node --test test/` 会因为测试 runner 需要 spawn 子进程而被拒绝（`spawn EPERM`）。直接运行两个测试文件即可，效果等价。

**硬门槛：任何改动都不能让 `test/gomoku-tactics.test.mjs` 低于 31/31。** 目前 0% / 50% / 100% 进攻强度下都是 31/31。

---

## 3. 目录与职责

| 路径 | 职责 |
| --- | --- |
| `index.html` | 页面结构、棋盘 canvas、控制区（算法 / 速度 / 进攻强度 / 操作） |
| `css/gomoku.css` | 响应式样式；滑杆样式在 `.intensity-control` |
| `js/gomoku-engine.js` | 规则、棋形评分、评估、Alpha-Beta/TT/PVS、VCF/VCT、MCTS |
| `js/gomoku-app.js` | Canvas 绘制、对局状态、Worker 池、UI 事件、速度/棋风路由 |
| `js/gomoku-worker.js` | Worker 任务入口，按 `mode` 调引擎，回包带 `id` |
| `test/gomoku-engine.test.mjs` | 引擎回归（14 条） |
| `test/gomoku-tactics.test.mjs` | 战术回归，自动读取 `bench/cases.mjs` |
| `test/selfplay.mjs` | 手动自对弈模板；检测 `NODE_TEST_CONTEXT`，`node --test` 下不会执行 `main()` |
| `bench/cases.mjs` | 共享战术用例；新增用例加这里，测试与 bench 同时生效 |
| `bench/tactics.mjs` | 战术通过率基准 |
| `bench/match.mjs` | 配置对比基准（judge / play） |
| `bench/positions.mjs` | 确定性随机中盘生成器 |

自对弈模板见 `test/selfplay.mjs`；它只做手动评估，不进入自动化测试。

---

## 4. 引擎架构

### 4.1 规则与棋形

核心函数：

- `createBoard` / `checkWin` / `listCandidateMoves`
- `analyzePlacement(board,row,col,player)`：在空点试落，返回 `{score, five, fivePoints, openFour, four, openThree}`；内部会落子/撤销，使用共享 `LINE_CELLS` 缓冲，**不要嵌套调用**。
- `evaluatePattern`：`analyzePlacement(...).score`。
- `levelOf(analysis)`：
  - 5 级：直接成五
  - 4 级：活四/双四、四三、双活三（`fivePoints >= 2` 或 `four+three` 或 `openThree >= 2`）
  - 3 级：普通冲四或活三

棋形识别方式（不要退回“只数连续子”）：

- 每个方向取落点两侧各 4 格，共 9 格；
- 5 格窗口内“4 枚己方 + 1 空点”= 一个成五点，因此连四、冲四、跳四都能识别；
- 6 格模板（base-3 编码）识别活三/跳三：`011100`、`001110`、`010110`、`011010`；
- `fivePoints` 按**不同空点**去重：两个四共用同一个成五点只算一个威胁，不能算双四。

### 4.2 静态评估

`evaluateBoard(board, player)`：

- 双方各取前三威胁分，按 `1 / 0.2 / 0.05` 加权；
- 每个 4 级威胁点加 `activeStyle.levelFour`（默认 10,000，最高 14,000）；
- 减去 `activeStyle.boardOpponent × 对手同项`（默认 1.1，最低 0.9）；
- 结果夹在 `±WIN_SCORE/2`，保证真实连五分永远高于静态分。

风格权重集中在 `STYLE_PRESETS` 和 `setAttackIntensity(0..1)`。风格变化必须清空置换表（`ttFlag.fill(0)`），否则旧权重下的缓存分数会串用。

### 4.3 搜索

- `searchRootMove(board, move, player, depth)`：根着搜索；**分数始终是白方视角**。
- `alphaBeta(...)`：白方最大化、黑方最小化；Zobrist 双键 + 直接映射 TT（`2^17`）；PVS 零窗口探测；TT move 优先排序。
- `getSearchMoves`：强制着法优先（成五、挡五、任意造四、4 级威胁、对手 4 级点），再按棋形分补足到 4 个，强制着最多 6 个。
- `leafScore`：`|eval| >= 10,000` 时进入 `resolveThreats` 静止搜索。
- `searchDepthForMoves` 仍保留“≤20 手 8 层、>20 手 10 层”，但**应用层已不再使用**；现在应用用快速 D8 / 标准 D10 固定档。

### 4.4 VCF / VCT

- `findVcfWin`：只走造四着法，对手被迫单点挡；用于进攻和根着防守。
- `findVctWin`：把活三也作为逼着；防线点由 `OPEN_THREE_DEFENSE` 给出（连三两端，跳三端点+断点）。
- VCT 是**保守证明**：如果防守方已有成五点或造四点，直接放弃这条线；找不到不代表不存在，找到则应是真必胜。
- VCT 防守只在**安静根着**上运行（根着自己造出四/活三时，对手必须先应这手，VCT 前提不成立）。
- 不要在没有新测试的情况下删除这些保守检查，否则会把“看起来像胜”的线路当成必胜。

### 4.5 MCTS

`runMcts` 目前是实验/娱乐模式：每个 Worker 90 次迭代、20 手 rollout、评分前 5 随机。棋力弱于极大极小，**不要把它当强度选项**。

---

## 5. 应用层

### 5.1 速度档

- 快速：全程 D8；
- 标准：全程 D10；
- 默认：`navigator.hardwareConcurrency >= 8` 用标准，否则快速；
- 选择存在 `localStorage` 的 `gomoku-speed`；
- MCTS 模式下速度选择禁用（固定迭代预算）。

### 5.2 进攻强度滑杆

- UI：`#attackIntensity`，范围 0–100，步长 5；
- 0% = 原均衡；100% = 原进攻；
- 插值参数见 README 的“棋风”表；
- 值存在 `localStorage` 的 `gomoku-attack`；
- 旧 `gomoku-style=attack` 会迁移为 100%；
- 滑杆只改静态聚合、根着排序、VCT 进攻预算；**不改**立即成五/挡五、强制候选、VCF/VCT 防守。

### 5.3 Worker 池

- `POOL_SIZE = min(8, hardwareConcurrency - 1)`；
- 常驻 Worker，任务队列 + 动态领取；不要退回“每个任务 new Worker/terminate”；
- 任务消息：`{ id, mode, board, player, candidates, depth, style|intensity, iterations, seed }`；
- 回包：`{ id, mode, results }`，主线程用 `id` 丢弃过期结果；
- `cancelAnalysis()` 会关闭池并把 `workerPool` 置空；下一次分析重建；
- Worker 报错会替换；不要在多处同时创建池。

### 5.4 根着

- 主线程先算全盘空位分（`scoreMove`）；
- 根着 = `getSearchMoves(...)` 的强制着法 + 静态高分，共 **12 个**（`ROOT_LIMIT`）；
- 每个根着一个 Worker 任务，池动态调度；
- 同分根着随机选一个，避免每局完全重演。

---

## 6. 不可破坏的约束

1. **不添加超时/时间预算**：用户明确要求“不做超时限制”。不要引入 `timeMs`、deadline、iterative-deepening 超时中断；搜索算完为止。若要加，先得到用户明确同意。
2. **零依赖**：不引入 npm 包、CDN、构建工具；浏览器直接可跑。
3. **UMD/Worker 兼容**：引擎必须同时能被 `require`、`<script>`、`importScripts` 加载；Worker 依赖全局 `GomokuEngine`。
4. **战术用例是硬门槛**：至少 31/31；新增战术逻辑应先在 `bench/cases.mjs` 加用例。
5. **安全阀不能弱化**：立即成五、挡五、强制四/4 级候选、VCF/VCT 防守，不能因为棋风滑杆或评估调参而删除。
6. **默认行为保持均衡**：进攻强度默认 0%；除非用户明确要求，不要把默认改成进攻。
7. **分数视角**：`searchRootMove` 永远返回白方视角分数；给黑方写选点逻辑时按升序取（越小对黑方越好）。
8. **TT 与风格**：风格变化必须清空 TT；TT 键只含棋盘，不含风格。
9. **不要提交 commit**，除非用户明确要求。工作区可能包含多轮未提交改动。

---

## 7. 修改指南

### 加战术用例

在 `bench/cases.mjs` 的 `cases` 数组里加对象：

```js
{
    name: '...',
    check(engine) {
        const current = board(engine, [[7, 6, 2], ...]);
        const result = engine.findVctWin(current, 2);
        return result ? true : 'no VCT found';
    }
}
```

同时自动进入 `test/gomoku-tactics.test.mjs` 和 `bench/tactics.mjs`。不要只改其中一处。

### 改评估权重

- 只改 `evaluateBoard` / `scoreMove` 的聚合逻辑，不要动棋形基础分（`SCORES`）和 5 格/6 格识别，除非同时更新 README 和测试。
- 改完至少跑：
  - 0% / 50% / 100% 三档战术用例；
  - `bench/match.mjs --positions 12 --ref-depth 10`；
  - 小样本自对弈。
- 注意 TT 缓存：权重变化后要清表（`setAttackIntensity` 已做）。

### 改搜索

- 先跑 `bench/match.mjs` 记录改前基线；
- 任何 PVS/TT 改动都要验证冷/热 TT 分数一致（同一局面同深度重复搜索应得到相同分数）；
- 不要增加每个节点的分配；当前性能瓶颈是 `analyzePlacement`，历史上一次朴素重写让 D10 慢了 5 倍。

### 改 UI

- 控制区编号目前：01 对局、02 AI 算法、03 强度与棋风、04 操作；
- 新增控件后要同步：
  - `updateStatus()` 的禁用逻辑；
  - `syncOptionAvailability()`；
  - MCTS 模式禁用；
  - `localStorage` 读写；
  - README 的操作说明。
- DOM 级验证可以用假 DOM + 假 Worker（见第 9 节），避免依赖真实浏览器。

---

## 8. 性能与基准（参考值）

Node 单线程、冷 TT、3 个随机中盘、12 个根着：

| 深度 | 总耗时 | 最慢单根着 | 节点数 |
| ---: | ---: | ---: | ---: |
| D8 | ~3.4 s | ~0.27 s | ~19k |
| D10 | ~11.1 s | ~1.13 s | ~70k |

浏览器 7–8 个 Worker 动态领取后，大致：

- 快速 D8：0.4–0.5 秒/手；
- 标准 D10：1.4–2.5 秒/手（冷 TT，热起来会快）；
- 自对弈：D8 约 26 秒/局、31 手；D10 约 118 秒/局、64 手；这些都是历史样本，硬件不同会变。

性能判断以“同机改前/改后对比”为准，不要拿不同机器/不同局面的绝对数字下结论。

---

## 9. 测试与自对弈方法

### 裁判基准

`bench/match.mjs` 默认用深度 10 的参考搜索给两个配置的选点打分，报告 mean loss / median / best-move / blunders / ms per move。

注意：

- `--mode play` 受先手优势主导，接近 50% 只说明分不出，不代表一样强；
- 随机中盘里两个配置经常选同一手，全 0 是正常结果；用 `--tactical` 或更多样本拉开差距；
- `bench/match.mjs` 的 profile 目前支持 `depth=`、`roots=`、`vcf=`，还没有 `style` 参数；要测棋风需自行扩展。

### 自对弈 harness（`test/selfplay.mjs`）

仓库里已有模板，手动运行：

```powershell
node test/selfplay.mjs --help
node test/selfplay.mjs --openings 6
node test/selfplay.mjs `
  --a "name=attack,depth=8,roots=12,intensity=100" `
  --b "name=weak,depth=6,roots=8,vct=0" `
  --openings 6
```

profile 字段：`name / engine / depth / roots / vcf / vct / intensity`，文件顶部注释有完整说明。要点：

- 两个 profile 各自**独立加载引擎模块**（清 `require.cache`），避免共享 TT / 全局风格；
- 每步顺序：己方成五 → 挡对方五 → VCF → VCT → 静态前 N 根着 + `searchRootMove`；
- 白方按分数降序，黑方按分数升序（`searchRootMove` 是白方视角）；
- 固定黑中宫 + 固定白方开局，交换执黑，默认最多 80 手；
- 输出总胜负、分执黑/执白胜负、平均手数/耗时、各来源（win/block/vcf/vct/search）计数；
- 样本至少 6–20 局，小样本不要下强结论。

弱黑对照：`--b "name=weak,depth=6,roots=8,vct=0"`。历史结果：进攻 100% 白 vs 弱黑 6–0；均衡白 vs 同一弱黑 1–3–2；进攻白 vs 均衡黑 3–3（都是小样本）。

`node --test` 会递归执行 `test/` 下的所有 `.mjs`，所以模板用 `NODE_TEST_CONTEXT` / `execArgv` 检测测试 runner，在测试环境中不执行 `main()`；它会被当作一个空测试文件加载，但不会跑对局，回归计数仍以 14 条引擎 + 31 条战术为准。它是手动评估工具，不是回归测试。

### DOM 级验证

可以用 Node `vm` + 假 `document`/`canvas`/`Worker` 跑 `gomoku-app.js`：

- 假 Worker 收到 `{id, mode, board, ...}` 后同步调用引擎并回包；
- 点击 canvas 中心（600×600 时 margin 27、cell 39，中心 300,300）；
- 轮询 `#moveCount` 是否为 `2`；
- 可验证快速/标准深度、滑杆、重开后的 Worker 池重建。

---

## 10. 已知限制 / 待办

- VCT 是保守版：防守方有反四时直接放弃，可能漏掉一些真实胜；不是完整 threat-space search。
- VCT 防守只查安静根着，不模拟“我方造威胁、对手被迫应”的线路。
- MCTS 很弱（每树 90 次迭代），仅实验。
- 没有开局库；白方前几手靠搜索，固定开局下容易重复。
- 静态评估是“点级 top3 + 4 级点计数”，仍会高估同一线上的多个点；还不是按线去重。
- TT 是直接映射、无 aging；风格切换清表。
- 没有时间预算（产品决定，不要加）。
- 自对弈样本仍偏小，棋力结论要谨慎。

可能的下一步（按价值排序）：

1. 进攻强度 25/50/75/100 各跑一批弱黑/同级，找默认值；
2. 白方开局库（4–6 手）；
3. 按“威胁等级”拆分对手权重，避免进攻模式忽视黑方慢速活三；
4. 完整 VCT 防守 / 线级威胁评估；
5. UI 显示深度、节点数、耗时。

---

## 11. 交接检查清单

开始：

- [ ] `git status` / `git diff` 看清未提交改动
- [ ] 读 `README.md` + 本文件
- [ ] 跑 `node test/gomoku-engine.test.mjs` 和 `node test/gomoku-tactics.test.mjs` 确认基线

提交前（如果用户要求提交）：

- [ ] 战术 31/31（至少 0% 和 100% 两档）
- [ ] 引擎测试 14/14
- [ ] `node --check` 三个 JS 文件
- [ ] `git diff --check`
- [ ] 用户可见行为变化同步到 README
- [ ] 不引入依赖、不加超时
