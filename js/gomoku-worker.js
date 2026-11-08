importScripts('gomoku-engine.js');

self.addEventListener('message', event => {
    const { id, board, player, candidates, depth, style, intensity } = event.data;
    const engine = self.GomokuEngine;
    if (typeof intensity === 'number') engine.setAttackIntensity(intensity);
    else if (style) engine.setStyle(style);

    const results = candidates.map(move => engine.searchRootMove(board, move, player, depth));
    self.postMessage({ id, results });
});
