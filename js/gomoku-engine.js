(function (root, factory) {
    const engine = factory();
    if (typeof module === 'object' && module.exports) module.exports = engine;
    root.GomokuEngine = engine;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
    const SIZE = 15;
    const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const WIN_SCORE = 1_000_000_000;
    const SEARCH_BRANCH_LIMIT = 4;
    const SCORES = {
        openFour: 100_000,
        doubleOpenFour: 500_000,
        four: 10_000,
        openThree: 10_000,
        doubleOpenThree: 30_000,
        three: 1_000,
        openTwo: 1_000,
        two: 100
    };
    const POSITION_SCORE = [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 2, 2, 2, 3, 2, 2, 2, 1, 1, 1, 0],
        [0, 1, 2, 3, 3, 3, 3, 4, 3, 3, 3, 3, 2, 1, 0],
        [0, 1, 3, 4, 4, 4, 4, 5, 4, 4, 4, 4, 3, 1, 0],
        [0, 2, 3, 4, 5, 5, 5, 6, 5, 5, 5, 4, 3, 2, 0],
        [0, 2, 3, 4, 5, 6, 6, 7, 6, 6, 5, 4, 3, 2, 0],
        [0, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 0],
        [0, 3, 4, 5, 6, 7, 8, 10, 8, 7, 6, 5, 4, 3, 0],
        [0, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 0],
        [0, 2, 3, 4, 5, 6, 6, 7, 6, 6, 5, 4, 3, 2, 0],
        [0, 2, 3, 4, 5, 5, 5, 6, 5, 5, 5, 4, 3, 2, 0],
        [0, 1, 3, 4, 4, 4, 4, 5, 4, 4, 4, 4, 3, 1, 0],
        [0, 1, 2, 3, 3, 3, 3, 4, 3, 3, 3, 3, 2, 1, 0],
        [0, 1, 1, 1, 2, 2, 2, 3, 2, 2, 2, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ];

    function createBoard() {
        return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    }

    function cloneBoard(board) {
        return board.map(row => row.slice());
    }

    function checkWin(board, row, col, player) {
        for (const [dx, dy] of DIRECTIONS) {
            const line = [{ row, col }];
            for (const sign of [1, -1]) {
                for (let step = 1; step < 5; step++) {
                    const nextRow = row + sign * dy * step;
                    const nextCol = col + sign * dx * step;
                    if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE || board[nextRow][nextCol] !== player) break;
                    if (sign === 1) line.push({ row: nextRow, col: nextCol });
                    else line.unshift({ row: nextRow, col: nextCol });
                }
            }
            if (line.length >= 5) return line;
        }
        return null;
    }

    function evaluatePattern(board, row, col, player) {
        if (board[row][col] !== 0) return -Infinity;
        let score = 0;
        let openThreeCount = 0;
        let openFourCount = 0;
        board[row][col] = player;
        try {
            for (const [dx, dy] of DIRECTIONS) {
                let count = 1;
                let blockedCount = 0;
                for (const sign of [1, -1]) {
                    for (let step = 1; step < 5; step++) {
                        const nextRow = row + sign * dy * step;
                        const nextCol = col + sign * dx * step;
                        if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE) {
                            blockedCount++;
                            break;
                        }
                        if (board[nextRow][nextCol] === player) count++;
                        else {
                            if (board[nextRow][nextCol] !== 0) blockedCount++;
                            break;
                        }
                    }
                }

                if (count >= 5) score += WIN_SCORE;
                else if (count === 4) {
                    if (blockedCount === 0) {
                        score += SCORES.openFour;
                        openFourCount++;
                    } else if (blockedCount === 1) score += SCORES.four;
                } else if (count === 3) {
                    if (blockedCount === 0) {
                        score += SCORES.openThree;
                        openThreeCount++;
                    } else if (blockedCount === 1) score += SCORES.three;
                } else if (count === 2) {
                    if (blockedCount === 0) score += SCORES.openTwo;
                    else if (blockedCount === 1) score += SCORES.two;
                }
            }
        } finally {
            board[row][col] = 0;
        }
        if (openFourCount >= 2) score += SCORES.doubleOpenFour;
        else if (openThreeCount >= 2) score += SCORES.doubleOpenThree;
        return score;
    }

    function evaluateMove(board, row, col, player) {
        return evaluatePattern(board, row, col, player) + POSITION_SCORE[row][col];
    }

    function scoreMove(board, row, col, player) {
        const opponent = player === 1 ? 2 : 1;
        return evaluatePattern(board, row, col, player)
            + evaluatePattern(board, row, col, opponent) * 1.2
            + POSITION_SCORE[row][col];
    }

    function listEmptyPoints(board) {
        const points = [];
        for (let row = 0; row < SIZE; row++) {
            for (let col = 0; col < SIZE; col++) {
                if (board[row][col] === 0) points.push({ row, col });
            }
        }
        return points;
    }

    function listCandidateMoves(board) {
        const occupied = [];
        for (let row = 0; row < SIZE; row++) {
            for (let col = 0; col < SIZE; col++) {
                if (board[row][col] !== 0) occupied.push({ row, col });
            }
        }
        if (occupied.length === 0) return [{ row: 7, col: 7 }];

        const candidates = [];
        const seen = new Set();
        for (const point of occupied) {
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    const row = point.row + dr;
                    const col = point.col + dc;
                    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE || board[row][col] !== 0) continue;
                    const key = row * SIZE + col;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    candidates.push({ row, col });
                }
            }
        }
        return candidates;
    }

    function getCandidateMoves(board, player, limit = 24) {
        if (board.every(row => row.every(cell => cell === 0))) return [{ row: 7, col: 7, score: POSITION_SCORE[7][7] }];
        const candidates = listCandidateMoves(board).map(move => {
            return { ...move, score: scoreMove(board, move.row, move.col, player) };
        });
        return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    function findImmediateMove(board, player) {
        for (const move of listCandidateMoves(board)) {
            board[move.row][move.col] = player;
            const win = checkWin(board, move.row, move.col, player);
            board[move.row][move.col] = 0;
            if (win) return { row: move.row, col: move.col };
        }
        return null;
    }

    function evaluateBoard(board, player) {
        const opponent = player === 1 ? 2 : 1;
        const ownThreat = getCandidateMoves(board, player, 12)[0]?.score || 0;
        const opponentThreat = getCandidateMoves(board, opponent, 12)[0]?.score || 0;
        return ownThreat - opponentThreat;
    }

    function searchDepthForMoves(moveCount) {
        if (moveCount <= 4) return 4;
        if (moveCount <= 20) return 8;
        return 10;
    }

    function alphaBeta(board, depth, alpha, beta, player, lastMove, context, ply) {
        context.nodes++;
        if (lastMove && checkWin(board, lastMove.row, lastMove.col, lastMove.player)) {
            return { score: lastMove.player === 2 ? WIN_SCORE - ply : -WIN_SCORE + ply };
        }
        if (depth === 0) return { score: evaluateBoard(board, 2) };

        const moves = getCandidateMoves(board, player, SEARCH_BRANCH_LIMIT);
        if (moves.length === 0) return { score: evaluateBoard(board, 2) };
        const maximizing = player === 2;
        let bestScore = maximizing ? -Infinity : Infinity;
        let bestMove = moves[0];

        for (const move of moves) {
            board[move.row][move.col] = player;
            const result = alphaBeta(
                board,
                depth - 1,
                alpha,
                beta,
                player === 1 ? 2 : 1,
                { ...move, player },
                context,
                ply + 1
            );
            board[move.row][move.col] = 0;

            if ((maximizing && result.score > bestScore) || (!maximizing && result.score < bestScore)) {
                bestScore = result.score;
                bestMove = move;
            }
            if (maximizing) alpha = Math.max(alpha, bestScore);
            else beta = Math.min(beta, bestScore);
            if (beta <= alpha) {
                context.cutoffs++;
                break;
            }
        }
        return { score: bestScore, move: bestMove };
    }

    function searchRootMove(board, move, player, depth) {
        const searchBoard = cloneBoard(board);
        searchBoard[move.row][move.col] = player;
        const context = { nodes: 0, cutoffs: 0 };
        const result = alphaBeta(
            searchBoard,
            depth - 1,
            -Infinity,
            Infinity,
            player === 1 ? 2 : 1,
            { ...move, player },
            context,
            1
        );
        return { row: move.row, col: move.col, score: result.score, nodes: context.nodes, cutoffs: context.cutoffs, depth };
    }

    function chooseEvaluationMove(board, player) {
        const ownWin = findImmediateMove(board, player);
        if (ownWin) return ownWin;
        const block = findImmediateMove(board, player === 1 ? 2 : 1);
        if (block) return block;
        const moves = listEmptyPoints(board).map(move => ({ ...move, score: scoreMove(board, move.row, move.col, player) }));
        return moves[0] ? { row: moves[0].row, col: moves[0].col } : null;
    }

    function createRandom(seed) {
        let state = seed >>> 0 || 1;
        return function () {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 0x1_0000_0000;
        };
    }

    function runMcts(board, player, iterations, seed) {
        const random = createRandom(seed);
        const rootPlayer = player;
        const makeNode = (position, nextPlayer, move, parent) => ({
            board: position,
            player: nextPlayer,
            move,
            parent,
            children: [],
            untried: getCandidateMoves(position, nextPlayer, 14),
            visits: 0,
            wins: 0
        });
        const root = makeNode(cloneBoard(board), player, null, null);

        function selectChild(node) {
            const maximizing = node.player === rootPlayer;
            let best = null;
            let bestValue = maximizing ? -Infinity : Infinity;
            for (const child of node.children) {
                const exploitation = child.wins / child.visits;
                const exploration = Math.sqrt(2 * Math.log(node.visits) / child.visits);
                const value = exploitation + (maximizing ? exploration : -exploration);
                if ((maximizing && value > bestValue) || (!maximizing && value < bestValue)) {
                    best = child;
                    bestValue = value;
                }
            }
            return best;
        }

        function rollout(position, nextPlayer) {
            let current = nextPlayer;
            for (let turn = 0; turn < 20; turn++) {
                const win = findImmediateMove(position, current);
                const move = win || findImmediateMove(position, current === 1 ? 2 : 1);
                const moves = getCandidateMoves(position, current, 8);
                if (moves.length === 0) return 0.5;
                const selected = move || moves[Math.floor(random() * Math.min(5, moves.length))];
                position[selected.row][selected.col] = current;
                if (checkWin(position, selected.row, selected.col, current)) return current === rootPlayer ? 1 : 0;
                current = current === 1 ? 2 : 1;
            }
            const difference = evaluateBoard(position, rootPlayer);
            return 0.5 + 0.5 * difference / (Math.abs(difference) + 100_000);
        }

        for (let iteration = 0; iteration < iterations; iteration++) {
            let node = root;
            while (node.untried.length === 0 && node.children.length > 0) node = selectChild(node);
            if (node.untried.length > 0) {
                const index = Math.floor(random() * node.untried.length);
                const move = node.untried.splice(index, 1)[0];
                const nextBoard = cloneBoard(node.board);
                nextBoard[move.row][move.col] = node.player;
                node = makeNode(nextBoard, node.player === 1 ? 2 : 1, move, node);
                node.parent.children.push(node);
            }
            const result = rollout(cloneBoard(node.board), node.player);
            for (let current = node; current; current = current.parent) {
                current.visits++;
                current.wins += result;
            }
        }

        return root.children.map(child => ({ ...child.move, visits: child.visits, wins: child.wins }));
    }

    return { SIZE, WIN_SCORE, createBoard, cloneBoard, checkWin, evaluatePattern, evaluateMove, scoreMove, evaluateBoard, listEmptyPoints, listCandidateMoves, getCandidateMoves, findImmediateMove, chooseEvaluationMove, searchDepthForMoves, searchRootMove, runMcts };
});