import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// Importing a schema module, NOT `./zod-config` — the point of the test is that
// touching any schema is enough to have switched the JIT off.
import './rules';

/**
 * zod reads `jitless` when a schema is CONSTRUCTED, and constructing a schema is
 * what evaluates its `allowsEval` probe — the `new Function('')` that would
 * otherwise raise a CSP violation in the shipped extension. So the setting being
 * merely present somewhere is not the property worth testing; the property is
 * that it is already in force by the time any schema in this codebase is built.
 *
 * If this fails, a schema module lost its `import './zod-config'` first line.
 * See docs/security.md, "Dynamic code in dependencies, honestly".
 */
describe('zod JIT compilation', () => {
  it('is off by the time a schema module has been imported', () => {
    expect(z.config().jitless).toBe(true);
  });
});
