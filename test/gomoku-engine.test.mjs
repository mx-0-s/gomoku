import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const engine = require('../js/gomoku-engine.js');

test('an empty board opens at the center', () => {
    assert.deepEqual(engine.listCandidateMoves(engine.createBoard()), [{ row: 7, col: 7 }]);
});

test('restored evaluator assigns the reference open-four and double-open-three weights', () => {
    const openFour = engine.createBoard();
    for (let col = 5; col < 8; col++) openFour[7][col] = 2;
    assert.equal(engine.evaluatePattern(openFour, 7, 8, 2), 100_000);

    const doubleOpenThree = engine.createBoard();
    doubleOpenThree[7][6] = 2;
    doubleOpenThree[7][8] = 2;
    doubleOpenThree[6][7] = 2;
    doubleOpenThree[8][7] = 2;
    assert.equal(engine.evaluatePattern(doubleOpenThree, 7, 7, 2), 50_000);
});

test('evaluation enumerates every empty point instead of nearby candidates only', () => {
    const board = engine.createBoard();
    board[7][7] = 1;
    assert.equal(engine.listEmptyPoints(board).length, 224);
});

test('detects a horizontal five at the board edge', () => {
    const board = engine.createBoard();
    for (let col = 0; col < 5; col++) board[0][col] = 1;
    assert.equal(engine.checkWin(board, 0, 4, 1).length, 5);
});

test('evaluation takes an immediate win before considering defense', () => {
    const board = engine.createBoard();
    for (let col = 3; col < 7; col++) board[7][col] = 2;
    for (let col = 4; col < 8; col++) board[5][col] = 1;
    const move = engine.chooseEvaluationMove(board, 2);
    assert.equal(move.row, 7);
    assert.ok(move.col === 2 || move.col === 7);
    board[move.row][move.col] = 2;
    assert.ok(engine.checkWin(board, move.row, move.col, 2));
});

test('evaluation blocks an opponent immediate win', () => {
    const board = engine.createBoard();
    board[7][3] = 2;
    for (let col = 4; col < 8; col++) board[7][col] = 1;
    assert.deepEqual(engine.chooseEvaluationMove(board, 2), { row: 7, col: 8 });
});

test('search depth follows the requested move-count bands', () => {
    assert.equal(engine.searchDepthForMoves(0), 8);
    assert.equal(engine.searchDepthForMoves(4), 8);
    assert.equal(engine.searchDepthForMoves(20), 8);
    assert.equal(engine.searchDepthForMoves(21), 10);
});

test('minimax recognizes an immediate winning root move', () => {
    const board = engine.createBoard();
    for (let col = 3; col < 7; col++) board[7][col] = 2;
    const result = engine.searchRootMove(board, { row: 7, col: 7 }, 2, 4);
    assert.equal(result.score, engine.WIN_SCORE - 1);
    assert.equal(result.depth, 4);
});

test('Alpha-Beta records cutoffs during recursive search', () => {
    const board = engine.createBoard();
    board[7][7] = 1;
    board[7][8] = 2;
    board[8][7] = 1;
    board[8][8] = 2;
    const result = engine.searchRootMove(board, { row: 6, col: 8 }, 2, 4);
    assert.ok(result.nodes > 1);
    assert.ok(result.cutoffs > 0);
});

function lineBoard(player, length) {
    const board = engine.createBoard();
    const first = 7 - Math.floor(length / 2);
    for (let col = first; col < first + length; col++) board[7][col] = player;
    return board;
}

test('static evaluation rewards its own threats and punishes the opponent’s', () => {
    const white = [2, 3, 4].map(length => engine.evaluateBoard(lineBoard(2, length), 2));
    assert.ok(white[0] > 0, `an open two should already favour White, got ${white[0]}`);
    assert.ok(white[0] < white[1] && white[1] < white[2], `White's score should grow with its threat: ${white.join(' < ')}`);

    const black = [2, 3, 4].map(length => engine.evaluateBoard(lineBoard(1, length), 2));
    assert.ok(black[0] < 0, `an opponent open two should already hurt White, got ${black[0]}`);
    assert.ok(black[0] > black[1] && black[1] > black[2], `Black's threat should lower White's score: ${black.join(' > ')}`);

    const cap = engine.WIN_SCORE / 2;
    assert.ok(white[2] <= cap && black[2] >= -cap, 'static evaluation must stay below the terminal win value');
});

test('a double four outranks a single open four', () => {
    const doubleFour = engine.createBoard();
    doubleFour[7][2] = 1;
    for (let col = 3; col < 6; col++) doubleFour[7][col] = 2;
    doubleFour[3][6] = 1;
    for (let row = 4; row < 7; row++) doubleFour[row][6] = 2;

    const openFour = lineBoard(2, 3);
    assert.ok(
        engine.evaluatePattern(doubleFour, 7, 6, 2) > engine.evaluatePattern(openFour, 7, 6, 2),
        'a forced win by two closed fours must score above a lone open four'
    );
});

test('the single-threaded fallback takes the best-scoring point instead of the top-left corner', () => {
    const board = engine.createBoard();
    board[7][7] = 1;
    const move = engine.chooseEvaluationMove(board, 2);
    assert.notDeepEqual(move, { row: 0, col: 0 });

    const best = Math.max(...engine.listEmptyPoints(board).map(m => engine.scoreMove(board, m.row, m.col, 2)));
    assert.equal(engine.scoreMove(board, move.row, move.col, 2), best);
});

test('the Black third-move book recognises Kagetsu and Ugetsu', () => {
    const kagetsu = engine.createBoard();
    kagetsu[7][7] = 1;
    kagetsu[8][7] = 2;
    assert.deepEqual(engine.findOpeningMove(kagetsu, 1), { row: 8, col: 8 });

    const ugetsu = engine.createBoard();
    ugetsu[7][7] = 1;
    ugetsu[8][8] = 2;
    assert.deepEqual(engine.findOpeningMove(ugetsu, 1), { row: 6, col: 8 });

    const offBook = engine.createBoard();
    offBook[7][7] = 1;
    offBook[7][10] = 2;
    assert.equal(engine.findOpeningMove(offBook, 1), null);
    assert.equal(engine.findOpeningMove(kagetsu, 2), null);
});

test('the two-stage evaluation pipeline blocks an opponent open three', () => {
    const board = engine.createBoard();
    for (let col = 5; col < 8; col++) board[7][col] = 1;
    board[9][9] = 2;
    board[10][10] = 2;

    // Mirrors evaluateInParallel in gomoku-app.js: score every empty point, then search the
    // highest-ranked root moves and keep the best score.
    const scored = engine.listEmptyPoints(board)
        .map(move => ({ ...move, score: engine.scoreMove(board, move.row, move.col, 2) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    const best = scored
        .map(move => engine.searchRootMove(board, move, 2, 6))
        .sort((a, b) => b.score - a.score)[0];

    assert.equal(best.row, 7);
    assert.ok(best.col === 4 || best.col === 8, `expected the open three to be blocked, got (${best.row},${best.col})`);
});