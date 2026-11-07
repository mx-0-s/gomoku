import { createRequire } from 'node:module';
import { generatePositions } from './positions.mjs';

const require = createRequire(import.meta.url);
const engine = require('../js/gomoku-engine.js');

// ---------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------

function parseProfile(text, fallbackName) {
    const profile = { name: fallbackName, depth: 8, vcf: true, roots: 8 };
    for (const part of text.split(',')) {
        const [key, value] = part.split('=');
        if (!key) continue;
        if (key === 'depth') profile.depth = Number(value);
        else if (key === 'roots') profile.roots = Number(value);
        else if (key === 'vcf') profile.vcf = value !== '0' && value !== 'false';
        else if (key === 'name') profile.name = value;
    }
    return profile;
}

function argValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

function topRoots(board, player, count) {
    return engine.listEmptyPoints(board)
        .map(move => ({ ...move, score: engine.scoreMove(board, move.row, move.col, player) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, count);
}

// What the app would play for `player` under a given profile.
function chooseMove(board, player, profile) {
    const opponent = player === 1 ? 2 : 1;
    const win = engine.findImmediateMove(board, player);
    if (win) return { move: win, source: 'win' };
    const block = engine.findImmediateMove(board, opponent);
    if (block) return { move: block, source: 'block' };
    if (profile.vcf) {
        const vcf = engine.findVcfWin(board, player);
        if (vcf) return { move: vcf.move, source: 'vcf' };
        const vct = engine.findVctWin(board, player);
        if (vct) return { move: vct.move, source: 'vct' };
    }
    const results = topRoots(board, player, profile.roots)
        .map(move => engine.searchRootMove(board, move, player, profile.depth));
    // Scores are always from White's point of view: White maximises, Black minimises.
    results.sort((a, b) => (player === 2 ? b.score - a.score : a.score - b.score));
    return { move: results[0], source: 'search' };
}

// ---------------------------------------------------------------------------------------
// Judge: score each profile's move with a shared, deeper reference search
// ---------------------------------------------------------------------------------------

function judge(profiles, options) {
    // Random mid-game positions rarely contain a forcing line, so a mixed pool is the default
    // and `--tactical` restricts the sample to positions where White actually has a VCF.
    const pool = generatePositions(engine, options.tactical ? options.positions * 40 : options.positions * 6);
    let positions = pool;
    if (options.tactical) {
        // Only multi-step forcing wins: a one-move open four is found by every profile and
        // would not separate anything.
        positions = pool.filter(position => {
            const hit = engine.findVcfWin(position, 2);
            return hit !== null && hit.line.length >= 2;
        });
    }
    positions = positions.slice(0, options.positions);
    console.log(`judge: ${positions.length} positions${options.tactical ? ' (forcing)' : ''}, reference depth ${options.refDepth}, roots ${options.roots}\n`);
    if (positions.length === 0) {
        console.log('no positions matched the filter; try a larger --positions value');
        return;
    }

    const stats = profiles.map(profile => ({ profile, losses: [], matched: 0, blunders: 0, ms: 0, games: 0 }));
    let skipped = 0;

    for (const position of positions) {
        const refResults = topRoots(position, 2, options.roots)
            .map(move => engine.searchRootMove(position, move, 2, options.refDepth))
            .sort((a, b) => b.score - a.score);
        const best = refResults[0];
        if (best.score <= -engine.WIN_SCORE / 2) {
            skipped++;
            continue;
        }
        for (const stat of stats) {
            const started = Date.now();
            const { move } = chooseMove(position, 2, stat.profile);
            stat.ms += Date.now() - started;
            const known = refResults.find(result => result.row === move.row && result.col === move.col);
            const value = known ? known.score : engine.searchRootMove(position, move, 2, options.refDepth).score;
            const loss = best.score - value;
            stat.losses.push(loss);
            if (loss === 0) stat.matched++;
            // A blunder is a move that throws away a whole threat class, not a rounding error.
            if (loss >= engine.WIN_SCORE / 10) stat.blunders++;
            stat.games++;
            if (options.verbose) {
                console.log(
                    `  pos ${stat.games} ${stat.profile.name.padEnd(7)} plays (${move.row},${move.col}) ` +
                    `value ${Math.round(value)}  ref (${best.row},${best.col}) ${Math.round(best.score)}  loss ${Math.round(loss)}`
                );
            }
        }
    }

    const nameWidth = Math.max(...profiles.map(profile => profile.name.length), 7);
    console.log(`${''.padEnd(nameWidth)}  ${'mean loss'.padStart(12)} ${'median'.padStart(10)} ${'best-move'.padStart(10)} ${'blunders'.padStart(9)} ${'ms/move'.padStart(8)}`);
    for (const stat of stats) {
        const sorted = stat.losses.slice().sort((a, b) => a - b);
        const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
        const median = sorted[Math.floor(sorted.length / 2)] || 0;
        const matched = `${stat.matched}/${stat.games}`;
        console.log(
            `${stat.profile.name.padEnd(nameWidth)}  ${Math.round(mean).toString().padStart(12)} ` +
            `${Math.round(median).toString().padStart(10)} ${matched.padStart(10)} ` +
            `${String(stat.blunders).padStart(9)} ${(stat.ms / Math.max(1, stat.games)).toFixed(0).padStart(8)}`
        );
    }
    if (skipped) console.log(`\nskipped ${skipped} position(s) that were already lost for White`);
    console.log('\nloss is measured in evaluation points against the same reference search;');
    console.log('lower is better, and "blunders" counts moves losing >= 10% of a win (i.e. a threat class).');
}

// ---------------------------------------------------------------------------------------
// Play: direct games with colours swapped
// ---------------------------------------------------------------------------------------

const OPENINGS = [[6, 7], [7, 6], [6, 6], [8, 8], [6, 8], [8, 6]];

function playGame(blackProfile, whiteProfile, whiteOpening) {
    const board = engine.createBoard();
    board[7][7] = 1;
    board[whiteOpening[0]][whiteOpening[1]] = 2;
    let mover = 1;
    for (let ply = 2; ply < 225; ply++) {
        const profile = mover === 1 ? blackProfile : whiteProfile;
        const { move } = chooseMove(board, mover, profile);
        if (!move || board[move.row][move.col] !== 0) return { winner: 0, plies: ply };
        board[move.row][move.col] = mover;
        if (engine.checkWin(board, move.row, move.col, mover)) return { winner: mover, plies: ply + 1 };
        mover = mover === 1 ? 2 : 1;
    }
    return { winner: 0, plies: 225 };
}

function play(a, b) {
    const started = Date.now();
    const tally = { black: 0, white: 0, draw: 0, plies: 0, games: 0 };
    const rows = [];
    for (const opening of OPENINGS) {
        for (const aIsBlack of [true, false]) {
            const result = aIsBlack ? playGame(a, b, opening) : playGame(b, a, opening);
            tally.games++;
            tally.plies += result.plies;
            if (result.winner === 0) tally.draw++;
            else if (result.winner === 1) tally.black++;
            else tally.white++;
            const aColour = aIsBlack ? 'black' : 'white';
            const won = result.winner === (aIsBlack ? 1 : 2);
            rows.push(`  ${a.name} as ${aColour.padEnd(5)} opening (${opening[0]},${opening[1]})  -> ${result.winner ? (won ? `${a.name} wins` : `${b.name} wins`) : 'draw'} at ply ${result.plies}`);
        }
    }
    for (const row of rows) console.log(row);
    console.log(`\n${a.name} vs ${b.name}: ${tally.games} games in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    console.log(`  black wins ${tally.black}  white wins ${tally.white}  draws ${tally.draw}  avg plies ${(tally.plies / tally.games).toFixed(0)}`);
    console.log('\ncaveat: gomoku is a first-player win, so a colour-split result near 50% means');
    console.log('"indistinguishable", not "equally strong". Prefer the judge mode for small gaps.');
}

// ---------------------------------------------------------------------------------------

const mode = argValue('--mode') || 'judge';
const options = {
    positions: Number(argValue('--positions') || 6),
    refDepth: Number(argValue('--ref-depth') || 10),
    roots: Number(argValue('--roots') || 8),
    tactical: process.argv.includes('--tactical'),
    verbose: process.argv.includes('--verbose')
};
const profileA = parseProfile(argValue('--a') || 'depth=6,vcf=1,name=normal', 'normal');
const profileB = parseProfile(argValue('--b') || 'depth=2,vcf=0,name=easy', 'easy');

if (mode === 'play') play(profileA, profileB);
else judge([profileA, profileB], options);



