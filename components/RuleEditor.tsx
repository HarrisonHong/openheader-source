import type { JSX } from 'preact';
import type { RuleStatus } from '../lib/dnr';
import { checkRegexSupport } from '../lib/dnr';
import type {
  HeaderEdit,
  HeaderRule,
  Matcher,
  RequestMethod,
  ResourceType,
} from '../lib/rules';
import {
  HEADER_OPERATIONS,
  MATCHER_KINDS,
  MATCHER_KIND_LABELS,
  REQUEST_METHODS,
  RESOURCE_TYPES,
  createHeaderEdit,
  createMatcher,
  randomId,
} from '../lib/rules';
import { Button, ChipGroup, Select, StatusBadge, Switch, TextField } from '../ui';
import { RuleStatusDetail } from './RuleStatusDetail';
import { SiteAccess } from './SiteAccess';

export interface RuleEditorProps {
  rule: HeaderRule;
  status: RuleStatus | undefined;
  grantedOrigins: readonly string[];
  onChange: (change: (rule: HeaderRule) => HeaderRule, deferred: boolean) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (delta: number) => void;
  onPermissionsChanged: () => void;
}

const MATCHER_OPTIONS = MATCHER_KINDS.map((kind) => ({
  value: kind,
  label: MATCHER_KIND_LABELS[kind],
}));

const TARGET_OPTIONS = [
  { value: 'request', label: 'Request header' },
  { value: 'response', label: 'Response header' },
];

const OPERATION_OPTIONS = HEADER_OPERATIONS.map((operation) => ({
  value: operation,
  label: operation === 'set' ? 'Set' : operation === 'append' ? 'Append' : 'Remove',
}));

const RESOURCE_OPTIONS = RESOURCE_TYPES.map((type) => ({
  value: type,
  label: type === 'xmlhttprequest' ? 'fetch / XHR' : type.replace(/_/g, ' '),
}));

const METHOD_OPTIONS = REQUEST_METHODS.map((method) => ({
  value: method,
  label: method.toUpperCase(),
}));

const PLACEHOLDERS: Record<Matcher['kind'], string> = {
  domain: 'api.example.com',
  'url-prefix': 'https://api.example.com/v1/',
  'url-contains': '/graphql',
  'url-exact': 'https://api.example.com/v1/session',
  regex: String.raw`^https://api\.example\.com/v[0-9]+/`,
};

export function RuleEditor({
  rule,
  status,
  grantedOrigins,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  onPermissionsChanged,
}: RuleEditorProps): JSX.Element {
  const set = (change: (rule: HeaderRule) => HeaderRule): void => onChange(change, false);
  const type = (change: (rule: HeaderRule) => HeaderRule): void => onChange(change, true);

  return (
    <div class="ui-stack ui-stack--4">
      <div class="ui-row ui-row--between ui-row--wrap">
        <div class="ui-grow">
          <TextField
            label="Rule name"
            value={rule.name}
            placeholder="Staging auth token"
            onValueChange={(name) => type((current) => ({ ...current, name }))}
          />
        </div>
        <StatusBadge state={status?.state ?? 'inactive'} hasWarnings={(status?.warnings.length ?? 0) > 0} />
      </div>

      <Switch
        label="Rule is on"
        description={status?.summary}
        checked={rule.enabled}
        onChange={(enabled) => set((current) => ({ ...current, enabled }))}
      />

      <RuleStatusDetail status={status} />

      <HeaderList
        headers={rule.headers}
        onSet={(headers) => set((current) => ({ ...current, headers }))}
        onType={(headers) => type((current) => ({ ...current, headers }))}
        problems={status}
      />

      <MatcherList
        legend="Applies to"
        hint="A request matches when any one of these matches."
        matchers={rule.match}
        emptyMessage="This rule matches nothing yet. Add a condition."
        onSet={(match) => set((current) => ({ ...current, match }))}
        onType={(match) => type((current) => ({ ...current, match }))}
      />

      <MatcherList
        legend="Except"
        hint="A request matching any of these is left alone, regular expressions included, which browsers offer no built-in exclusion field for."
        matchers={rule.exclude}
        emptyMessage="No exceptions."
        onSet={(exclude) => set((current) => ({ ...current, exclude }))}
        onType={(exclude) => type((current) => ({ ...current, exclude }))}
      />

      <SiteAccess
        rule={rule}
        grantedOrigins={grantedOrigins}
        onChange={(sites) => set((current) => ({ ...current, sites }))}
        onPermissionsChanged={onPermissionsChanged}
      />

      <ChipGroup
        legend="Request types"
        hint="fetch / XHR is on by default — a header editor that leaves it out appears to work on page loads and does nothing on background requests."
        options={RESOURCE_OPTIONS}
        selected={rule.resourceTypes}
        onToggle={(value, on) =>
          set((current) => ({
            ...current,
            resourceTypes: toggle(current.resourceTypes, value as ResourceType, on),
          }))
        }
      />

      <ChipGroup
        legend="Request methods"
        hint="None selected means every method, including POST."
        options={METHOD_OPTIONS}
        selected={rule.requestMethods}
        onToggle={(value, on) =>
          set((current) => ({
            ...current,
            requestMethods: toggle(current.requestMethods, value as RequestMethod, on),
          }))
        }
      />

      <TextField
        label="Notes"
        value={rule.notes}
        hint="For you only. Never leaves this device."
        onValueChange={(notes) => type((current) => ({ ...current, notes }))}
      />

      <div class="ui-row ui-row--wrap">
        <Button onClick={() => onMove(-1)}>Move up</Button>
        <Button onClick={() => onMove(1)}>Move down</Button>
        <Button onClick={onDuplicate}>Duplicate</Button>
        <Button variant="ghost" onClick={onDelete}>
          Delete rule
        </Button>
      </div>
    </div>
  );
}

function toggle<T extends string>(values: readonly T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...values, value])] : values.filter((entry) => entry !== value);
}

function HeaderList({
  headers,
  onSet,
  onType,
  problems,
}: {
  headers: HeaderEdit[];
  onSet: (headers: HeaderEdit[]) => void;
  onType: (headers: HeaderEdit[]) => void;
  problems: RuleStatus | undefined;
}): JSX.Element {
  const replace = (
    id: string,
    change: (header: HeaderEdit) => HeaderEdit,
    deferred: boolean,
  ): void => {
    const next = headers.map((header) => (header.id === id ? change(header) : header));
    if (deferred) onType(next);
    else onSet(next);
  };

  const errorFor = (id: string): string | undefined =>
    problems?.problems.find((problem) => problem.headerId === id)?.message;

  return (
    <div class="ui-stack ui-stack--2">
      <div class="ui-stack ui-stack--1">
        <span class="ui-field__label">Headers</span>
        <span class="ui-field__hint">
          Request and response headers live on the same rule, so one rule can do both.
        </span>
      </div>

      {headers.length === 0 ? <p class="ui-muted">No headers yet.</p> : null}

      <ul class="ui-list">
        {headers.map((header) => (
          <li key={header.id} class="ui-item ui-stack ui-stack--2">
            <div class="ui-grid">
              <Select
                label="Applies to"
                value={header.target}
                options={TARGET_OPTIONS}
                onValueChange={(target) =>
                  replace(header.id, (current) => ({ ...current, target: target as HeaderEdit['target'] }), false)
                }
              />
              <Select
                label="Action"
                value={header.operation}
                options={OPERATION_OPTIONS}
                onValueChange={(operation) =>
                  replace(
                    header.id,
                    (current) => ({ ...current, operation: operation as HeaderEdit['operation'] }),
                    false,
                  )
                }
              />
            </div>
            <div class="ui-grid">
              <TextField
                label="Header name"
                mono
                value={header.name}
                placeholder="Authorization"
                error={errorFor(header.id)}
                onValueChange={(name) => replace(header.id, (current) => ({ ...current, name }), true)}
              />
              <TextField
                label="Value"
                mono
                value={header.value}
                placeholder="Bearer …"
                disabled={header.operation === 'remove'}
                hint={header.operation === 'remove' ? 'Not used when removing a header.' : undefined}
                onValueChange={(value) => replace(header.id, (current) => ({ ...current, value }), true)}
              />
            </div>
            <div class="ui-row ui-row--between ui-row--wrap">
              <Switch
                label="On"
                checked={header.enabled}
                onChange={(enabled) => replace(header.id, (current) => ({ ...current, enabled }), false)}
              />
              <Button
                variant="ghost"
                onClick={() => onSet(headers.filter((entry) => entry.id !== header.id))}
              >
                Remove header
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div class="ui-row">
        <Button onClick={() => onSet([...headers, createHeaderEdit(randomId, 'request')])}>
          Add request header
        </Button>
        <Button onClick={() => onSet([...headers, createHeaderEdit(randomId, 'response')])}>
          Add response header
        </Button>
      </div>
    </div>
  );
}

function MatcherList({
  legend,
  hint,
  matchers,
  emptyMessage,
  onSet,
  onType,
}: {
  legend: string;
  hint: string;
  matchers: Matcher[];
  emptyMessage: string;
  onSet: (matchers: Matcher[]) => void;
  onType: (matchers: Matcher[]) => void;
}): JSX.Element {
  const replace = (id: string, change: (matcher: Matcher) => Matcher, deferred: boolean): void => {
    const next = matchers.map((matcher) => (matcher.id === id ? change(matcher) : matcher));
    if (deferred) onType(next);
    else onSet(next);
  };

  return (
    <div class="ui-stack ui-stack--2">
      <div class="ui-stack ui-stack--1">
        <span class="ui-field__label">{legend}</span>
        <span class="ui-field__hint">{hint}</span>
      </div>

      {matchers.length === 0 ? <p class="ui-muted">{emptyMessage}</p> : null}

      <ul class="ui-list">
        {matchers.map((matcher) => {
          // Checked as the user types: a regex Chrome cannot compile is reported
          // here, not silently dropped when the rule is installed.
          const regexProblem =
            matcher.kind === 'regex' && matcher.value.trim() !== ''
              ? checkRegexSupport(matcher.value).reason
              : undefined;

          return (
            <li key={matcher.id} class="ui-item ui-stack ui-stack--2">
              <div class="ui-grid">
                <Select
                  label="Condition"
                  value={matcher.kind}
                  options={MATCHER_OPTIONS}
                  onValueChange={(kind) =>
                    replace(matcher.id, (current) => ({ ...current, kind: kind as Matcher['kind'] }), false)
                  }
                />
                <TextField
                  label="Value"
                  mono
                  value={matcher.value}
                  placeholder={PLACEHOLDERS[matcher.kind]}
                  error={regexProblem}
                  onValueChange={(value) =>
                    replace(matcher.id, (current) => ({ ...current, value }), true)
                  }
                />
              </div>
              <div class="ui-row ui-row--between ui-row--wrap">
                <Switch
                  label="On"
                  checked={matcher.enabled}
                  onChange={(enabled) =>
                    replace(matcher.id, (current) => ({ ...current, enabled }), false)
                  }
                />
                <Button
                  variant="ghost"
                  onClick={() => onSet(matchers.filter((entry) => entry.id !== matcher.id))}
                >
                  Remove
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div class="ui-row">
        <Button onClick={() => onSet([...matchers, createMatcher(randomId, 'domain', '')])}>
          Add condition
        </Button>
      </div>
    </div>
  );
}
