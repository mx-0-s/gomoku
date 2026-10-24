import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const engine = require('../js/gomoku-engine.js');

test('an empty board opens at the center', () => {
    assert.deepEqual(engine.getCandidateMoves(engine.createBoard(), 2), [{ row: 7, col: 7, score: 10 }]);
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

test('MCTS returns legal moves and finite root statistics', () => {
    const board = engine.createBoard();
    board[7][7] = 1;
    const results = engine.runMcts(board, 2, 24, 42);
    assert.ok(results.length > 0);
    for (const result of results) {
        assert.equal(board[result.row][result.col], 0);
        assert.ok(Number.isFinite(result.visits));
        assert.ok(Number.isFinite(result.wins));
    }
});

test('search depth follows the requested move-count bands', () => {
    assert.equal(engine.searchDepthForMoves(4), 4);
    assert.equal(engine.searchDepthForMoves(5), 8);
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