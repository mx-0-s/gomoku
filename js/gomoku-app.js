document.addEventListener('DOMContentLoaded', () => {
    const { SIZE, createBoard, cloneBoard, checkWin, listEmptyPoints, findOpeningMove, findImmediateMove, findVcfWin, findVctWin, chooseEvaluationMove } = GomokuEngine;
    let HUMAN = 1;
    let AI = 2;
    const MAX_WORKERS = 8;
    // Persistent workers: creating a Worker (and re-running importScripts) costs more than
    // a shallow search, so the pool is built once and reused for every move in the game.
    const POOL_SIZE = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
    const ROOT_LIMIT = 12;

    let board = createBoard();
    let currentPlayer = 1;
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
    let hoverPoint = null;
    let lastSearchMeta = null;

    function readPreference(key, fallback) {
        try {
            return localStorage.getItem(key) || fallback;
        } catch (error) {
            return fallback;
        }
    }

    function writePreference(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // Private mode or a file:// origin can forbid storage; the choice still works
            // for this session.
        }
    }

    let humanColor = readPreference('gomoku-color', '1') === '2' ? 2 : 1;
    // Two-player modes share the original `gomoku-color` key; self-play is a separate mode so
    // switching in and out restores the previous colour choice.
    let selfPlay = readPreference('gomoku-mode', 'human') === 'self';
    HUMAN = humanColor;
    AI = humanColor === 1 ? 2 : 1;

    const defaultSpeed = (navigator.hardwareConcurrency || 2) >= 8 ? 'standard' : 'fast';
    let speedMode = readPreference('gomoku-speed', defaultSpeed);
    // Migrate the old balanced/attack toggle: attack becomes 100%, balanced 0%.
    const legacyStyle = readPreference('gomoku-style', '');
    const storedIntensity = readPreference('gomoku-attack', legacyStyle === 'attack' ? '100' : '0');
    let attackIntensity = Math.max(0, Math.min(100, Number(storedIntensity) || 0));
    // Self-play keeps one style per colour. Both sides are AI and both search at D10.
    let blackIntensity = Math.max(0, Math.min(100, Number(readPreference('gomoku-selfplay-black', '0')) || 0));
    let whiteIntensity = Math.max(0, Math.min(100, Number(readPreference('gomoku-selfplay-white', '0')) || 0));

    function isHumanPlayer(player) {
        return !selfPlay && player === HUMAN;
    }

    function isAiPlayer(player) {
        return selfPlay || player === AI;
    }

    // The slider that drives the current mover: the single AI slider outside self-play, and
    // the colour-specific slider inside it.
    function intensityFor(player) {
        if (!selfPlay) return attackIntensity;
        return player === 1 ? blackIntensity : whiteIntensity;
    }

    function searchDepth() {
        if (selfPlay) return 10;
        return speedMode === 'fast' ? 8 : 10;
    }

    const canvas = document.getElementById('gameCanvas');
    const context = canvas.getContext('2d');
    const statusText = document.getElementById('statusText');
    const gameStatus = document.getElementById('gameStatus');
    const statusMark = document.getElementById('statusMark');
    const searchStatus = document.getElementById('searchStatus');
    const currentPlayerStone = document.getElementById('currentPlayer');
    const playerText = document.getElementById('playerText');
    const blackPlayerValue = document.getElementById('blackPlayerValue');
    const whitePlayerValue = document.getElementById('whitePlayerValue');
    const moveCount = document.getElementById('moveCount');
    const gameTime = document.getElementById('gameTime');
    const parallelText = document.getElementById('parallelText');
    const speedDescription = document.getElementById('speedDescription');
    const styleDescription = document.getElementById('styleDescription');
    const singleIntensityControl = document.getElementById('singleIntensityControl');
    const selfplayIntensities = document.getElementById('selfplayIntensities');
    const blackIntensitySlider = document.getElementById('blackIntensity');
    const blackIntensityOutput = document.getElementById('blackIntensityValue');
    const whiteIntensitySlider = document.getElementById('whiteIntensity');
    const whiteIntensityOutput = document.getElementById('whiteIntensityValue');
    const undoButton = document.getElementById('undoBtn');
    const winModal = document.getElementById('winModal');
    const winnerText = document.getElementById('winnerText');
    const winMessage = document.getElementById('winMessage');
    const resultStone = document.getElementById('resultStone');
    let workerPool = null;
    let taskSequence = 0;

    function createWorkerPool(size) {
        const workers = [];
        const idle = [];
        const queue = [];
        let closed = false;

        function dispatch() {
            while (!closed && idle.length > 0 && queue.length > 0) {
                const worker = idle.pop();
                const task = queue.shift();
                worker.current = task;
                task.worker = worker;
                worker.postMessage(task.payload);
            }
        }

        function finish(worker) {
            worker.current = null;
            idle.push(worker);
            dispatch();
        }

        function spawn() {
            const worker = new Worker('js/gomoku-worker.js');
            worker.current = null;
            worker.addEventListener('message', event => {
                const task = worker.current;
                if (!task || event.data.id !== task.id) return;
                finish(worker);
                task.resolve(event.data);
            });
            worker.addEventListener('error', event => {
                const task = worker.current;
                worker.current = null;
                if (task) task.reject(new Error(event.message || 'Worker failed'));
                try { worker.terminate(); } catch (error) { /* already gone */ }
                const index = workers.indexOf(worker);
                if (index >= 0) workers.splice(index, 1);
                if (closed) return;
                try {
                    idle.push(spawn());
                    dispatch();
                } catch (error) { /* no replacement available */ }
            });
            workers.push(worker);
            return worker;
        }

        function rejectAll(error) {
            closed = true;
            for (const task of queue.splice(0)) task.reject(error);
            for (const worker of workers) {
                const task = worker.current;
                worker.current = null;
                if (task) task.reject(error);
                try { worker.terminate(); } catch (terminateError) { /* already gone */ }
            }
        }

        try {
            for (let index = 0; index < size; index++) idle.push(spawn());
        } catch (error) {
            for (const worker of workers) {
                try { worker.terminate(); } catch (terminateError) { /* already gone */ }
            }
            throw error;
        }

        return {
            request(payload) {
                return new Promise((resolve, reject) => {
                    if (closed) {
                        reject(new Error('Worker pool closed'));
                        return;
                    }
                    taskSequence++;
                    const id = taskSequence;
                    queue.push({ id, payload: { ...payload, id }, resolve, reject, worker: null });
                    dispatch();
                });
            },
            close() {
                if (closed) return;
                rejectAll(new Error('Analysis cancelled'));
            }
        };
    }

    function poolRequest(payload) {
        if (!workerPool) workerPool = createWorkerPool(POOL_SIZE);
        return workerPool.request(payload);
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

    function pointFromEvent(event) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const col = Math.round((x - boardMetrics.margin) / boardMetrics.cell);
        const row = Math.round((y - boardMetrics.margin) / boardMetrics.cell);
        if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;
        const point = pointFor(row, col);
        if (Math.hypot(point.x - x, point.y - y) > boardMetrics.cell * 0.48) return null;
        return { row, col };
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
        if (hoverPoint && gameActive && !thinking && isHumanPlayer(currentPlayer)
            && !winningLine && board[hoverPoint.row][hoverPoint.col] === 0) {
            drawHoverStone(hoverPoint.row, hoverPoint.col);
        }
    }

    function drawHoverStone(row, col) {
        const { x, y } = pointFor(row, col);
        const radius = boardMetrics.cell * 0.42;
        const isBlack = HUMAN === 1;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = isBlack ? 'rgba(18, 26, 21, 0.16)' : 'rgba(255, 254, 250, 0.32)';
        context.fill();
        context.strokeStyle = isBlack ? 'rgba(18, 26, 21, 0.32)' : 'rgba(255, 254, 250, 0.7)';
        context.lineWidth = 1;
        context.stroke();
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
        if (player === 1) {
            gradient.addColorStop(0, '#555b57');
            gradient.addColorStop(1, '#101511');
        } else {
            gradient.addColorStop(0, '#fffefa');
            gradient.addColorStop(1, '#d7d4c9');
        }
        context.fillStyle = gradient;
        context.fill();
        context.strokeStyle = player === 1 ? '#101511' : '#c4c1b6';
        context.lineWidth = 1;
        context.stroke();
        if (lastMove && lastMove.row === row && lastMove.col === col) {
            context.beginPath();
            context.arc(x, y, Math.max(2, radius * 0.19), 0, Math.PI * 2);
            context.fillStyle = player === 1 ? '#f0a287' : '#c45e47';
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

    function formatCount(value) {
        if (value >= 10_000) return `${Math.round(value / 1000)}k`;
        if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
        return String(value);
    }

    function searchMetaText() {
        if (!lastSearchMeta) return 'READY';
        const { depth, roots, nodes, ms } = lastSearchMeta;
        const time = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
        return `D${depth} · ${roots}R · ${formatCount(nodes)}N · ${time}`;
    }

    function colorName(color) {
        return color === 1 ? '黑方' : '白方';
    }

    function syncColorControls() {
        document.querySelectorAll('input[name="human-color"]').forEach(input => {
            const value = input.value;
            input.checked = selfPlay ? value === 'self' : Number(value) === humanColor;
        });
        blackPlayerValue.textContent = selfPlay ? '自对弈 AI' : (humanColor === 1 ? '你' : 'AI 对手');
        whitePlayerValue.textContent = selfPlay ? '自对弈 AI' : (humanColor === 2 ? '你' : 'AI 对手');
    }

    function syncSpeedControls() {
        const activeMode = selfPlay ? 'standard' : speedMode;
        document.querySelectorAll('input[name="speed-mode"]').forEach(input => {
            input.checked = input.value === activeMode;
        });
        speedDescription.textContent = selfPlay
            ? '自对弈：黑白双方固定使用标准 D10（10 层搜索）。'
            : (speedMode === 'fast'
                ? '快速：全程 8 层，12 个根着。'
                : '标准：全程 10 层，12 个根着，思考更久。');
    }

    function intensityDescription(value) {
        if (value <= 0) return '均衡：根着排序更看重对手威胁，优先防守。';
        if (value < 50) return '轻度进攻：稍微重视自己的棋形。';
        if (value < 100) return '进攻：更重视自己的棋形，可能冒险。';
        return '强攻：最大进攻权重，风险也最高。';
    }

    function syncIntensityControl() {
        const slider = document.getElementById('attackIntensity');
        const output = document.getElementById('attackIntensityValue');
        if (slider) slider.value = String(attackIntensity);
        if (output) output.textContent = `${attackIntensity}%`;
        if (blackIntensitySlider) blackIntensitySlider.value = String(blackIntensity);
        if (blackIntensityOutput) blackIntensityOutput.textContent = `${blackIntensity}%`;
        if (whiteIntensitySlider) whiteIntensitySlider.value = String(whiteIntensity);
        if (whiteIntensityOutput) whiteIntensityOutput.textContent = `${whiteIntensity}%`;
        singleIntensityControl?.classList.toggle('is-hidden', selfPlay);
        selfplayIntensities?.classList.toggle('is-hidden', !selfPlay);
        styleDescription.textContent = selfPlay
            ? `自对弈：黑方 ${blackIntensity}% · 白方 ${whiteIntensity}%，0% 均衡、100% 强攻。`
            : intensityDescription(attackIntensity);
    }

    function syncOptionAvailability() {
        // Leaving self-play must stay possible while the engine is thinking, so mode radios
        // (and the per-colour sliders) remain live there; the speed is fixed at D10.
        const lockForThinking = thinking && !selfPlay;
        document.querySelectorAll('input[name="human-color"], input[name="speed-mode"]').forEach(input => {
            if (input.name === 'speed-mode') input.disabled = selfPlay || lockForThinking;
            else input.disabled = lockForThinking;
        });
        const slider = document.getElementById('attackIntensity');
        if (slider) slider.disabled = lockForThinking;
        if (blackIntensitySlider) blackIntensitySlider.disabled = !selfPlay;
        if (whiteIntensitySlider) whiteIntensitySlider.disabled = !selfPlay;
    }

    function updateStatus() {
        if (gameActive) {
            statusText.textContent = thinking ? `${colorName(currentPlayer)}正在分析局面` : `${colorName(currentPlayer)}回合`;
            playerText.textContent = selfPlay
                ? `${colorName(currentPlayer)} · 自对弈`
                : `${colorName(currentPlayer)} · ${currentPlayer === HUMAN ? '你' : 'AI'}`;
            currentPlayerStone.className = `stone ${currentPlayer === 1 ? 'stone-black' : 'stone-white'}`;
            gameStatus.classList.toggle('is-thinking', thinking);
        }
        moveCount.textContent = history.length.toString();
        undoButton.disabled = thinking || !gameActive || history.length < 2;
        syncOptionAvailability();
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
        if (workerPool) {
            workerPool.close();
            workerPool = null;
        }
    }

    async function evaluateInParallel(snapshot, candidates, version, player, intensity) {
        // Scoring every empty point takes a few milliseconds on the main thread. Doing it
        // here removes a whole worker round-trip and lets the pool spend its time on search.
        // In self-play the two colours can carry different styles, so the side to move sets
        // the engine's active weights before scoring and sends that same intensity to every
        // worker task.
        GomokuEngine.setAttackIntensity(intensity / 100);
        const rankedMoves = candidates
            .map(move => ({ row: move.row, col: move.col, score: GomokuEngine.scoreMove(snapshot, move.row, move.col, player) }))
            .sort((a, b) => b.score - a.score);
        if (!rankedMoves.length) return null;

        const depth = searchDepth();
        const rootMoves = [];
        const seen = new Set();
        // Forcing moves come first, then the best static scores. Twelve roots instead of
        // four to eight means a good defensive point no longer has to beat every quiet move
        // just to be searched at all.
        for (const move of [...GomokuEngine.getSearchMoves(snapshot, player, ROOT_LIMIT), ...rankedMoves]) {
            const key = move.row * SIZE + move.col;
            if (seen.has(key)) continue;
            seen.add(key);
            rootMoves.push({ row: move.row, col: move.col });
            if (rootMoves.length >= ROOT_LIMIT) break;
        }

        parallelText.textContent = `Alpha-Beta · 深度 ${depth} · ${rootMoves.length} 个根着`;
        const searchStarted = performance.now();
        const searchBatches = await Promise.all(rootMoves.map(move => poolRequest({
            board: snapshot,
            player,
            depth,
            intensity: intensity / 100,
            candidates: [move]
        })));
        if (version !== analysisId) return null;
        const searchElapsed = performance.now() - searchStarted;
        const ranked = searchBatches.flatMap(batch => batch.results)
            .sort((a, b) => (player === 2 ? b.score - a.score : a.score - b.score));
        if (!ranked.length) return rootMoves[0];
        lastSearchMeta = {
            depth,
            roots: rootMoves.length,
            nodes: ranked.reduce((sum, result) => sum + (result.nodes || 0), 0),
            ms: searchElapsed
        };
        // Equal scores are equally good as far as the evaluation is concerned, so one of them
        // is picked at random. Without this the AI replays the same game down to the move and
        // a single losing line repeats forever.
        const bestMoves = ranked.filter(result => result.score === ranked[0].score);
        return bestMoves[Math.floor(Math.random() * bestMoves.length)];
    }

    async function fallbackMove(snapshot, player) {
        parallelText.textContent = 'Worker 不可用 · 单线程回退';
        return chooseEvaluationMove(snapshot, player);
    }

    async function chooseAiMove(version, player) {
        const opponent = player === 1 ? 2 : 1;
        const snapshot = cloneBoard(board);
        // The Black AI opens at the centre; searching an empty board is pure waste.
        if (player === 1 && history.length === 0) return { row: 7, col: 7 };
        // Only the Black third move is booked (Kagetsu/Ugetsu); later moves search normally.
        const opening = findOpeningMove(snapshot, player);
        if (opening) return opening;
        const win = findImmediateMove(snapshot, player);
        if (win) return win;
        const block = findImmediateMove(snapshot, opponent);
        if (block) return block;
        // Continuous-four and continuous-threat wins are proofs, so they are played
        // without asking the search.
        const vcf = findVcfWin(snapshot, player);
        if (vcf) return vcf.move;
        const vct = findVctWin(snapshot, player);
        if (vct) return vct.move;
        const candidates = listEmptyPoints(snapshot);
        if (typeof Worker === 'undefined') return fallbackMove(snapshot, player);
        return evaluateInParallel(snapshot, candidates, version, player, intensityFor(player));
    }

    async function aiMove() {
        if (!gameActive || thinking) return;
        const player = currentPlayer;
        if (!isAiPlayer(player)) return;
        thinking = true;
        lastSearchMeta = null;
        searchStatus.textContent = `MINIMAX · D${searchDepth()} · 分析中`;
        updateStatus();
        GomokuEngine.setAttackIntensity(intensityFor(player) / 100);
        const version = analysisId;
        let move = null;
        try {
            move = await chooseAiMove(version, player);
        } catch (error) {
            if (version !== analysisId) return;
            if (workerPool) {
                workerPool.close();
                workerPool = null;
            }
            move = await fallbackMove(cloneBoard(board), player);
        }
        if (version !== analysisId) return;
        thinking = false;
        searchStatus.textContent = searchMetaText();
        if (move && gameActive && currentPlayer === player) makeMove(move.row, move.col, player);
        else updateStatus();
    }

    function makeMove(row, col, player) {
        if (!gameActive || board[row][col] !== 0 || (isHumanPlayer(player) && thinking)) return false;
        hoverPoint = null;
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
            statusText.textContent = player === 1 ? '黑棋获胜' : '白棋获胜';
            winnerText.textContent = player === 1 ? '黑棋获胜' : '白棋获胜';
            winMessage.textContent = selfPlay
                ? `自对弈第 ${history.length} 手，${colorName(player)}连成五子。`
                : (player === HUMAN ? '你赢下了这场对局。' : 'AI 赢下了这场对局。再试一局。');
            resultStone.classList.toggle('is-white', player === 2);
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
            currentPlayer = player === 1 ? 2 : 1;
            updateStatus();
            if (isAiPlayer(currentPlayer)) setTimeout(aiMove, 20);
        }
        updateStatus();
        return true;
    }

    function resetGame() {
        cancelAnalysis();
        board = createBoard();
        currentPlayer = 1;
        gameActive = true;
        thinking = false;
        history = [];
        lastMove = null;
        winningLine = null;
        hoverPoint = null;
        lastSearchMeta = null;
        elapsedSeconds = 0;
        gameTime.textContent = '00:00';
        statusText.textContent = '黑方先行';
        searchStatus.textContent = 'READY';
        resultStone.classList.remove('is-white');
        winModal.classList.add('is-hidden');
        drawBoard();
        updateStatus();
        startTimer();
        if (isAiPlayer(currentPlayer)) setTimeout(aiMove, 80);
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
        hoverPoint = null;
        lastSearchMeta = null;
        // Black always moves first; the next mover follows the parity of the remaining moves.
        currentPlayer = history.length % 2 === 0 ? 1 : 2;
        drawBoard();
        updateStatus();
        if (isAiPlayer(currentPlayer)) setTimeout(aiMove, 20);
    }

    canvas.addEventListener('click', event => {
        if (!gameActive || thinking || !isHumanPlayer(currentPlayer)) return;
        const point = pointFromEvent(event);
        if (point) makeMove(point.row, point.col, HUMAN);
    });

    canvas.addEventListener('mousemove', event => {
        const point = gameActive && !thinking && isHumanPlayer(currentPlayer) ? pointFromEvent(event) : null;
        const next = point && board[point.row][point.col] === 0 ? point : null;
        if (next?.row === hoverPoint?.row && next?.col === hoverPoint?.col) return;
        hoverPoint = next;
        drawBoard();
    });

    canvas.addEventListener('mouseleave', () => {
        if (!hoverPoint) return;
        hoverPoint = null;
        drawBoard();
    });

    document.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
        const tag = event.target && event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (event.key === 'r' || event.key === 'R') {
            event.preventDefault();
            resetGame();
        } else if (event.key === 'u' || event.key === 'U') {
            event.preventDefault();
            undoMove();
        }
    });

    document.getElementById('restartBtn').addEventListener('click', resetGame);
    document.getElementById('newGameBtn').addEventListener('click', resetGame);
    undoButton.addEventListener('click', undoMove);
    document.querySelector('.wordmark').addEventListener('click', event => {
        if (gameActive && history.length > 0 && !window.confirm('当前对局尚未结束，确定要离开吗？')) {
            event.preventDefault();
        }
    });
    document.querySelectorAll('input[name="human-color"]').forEach(input => {
        input.addEventListener('change', event => {
            const value = event.target.value;
            if (value === 'self') {
                selfPlay = true;
            } else {
                selfPlay = false;
                humanColor = Number(value) === 2 ? 2 : 1;
                writePreference('gomoku-color', String(humanColor));
            }
            writePreference('gomoku-mode', selfPlay ? 'self' : 'human');
            HUMAN = humanColor;
            AI = humanColor === 1 ? 2 : 1;
            syncColorControls();
            syncSpeedControls();
            syncIntensityControl();
            resetGame();
        });
    });
    document.querySelectorAll('input[name="speed-mode"]').forEach(input => {
        input.addEventListener('change', event => {
            if (selfPlay) return;
            speedMode = event.target.value;
            writePreference('gomoku-speed', speedMode);
            syncSpeedControls();
            updateStatus();
        });
    });
    const attackSlider = document.getElementById('attackIntensity');
    if (attackSlider) {
        attackSlider.addEventListener('input', event => {
            attackIntensity = Math.max(0, Math.min(100, Number(event.target.value) || 0));
            syncIntensityControl();
        });
        attackSlider.addEventListener('change', () => {
            writePreference('gomoku-attack', String(attackIntensity));
        });
    }
    if (blackIntensitySlider) {
        blackIntensitySlider.addEventListener('input', event => {
            blackIntensity = Math.max(0, Math.min(100, Number(event.target.value) || 0));
            syncIntensityControl();
        });
        blackIntensitySlider.addEventListener('change', () => {
            writePreference('gomoku-selfplay-black', String(blackIntensity));
        });
    }
    if (whiteIntensitySlider) {
        whiteIntensitySlider.addEventListener('input', event => {
            whiteIntensity = Math.max(0, Math.min(100, Number(event.target.value) || 0));
            syncIntensityControl();
        });
        whiteIntensitySlider.addEventListener('change', () => {
            writePreference('gomoku-selfplay-white', String(whiteIntensity));
        });
    }
    if ('ResizeObserver' in window) new ResizeObserver(updateCanvasSize).observe(canvas);
    else window.addEventListener('resize', updateCanvasSize);

    syncColorControls();
    syncSpeedControls();
    syncIntensityControl();
    parallelText.textContent = typeof Worker === 'undefined' ? 'Worker 不可用 · 单线程回退' : `Worker 就绪 · 常驻 ${POOL_SIZE} 路`;
    updateCanvasSize();
    updateStatus();
    startTimer();
    if (isAiPlayer(currentPlayer)) setTimeout(aiMove, 80);
});