import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { sendMessage } from '../lib/messaging';
import type { RulesDocument } from '../lib/rules';
import { Button, Callout, ChipGroup, Panel } from '../ui';

export interface ExportPanelProps {
  document: RulesDocument;
}

/**
 * Account-free sharing: rules out to a file, nothing to a server.
 *
 * The download is built from a Blob in this page, so no `downloads` permission
 * is needed and the file never leaves the machine on its way out.
 */
export function ExportPanel({ document }: ExportPanelProps): JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const run = (): void => {
    setBusy(true);
    setError(null);
    sendMessage('rules:export', { profileIds: selected }).then(
      ({ json, fileName }) => {
        setBusy(false);
        try {
          download(json, fileName);
          setSaved(fileName);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
      (cause: unknown) => {
        setBusy(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <Panel
      title="Export and share"
      description="Save your rules to a file to back them up or hand to a colleague. There is no account and no server involved."
    >
      <ChipGroup
        legend="Profiles to export"
        hint="Select none to export all of them."
        options={document.profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
        selected={selected}
        onToggle={(value, on) =>
          setSelected((current) =>
            on ? [...current, value] : current.filter((entry) => entry !== value),
          )
        }
      />

      <div class="ui-row">
        <Button variant="primary" loading={busy} onClick={run}>
          Download rule file
        </Button>
      </div>

      {saved ? (
        <Callout tone="success" live>
          <p>
            Saved <span class="ui-mono">{saved}</span>. Treat it like a credential — exported rules
            often contain tokens and cookies.
          </p>
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" title="Could not export" live>
          <p>{error}</p>
        </Callout>
      ) : null}
    </Panel>
  );
}

function download(contents: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  try {
    const anchor = globalThis.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    // Revoking immediately would race the download in some Chrome versions.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
