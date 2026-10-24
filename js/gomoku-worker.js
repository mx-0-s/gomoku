importScripts('gomoku-engine.js');

self.addEventListener('message', event => {
    const { mode, board, player, candidates, iterations, seed } = event.data;
    const engine = self.GomokuEngine;

    if (mode === 'evaluate') {
        const results = candidates.map(move => ({
            row: move.row,
            col: move.col,
            score: engine.scoreMove(board, move.row, move.col, player)
        }));
        self.postMessage({ mode, results });
        return;
    }

    if (mode === 'search') {
        const results = candidates.map(move => engine.searchRootMove(board, move, player, event.data.depth));
        self.postMessage({ mode, results });
        return;
    }

    const results = engine.runMcts(board, player, iterations, seed);
    self.postMessage({ mode, results });
});