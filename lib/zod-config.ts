/**
 * Turns off zod's JIT validator compilation, process-wide.
 *
 * zod builds fast object validators with the `Function` constructor, and probes
 * for permission to do so by constructing one. Under this extension's CSP both
 * are dead ends — `script-src 'self'` blocks them — but the probe still raises a
 * `securitypolicyviolation`, and "no dynamic code" is a guarantee this product
 * makes rather than a preference. `jitless` is zod's documented switch for it.
 * The cost is some validation speed on schemas nothing here validates in a hot
 * loop.
 *
 * This is its own module because the order matters. zod reads `jitless` when a
 * schema is constructed, not when it is parsed, and evaluating `allowsEval` is
 * what runs the probe — so the setting must be in force before the first
 * `z.object()` anywhere, on any surface. Every module that builds a schema
 * imports this one first, and ES modules evaluate imports depth-first in source
 * order, so that ordering is guaranteed rather than hoped for.
 *
 * The `Function` references left in zod's shipped code are unreachable as a
 * result, and are declared as such in `scripts/verify-bundle.mjs`. See
 * docs/security.md.
 */

import { z } from 'zod';

z.config({ jitless: true });
