importScripts('gomoku-engine.js');

self.addEventListener('message', event => {
    const { id, mode, board, player, candidates, iterations, seed, style, intensity } = event.data;
    const engine = self.GomokuEngine;
    if (typeof intensity === 'number') engine.setAttackIntensity(intensity);
    else if (style) engine.setStyle(style);

    if (mode === 'evaluate') {
        const results = candidates.map(move => ({
            row: move.row,
            col: move.col,
            score: engine.scoreMove(board, move.row, move.col, player)
        }));
        self.postMessage({ id, mode, results });
        return;
    }

    if (mode === 'search') {
        const results = candidates.map(move => engine.searchRootMove(board, move, player, event.data.depth));
        self.postMessage({ id, mode, results });
        return;
    }

    const results = engine.runMcts(board, player, iterations, seed);
    self.postMessage({ id, mode, results });
});
