import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { cases } from '../bench/cases.mjs';

const require = createRequire(import.meta.url);
const engine = require('../js/gomoku-engine.js');

// The case list lives in bench/cases.mjs so the test suite and bench/tactics.mjs can never
// drift apart. Each case returns `true` or a short reason string.
for (const testCase of cases) {
    test(testCase.name, () => {
        const result = testCase.check(engine);
        assert.equal(result, true, typeof result === 'string' ? result : 'case failed');
    });
}
