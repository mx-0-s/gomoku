(function (root, factory) {
    const engine = factory();
    if (typeof module === 'object' && module.exports) module.exports = engine;
    root.GomokuEngine = engine;
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
    const SIZE = 15;
    const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];
    // Transposition table. Forcing lines revisit the same positions constantly, so a small
    // direct-mapped table is enough. Each entry is verified with a second 32-bit key, which
    // keeps collisions from returning a wrong score.
    const TT_BITS = 17;
    const TT_SIZE = 1 << TT_BITS;
    const TT_MASK = TT_SIZE - 1;
    const TT_EXACT = 1;
    const TT_LOWER = 2;
    const TT_UPPER = 3;
    const ttKeyA = new Int32Array(TT_SIZE);
    const ttKeyB = new Int32Array(TT_SIZE);
    const ttDepth = new Int8Array(TT_SIZE);
    const ttFlag = new Int8Array(TT_SIZE);
    const ttScore = new Float64Array(TT_SIZE);
    const ttMove = new Int16Array(TT_SIZE);
    ttMove.fill(-1);

    const ZOBRIST_A = new Int32Array(SIZE * SIZE * 2);
    const ZOBRIST_B = new Int32Array(SIZE * SIZE * 2);
    (function initZobrist() {
        let state = 0x9e3779b9;
        const next = () => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return state | 0;
        };
        for (let index = 0; index < ZOBRIST_A.length; index++) {
            ZOBRIST_A[index] = next();
            ZOBRIST_B[index] = next();
        }
    })();

    function positionKey(board) {
        let a = 0;
        let b = 0;
        for (let row = 0; row < SIZE; row++) {
            for (let col = 0; col < SIZE; col++) {
                const cell = board[row][col];
                if (cell === 0) continue;
                const index = (row * SIZE + col) * 2 + (cell - 1);
                a ^= ZOBRIST_A[index];
                b ^= ZOBRIST_B[index];
            }
        }
        return { a, b };
    }
    // Six-cell templates for a live three, encoded in base 3 so a candidate window is one
    // integer compare instead of 24 cell compares. The placed stone is one of the three 1s,
    // so `.X.XX.` and `.XX.X.` cover the broken ("jump") threes that the old contiguous scan
    // could only read as a two. This is the hottest loop in the search.
    const POW3_5 = 243;

    function isOpenThreeCode(code) {
        switch (code) {
            case 117: // 011100  .XXX..
            case 39:  // 001110  ..XXX.
            case 93:  // 010110  .X.XX.
            case 111: // 011010  .XX.X.
                return true;
            default:
                return false;
        }
    }
    const WIN_SCORE = 1_000_000_000;
    const SEARCH_BRANCH_LIMIT = 4;
    const MAX_FORCED_MOVES = 6;
    const VCF_MAX_DEPTH = 20;
    const VCF_MAX_NODES = 2000;
    const VCT_MAX_DEPTH = 12;
    const VCT_MAX_NODES = 1200;
    const VCT_DEFENSE_NODES = 400;
    // Empty cells inside a live-three window that actually stop it turning into an open
    // four. A contiguous three only has its two ends; a jump three also has the gap.
    const OPEN_THREE_DEFENSE = {
        117: [0, 4],    // 011100  .XXX..
        39: [1, 5],     // 001110  ..XXX.
        93: [0, 2, 5],  // 010110  .X.XX.
        111: [0, 3, 5]  // 011010  .XX.X.
    };
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
    // Play-style slider. 0 is Balanced and 1 is Attack; intermediate values interpolate the
    // aggregation weights and the VCT attack budget. Immediate wins/blocks, forced
    // candidates and VCT defense never change.
    const STYLE_PRESETS = {
        balanced: {
            moveOpponent: 1.2,
            boardOpponent: 1.1,
            levelFour: 10_000,
            vctNodes: VCT_MAX_NODES
        },
        attack: {
            moveOpponent: 1.0,
            boardOpponent: 0.9,
            levelFour: 14_000,
            vctNodes: 1800
        }
    };
    let activeIntensity = 0;
    let activeStyle = STYLE_PRESETS.balanced;

    function setAttackIntensity(value) {
        const intensity = Math.max(0, Math.min(1, Number(value) || 0));
        if (Math.abs(intensity - activeIntensity) < 1e-4) return;
        activeIntensity = intensity;
        activeStyle = {
            moveOpponent: 1.2 - 0.2 * intensity,
            boardOpponent: 1.1 - 0.2 * intensity,
            levelFour: 10_000 + 4_000 * intensity,
            vctNodes: Math.round(1_200 + 600 * intensity)
        };
        // Scores in the table were produced with the old weights, so drop them.
        ttFlag.fill(0);
    }

    function setStyle(name) {
        setAttackIntensity(name === 'attack' ? 1 : 0);
    }

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

    // Scores one placement and reports the threat shapes it creates. A quick contiguous scan
    // runs for every direction; only a line holding at least two other own stones can hide a
    // broken shape (a three needs three own stones in total), so the 9-cell window work is
    // skipped for the many quiet directions that dominate the search.
    // Scratch buffer for the 9-cell line. `analyzePlacement` is synchronous and never
    // recurses, so one buffer is safe and keeps the hot path allocation-free.
    const LINE_CELLS = new Array(9);

    function analyzePlacement(board, row, col, player) {
        board[row][col] = player;
        let score = 0;
        let openThreeCount = 0;
        let openFourCount = 0;
        let fourCount = 0;
        let fiveCount = 0;
        // Distinct five points across every direction. Two fours that share the same
        // completion point are a single threat (one block stops both), so duplicates must
        // not be counted as a double four. Arrays beat Sets here: the list is never longer
        // than a handful of points and this runs twice per candidate at every node.
        const fivePointKeys = [];
        const cells = LINE_CELLS;
        try {
            for (const [dx, dy] of DIRECTIONS) {
                // Contiguous run through the move (the original reading) plus the number of
                // own stones anywhere in the nine-cell line, which is what enables a broken
                // shape. A gap stops the contiguous run but not the line scan.
                let count = 1;
                let blockedCount = 0;
                let otherOwn = 0;
                for (const sign of [1, -1]) {
                    let gap = false;
                    for (let step = 1; step < 5; step++) {
                        const nextRow = row + sign * dy * step;
                        const nextCol = col + sign * dx * step;
                        if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE) {
                            if (!gap) blockedCount++;
                            break;
                        }
                        const value = board[nextRow][nextCol];
                        if (value === player) {
                            otherOwn++;
                            if (!gap) count++;
                        } else if (value === 0) {
                            gap = true;
                        } else {
                            if (!gap) blockedCount++;
                            break;
                        }
                    }
                }

                if (otherOwn >= 2) {
                    let own = 0;
                    for (let index = 0; index < 9; index++) {
                        const nextRow = row + (index - 4) * dy;
                        const nextCol = col + (index - 4) * dx;
                        if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE) {
                            cells[index] = 2;
                            continue;
                        }
                        const value = board[nextRow][nextCol];
                        if (value === player) {
                            cells[index] = 1;
                            own++;
                        } else if (value === 0) {
                            cells[index] = 0;
                        } else {
                            cells[index] = 2;
                        }
                    }

                    // Five and four detection share one rolling 5-cell window: five own is a
                    // win, four own plus one empty leaves a five point. An open four produces
                    // two five points; a closed or broken four exactly one.
                    let five = false;
                    const directionFivePoints = [];
                    if (own >= 4) {
                        let ownCount = 0;
                        let emptyCount = 0;
                        let blocked = 0;
                        for (let step = 0; step < 5; step++) {
                            const value = cells[step];
                            if (value === 1) ownCount++;
                            else if (value === 0) emptyCount++;
                            else blocked++;
                        }
                        for (let start = 0; start <= 4; start++) {
                            if (blocked === 0) {
                                if (ownCount === 5) { five = true; break; }
                                if (ownCount === 4 && emptyCount === 1) {
                                    for (let step = 0; step < 5; step++) {
                                        if (cells[start + step] !== 0) continue;
                                        const index = start + step - 4;
                                        const key = (row + index * dy) * SIZE + col + index * dx;
                                        if (!directionFivePoints.includes(key)) directionFivePoints.push(key);
                                        if (!fivePointKeys.includes(key)) fivePointKeys.push(key);
                                        break;
                                    }
                                }
                            }
                            if (start < 4) {
                                const outgoing = cells[start];
                                const incoming = cells[start + 5];
                                if (outgoing === 1) ownCount--;
                                else if (outgoing === 0) emptyCount--;
                                else blocked--;
                                if (incoming === 1) ownCount++;
                                else if (incoming === 0) emptyCount++;
                                else blocked++;
                            }
                        }
                    }
                    if (five) {
                        score += WIN_SCORE;
                        fiveCount++;
                        continue;
                    }
                    if (directionFivePoints.length > 0) {
                        if (directionFivePoints.length >= 2) {
                            score += SCORES.openFour;
                            openFourCount++;
                        } else {
                            score += SCORES.four;
                            fourCount++;
                        }
                        continue;
                    }

                    let openThree = false;
                    if (own >= 3) {
                        let code = 0;
                        for (let step = 0; step < 6; step++) code = code * 3 + cells[step];
                        for (let start = 0; start <= 3; start++) {
                            if (isOpenThreeCode(code)) { openThree = true; break; }
                            if (start < 3) code = (code - cells[start] * POW3_5) * 3 + cells[start + 6];
                        }
                    }
                    if (openThree) {
                        score += SCORES.openThree;
                        openThreeCount++;
                        continue;
                    }
                }

                // Quiet shapes keep the original contiguous reading so the two/three weights
                // and every existing benchmark stay comparable.
                if (count === 3) {
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
        const fivePoints = fivePointKeys.length;
        if (openFourCount >= 2) score += SCORES.doubleOpenFour;
        else if (openFourCount === 1 && fourCount >= 1) score += SCORES.doubleFour;
        else if (fourCount >= 2 && fivePoints >= 2) score += SCORES.doubleFour;
        else if (fourCount >= 1 && openThreeCount >= 1) score += SCORES.fourThree;
        else if (openThreeCount >= 2) score += SCORES.doubleOpenThree;
        return {
            score,
            five: fiveCount,
            fivePoints,
            openFour: openFourCount,
            four: fourCount,
            openThree: openThreeCount
        };
    }

    function evaluatePattern(board, row, col, player) {
        if (board[row][col] !== 0) return -Infinity;
        return analyzePlacement(board, row, col, player).score;
    }

    // Structural threat level. A plain four and an open three both score 10,000, so score
    // thresholds cannot tell a forcing move from a developing one; the shape counts can.
    // Level 4 means the move is a forced win: open four/double four, four-plus-open-three,
    // or a double open three.
    function levelOf(analysis) {
        if (analysis.five > 0) return 5;
        if (analysis.fivePoints >= 2
            || (analysis.fivePoints >= 1 && analysis.openThree >= 1)
            || analysis.openThree >= 2) return 4;
        if (analysis.four > 0 || analysis.openThree > 0) return 3;
        return 0;
    }

    // Does placing `player` at an empty point win, or leave a five point (a four)? This is
    // the structural test that replaces the score prefilter: a broken four with a short
    // contiguous run scores only 1,000 but is still a forcing move.
    function windowThreat(board, row, col, player) {
        let four = false;
        for (const [dx, dy] of DIRECTIONS) {
            for (let offset = -4; offset <= 0; offset++) {
                let own = 1;
                let emptyRow = -1;
                let blocked = false;
                for (let step = 0; step < 5; step++) {
                    const position = offset + step;
                    if (position === 0) continue;
                    const nextRow = row + position * dy;
                    const nextCol = col + position * dx;
                    if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE) {
                        blocked = true;
                        break;
                    }
                    const value = board[nextRow][nextCol];
                    if (value === player) own++;
                    else if (value === 0) {
                        if (emptyRow >= 0) { blocked = true; break; }
                        emptyRow = nextRow;
                    } else {
                        blocked = true;
                        break;
                    }
                }
                if (blocked) continue;
                if (own === 5) return { win: true, four: false };
                if (own === 4 && emptyRow >= 0) four = true;
            }
        }
        return { win: false, four };
    }

    function scoreMove(board, row, col, player) {
        const opponent = player === 1 ? 2 : 1;
        return evaluatePattern(board, row, col, player)
            + evaluatePattern(board, row, col, opponent) * activeStyle.moveOpponent
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

    // Move generation for the search. Forcing points are never truncated away, so the one
    // move that answers an opponent's five or four can never fall outside the candidate set —
    // which is what a plain top-N cut silently does. Level 4 also covers blocking an opponent
    // open three: that point is where they would make an open four, which is a forced win.
    function getSearchMoves(board, player, limit = SEARCH_BRANCH_LIMIT) {
        const opponent = player === 1 ? 2 : 1;
        const points = [];
        for (const move of listCandidateMoves(board)) {
            const own = analyzePlacement(board, move.row, move.col, player);
            const threat = analyzePlacement(board, move.row, move.col, opponent);
            points.push({
                row: move.row,
                col: move.col,
                own: own.score,
                threat: threat.score,
                ownLevel: levelOf(own),
                threatLevel: levelOf(threat),
                ownFivePoints: own.fivePoints,
                threatFivePoints: threat.fivePoints,
                score: own.score + threat.score * activeStyle.moveOpponent + POSITION_SCORE[move.row][move.col]
            });
        }
        points.sort((a, b) => b.score - a.score);

        const wins = points.filter(point => point.ownLevel === 5);
        if (wins.length) return wins;

        const blocks = points.filter(point => point.threatLevel === 5);
        if (blocks.length) return blocks;

        // Every forcing move is kept: a plain four (one five point) is a forcing move even
        // though it shares the 10,000 score with an open three, and a level-4 move is a
        // forced win. Opponent level-4 points are the block squares, so they are kept too.
        const forced = points.filter(point =>
            point.ownLevel >= 4
            || point.ownFivePoints >= 1
            || point.threatLevel >= 4
        );
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
        const seen = new Set();
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
                if (!valid || !empty) continue;
                // Overlapping windows can report the same completion point twice; a duplicate
                // is not a second five point, and treating it as one would fake a double four.
                const key = empty.row * SIZE + empty.col;
                if (seen.has(key)) continue;
                seen.add(key);
                points.push(empty);
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
                // Structural prefilter: a forcing move either wins or leaves a five point.
                // A broken four can score only a two-level 1,000, so the old score test
                // (`>= openThree`) silently dropped it from every VCF line.
                const forcing = windowThreat(board, move.row, move.col, player);
                if (!forcing.win && !forcing.four) continue;
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

    // Static evaluation from `player`'s point of view. Reading only the single strongest
    // move made two separate open threes look exactly like one, so the top three threats are
    // combined with decaying weights: one threat keeps its full value, a second adds half,
    // a third a quarter. The opponent's total is weighted slightly higher because it forces
    // a reply. The result is clamped well below WIN_SCORE so a terminal win always wins.
    function evaluateBoard(board, player) {
        const opponent = player === 1 ? 2 : 1;
        let ownBest = 0;
        let ownSecond = 0;
        let ownThird = 0;
        let opponentBest = 0;
        let opponentSecond = 0;
        let opponentThird = 0;
        // A live three contributes two level-4 extension points, a second live three two
        // more. Counting them is what makes two separate threes outweigh one; the top-three
        // point scores alone saturate because both ends of one three already score high.
        let ownLevelFour = 0;
        let opponentLevelFour = 0;

        for (const move of listCandidateMoves(board)) {
            const ownAnalysis = analyzePlacement(board, move.row, move.col, player);
            const own = ownAnalysis.score;
            if (levelOf(ownAnalysis) >= 4) ownLevelFour++;
            if (own > ownBest) {
                ownThird = ownSecond;
                ownSecond = ownBest;
                ownBest = own;
            } else if (own > ownSecond) {
                ownThird = ownSecond;
                ownSecond = own;
            } else if (own > ownThird) {
                ownThird = own;
            }

            const threatAnalysis = analyzePlacement(board, move.row, move.col, opponent);
            const threat = threatAnalysis.score;
            if (levelOf(threatAnalysis) >= 4) opponentLevelFour++;
            if (threat > opponentBest) {
                opponentThird = opponentSecond;
                opponentSecond = opponentBest;
                opponentBest = threat;
            } else if (threat > opponentSecond) {
                opponentThird = opponentSecond;
                opponentSecond = threat;
            } else if (threat > opponentThird) {
                opponentThird = threat;
            }
        }

        const levelFourWeight = activeStyle.levelFour;
        const own = ownBest + 0.2 * ownSecond + 0.05 * ownThird
            + levelFourWeight * Math.min(ownLevelFour, 8);
        const threat = opponentBest + 0.2 * opponentSecond + 0.05 * opponentThird
            + levelFourWeight * Math.min(opponentLevelFour, 8);
        const raw = own - activeStyle.boardOpponent * threat;
        const cap = WIN_SCORE / 2;
        return Math.max(-cap, Math.min(cap, raw));
    }

    // Points where `player` would create a four, i.e. a move that leaves him one step from a
    // five. Found structurally (does the stone create a five point?) because the score table
    // rates a plain four and an open three identically.
    function fourThreatPoints(board, player) {
        const points = [];
        for (const move of listCandidateMoves(board)) {
            // No score threshold: `windowThreat` reads the 5-cell windows directly, so
            // gapped and broken fours are found even when their contiguous run is short.
            if (!windowThreat(board, move.row, move.col, player).four) continue;
            points.push({ row: move.row, col: move.col });
        }
        return points;
    }

    // Cells whose occupation by the defender stops `player`'s just-created live three from
    // becoming an open four. `board[row][col]` holds the attacker's new stone.
    function openThreeDefensePoints(board, row, col, player) {
        const points = [];
        const seen = new Set();
        for (const [dx, dy] of DIRECTIONS) {
            const cells = new Array(9);
            for (let index = 0; index < 9; index++) {
                const nextRow = row + (index - 4) * dy;
                const nextCol = col + (index - 4) * dx;
                if (nextRow < 0 || nextRow >= SIZE || nextCol < 0 || nextCol >= SIZE) {
                    cells[index] = 2;
                    continue;
                }
                const value = board[nextRow][nextCol];
                cells[index] = value === player ? 1 : value === 0 ? 0 : 2;
            }
            for (let start = 0; start <= 3; start++) {
                let code = 0;
                for (let step = 0; step < 6; step++) code = code * 3 + cells[start + step];
                const defenses = OPEN_THREE_DEFENSE[code];
                if (!defenses) continue;
                for (const offset of defenses) {
                    const index = start + offset;
                    if (cells[index] !== 0) continue;
                    const defenseRow = row + (index - 4) * dy;
                    const defenseCol = col + (index - 4) * dx;
                    const key = defenseRow * SIZE + defenseCol;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    points.push({ row: defenseRow, col: defenseCol });
                }
            }
        }
        return points;
    }

    // Does `player` have any move that leaves a five point? Used to abandon a VCT proof when
    // the defender can answer with a counter-four of his own.
    function hasFourThreat(board, player) {
        for (const move of listCandidateMoves(board)) {
            if (windowThreat(board, move.row, move.col, player).four) return true;
        }
        return false;
    }

    function vctMoves(board, player) {
        const moves = [];
        for (const move of listCandidateMoves(board)) {
            const analysis = analyzePlacement(board, move.row, move.col, player);
            if (analysis.fivePoints >= 1 || analysis.openThree >= 1) {
                moves.push({ row: move.row, col: move.col, analysis, score: analysis.score });
            }
        }
        return moves.sort((a, b) => b.score - a.score).slice(0, 16);
    }

    // Victory by Continuous Threats: fours and live threes instead of fours only. The proof
    // is deliberately conservative: whenever the defender has a five point or can make a
    // four, the line is abandoned, because those counter-threats need a different response.
    // What remains is a forcing sequence the defender can only answer at the live-three
    // defense points, so a proof is a real forced win.
    function findVctWin(board, player, maxDepth = VCT_MAX_DEPTH, maxNodes = activeStyle.vctNodes) {
        const opponent = player === 1 ? 2 : 1;
        const budget = { nodes: 0 };

        function search(depth) {
            if (depth <= 0 || budget.nodes >= maxNodes) return null;
            budget.nodes++;

            const win = findImmediateMove(board, player);
            if (win) return [win];
            if (findImmediateMove(board, opponent)) return null;
            if (hasFourThreat(board, opponent)) return null;

            for (const move of vctMoves(board, player)) {
                const analysis = move.analysis;
                // Two distinct five points cannot both be blocked.
                if (analysis.fivePoints >= 2) return [move];
                if (analysis.fivePoints === 1) {
                    board[move.row][move.col] = player;
                    const fives = fivePointsThrough(board, move.row, move.col, player);
                    if (fives.length === 0) {
                        board[move.row][move.col] = 0;
                        continue;
                    }
                    const block = fives[0];
                    board[block.row][block.col] = opponent;
                    const deeper = search(depth - 2);
                    board[block.row][block.col] = 0;
                    board[move.row][move.col] = 0;
                    if (deeper) return [move, block, ...deeper];
                    continue;
                }
                if (analysis.openThree >= 1) {
                    board[move.row][move.col] = player;
                    const defenses = openThreeDefensePoints(board, move.row, move.col, player);
                    let line = null;
                    if (defenses.length > 0) {
                        line = [];
                        for (const defense of defenses) {
                            board[defense.row][defense.col] = opponent;
                            const deeper = search(depth - 2);
                            board[defense.row][defense.col] = 0;
                            if (!deeper) { line = null; break; }
                            if (line.length === 0) line = [defense, ...deeper];
                        }
                    }
                    board[move.row][move.col] = 0;
                    if (line) return [move, ...line];
                }
            }
            return null;
        }

        const line = search(maxDepth);
        return line ? { move: line[0], line, nodes: budget.nodes } : null;
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

    function storeTT(slot, keyA, keyB, depth, score, flag, move) {
        // Depth-preferred replacement: a deeper stored proof survives a shallow collision,
        // while a different position with at least the same depth takes the slot.
        if (ttFlag[slot] !== 0
            && (ttKeyA[slot] !== keyA || ttKeyB[slot] !== keyB)
            && ttDepth[slot] > depth) return;
        ttKeyA[slot] = keyA;
        ttKeyB[slot] = keyB;
        ttDepth[slot] = depth;
        ttScore[slot] = score;
        ttFlag[slot] = flag;
        ttMove[slot] = move;
    }

    function searchChild(board, move, player, depth, alpha, beta, keyA, keyB, context, ply) {
        board[move.row][move.col] = player;
        const index = (move.row * SIZE + move.col) * 2 + (player - 1);
        const result = alphaBeta(
            board,
            depth,
            alpha,
            beta,
            player === 1 ? 2 : 1,
            { row: move.row, col: move.col, player },
            keyA ^ ZOBRIST_A[index],
            keyB ^ ZOBRIST_B[index],
            context,
            ply
        );
        board[move.row][move.col] = 0;
        return result;
    }

    function alphaBeta(board, depth, alpha, beta, player, lastMove, keyA, keyB, context, ply) {
        context.nodes++;
        if (lastMove && checkWin(board, lastMove.row, lastMove.col, lastMove.player)) {
            return { score: lastMove.player === 2 ? WIN_SCORE - ply : -WIN_SCORE + ply };
        }

        const slot = keyA & TT_MASK;
        let ttBest = -1;
        if (ttFlag[slot] !== 0 && ttKeyA[slot] === keyA && ttKeyB[slot] === keyB) {
            ttBest = ttMove[slot];
            if (ttDepth[slot] >= depth) {
                const score = ttScore[slot];
                const flag = ttFlag[slot];
                if (flag === TT_EXACT) return { score };
                if (flag === TT_LOWER) {
                    if (score >= beta) return { score };
                    if (score > alpha) alpha = score;
                } else if (flag === TT_UPPER) {
                    if (score <= alpha) return { score };
                    if (score < beta) beta = score;
                }
                if (alpha >= beta) return { score };
            }
        }

        if (depth === 0) {
            const score = leafScore(board, player, ply);
            // Only static-range scores are cached: a mate score depends on the ply.
            if (Math.abs(score) < WIN_SCORE / 2) storeTT(slot, keyA, keyB, 0, score, TT_EXACT, -1);
            return { score };
        }

        let moves = getSearchMoves(board, player, SEARCH_BRANCH_LIMIT);
        if (moves.length === 0) return { score: leafScore(board, player, ply) };
        if (ttBest >= 0) {
            const index = moves.findIndex(move => move.row * SIZE + move.col === ttBest);
            if (index > 0) {
                const [best] = moves.splice(index, 1);
                moves.unshift(best);
            }
        }

        const maximizing = player === 2;
        const originalAlpha = alpha;
        const originalBeta = beta;
        let bestScore = maximizing ? -Infinity : Infinity;
        let bestMove = moves[0];
        let first = true;

        for (const move of moves) {
            let result;
            // PVS: the first child gets the full window, later siblings a null window; only
            // a score inside the window pays for the re-search.
            if (first) {
                result = searchChild(board, move, player, depth - 1, alpha, beta, keyA, keyB, context, ply + 1);
            } else if (maximizing) {
                result = searchChild(board, move, player, depth - 1, alpha, alpha + 1, keyA, keyB, context, ply + 1);
                if (result.score > alpha && result.score < beta) {
                    result = searchChild(board, move, player, depth - 1, alpha, beta, keyA, keyB, context, ply + 1);
                }
            } else {
                result = searchChild(board, move, player, depth - 1, beta - 1, beta, keyA, keyB, context, ply + 1);
                if (result.score < beta && result.score > alpha) {
                    result = searchChild(board, move, player, depth - 1, alpha, beta, keyA, keyB, context, ply + 1);
                }
            }
            first = false;

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

        if (Math.abs(bestScore) < WIN_SCORE / 2) {
            const flag = bestScore <= originalAlpha ? TT_UPPER
                : bestScore >= originalBeta ? TT_LOWER
                    : TT_EXACT;
            storeTT(slot, keyA, keyB, depth, bestScore, flag, bestMove.row * SIZE + bestMove.col);
        }
        return { score: bestScore, move: bestMove };
    }

    function searchRootMove(board, move, player, depth) {
        const rootAnalysis = analyzePlacement(board, move.row, move.col, player);
        const searchBoard = cloneBoard(board);
        searchBoard[move.row][move.col] = player;
        const context = { nodes: 0, cutoffs: 0 };
        const opponent = player === 1 ? 2 : 1;
        const baseKey = positionKey(board);
        const moveIndex = (move.row * SIZE + move.col) * 2 + (player - 1);
        const keyA = baseKey.a ^ ZOBRIST_A[moveIndex];
        const keyB = baseKey.b ^ ZOBRIST_B[moveIndex];
        // A proven continuous-four win for the opponent means this root move simply loses.
        // Scoring it as a loss (delayed by the line length) keeps the engine from ranking a
        // dead move above a live one, and it costs about a millisecond per root.
        if (!checkWin(searchBoard, move.row, move.col, player)) {
            // If the opponent still has an immediate five, this move loses right away. This
            // has to be checked before VCF: a longer VCF line would otherwise make a move
            // that ignores an open four look like a slower (and therefore "better") loss.
            if (findImmediateMove(searchBoard, opponent) !== null) {
                return {
                    row: move.row,
                    col: move.col,
                    score: opponent === 2 ? WIN_SCORE - 1 : -WIN_SCORE + 1,
                    nodes: 1,
                    cutoffs: 0,
                    depth
                };
            }
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
            // A quiet move hands the opponent a free turn, so a VCT proof for him is valid.
            // For a move that already creates a four or a live three the opponent must answer
            // that first, which a threat search starting from a free position would not model.
            if (rootAnalysis.fivePoints === 0 && rootAnalysis.openThree === 0) {
                const threats = findVctWin(searchBoard, opponent, VCT_MAX_DEPTH, VCT_DEFENSE_NODES);
                if (threats) {
                    const penalty = Math.min(threats.line.length * 2, WIN_SCORE / 2);
                    return {
                        row: move.row,
                        col: move.col,
                        score: opponent === 2 ? WIN_SCORE - penalty : -WIN_SCORE + penalty,
                        nodes: threats.nodes,
                        cutoffs: 0,
                        depth
                    };
                }
            }
        }
        const result = alphaBeta(
            searchBoard,
            depth - 1,
            -Infinity,
            Infinity,
            player === 1 ? 2 : 1,
            { ...move, player },
            keyA,
            keyB,
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
        const vct = findVctWin(board, player);
        if (vct) return vct.move;
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

    return { SIZE, WIN_SCORE, setStyle, setAttackIntensity, createBoard, cloneBoard, checkWin, evaluatePattern, scoreMove, evaluateBoard, bestThreat, listEmptyPoints, listCandidateMoves, getCandidateMoves, getSearchMoves, findImmediateMove, fivePointsThrough, findVcfWin, findVctWin, openThreeDefensePoints, resolveThreats, fourThreatPoints, chooseEvaluationMove, searchDepthForMoves, searchRootMove, runMcts };
});


