import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { hostnameOf, patternForDomain } from '../lib/match-patterns';
import type { EngineStateMessage } from '../lib/messaging';
import { sendMessage } from '../lib/messaging';
import type { ImportReport } from '../lib/modheader';
import { Button, Callout, Panel, Select, TextField } from '../ui';

export interface ImportPanelProps {
  onImported: (state: EngineStateMessage) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; report: ImportReport };

const SOURCE_OPTIONS = [
  { value: 'modheader', label: 'ModHeader export (.json)' },
  { value: 'file', label: 'A rule file exported from this extension' },
];

const MODE_OPTIONS = [
  { value: 'merge', label: 'Add to my existing rules' },
  { value: 'replace', label: 'Replace everything I have' },
];

/**
 * One-click ModHeader import.
 *
 * ModHeader was pulled from both stores, so its own export button is out of
 * reach for anyone who has not already saved a file — the copy below says so and
 * points at the recovery tool rather than leaving people stuck.
 *
 * The import never silently drops anything: what could not be represented comes
 * back as a note, and a snapshot of the previous rules is taken before the write
 * so an import can always be undone from Backups.
 */
export function ImportPanel({ onImported }: ImportPanelProps): JSX.Element {
  const [source, setSource] = useState<'modheader' | 'file'>('modheader');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [json, setJson] = useState('');
  const [sites, setSites] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const readFile = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setPhase({ kind: 'working' });
    file.text().then(
      (text) => {
        setJson(text);
        setPhase({ kind: 'idle' });
      },
      (cause: unknown) => {
        setPhase({
          kind: 'failed',
          error: `That file could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      },
    );
  };

  const run = (): void => {
    if (json.trim() === '') {
      setPhase({ kind: 'failed', error: 'Choose a file or paste the exported JSON first.' });
      return;
    }

    setPhase({ kind: 'working' });
    sendMessage('rules:import', { source, json, mode, sites: parseSites(sites) }).then(
      (result) => {
        if (!result.ok || !result.report) {
          setPhase({ kind: 'failed', error: result.error ?? 'The import failed.' });
          return;
        }
        setPhase({ kind: 'done', report: result.report });
        setJson('');
        if (result.state) onImported(result.state);
      },
      (cause: unknown) => {
        setPhase({
          kind: 'failed',
          error: cause instanceof Error ? cause.message : String(cause),
        });
      },
    );
  };

  return (
    <Panel
      title="Import your rules"
      description="Bring a ModHeader export straight in. No account, no upload — the file is read on this device and never sent anywhere."
    >
      <Select
        label="What are you importing?"
        value={source}
        options={SOURCE_OPTIONS}
        onValueChange={(value) => setSource(value as 'modheader' | 'file')}
      />

      {source === 'modheader' ? (
        <Callout tone="info">
          <p>
            ModHeader was removed from the Chrome and Edge stores in July 2026, so its Export button
            may be out of reach. If you no longer have an export file, its profiles are still in
            your browser profile on disk and can be recovered with a command-line tool — search for
            <span class="ui-mono"> modheader-export-backup</span>.
          </p>
        </Callout>
      ) : null}

      <div class="ui-field">
        <label class="ui-field__label" for="import-file">
          Choose a file
        </label>
        <input id="import-file" class="ui-input" type="file" accept=".json,application/json" onChange={readFile} />
      </div>

      <div class="ui-field">
        <label class="ui-field__label" for="import-json">
          …or paste the JSON
        </label>
        <textarea
          id="import-json"
          class="ui-textarea"
          value={json}
          placeholder='[{"title": "Staging", "headers": [ … ]}]'
          onInput={(event) => setJson((event.currentTarget as HTMLTextAreaElement).value)}
        />
      </div>

      <Select
        label="Where should they go?"
        value={mode}
        options={MODE_OPTIONS}
        hint="Either way, a backup of your current rules is taken first."
        onValueChange={(value) => setMode(value as 'merge' | 'replace')}
      />

      <TextField
        label="Sites these rules should apply to (optional)"
        value={sites}
        placeholder="api.example.com, localhost"
        hint="ModHeader held access to every site. This extension never does, so imported rules start with no site access unless you name the sites here or accept the ones suggested from their URL filters."
        onValueChange={setSites}
      />

      <div class="ui-row">
        <Button variant="primary" loading={phase.kind === 'working'} onClick={run}>
          Import
        </Button>
      </div>

      {phase.kind === 'failed' ? (
        <Callout tone="danger" title="Nothing was imported" live>
          <p>{phase.error}</p>
          <p>Your existing rules are untouched.</p>
        </Callout>
      ) : null}

      {phase.kind === 'done' ? (
        <Callout tone="success" title="Imported" live>
          <p>
            {phase.report.profileCount} profile{phase.report.profileCount === 1 ? '' : 's'},{' '}
            {phase.report.ruleCount} rule{phase.report.ruleCount === 1 ? '' : 's'} and{' '}
            {phase.report.headerCount} header{phase.report.headerCount === 1 ? '' : 's'}. A backup
            of your previous rules is in Backups below.
          </p>
          {phase.report.notes.length > 0 ? (
            <ul class="ui-stack ui-stack--1">
              {phase.report.notes.map((note, position) => (
                <li key={`${note.profile ?? ''}-${position}`}>
                  {note.level === 'warning' ? '⚠ ' : ''}
                  {note.profile ? <strong>{note.profile}: </strong> : null}
                  {note.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Callout>
      ) : null}
    </Panel>
  );
}

/** `example.com, https://api.test` → narrow match patterns. */
function parseSites(raw: string): string[] {
  const patterns = raw
    .split(/[\s,]+/)
    .map((entry) => hostnameOf(entry))
    .filter((host): host is string => host !== null)
    .map(patternForDomain);
  return [...new Set(patterns)];
}
