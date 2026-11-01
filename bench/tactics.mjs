import { createRequire } from 'node:module';
import { cases } from './cases.mjs';

const require = createRequire(import.meta.url);
const engine = require('../js/gomoku-engine.js');

const verbose = process.argv.includes('--verbose');
const started = Date.now();
const failures = [];

console.log(`tactical suite: ${cases.length} cases\n`);

for (const testCase of cases) {
    const caseStarted = Date.now();
    const result = testCase.check(engine);
    const elapsed = Date.now() - caseStarted;
    const ok = result === true;
    if (!ok) failures.push({ name: testCase.name, reason: typeof result === 'string' ? result : 'failed' });
    if (verbose || !ok) {
        const mark = ok ? 'PASS' : 'FAIL';
        const detail = ok ? '' : `  <- ${typeof result === 'string' ? result : 'failed'}`;
        console.log(`  ${mark}  ${testCase.name.padEnd(62)} ${String(elapsed).padStart(5)} ms${detail}`);
    }
}

const passed = cases.length - failures.length;
const rate = (passed / cases.length * 100).toFixed(1);
console.log(`\npass rate ${passed}/${cases.length} (${rate}%) in ${Date.now() - started} ms`);
if (failures.length) {
    console.log('\nfailures:');
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.reason}`);
    process.exitCode = 1;
}
