import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { RulesDocument } from '../lib/rules';
import {
  addProfile,
  createProfile,
  duplicateProfile,
  isProfileActive,
  randomId,
  removeProfile,
  renameProfile,
  setProfileActive,
  switchToProfile,
} from '../lib/rules';
import { Button, Panel, Switch, TextField } from '../ui';

export interface ProfilesPanelProps {
  document: RulesDocument;
  selectedProfileId: string;
  onSelect: (profileId: string) => void;
  onChange: (change: (document: RulesDocument) => RulesDocument, deferred: boolean) => void;
}

/**
 * Real profiles, switched in one click.
 *
 * Not tags and not groups: a profile is a separate set of rules that is either
 * applied or not. That is the thing ModHeader users actually had, and the
 * surviving alternatives do not offer it.
 */
export function ProfilesPanel({
  document,
  selectedProfileId,
  onSelect,
  onChange,
}: ProfilesPanelProps): JSX.Element {
  const [newName, setNewName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const create = (): void => {
    const name = newName.trim() === '' ? `Profile ${document.profiles.length + 1}` : newName.trim();
    const profile = createProfile(randomId, name);
    setNewName('');
    onChange((current) => addProfile(current, profile), false);
    onSelect(profile.id);
  };

  return (
    <Panel
      title="Profiles"
      description="Each profile is its own set of rules. Switch between them in one click, or run more than one at a time."
    >
      <ul class="ui-list">
        {document.profiles.map((profile) => {
          const active = isProfileActive(document, profile.id);
          const selected = profile.id === selectedProfileId;
          return (
            <li key={profile.id} class={`ui-item${selected ? ' ui-item--selected' : ''}`}>
              <div class="ui-stack ui-stack--2">
                <div class="ui-row ui-row--between ui-row--wrap">
                  <div class="ui-grow">
                    <TextField
                      label={`Name of profile ${profile.name}`}
                      labelHidden
                      value={profile.name}
                      onValueChange={(name) =>
                        onChange((current) => renameProfile(current, profile.id, name), true)
                      }
                    />
                  </div>
                  <span class="ui-muted">
                    {profile.rules.length} rule{profile.rules.length === 1 ? '' : 's'}
                  </span>
                </div>

                <div class="ui-row ui-row--between ui-row--wrap">
                  <Switch
                    label="Applied"
                    checked={active}
                    onChange={(on) =>
                      onChange((current) => setProfileActive(current, profile.id, on), false)
                    }
                  />
                  <div class="ui-row ui-row--wrap">
                    {selected ? null : (
                      <Button onClick={() => onSelect(profile.id)}>Edit rules</Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => onChange((current) => switchToProfile(current, profile.id), false)}
                    >
                      Use only this
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        onChange((current) => duplicateProfile(current, profile.id, randomId), false)
                      }
                    >
                      Duplicate
                    </Button>
                    {document.profiles.length > 1 ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (confirmingDelete === profile.id) {
                            setConfirmingDelete(null);
                            if (selectedProfileId === profile.id) {
                              const next = document.profiles.find((entry) => entry.id !== profile.id);
                              if (next) onSelect(next.id);
                            }
                            onChange((current) => removeProfile(current, profile.id), false);
                          } else {
                            setConfirmingDelete(profile.id);
                          }
                        }}
                      >
                        {confirmingDelete === profile.id
                          ? `Delete "${profile.name}" and its ${profile.rules.length} rule(s)?`
                          : 'Delete'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div class="ui-row ui-row--top">
        <div class="ui-grow">
          <TextField
            label="New profile name"
            value={newName}
            placeholder="Staging"
            onValueChange={setNewName}
            onKeyDown={(event) => {
              if ((event as KeyboardEvent).key === 'Enter') {
                event.preventDefault();
                create();
              }
            }}
          />
        </div>
        <Button variant="primary" onClick={create}>
          Add profile
        </Button>
      </div>
    </Panel>
  );
}
