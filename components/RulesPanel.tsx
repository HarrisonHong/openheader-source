import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { RuleStatus } from '../lib/dnr';
import type { HeaderRule, Profile, RulesDocument } from '../lib/rules';
import {
  addRule,
  cloneRuleWithNewIds,
  createRule,
  moveRule,
  randomId,
  removeRule,
  updateRule,
} from '../lib/rules';
import { Button, EmptyState, Panel, StatusBadge, Switch } from '../ui';
import { RuleEditor } from './RuleEditor';

export interface RulesPanelProps {
  profile: Profile;
  statuses: Map<string, RuleStatus>;
  grantedOrigins: readonly string[];
  onChange: (change: (document: RulesDocument) => RulesDocument, deferred: boolean) => void;
  onPermissionsChanged: () => void;
}

export function RulesPanel({
  profile,
  statuses,
  grantedOrigins,
  onChange,
  onPermissionsChanged,
}: RulesPanelProps): JSX.Element {
  const [openRuleId, setOpenRuleId] = useState<string | null>(null);

  const add = (): void => {
    const rule = createRule(randomId, 'New rule');
    setOpenRuleId(rule.id);
    onChange((current) => addRule(current, profile.id, rule), false);
  };

  return (
    <Panel
      title={`Rules in "${profile.name}"`}
      description="Every rule says whether it is applying. A rule that cannot apply says why."
    >
      {profile.rules.length === 0 ? (
        <EmptyState
          title="No rules in this profile"
          body="A rule adds, replaces or removes one or more headers on the sites you name — on page loads and on fetch/XHR alike."
          action={
            <Button variant="primary" onClick={add}>
              Create your first rule
            </Button>
          }
        />
      ) : (
        <ul class="ui-list">
          {profile.rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              status={statuses.get(rule.id)}
              open={openRuleId === rule.id}
              grantedOrigins={grantedOrigins}
              onToggleOpen={() => setOpenRuleId(openRuleId === rule.id ? null : rule.id)}
              onChange={(change, deferred) =>
                onChange((current) => updateRule(current, rule.id, change), deferred)
              }
              onDelete={() => {
                setOpenRuleId(null);
                onChange((current) => removeRule(current, rule.id), false);
              }}
              onDuplicate={() =>
                onChange(
                  (current) => addRule(current, profile.id, cloneRuleWithNewIds(rule, randomId)),
                  false,
                )
              }
              onMove={(delta) => onChange((current) => moveRule(current, rule.id, delta), false)}
              onPermissionsChanged={onPermissionsChanged}
            />
          ))}
        </ul>
      )}

      {profile.rules.length > 0 ? (
        <div class="ui-row">
          <Button variant="primary" onClick={add}>
            Add rule
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function RuleRow({
  rule,
  status,
  open,
  grantedOrigins,
  onToggleOpen,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  onPermissionsChanged,
}: {
  rule: HeaderRule;
  status: RuleStatus | undefined;
  open: boolean;
  grantedOrigins: readonly string[];
  onToggleOpen: () => void;
  onChange: (change: (rule: HeaderRule) => HeaderRule, deferred: boolean) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (delta: number) => void;
  onPermissionsChanged: () => void;
}): JSX.Element {
  return (
    <li class="ui-item ui-stack ui-stack--2">
      <div class="ui-row ui-row--between ui-row--wrap">
        <Switch
          label={rule.name || 'Untitled rule'}
          checked={rule.enabled}
          onChange={(enabled) => onChange((current) => ({ ...current, enabled }), false)}
        />
        <div class="ui-row">
          <StatusBadge
            state={status?.state ?? 'inactive'}
            hasWarnings={(status?.warnings.length ?? 0) > 0}
          />
          <Button onClick={onToggleOpen} aria-expanded={open}>
            {open ? 'Close' : 'Edit'}
          </Button>
        </div>
      </div>

      <p class="ui-muted">{status?.summary ?? 'Not analysed yet.'}</p>

      {open ? (
        <>
          <hr class="ui-divider" />
          <RuleEditor
            rule={rule}
            status={status}
            grantedOrigins={grantedOrigins}
            onChange={onChange}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onMove={onMove}
            onPermissionsChanged={onPermissionsChanged}
          />
        </>
      ) : null}
    </li>
  );
}
