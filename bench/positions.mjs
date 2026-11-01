// Deterministic mid-game positions for the benchmark. Each position has an odd number of
// stones (Black moved first), so White is to move — the same side the app's AI plays.

export function generatePositions(engine, count = 6, stones = 11) {
    const positions = [];
    for (let seed = 1; positions.length < count && seed <= 4000; seed++) {
        const position = attempt(engine, seed, stones);
        if (position) positions.push(position);
    }
    return positions;
}

function attempt(engine, seed, stones) {
    let state = (seed * 2654435761) >>> 0 || 1;
    const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const board = engine.createBoard();
    let player = 1;
    for (let ply = 0; ply < stones; ply++) {
        if (engine.findImmediateMove(board, 1) || engine.findImmediateMove(board, 2)) return null;
        const pool = engine.listEmptyPoints(board)
            .map(move => ({ ...move, score: engine.scoreMove(board, move.row, move.col, player) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 6);
        if (pool.length === 0) return null;
        const move = pool[Math.floor(random() * pool.length)];
        board[move.row][move.col] = player;
        if (engine.checkWin(board, move.row, move.col, player)) return null;
        player = player === 1 ? 2 : 1;
    }
    if (stones % 2 === 0) return null;
    if (engine.findImmediateMove(board, 2) || engine.findImmediateMove(board, 1)) return null;
    return board;
}
