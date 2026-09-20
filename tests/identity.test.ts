import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../wxt.config';

/**
 * The product's name is not a cosmetic string: `manifest.name` IS the Chrome Web
 * Store listing title (the dashboard has no separate title field), and the store
 * rejects a submission whose title exceeds 75 characters. Nothing else in the
 * build looks at these strings, so a half-finished rename — the manifest renamed
 * and a page title left behind, or a listing title quietly grown past the limit —
 * would ship without a single check firing.
 *
 * The two forms and where each belongs are recorded in docs/single-purpose.md,
 * "On the name"; this file is the mechanical half of that document.
 */

/** The in-product name: `short_name`, the toolbar tooltip, every heading. */
const PRODUCT = 'Headerman';

/** The store listing title. Long enough to carry the phrase users search. */
const LISTING_TITLE = 'Headerman — HTTP Header Editor';

/** Chrome's hard limit on `manifest.name`. */
const NAME_LIMIT = 75;

const manifest = config.manifest as {
  name: string;
  short_name: string;
  action: { default_title: string };
};

describe('the manifest identity', () => {
  it('uses the listing title as the name', () => {
    expect(manifest.name).toBe(LISTING_TITLE);
  });

  it('stays inside the store limit on the name', () => {
    expect(manifest.name.length).toBeLessThanOrEqual(NAME_LIMIT);
  });

  it('uses the bare product name for the short name and the toolbar tooltip', () => {
    expect(manifest.short_name).toBe(PRODUCT);
    expect(manifest.action.default_title).toBe(PRODUCT);
  });

  it('opens the listing title with the product name', () => {
    expect(manifest.name.startsWith(PRODUCT)).toBe(true);
  });
});

/**
 * The page titles are the other place the product names itself, and they are
 * plain HTML no test would otherwise open.
 */
const ROOT = resolve(import.meta.dirname, '..');
const ENTRYPOINTS = ['popup', 'options', 'welcome'] as const;

describe.each(ENTRYPOINTS)('the %s page title', (entrypoint) => {
  const html = readFileSync(resolve(ROOT, 'entrypoints', entrypoint, 'index.html'), 'utf8');
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];

  it('names the product', () => {
    expect(title).toContain(PRODUCT);
  });
});
