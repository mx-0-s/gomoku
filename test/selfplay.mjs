#!/usr/bin/env node
// 自对弈评估模板（手动运行，不属于自动化测试）。
//
// 注意：`node --test` 会递归执行 test/ 目录下的所有 .mjs（不只是 *.test.mjs）。
// 本文件通过 NODE_TEST_CONTEXT / execArgv 检测测试 runner，并在其中跳过 main()，
// 所以 `node --test` 不会真的跑对局；只有直接 `node test/selfplay.mjs` 才会运行。
//
// 用法：
//   node test/selfplay.mjs
//   node test/selfplay.mjs --openings 6
//   node test/selfplay.mjs \
//     --a "name=attack,depth=8,roots=12,vcf=1,vct=1,intensity=100" \
//     --b "name=balanced,depth=8,roots=12,vcf=1,vct=1,intensity=0"
//   node test/selfplay.mjs \
//     --a "name=attack,depth=8,roots=12,intensity=100" \
//     --b "name=weak,depth=6,roots=8,vct=0" \
//     --openings 6
//
// 参数：
//   --a / --b       profile，逗号分隔的 key=value
//   --openings N    使用前 N 个白方开局（默认 4，最多 6）
//   --max-plies N   单手对局上限（默认 80，到达即和棋）
//   --seed N        随机种子（只影响同分根着的随机选择）
//   --help
//
// profile 字段：
//   name       显示名（默认 A / B）
//   engine     引擎路径；默认 ../js/gomoku-engine.js。相对路径按当前工作目录解析
//   depth      搜索深度（默认 8；弱黑可用 6）
//   roots      根着数（默认 12；弱黑可用 8）
//   vcf        1/0，是否使用 VCF 进攻（默认 1）
//   vct        1/0，是否使用 VCT 进攻（默认 1；旧引擎没有该函数时会自动跳过）
//   intensity  0–100，进攻强度（默认 0；100 = 强攻）
//
// 注意：
//   - 两个 profile 各自独立加载引擎模块（清 require.cache），避免共享 TT 和全局棋风；
//   - 白方选点按分数降序，黑方按升序（searchRootMove 始终是白方视角）；
//   - 自对弈结果受先手优势影响很大，必须同时看“总胜负”和“分执黑/执白胜负”；
//   - 每组至少 6–20 局再下结论。

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DEFAULT_ENGINE = fileURLToPath(new URL('../js/gomoku-engine.js', import.meta.url));
const OPENINGS = [[6, 7], [7, 6], [6, 6], [8, 8], [6, 8], [8, 6]];

function argValue(flag) {
    const index = process.argv.indexOf(flag);
    if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
    const prefix = `${flag}=`;
    const inline = process.argv.find(argument => argument.startsWith(prefix));
    return inline ? inline.slice(prefix.length) : null;
}

function parseBoolean(value, fallback) {
    if (value === undefined) return fallback;
    return !(value === '0' || value === 'false' || value === 'no');
}

function parseProfile(text, fallbackName) {
    const config = {
        name: fallbackName,
        engine: DEFAULT_ENGINE,
        depth: 8,
        roots: 12,
        vcf: true,
        vct: true,
        intensity: 0
    };
    for (const part of text.split(',')) {
        const separator = part.indexOf('=');
        if (separator === -1) continue;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (key === 'name') config.name = value || fallbackName;
        else if (key === 'engine') config.engine = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
        else if (key === 'depth') config.depth = Math.max(1, Number(value) || config.depth);
        else if (key === 'roots') config.roots = Math.max(1, Number(value) || config.roots);
        else if (key === 'vcf') config.vcf = parseBoolean(value, config.vcf);
        else if (key === 'vct') config.vct = parseBoolean(value, config.vct);
        else if (key === 'intensity') config.intensity = Math.max(0, Math.min(100, Number(value) || 0));
    }
    return config;
}

function createRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

function loadEngine(enginePath) {
    let resolved;
    try {
        resolved = require.resolve(enginePath);
    } catch (error) {
        throw new Error(`cannot resolve engine: ${enginePath}`);
    }
    // 同一路径加载两次也要得到两个独立模块实例（独立 TT / 全局棋风）。
    delete require.cache[resolved];
    return require(resolved);
}

function createProfile(config) {
    const engine = loadEngine(config.engine);
    if (typeof engine.setAttackIntensity === 'function') {
        engine.setAttackIntensity(config.intensity / 100);
    } else if (config.intensity > 0) {
        console.warn(`warning: ${config.name} engine has no setAttackIntensity(); intensity ignored`);
    }
    return { ...config, engine };
}

function chooseMove(profile, board, player, random) {
    const engine = profile.engine;
    const opponent = player === 1 ? 2 : 1;

    const opening = engine.findOpeningMove(board, player);
    if (opening) return { move: opening, source: 'book' };
    const win = engine.findImmediateMove(board, player);
    if (win) return { move: win, source: 'win' };
    const block = engine.findImmediateMove(board, opponent);
    if (block) return { move: block, source: 'block' };

    if (profile.vcf) {
        const vcf = engine.findVcfWin(board, player);
        if (vcf) return { move: vcf.move, source: 'vcf' };
    }
    if (profile.vct && typeof engine.findVctWin === 'function') {
        const vct = engine.findVctWin(board, player);
        if (vct) return { move: vct.move, source: 'vct' };
    }

    const roots = engine.listEmptyPoints(board)
        .map(move => ({ ...move, score: engine.scoreMove(board, move.row, move.col, player) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, profile.roots);
    if (roots.length === 0) return { move: null, source: 'none' };

    const results = roots.map(move => engine.searchRootMove(board, move, player, profile.depth));
    // searchRootMove 的分数始终是白方视角：白方取最大，黑方取最小。
    results.sort((a, b) => (player === 2 ? b.score - a.score : a.score - b.score));
    const best = results[0].score;
    const ties = results.filter(result => result.score === best);
    const pick = ties[Math.floor(random() * ties.length)];
    return { move: { row: pick.row, col: pick.col }, source: 'search' };
}

function playGame(blackProfile, whiteProfile, opening, seed, maxPlies) {
    const board = blackProfile.engine.createBoard();
    board[7][7] = 1;
    board[opening[0]][opening[1]] = 2;
    const random = createRandom(seed);
    const started = Date.now();
    const sources = { black: {}, white: {} };
    let turn = 1;

    for (let ply = 3; ply <= maxPlies; ply++) {
        const profile = turn === 1 ? blackProfile : whiteProfile;
        const { move, source } = chooseMove(profile, board, turn, random);
        const colour = turn === 1 ? 'black' : 'white';
        sources[colour][source] = (sources[colour][source] || 0) + 1;
        if (!move || board[move.row][move.col] !== 0) {
            return { winner: 0, plies: ply, ms: Date.now() - started, sources, illegal: true };
        }
        board[move.row][move.col] = turn;
        if (blackProfile.engine.checkWin(board, move.row, move.col, turn)) {
            return { winner: turn, plies: ply, ms: Date.now() - started, sources };
        }
        turn = turn === 1 ? 2 : 1;
    }
    return { winner: 0, plies: maxPlies, ms: Date.now() - started, sources };
}

function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        const header = String(process.argv[1]).replace(/^.*[\\/]/, '');
        console.log(`usage: node test/${header} [--a profile] [--b profile] [--openings N] [--max-plies N] [--seed N]`);
        console.log('see the comment block at the top of this file for profile fields');
        return;
    }

    const first = createProfile(parseProfile(argValue('--a') || 'name=A', 'A'));
    const second = createProfile(parseProfile(argValue('--b') || 'name=B', 'B'));
    const openingCount = Math.max(1, Math.min(OPENINGS.length, Number(argValue('--openings')) || 4));
    const maxPlies = Math.max(10, Number(argValue('--max-plies')) || 80);
    const seed = Number(argValue('--seed')) || 1;

    console.log(`self-play: ${first.name} (depth ${first.depth}, roots ${first.roots}, intensity ${first.intensity}%)`);
    console.log(`           ${second.name} (depth ${second.depth}, roots ${second.roots}, intensity ${second.intensity}%)`);
    console.log(`${openingCount * 2} games, max ${maxPlies} plies\n`);

    const stats = [first, second].map(profile => ({
        profile,
        wins: 0,
        asBlack: 0,
        asWhite: 0,
        sources: { win: 0, block: 0, vcf: 0, vct: 0, search: 0, none: 0 }
    }));
    const statFor = profile => stats.find(entry => entry.profile === profile);
    let draws = 0;
    let totalPlies = 0;
    let totalMs = 0;
    let games = 0;

    for (const opening of OPENINGS.slice(0, openingCount)) {
        for (const firstIsBlack of [true, false]) {
            const black = firstIsBlack ? first : second;
            const white = firstIsBlack ? second : first;
            const result = playGame(black, white, opening, seed + games, maxPlies);
            games++;
            totalPlies += result.plies;
            totalMs += result.ms;

            for (const colour of ['black', 'white']) {
                const profile = colour === 'black' ? black : white;
                const entry = statFor(profile);
                for (const [source, count] of Object.entries(result.sources[colour])) {
                    entry.sources[source] = (entry.sources[source] || 0) + count;
                }
            }

            if (result.winner === 0) {
                draws++;
                console.log(`game ${games}: opening (${opening[0]},${opening[1]})  ${first.name} as ${firstIsBlack ? 'black' : 'white'}  -> draw  ${result.plies} plies  ${(result.ms / 1000).toFixed(0)} s`);
            } else {
                const winner = result.winner === 1 ? black : white;
                const entry = statFor(winner);
                entry.wins++;
                if (result.winner === 1) entry.asBlack++;
                else entry.asWhite++;
                console.log(`game ${games}: opening (${opening[0]},${opening[1]})  ${first.name} as ${firstIsBlack ? 'black' : 'white'}  -> ${winner.name} (${result.winner === 1 ? 'black' : 'white'})  ${result.plies} plies  ${(result.ms / 1000).toFixed(0)} s`);
            }
        }
    }

    console.log(`\n${games} games in ${(totalMs / 1000).toFixed(0)} s, avg ${(totalMs / games / 1000).toFixed(0)} s/game, avg ${(totalPlies / games).toFixed(0)} plies`);
    for (const entry of stats) {
        const sourceText = Object.entries(entry.sources)
            .filter(([, count]) => count > 0)
            .map(([source, count]) => `${source} ${count}`)
            .join('  ');
        console.log(`${entry.profile.name}: ${entry.wins} wins  (as black ${entry.asBlack}, as white ${entry.asWhite})  [${sourceText || 'no moves'}]`);
    }
    console.log(`draws ${draws}`);
    console.log('\nfirst-player advantage dominates raw totals; compare as-black/as-white columns, not just total wins.');
}

// `node --test` recursively executes every .mjs under a directory named `test`,
// regardless of the *.test.mjs suffix. Detect the runner (env or --test in execArgv)
// and do nothing there; this file is a manual tool, not a test.
const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
if (!underTestRunner) main();
