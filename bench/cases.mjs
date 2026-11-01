// Shared tactical cases. Each case builds a fresh board and returns `true` on success or a
// short string explaining the failure, so the same list drives both the test suite
// (test/gomoku-tactics.test.mjs) and the scored benchmark (bench/tactics.mjs).

function board(engine, stones) {
    const result = engine.createBoard();
    for (const [row, col, player] of stones) result[row][col] = player;
    return result;
}

function completesFive(engine, current, move, player) {
    if (current[move.row]?.[move.col] !== 0) return false;
    current[move.row][move.col] = player;
    const win = engine.checkWin(current, move.row, move.col, player);
    current[move.row][move.col] = 0;
    return Boolean(win);
}

function has(moves, row, col) {
    return moves.some(move => move.row === row && move.col === col);
}

// Mirrors evaluateInParallel in gomoku-app.js: score every empty point, then search the
// highest-ranked root moves and keep the best one.
function pipelineMove(engine, current, player, depth = 6) {
    const scored = engine.listEmptyPoints(current)
        .map(move => ({ ...move, score: engine.scoreMove(current, move.row, move.col, player) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    return scored
        .map(move => engine.searchRootMove(current, move, player, depth))
        .sort((a, b) => b.score - a.score)[0];
}

function replayVcf(engine, current, player, line) {
    const probe = current.map(row => row.slice());
    const opponent = player === 1 ? 2 : 1;
    for (let index = 0; index < line.length; index++) {
        const move = line[index];
        if (probe[move.row]?.[move.col] !== 0) return `move ${index} is illegal`;
        probe[move.row][move.col] = player;
        if (engine.checkWin(probe, move.row, move.col, player)) return true;
        const fives = engine.fivePointsThrough(probe, move.row, move.col, player);
        if (fives.length === 0) return `move ${index} does not create a four`;
        if (fives.length >= 2) return true;
        if (index === line.length - 1) return 'a four without a win is not a forced win';
        probe[fives[0].row][fives[0].col] = opponent;
    }
    return 'empty line';
}

const NOISY_MIDGAME = [
    [7, 7, 1], [8, 9, 2], [6, 10, 1], [9, 6, 2], [5, 5, 1],
    [7, 10, 2], [10, 7, 1], [4, 6, 2], [9, 10, 1], [6, 4, 2]
];

export const cases = [
    {
        name: 'candidate generation never returns an occupied point',
        check(engine) {
            const current = board(engine, [[7, 7, 1], [7, 8, 2], [8, 7, 1], [6, 6, 2], [8, 8, 1]]);
            for (const move of engine.getSearchMoves(current, 2, 4)) {
                if (current[move.row][move.col] !== 0) return `(${move.row},${move.col}) is occupied`;
            }
            return true;
        }
    },
    {
        name: 'a move that completes five is the only candidate',
        check(engine) {
            const current = board(engine, [4, 5, 6, 7].map(col => [7, col, 2]));
            const moves = engine.getSearchMoves(current, 2, 4);
            if (moves.length !== 2) return `expected 2 candidates, got ${moves.length}`;
            for (const move of moves) {
                if (!completesFive(engine, current, move, 2)) return `(${move.row},${move.col}) does not win`;
            }
            return true;
        }
    },
    {
        name: 'an opponent five threat is answered only by blocking points',
        check(engine) {
            const current = board(engine, [4, 5, 6, 7].map(col => [7, col, 1]));
            const moves = engine.getSearchMoves(current, 2, 4);
            const cols = moves.map(move => move.col).sort((a, b) => a - b);
            if (moves.length !== 2 || cols[0] !== 3 || cols[1] !== 8) return `got ${JSON.stringify(cols)}`;
            return true;
        }
    },
    {
        name: 'both ends of an opponent open three stay in the candidate set',
        check(engine) {
            const current = board(engine, [[7, 5, 1], [7, 6, 1], [7, 7, 1], [11, 11, 2], [12, 12, 2]]);
            const moves = engine.getSearchMoves(current, 2, 4);
            if (!has(moves, 7, 4)) return 'the left block point is missing';
            if (!has(moves, 7, 8)) return 'the right block point is missing';
            return true;
        }
    },
    {
        name: 'forced moves are not truncated down to the branch limit',
        check(engine) {
            const stones = [];
            for (const row of [7, 10]) for (let col = 5; col < 8; col++) stones.push([row, col, 1]);
            for (let row = 5; row < 8; row++) stones.push([row, 10, 1]);
            stones.push([2, 2, 2]);
            const current = board(engine, stones);
            const moves = engine.getSearchMoves(current, 2, 4);
            if (moves.length <= 4) return `expected more than the branch limit, got ${moves.length}`;
            for (const [row, col] of [[7, 4], [7, 8], [10, 4], [10, 8], [4, 10], [8, 10]]) {
                if (!has(moves, row, col)) return `block point (${row},${col}) was dropped`;
            }
            return true;
        }
    },
    {
        name: 'a quiet position still yields four candidates',
        check(engine) {
            const current = board(engine, [[7, 7, 1]]);
            const moves = engine.getSearchMoves(current, 2, 4);
            if (moves.length !== 4) return `expected 4, got ${moves.length}`;
            for (const move of moves) if (current[move.row][move.col] !== 0) return 'occupied point returned';
            return true;
        }
    },
    {
        name: 'the pipeline takes an immediate win',
        check(engine) {
            const current = board(engine, [[7, 3, 2], [7, 4, 2], [7, 5, 2], [7, 6, 2], [5, 3, 1], [5, 4, 1]]);
            const best = pipelineMove(engine, current, 2);
            return completesFive(engine, current, best, 2) ? true : `(${best.row},${best.col}) does not win`;
        }
    },
    {
        name: 'the pipeline blocks an opponent four',
        check(engine) {
            const current = board(engine, [[7, 4, 1], [7, 5, 1], [7, 6, 1], [7, 7, 1], [9, 9, 2], [10, 10, 2]]);
            const best = pipelineMove(engine, current, 2);
            if (best.row !== 7) return `expected row 7, got (${best.row},${best.col})`;
            return best.col === 3 || best.col === 8 ? true : `expected col 3 or 8, got ${best.col}`;
        }
    },
    {
        name: 'the pipeline blocks an opponent open three',
        check(engine) {
            const current = board(engine, [[7, 5, 1], [7, 6, 1], [7, 7, 1], [9, 9, 2], [10, 10, 2]]);
            const best = pipelineMove(engine, current, 2);
            if (best.row !== 7) return `expected row 7, got (${best.row},${best.col})`;
            return best.col === 4 || best.col === 8 ? true : `expected col 4 or 8, got ${best.col}`;
        }
    },
    {
        name: 'a double four is played as the winning move',
        check(engine) {
            const current = board(engine, [
                [7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2],
                [3, 6, 1], [4, 6, 2], [5, 6, 2], [6, 6, 2]
            ]);
            const best = pipelineMove(engine, current, 2);
            return best.row === 7 && best.col === 6 ? true : `got (${best.row},${best.col})`;
        }
    },
    {
        name: 'a four-three point is preferred over a quiet move',
        check(engine) {
            // (7,7) completes a closed four on row 7 and an open three on column 7.
            const current = board(engine, [
                [7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2], [7, 6, 2],
                [5, 7, 2], [6, 7, 2], [9, 7, 2]
            ]);
            const best = pipelineMove(engine, current, 2);
            return best.row === 7 && best.col === 7 ? true : `got (${best.row},${best.col})`;
        }
    },
    {
        name: 'the opening reply stays next to the opponent, not in an empty corner',
        check(engine) {
            const current = board(engine, [[7, 5, 2], [7, 6, 2], [0, 0, 1], [0, 1, 1]]);
            const best = pipelineMove(engine, current, 2);
            const nearOwn = Math.max(Math.abs(best.row - 7), Math.abs(best.col - 6)) <= 2;
            const nearCorner = Math.max(best.row, best.col) <= 2;
            if (!nearOwn) return `(${best.row},${best.col}) is far from White's stones`;
            if (nearCorner) return `(${best.row},${best.col}) sits in Black's corner`;
            return true;
        }
    },
    {
        name: 'VCF finds a double four in one move',
        check(engine) {
            const current = board(engine, [
                [7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2],
                [3, 6, 1], [4, 6, 2], [5, 6, 2], [6, 6, 2]
            ]);
            const result = engine.findVcfWin(current, 2);
            if (!result) return 'no VCF found';
            return result.move.row === 7 && result.move.col === 6 ? true : `got (${result.move.row},${result.move.col})`;
        }
    },
    {
        name: 'VCF plays a three-move forcing win and the line replays cleanly',
        check(engine) {
            const stones = [];
            for (const [row, col] of [[4, 6], [5, 7], [6, 5], [7, 5], [7, 7], [8, 7], [8, 9]]) stones.push([row, col, 1]);
            for (const [row, col] of [[5, 6], [6, 6], [6, 7], [7, 8], [8, 5], [8, 6]]) stones.push([row, col, 2]);
            const current = board(engine, stones);
            const result = engine.findVcfWin(current, 2);
            if (!result) return 'no VCF found';
            if (result.line.length !== 3) return `expected 3 moves, got ${result.line.length}`;
            const replay = replayVcf(engine, current, 2, result.line);
            if (replay !== true) return `line does not replay: ${replay}`;
            if (current.flat().filter(Boolean).length !== 13) return 'the search mutated the board';
            return true;
        }
    },
    {
        name: 'VCF refuses a line whose forced block hands the opponent a five',
        check(engine) {
            const stones = [[7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2]];
            for (let col = 8; col < 11; col++) stones.push([7, col, 1]);
            const current = board(engine, stones);
            return engine.findVcfWin(current, 2) === null ? true : 'a losing line was accepted';
        }
    },
    {
        name: 'VCF returns null when no forcing win exists',
        check(engine) {
            const current = board(engine, NOISY_MIDGAME);
            return engine.findVcfWin(current, 2) === null ? true : 'a win was invented';
        }
    },
    {
        name: 'a root move that allows an opponent VCF is scored as a loss',
        check(engine) {
            const current = board(engine, [
                [7, 2, 2], [7, 3, 1], [7, 4, 1], [7, 5, 1],
                [3, 6, 2], [4, 6, 1], [5, 6, 1], [6, 6, 1], [12, 12, 2]
            ]);
            const probe = current.map(row => row.slice());
            probe[13][0] = 2;
            if (!engine.findVcfWin(probe, 1)) return 'the test position has no opponent VCF';
            const result = engine.searchRootMove(current, { row: 13, col: 0 }, 2, 8);
            return result.score <= -engine.WIN_SCORE / 2 ? true : `expected a losing score, got ${result.score}`;
        }
    },
    {
        name: 'VCF does not claim a win when the opponent strikes first',
        check(engine) {
            // White to move: (5,8) completes an open four on the anti-diagonal, so White wins
            // on the next move. Black's own open four at (5,5) arrives one move too late and
            // must not be reported as a forcing win.
            const current = board(engine, [
                [5, 7, 2], [6, 6, 1], [6, 7, 2], [7, 5, 1], [7, 6, 2], [7, 7, 1],
                [8, 4, 1], [8, 5, 2], [8, 6, 2], [8, 7, 1], [8, 8, 1]
            ]);
            if (!engine.findVcfWin(current, 2)) return 'White should have a forcing win';
            const after = current.map(row => row.slice());
            after[5][8] = 2;
            return engine.findVcfWin(after, 1) === null
                ? true
                : 'Black was given a win that White reaches first';
        }
    },
    {
        name: 'the single-threaded fallback uses the VCF win',
        check(engine) {
            const current = board(engine, [
                [7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2],
                [3, 6, 1], [4, 6, 2], [5, 6, 2], [6, 6, 2]
            ]);
            const move = engine.chooseEvaluationMove(current, 2);
            return move.row === 7 && move.col === 6 ? true : `got (${move.row},${move.col})`;
        }
    },
    {
        name: 'the fallback picks the best-scoring point, not the top-left corner',
        check(engine) {
            const current = board(engine, [[7, 7, 1]]);
            const move = engine.chooseEvaluationMove(current, 2);
            if (!move) return 'no move returned';
            if (move.row === 0 && move.col === 0) return 'played the corner';
            const best = Math.max(...engine.listEmptyPoints(current).map(m => engine.scoreMove(current, m.row, m.col, 2)));
            return engine.scoreMove(current, move.row, move.col, 2) === best ? true : 'did not pick the top score';
        }
    },
    {
        name: 'static evaluation rewards own threats and punishes the opponent',
        check(engine) {
            const line = (player, length) => {
                const current = engine.createBoard();
                const first = 7 - Math.floor(length / 2);
                for (let col = first; col < first + length; col++) current[7][col] = player;
                return current;
            };
            const white = [2, 3, 4].map(length => engine.evaluateBoard(line(2, length), 2));
            if (!(white[0] > 0 && white[0] < white[1] && white[1] < white[2])) return `White scores ${white.join(',')}`;
            const black = [2, 3, 4].map(length => engine.evaluateBoard(line(1, length), 2));
            if (!(black[0] < 0 && black[0] > black[1] && black[1] > black[2])) return `Black scores ${black.join(',')}`;
            return true;
        }
    },
    {
        name: 'a leaf that reaches a five threat is resolved instead of clamping',
        check(engine) {
            // White to move; Black has a four with a single open end, so the static score
            // clamps to -WIN/2. Quiescence must play the forced block and score the result,
            // otherwise every such leaf is equal and the search picks by move order.
            const current = board(engine, [[7, 3, 2], [7, 4, 1], [7, 5, 1], [7, 6, 1], [7, 7, 1]]);
            const staticScore = engine.evaluateBoard(current, 2);
            if (staticScore !== -engine.WIN_SCORE / 2) return `expected the clamp, got ${staticScore}`;
            const resolved = engine.resolveThreats(current, 2, 1, 4, { nodes: 0 });
            if (resolved <= -engine.WIN_SCORE / 2) return `still clamped at ${resolved}`;
            if (current.flat().filter(Boolean).length !== 5) return 'the resolution mutated the board';
            return true;
        }
    },
    {
        name: 'four threats are detected structurally, not by their score',
        check(engine) {
            // (7,6) with Black at (7,2) creates a four: it leaves a single five point at (7,7).
            const withFour = board(engine, [[7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2]]);
            const threats = engine.fourThreatPoints(withFour, 2);
            if (!threats.some(move => move.row === 7 && move.col === 6)) return 'the four at (7,6) was missed';

            // Extending an open two to an open three scores 10,000, the same value a plain
            // four gets, but it creates no five point, so it is not a four threat.
            const openThree = board(engine, [[7, 6, 2], [7, 7, 2]]);
            if (engine.evaluatePattern(openThree, 7, 5, 2) < 10_000) return 'expected a three-level score at (7,5)';
            return engine.fourThreatPoints(openThree, 2).length === 0
                ? true
                : 'an open three was misread as a four threat';
        }
    },
    {
        name: 'the opening reply blocks a developing two instead of building its own shape',
        check(engine) {
            // Black has (7,7)+(7,6); playing (7,5) or (7,8) is what turns it into an open
            // three. Four plies of search could not see that and developed instead.
            const current = board(engine, [[7, 7, 1], [6, 7, 2], [7, 6, 1]]);
            const best = pipelineMove(engine, current, 2, 8);
            return best.row === 7 && (best.col === 5 || best.col === 8)
                ? true
                : `expected a block on row 7, got (${best.row},${best.col})`;
        }
    }
];

