import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { EngineStateMessage } from '../lib/messaging';
import { sendMessage } from '../lib/messaging';
import type { BackupSummary } from '../lib/rules-storage';
import { BACKUP_REASON_LABELS, MAX_BACKUPS } from '../lib/rules-storage';
import { Button, Callout, ErrorState, LoadingState, Panel, useAsync } from '../ui';

export interface BackupsPanelProps {
  onRestored: (state: EngineStateMessage) => void;
}

/**
 * Snapshots, and a one-click way back.
 *
 * "My rules vanished after an update" is the most damaging complaint in this
 * category, so a snapshot is taken automatically before every update, migration,
 * import and restore — and this panel is the obvious way back from any of them.
 * Restoring takes its own snapshot first, so a mistaken restore is undoable too.
 */
export function BackupsPanel({ onRestored }: BackupsPanelProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // `useAsync` owns the re-run counter; a second one here would fire the same
  // request twice per refresh and race its own answers.
  const { state, reload: refresh } = useAsync(() => sendMessage('rules:listBackups', {}), []);

  const backUpNow = (): void => {
    setBusy('new');
    setMessage(null);
    sendMessage('rules:createBackup', {}).then(
      (result) => {
        setBusy(null);
        if (result.error) {
          setMessage({ tone: 'danger', text: result.error });
          return;
        }
        setMessage({
          tone: 'success',
          text:
            result.dropped.length > 0
              ? `Snapshot saved. The oldest snapshot was dropped to stay within ${MAX_BACKUPS}.`
              : 'Snapshot saved.',
        });
        refresh();
      },
      (cause: unknown) => {
        setBusy(null);
        setMessage({ tone: 'danger', text: describe(cause) });
      },
    );
  };

  const restore = (backup: BackupSummary): void => {
    setBusy(backup.id);
    setMessage(null);
    sendMessage('rules:restoreBackup', { backupId: backup.id }).then(
      (result) => {
        setBusy(null);
        setConfirming(null);
        if (!result.ok || !result.state) {
          setMessage({ tone: 'danger', text: result.error ?? 'The restore failed.' });
          return;
        }
        onRestored(result.state);
        setMessage({
          tone: 'success',
          text: `Restored ${backup.ruleCount} rule(s). The rules you had a moment ago were saved as a new snapshot first.`,
        });
        refresh();
      },
      (cause: unknown) => {
        setBusy(null);
        setMessage({ tone: 'danger', text: describe(cause) });
      },
    );
  };

  return (
    <Panel
      title="Backups"
      description={`A snapshot is taken automatically before every import, restore and extension update. The last ${MAX_BACKUPS} are kept on this device.`}
    >
      {message ? (
        <Callout tone={message.tone} live>
          <p>{message.text}</p>
        </Callout>
      ) : null}

      {state.status === 'loading' ? <LoadingState label="Reading backups" /> : null}

      {state.status === 'error' ? (
        <ErrorState title="Could not read backups" detail={state.error.message} onRetry={refresh} />
      ) : null}

      {state.status === 'success' && state.value.backups.length === 0 ? (
        <p class="ui-muted">
          No snapshots yet. One is taken the first time your rules are about to change in a way that
          could lose them.
        </p>
      ) : null}

      {state.status === 'success' && state.value.backups.length > 0 ? (
        <ul class="ui-list">
          {state.value.backups.map((backup) => (
            <li key={backup.id} class="ui-item">
              <div class="ui-row ui-row--between ui-row--wrap">
                <div class="ui-grow ui-stack ui-stack--1">
                  <span class="ui-label">{formatTime(backup.createdAt)}</span>
                  <span class="ui-muted">
                    {BACKUP_REASON_LABELS[backup.reason]} · {backup.profileCount} profile
                    {backup.profileCount === 1 ? '' : 's'} · {backup.ruleCount} rule
                    {backup.ruleCount === 1 ? '' : 's'}
                  </span>
                </div>
                <Button
                  loading={busy === backup.id}
                  onClick={() => {
                    if (confirming === backup.id) restore(backup);
                    else setConfirming(backup.id);
                  }}
                >
                  {confirming === backup.id ? 'Replace my rules with this?' : 'Restore'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <div class="ui-row">
        <Button loading={busy === 'new'} onClick={backUpNow}>
          Back up now
        </Button>
      </div>
    </Panel>
  );
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
