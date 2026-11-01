(function (root, factory) {
    const engine = factory();
    if (typeof module === 'object' && module.exports) module.exports = engine;
    root.GomokuEngine = engine;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
    const SIZE = 15;
    const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];
    const WIN_SCORE = 1_000_000_000;
    const SEARCH_BRANCH_LIMIT = 4;
    const MAX_FORCED_MOVES = 6;
    const VCF_MAX_DEPTH = 20;
    const VCF_MAX_NODES = 2000;
    const QUIESCE_PLIES = 4;
    const QUIESCE_NODES = 32;
    const SCORES = {
        openFour: 100_000,
        doubleOpenFour: 500_000,
        doubleFour: 400_000,
        fourThree: 300_000,
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
        let fourCount = 0;
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
                    } else if (blockedCount === 1) {
                        score += SCORES.four;
                        fourCount++;
                    }
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
        // A double four (two closed fours, or an open four plus a closed four) and a
        // four-plus-open-three are both forced wins, so they must outrank a lone open four.
        if (openFourCount >= 2) score += SCORES.doubleOpenFour;
        else if (openFourCount + fourCount >= 2) score += SCORES.doubleFour;
        else if (fourCount >= 1 && openThreeCount >= 1) score += SCORES.fourThree;
        else if (openThreeCount >= 2) score += SCORES.doubleOpenThree;
        return score;
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

    function patternLevel(value) {
        if (value >= WIN_SCORE) return 5;
        if (value >= SCORES.openFour) return 4;
        if (value >= SCORES.openThree) return 3;
        return 0;
    }

    // Move generation for the search. Forcing points are never truncated away, so the one
    // move that answers an opponent's five or four can never fall outside the candidate set —
    // which is what a plain top-N cut silently does. Blocking an opponent open three is
    // covered as well, because that point makes an open four for them (a four-level threat).
    function getSearchMoves(board, player, limit = SEARCH_BRANCH_LIMIT) {
        const opponent = player === 1 ? 2 : 1;
        const points = [];
        for (const move of listCandidateMoves(board)) {
            const own = evaluatePattern(board, move.row, move.col, player);
            const threat = evaluatePattern(board, move.row, move.col, opponent);
            points.push({
                row: move.row,
                col: move.col,
                own,
                threat,
                score: own + threat * 1.2 + POSITION_SCORE[move.row][move.col]
            });
        }
        points.sort((a, b) => b.score - a.score);

        const wins = points.filter(point => patternLevel(point.own) === 5);
        if (wins.length) return wins;

        const blocks = points.filter(point => patternLevel(point.threat) === 5);
        if (blocks.length) return blocks;

        // A four-level point either wins by force (open four, double four, four-three) or is
        // where the opponent would win by force, so every one of them is searched. Softer
        // three-level threats keep competing through the normal score ordering instead of
        // widening the tree, which keeps the branching close to the old width.
        const forced = points.filter(point => patternLevel(point.own) >= 4 || patternLevel(point.threat) >= 4);
        const selected = forced.slice(0, MAX_FORCED_MOVES);
        const seen = new Set(selected.map(point => point.row * SIZE + point.col));
        for (const point of points) {
            if (selected.length >= limit) break;
            const key = point.row * SIZE + point.col;
            if (seen.has(key)) continue;
            seen.add(key);
            selected.push(point);
        }
        return selected;
    }

    // Up to `limit` empty points where `player` would immediately complete a five.
    function fivePointList(board, player, limit = 1) {
        const points = [];
        for (const move of listCandidateMoves(board)) {
            board[move.row][move.col] = player;
            const win = checkWin(board, move.row, move.col, player);
            board[move.row][move.col] = 0;
            if (!win) continue;
            points.push({ row: move.row, col: move.col });
            if (points.length >= limit) break;
        }
        return points;
    }

    function findImmediateMove(board, player) {
        const points = fivePointList(board, player, 1);
        return points.length ? points[0] : null;
    }

    // The five points a just-placed stone creates, found by sliding the five-cell windows that
    // contain it instead of rescanning the whole board. `board[row][col]` must hold `player`.
    function fivePointsThrough(board, row, col, player) {
        const points = [];
        for (const [dx, dy] of DIRECTIONS) {
            for (let offset = -4; offset <= 0; offset++) {
                let empty = null;
                let valid = true;
                for (let step = 0; step < 5; step++) {
                    const nextRow = row + (offset + step) * dy;
                    const nextCol = col + (offset + step) * dx;
                    if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE) { valid = false; break; }
                    const cell = board[nextRow][nextCol];
                    if (cell === player) continue;
                    if (cell !== 0 || empty) { valid = false; break; }
                    empty = { row: nextRow, col: nextCol };
                }
                if (valid && empty) points.push(empty);
            }
        }
        return points;
    }

    // Victory by Continuous Fours. Only moves that keep creating a four are played, so the
    // opponent has exactly one legal answer at every step and the line stays forcing all the
    // way down. Returns `{ move, line, nodes }` for a proven win, or null.
    function findVcfWin(board, player, maxDepth = VCF_MAX_DEPTH) {
        const opponent = player === 1 ? 2 : 1;
        const budget = { nodes: 0 };

        function search(depth) {
            if (depth <= 0 || budget.nodes >= VCF_MAX_NODES) return null;
            budget.nodes++;
            for (const move of listCandidateMoves(board)) {
                if (patternLevel(evaluatePattern(board, move.row, move.col, player)) < 3) continue;
                board[move.row][move.col] = player;
                if (checkWin(board, move.row, move.col, player)) {
                    board[move.row][move.col] = 0;
                    return [move];
                }
                // The opponent moves next. If he can still complete a five, he simply wins
                // before our four is converted, so this move cannot start a forcing line.
                // (A move that blocks his five point clears this check.)
                if (findImmediateMove(board, opponent) !== null) {
                    board[move.row][move.col] = 0;
                    continue;
                }
                const fives = fivePointsThrough(board, move.row, move.col, player);
                if (fives.length === 0) {
                    board[move.row][move.col] = 0;
                    continue;
                }
                // Two five points means the block cannot cover both: open four or double four.
                if (fives.length >= 2) {
                    board[move.row][move.col] = 0;
                    return [move];
                }
                const block = fives[0];
                board[block.row][block.col] = opponent;
                // A block that either completes a five for the opponent or hands him a five
                // threat kills this line: he would win instead of answering.
                const counter = checkWin(board, block.row, block.col, opponent)
                    || findImmediateMove(board, opponent) !== null;
                const deeper = counter ? null : search(depth - 2);
                board[block.row][block.col] = 0;
                board[move.row][move.col] = 0;
                if (deeper) return [move, ...deeper];
            }
            return null;
        }

        const line = search(maxDepth);
        return line ? { move: line[0], line, nodes: budget.nodes } : null;
    }

    // The strongest pattern `player` can still create on an empty point. Measured with
    // evaluatePattern only, so the two sides never leak into each other's number.
    function bestThreat(board, player) {
        let best = 0;
        for (const move of listCandidateMoves(board)) {
            const value = evaluatePattern(board, move.row, move.col, player);
            if (value >= WIN_SCORE) return WIN_SCORE;
            if (value > best) best = value;
        }
        return best;
    }

    // Static evaluation from `player`'s point of view. The opponent's threat is weighted
    // slightly higher because it forces a reply. The result is clamped well below WIN_SCORE
    // so that a terminal win always outranks any static position.
    function evaluateBoard(board, player) {
        const opponent = player === 1 ? 2 : 1;
        const raw = bestThreat(board, player) - 1.1 * bestThreat(board, opponent);
        const cap = WIN_SCORE / 2;
        return Math.max(-cap, Math.min(cap, raw));
    }

    // Points where `player` would create a four, i.e. a move that leaves him one step from a
    // five. Found structurally (does the stone create a five point?) because the score table
    // rates a plain four and an open three identically.
    function fourThreatPoints(board, player) {
        const points = [];
        for (const move of listCandidateMoves(board)) {
            if (evaluatePattern(board, move.row, move.col, player) < SCORES.four) continue;
            board[move.row][move.col] = player;
            const creates = fivePointsThrough(board, move.row, move.col, player).length > 0;
            board[move.row][move.col] = 0;
            if (creates) points.push({ row: move.row, col: move.col });
        }
        return points;
    }

    // Quiescence for forcing threats. Without it every leaf that reaches a five point
    // collapses to the same clamp value, so at the horizon the search cannot tell a lost
    // position from a merely risky one and picks by move order. Fours get one exchange layer
    // on top of that: a four threatens to become a five threat, which the static score alone
    // can only discount by a fixed factor.
    function resolveThreats(board, sideToMove, ply, budget, ctx) {
        const other = sideToMove === 1 ? 2 : 1;
        if (findImmediateMove(board, sideToMove)) {
            return sideToMove === 2 ? WIN_SCORE - ply : -WIN_SCORE + ply;
        }
        const five = fivePointList(board, other, 2);
        if (five.length >= 2) {
            return other === 2 ? WIN_SCORE - ply : -WIN_SCORE + ply;
        }
        if (budget <= 0 || ctx.nodes >= QUIESCE_NODES) return evaluateBoard(board, 2);
        if (five.length === 1) {
            // Blocking the single five point is the only playable move.
            ctx.nodes++;
            const block = five[0];
            board[block.row][block.col] = sideToMove;
            const score = resolveThreats(board, other, ply + 1, budget - 1, ctx);
            board[block.row][block.col] = 0;
            return score;
        }

        const mine = fourThreatPoints(board, sideToMove);
        const theirs = fourThreatPoints(board, other);
        if (mine.length === 0 && theirs.length === 0) return evaluateBoard(board, 2);

        // One static ply over the forcing candidates only. Recursing here cost roughly eight
        // times the search time, which is not affordable without a time budget.
        const moves = [];
        const seen = new Set();
        for (const move of [...theirs.slice(0, 2), ...mine.slice(0, 1)]) {
            const key = move.row * SIZE + move.col;
            if (seen.has(key)) continue;
            seen.add(key);
            moves.push(move);
        }
        const maximizing = sideToMove === 2;
        let best = maximizing ? -Infinity : Infinity;
        for (const move of moves) {
            board[move.row][move.col] = sideToMove;
            const score = evaluateBoard(board, 2);
            board[move.row][move.col] = 0;
            if (maximizing ? score > best : score < best) best = score;
        }
        return best;
    }

    function leafScore(board, sideToMove, ply) {
        const score = evaluateBoard(board, 2);
        // Quiet leaves (no three or better anywhere) are returned as-is: the quiescence only
        // pays for itself where the play is actually forcing.
        if (Math.abs(score) < SCORES.four) return score;
        return resolveThreats(board, sideToMove, ply, QUIESCE_PLIES, { nodes: 0 });
    }

    // The opening used to get only four plies, which is one ply short of seeing that letting
    // the opponent build an open three loses: the AI developed while the opponent made a
    // three and was on the defensive for the rest of the game. Eight plies from the start
    // fixes that at a cost of a few hundred milliseconds per early move.
    function searchDepthForMoves(moveCount) {
        if (moveCount <= 20) return 8;
        return 10;
    }

    function alphaBeta(board, depth, alpha, beta, player, lastMove, context, ply) {
        context.nodes++;
        if (lastMove && checkWin(board, lastMove.row, lastMove.col, lastMove.player)) {
            return { score: lastMove.player === 2 ? WIN_SCORE - ply : -WIN_SCORE + ply };
        }
        if (depth === 0) return { score: leafScore(board, player, ply) };

        const moves = getSearchMoves(board, player, SEARCH_BRANCH_LIMIT);
        if (moves.length === 0) return { score: leafScore(board, player, ply) };
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
        const opponent = player === 1 ? 2 : 1;
        // A proven continuous-four win for the opponent means this root move simply loses.
        // Scoring it as a loss (delayed by the line length) keeps the engine from ranking a
        // dead move above a live one, and it costs about a millisecond per root.
        if (!checkWin(searchBoard, move.row, move.col, player)) {
            const counter = findVcfWin(searchBoard, opponent);
            if (counter) {
                const penalty = Math.min(counter.line.length * 2, WIN_SCORE / 2);
                return {
                    row: move.row,
                    col: move.col,
                    score: opponent === 2 ? WIN_SCORE - penalty : -WIN_SCORE + penalty,
                    nodes: counter.nodes,
                    cutoffs: 0,
                    depth
                };
            }
        }
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
        const vcf = findVcfWin(board, player);
        if (vcf) return vcf.move;
        const moves = listEmptyPoints(board).map(move => ({ ...move, score: scoreMove(board, move.row, move.col, player) }));
        moves.sort((a, b) => b.score - a.score);
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

    return { SIZE, WIN_SCORE, createBoard, cloneBoard, checkWin, evaluatePattern, scoreMove, evaluateBoard, bestThreat, listEmptyPoints, listCandidateMoves, getCandidateMoves, getSearchMoves, findImmediateMove, fivePointsThrough, findVcfWin, resolveThreats, fourThreatPoints, chooseEvaluationMove, searchDepthForMoves, searchRootMove, runMcts };
});


