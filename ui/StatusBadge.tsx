import type { JSX } from 'preact';
import type { RuleStatusState } from '../lib/dnr';

export interface StatusBadgeProps {
  state: RuleStatusState;
  /** True when the rule works but has something worth reading. */
  hasWarnings?: boolean;
}

/**
 * The rule's state, in one word plus a colour.
 *
 * This badge is the product's core promise made visible: every rule says
 * whether it is applying, and a rule that is not applying says so here rather
 * than looking identical to one that is. Colour never carries the meaning on its
 * own — the word does, and the badge is inside a labelled row.
 */
const PRESENTATION: Record<RuleStatusState, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'active' },
  inactive: { label: 'Inactive', tone: 'neutral' },
  'needs-permission': { label: 'Needs site access', tone: 'warning' },
  unsupported: { label: "Won't apply", tone: 'danger' },
  // Distinct from "Won't apply" on purpose: nothing is wrong with this rule, so
  // sending the user to look for a fault in it would waste their time. The
  // browser refused the whole set, and the callout above the list says so.
  'engine-refused': { label: 'Browser refused', tone: 'danger' },
};

export function StatusBadge({ state, hasWarnings = false }: StatusBadgeProps): JSX.Element {
  const { label, tone } = PRESENTATION[state];
  const showWarning = hasWarnings && state === 'active';

  return (
    <span class={`ui-badge ui-badge--${showWarning ? 'warning' : tone}`}>
      {showWarning ? 'Active, with notes' : label}
    </span>
  );
}
