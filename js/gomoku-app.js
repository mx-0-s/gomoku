document.addEventListener('DOMContentLoaded', () => {
    const { SIZE, createBoard, cloneBoard, checkWin, listEmptyPoints, findImmediateMove, findVcfWin, chooseEvaluationMove, runMcts } = GomokuEngine;
    const HUMAN = 1;
    const AI = 2;
    const MAX_WORKERS = 8;
    const MCTS_ITERATIONS_PER_WORKER = 90;

    let board = createBoard();
    let currentPlayer = HUMAN;
    let gameActive = true;
    let thinking = false;
    let history = [];
    let lastMove = null;
    let winningLine = null;
    let elapsedSeconds = 0;
    let startedAt = Date.now();
    let timerId = null;
    let analysisId = 0;
    let boardMetrics = { size: 0, margin: 0, cell: 0 };
    let mode = document.querySelector('input[name="ai-mode"]:checked').value;

    const canvas = document.getElementById('gameCanvas');
    const context = canvas.getContext('2d');
    const statusText = document.getElementById('statusText');
    const gameStatus = document.getElementById('gameStatus');
    const statusMark = document.getElementById('statusMark');
    const searchStatus = document.getElementById('searchStatus');
    const currentPlayerStone = document.getElementById('currentPlayer');
    const playerText = document.getElementById('playerText');
    const moveCount = document.getElementById('moveCount');
    const gameTime = document.getElementById('gameTime');
    const parallelText = document.getElementById('parallelText');
    const modeDescription = document.getElementById('modeDescription');
    const undoButton = document.getElementById('undoBtn');
    const winModal = document.getElementById('winModal');
    const winnerText = document.getElementById('winnerText');
    const winMessage = document.getElementById('winMessage');
    const resultStone = document.getElementById('resultStone');
    const activeWorkers = new Map();

    function workerCount(taskCount) {
        const available = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
        return Math.max(1, Math.min(MAX_WORKERS, available, taskCount || 1));
    }

    function updateCanvasSize() {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width) return;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(rect.width * pixelRatio);
        canvas.height = Math.round(rect.height * pixelRatio);
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        const margin = rect.width * 0.045;
        boardMetrics = { size: rect.width, margin, cell: (rect.width - margin * 2) / (SIZE - 1) };
        drawBoard();
    }

    function pointFor(row, col) {
        return {
            x: boardMetrics.margin + col * boardMetrics.cell,
            y: boardMetrics.margin + row * boardMetrics.cell
        };
    }

    function drawBoard() {
        const { size, margin, cell } = boardMetrics;
        if (!size) return;
        context.clearRect(0, 0, size, size);
        context.strokeStyle = 'rgba(76, 52, 25, 0.74)';
        context.lineWidth = Math.max(0.7, size / 700);
        for (let index = 0; index < SIZE; index++) {
            const coordinate = margin + index * cell;
            context.beginPath();
            context.moveTo(margin, coordinate);
            context.lineTo(size - margin, coordinate);
            context.stroke();
            context.beginPath();
            context.moveTo(coordinate, margin);
            context.lineTo(coordinate, size - margin);
            context.stroke();
        }

        for (const { row, col } of [{ row: 3, col: 3 }, { row: 3, col: 11 }, { row: 7, col: 7 }, { row: 11, col: 3 }, { row: 11, col: 11 }]) {
            const point = pointFor(row, col);
            context.beginPath();
            context.arc(point.x, point.y, Math.max(1.7, cell * 0.065), 0, Math.PI * 2);
            context.fillStyle = '#55412e';
            context.fill();
        }

        for (let row = 0; row < SIZE; row++) {
            for (let col = 0; col < SIZE; col++) {
                if (board[row][col] !== 0) drawStone(row, col, board[row][col]);
            }
        }
        if (winningLine) drawWinningLine(winningLine);
    }

    function drawStone(row, col, player) {
        const { x, y } = pointFor(row, col);
        const radius = boardMetrics.cell * 0.42;
        context.beginPath();
        context.arc(x + 1, y + 2, radius, 0, Math.PI * 2);
        context.fillStyle = 'rgba(44, 34, 20, 0.25)';
        context.fill();
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        const gradient = context.createRadialGradient(x - radius * 0.35, y - radius * 0.4, radius * 0.08, x, y, radius);
        if (player === HUMAN) {
            gradient.addColorStop(0, '#555b57');
            gradient.addColorStop(1, '#101511');
        } else {
            gradient.addColorStop(0, '#fffefa');
            gradient.addColorStop(1, '#d7d4c9');
        }
        context.fillStyle = gradient;
        context.fill();
        context.strokeStyle = player === HUMAN ? '#101511' : '#c4c1b6';
        context.lineWidth = 1;
        context.stroke();
        if (lastMove && lastMove.row === row && lastMove.col === col) {
            context.beginPath();
            context.arc(x, y, Math.max(2, radius * 0.19), 0, Math.PI * 2);
            context.fillStyle = player === HUMAN ? '#f0a287' : '#c45e47';
            context.fill();
        }
    }

    function drawWinningLine(line) {
        const first = pointFor(line[0].row, line[0].col);
        const last = pointFor(line[line.length - 1].row, line[line.length - 1].col);
        context.beginPath();
        context.moveTo(first.x, first.y);
        context.lineTo(last.x, last.y);
        context.strokeStyle = '#d75f49';
        context.lineWidth = Math.max(3, boardMetrics.cell * 0.09);
        context.lineCap = 'round';
        context.stroke();
    }

    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
        const remainder = (seconds % 60).toString().padStart(2, '0');
        return `${minutes}:${remainder}`;
    }

    function updateStatus() {
        if (gameActive) {
            statusText.textContent = thinking ? '白方正在分析局面' : currentPlayer === HUMAN ? '黑方回合' : '白方回合';
            playerText.textContent = currentPlayer === HUMAN ? '黑方 · 你' : '白方 · AI';
            currentPlayerStone.className = `stone ${currentPlayer === HUMAN ? 'stone-black' : 'stone-white'}`;
            gameStatus.classList.toggle('is-thinking', thinking);
        }
        moveCount.textContent = history.length.toString();
        undoButton.disabled = thinking || !gameActive || history.length < 2;
        document.querySelectorAll('input[name="ai-mode"]').forEach(input => { input.disabled = thinking; });
    }

    // Derived from a start timestamp instead of an accumulating counter, so a throttled
    // background tab cannot make the clock drift behind real time.
    function syncElapsed() {
        elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        gameTime.textContent = formatTime(elapsedSeconds);
    }

    function startTimer() {
        clearInterval(timerId);
        startedAt = Date.now();
        elapsedSeconds = 0;
        syncElapsed();
        timerId = setInterval(() => {
            if (!gameActive) return;
            syncElapsed();
        }, 1000);
    }

    function cancelAnalysis() {
        analysisId++;
        for (const cancel of activeWorkers.values()) cancel();
        activeWorkers.clear();
    }

    function workerRequest(payload) {
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = new Worker('js/gomoku-worker.js');
            } catch (error) {
                reject(error);
                return;
            }
            const cancel = () => {
                if (!activeWorkers.has(worker)) return;
                activeWorkers.delete(worker);
                worker.terminate();
                reject(new Error('Analysis cancelled'));
            };
            activeWorkers.set(worker, cancel);
            const finish = callback => value => {
                if (!activeWorkers.has(worker)) return;
                activeWorkers.delete(worker);
                worker.terminate();
                callback(value);
            };
            worker.addEventListener('message', event => finish(resolve)(event.data), { once: true });
            worker.addEventListener('error', event => finish(reject)(new Error(event.message || 'Worker failed')), { once: true });
            worker.postMessage(payload);
        });
    }

    async function evaluateInParallel(snapshot, candidates, version) {
        const count = workerCount(candidates.length);
        const scoringJobs = Array.from({ length: count }, (_, index) => ({
            mode: 'evaluate',
            board: snapshot,
            player: AI,
            candidates: candidates.filter((_, candidateIndex) => candidateIndex % count === index)
        }));
        parallelText.textContent = `全盘评分 · ${count} 路并行`;
        const scoreBatches = await Promise.all(scoringJobs.map(workerRequest));
        if (version !== analysisId) return null;
        const rankedMoves = scoreBatches.flatMap(batch => batch.results).sort((a, b) => b.score - a.score);
        if (!rankedMoves.length) return null;

        const depth = GomokuEngine.searchDepthForMoves(history.length);
        const rootLimit = Math.min(rankedMoves.length, Math.min(16, Math.max(4, count)));
        const rootMoves = rankedMoves.slice(0, rootLimit);
        const searchJobs = Array.from({ length: Math.min(count, rootMoves.length) }, (_, index) => ({
            mode: 'search',
            board: snapshot,
            player: AI,
            depth,
            candidates: rootMoves.filter((_, moveIndex) => moveIndex % Math.min(count, rootMoves.length) === index)
        }));
        parallelText.textContent = `Alpha-Beta · 深度 ${depth} · ${searchJobs.length} 路`;
        const searchBatches = await Promise.all(searchJobs.map(workerRequest));
        if (version !== analysisId) return null;
        return searchBatches.flatMap(batch => batch.results).sort((a, b) => b.score - a.score)[0] || rootMoves[0];
    }

    async function mctsInParallel(snapshot, version) {
        const count = workerCount(MAX_WORKERS);
        parallelText.textContent = `MCTS · ${count} 棵搜索树并行`;
        const jobs = Array.from({ length: count }, (_, index) => ({
            mode: 'mcts',
            board: snapshot,
            player: AI,
            iterations: MCTS_ITERATIONS_PER_WORKER,
            seed: (Date.now() + (index + 1) * 7919) >>> 0
        }));
        const batches = await Promise.all(jobs.map(workerRequest));
        if (version !== analysisId) return null;
        const totals = new Map();
        for (const { results } of batches) {
            for (const result of results) {
                const key = `${result.row},${result.col}`;
                const total = totals.get(key) || { row: result.row, col: result.col, visits: 0, wins: 0 };
                total.visits += result.visits;
                total.wins += result.wins;
                totals.set(key, total);
            }
        }
        return [...totals.values()].sort((a, b) => b.visits - a.visits || b.wins - a.wins)[0] || null;
    }

    async function fallbackMove(snapshot, selectedMode) {
        parallelText.textContent = 'Worker 不可用 · 单线程回退';
        if (selectedMode === 'mcts') {
            const results = runMcts(snapshot, AI, 28, Date.now());
            return results.sort((a, b) => b.visits - a.visits)[0] || null;
        }
        return chooseEvaluationMove(snapshot, AI);
    }

    async function chooseAiMove(version) {
        const snapshot = cloneBoard(board);
        const win = findImmediateMove(snapshot, AI);
        if (win) return win;
        const block = findImmediateMove(snapshot, HUMAN);
        if (block) return block;
        // A continuous-four win is a proof, so it is played without asking the search.
        const vcf = findVcfWin(snapshot, AI);
        if (vcf) return vcf.move;
        if (mode === 'evaluate') {
            const candidates = listEmptyPoints(snapshot);
            if (typeof Worker === 'undefined') return fallbackMove(snapshot, mode);
            return evaluateInParallel(snapshot, candidates, version);
        }
        if (typeof Worker === 'undefined') return fallbackMove(snapshot, mode);
        return mctsInParallel(snapshot, version);
    }

    async function aiMove() {
        if (currentPlayer !== AI || !gameActive || thinking) return;
        thinking = true;
        searchStatus.textContent = mode === 'mcts' ? 'MCTS SEARCH' : `MINIMAX · D${GomokuEngine.searchDepthForMoves(history.length)}`;
        updateStatus();
        const version = analysisId;
        const selectedMode = mode;
        let move = null;
        try {
            move = await chooseAiMove(version);
        } catch (error) {
            if (version !== analysisId) return;
            for (const cancel of activeWorkers.values()) cancel();
            activeWorkers.clear();
            move = await fallbackMove(cloneBoard(board), selectedMode);
        }
        if (version !== analysisId) return;
        thinking = false;
        searchStatus.textContent = 'READY';
        if (move && gameActive && currentPlayer === AI) makeMove(move.row, move.col, AI);
        else updateStatus();
    }

    function makeMove(row, col, player) {
        if (!gameActive || board[row][col] !== 0 || (player === HUMAN && thinking)) return false;
        board[row][col] = player;
        const move = { row, col, player };
        history.push(move);
        lastMove = move;
        winningLine = checkWin(board, row, col, player);
        drawBoard();

        if (winningLine) {
            gameActive = false;
            clearInterval(timerId);
            syncElapsed();
            statusText.textContent = player === HUMAN ? '黑棋获胜' : '白棋获胜';
            winnerText.textContent = player === HUMAN ? '黑棋获胜' : '白棋获胜';
            winMessage.textContent = player === HUMAN ? '你赢下了这场对局。' : 'AI 赢下了这场对局。再试一局。';
            resultStone.classList.toggle('is-white', player === AI);
            winModal.classList.remove('is-hidden');
        } else if (history.length === SIZE * SIZE) {
            gameActive = false;
            clearInterval(timerId);
            syncElapsed();
            statusText.textContent = '棋盘已满 · 平局';
            resultStone.classList.remove('is-white');
            winModal.classList.remove('is-hidden');
            winnerText.textContent = '平局';
            winMessage.textContent = '棋盘已满，双方未能连成五子。';
        } else {
            currentPlayer = player === HUMAN ? AI : HUMAN;
            updateStatus();
            if (currentPlayer === AI) setTimeout(aiMove, 20);
        }
        updateStatus();
        return true;
    }

    function resetGame() {
        cancelAnalysis();
        board = createBoard();
        currentPlayer = HUMAN;
        gameActive = true;
        thinking = false;
        history = [];
        lastMove = null;
        winningLine = null;
        elapsedSeconds = 0;
        gameTime.textContent = '00:00';
        statusText.textContent = '黑方先行';
        searchStatus.textContent = 'READY';
        resultStone.classList.remove('is-white');
        winModal.classList.add('is-hidden');
        drawBoard();
        updateStatus();
        startTimer();
    }

    function undoMove() {
        if (thinking || !gameActive || history.length < 2) return;
        cancelAnalysis();
        for (let count = 0; count < 2; count++) {
            const move = history.pop();
            board[move.row][move.col] = 0;
        }
        lastMove = history[history.length - 1] || null;
        winningLine = null;
        currentPlayer = HUMAN;
        drawBoard();
        updateStatus();
    }

    canvas.addEventListener('click', event => {
        if (!gameActive || thinking || currentPlayer !== HUMAN) return;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const col = Math.round((x - boardMetrics.margin) / boardMetrics.cell);
        const row = Math.round((y - boardMetrics.margin) / boardMetrics.cell);
        if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return;
        const point = pointFor(row, col);
        if (Math.hypot(point.x - x, point.y - y) <= boardMetrics.cell * 0.48) makeMove(row, col, HUMAN);
    });

    document.getElementById('restartBtn').addEventListener('click', resetGame);
    document.getElementById('newGameBtn').addEventListener('click', resetGame);
    undoButton.addEventListener('click', undoMove);
    document.querySelector('.wordmark').addEventListener('click', event => {
        if (gameActive && history.length > 0 && !window.confirm('当前对局尚未结束，确定要离开吗？')) {
            event.preventDefault();
        }
    });
    document.querySelectorAll('input[name="ai-mode"]').forEach(input => {
        input.addEventListener('change', event => {
            mode = event.target.value;
            modeDescription.textContent = mode === 'mcts'
                ? '多棵搜索树并行推演，按访问统计选择落点。'
                : '全盘空位并行评分，再以 Alpha-Beta 极大极小搜索优化。';
            parallelText.textContent = mode === 'mcts' ? 'MCTS · 多树并行' : '评估函数 · 全盘空位并行';
        });
    });
    if ('ResizeObserver' in window) new ResizeObserver(updateCanvasSize).observe(canvas);
    else window.addEventListener('resize', updateCanvasSize);

    parallelText.textContent = typeof Worker === 'undefined' ? 'Worker 不可用 · 单线程回退' : `Worker 就绪 · 最多 ${workerCount(MAX_WORKERS)} 路`;
    updateCanvasSize();
    updateStatus();
    startTimer();
});