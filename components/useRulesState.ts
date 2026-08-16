/**
 * The shared rule-set state for the popup and the options page.
 *
 * The surface owns the document and writes it through `rules:save`, which
 * recompiles and reinstalls. Two things keep that honest. A save response never
 * overwrites the local document, only the statuses — otherwise a response
 * landing mid-keystroke would reset the field under the user's cursor. And a
 * pending debounced save is flushed when the surface goes away, because a popup
 * closes the instant it loses focus and an edit that was never written looks
 * exactly like an edit that was lost.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { RuleStatus } from '../lib/dnr';
import type { EngineStateMessage } from '../lib/messaging';
import { sendMessage } from '../lib/messaging';
import type { RulesDocument } from '../lib/rules';

export interface EngineSummary {
  grantedOrigins: string[];
  installedRuleCount: number;
  engineError: string | null;
  verification: { ok: boolean; detail: string | null };
  recoveryError: string | null;
  quarantinedAt: string | null;
}

export interface RulesState {
  phase: 'loading' | 'ready' | 'error';
  /** Why the rule set could not be loaded at all. */
  loadError: string | null;
  document: RulesDocument | null;
  statuses: Map<string, RuleStatus>;
  engine: EngineSummary | null;
  saving: boolean;
  /** Why the last save failed. Shown next to the edit, not swallowed. */
  saveError: string | null;
  /** Write immediately. Use for toggles, switches and destructive actions. */
  update: (change: (document: RulesDocument) => RulesDocument) => void;
  /** Write after a short pause. Use for text the user is still typing. */
  updateDeferred: (change: (document: RulesDocument) => RulesDocument) => void;
  /** Replace the document wholesale (import, restore) with a known-good state. */
  replace: (state: EngineStateMessage) => void;
  refresh: () => void;
}

const SAVE_DEBOUNCE_MS = 400;

function summarise(state: EngineStateMessage): EngineSummary {
  return {
    grantedOrigins: state.grantedOrigins,
    installedRuleCount: state.installedRuleCount,
    engineError: state.engineError,
    verification: state.verification,
    recoveryError: state.recoveryError,
    quarantinedAt: state.quarantinedAt,
  };
}

function index(statuses: readonly RuleStatus[]): Map<string, RuleStatus> {
  return new Map(statuses.map((status) => [status.ruleId, status]));
}

export function useRulesState(): RulesState {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [document, setDocument] = useState<RulesDocument | null>(null);
  const [statuses, setStatuses] = useState<Map<string, RuleStatus>>(new Map());
  const [engine, setEngine] = useState<EngineSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** The document a pending save will write. Kept out of state so the timer
   *  callback never closes over a stale render. */
  const pending = useRef<RulesDocument | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyState = useCallback((state: EngineStateMessage) => {
    setStatuses(index(state.statuses));
    setEngine(summarise(state));
  }, []);

  const write = useCallback(
    (next: RulesDocument) => {
      setSaving(true);
      sendMessage('rules:save', { document: next }).then(
        (state) => {
          setSaving(false);
          setSaveError(null);
          applyState(state);
        },
        (cause: unknown) => {
          setSaving(false);
          setSaveError(
            `Your change was not saved: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        },
      );
    },
    [applyState],
  );

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (next) write(next);
  }, [write]);

  const load = useCallback(() => {
    setPhase('loading');
    sendMessage('rules:getState', {}).then(
      (state) => {
        setDocument(state.document);
        applyState(state);
        setPhase('ready');
        setLoadError(null);
      },
      (cause: unknown) => {
        setPhase('error');
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [applyState]);

  useEffect(() => {
    load();
  }, [load]);

  // A popup is destroyed the moment it loses focus, so anything still waiting on
  // the debounce has to be written on the way out.
  useEffect(() => {
    const onHidden = (): void => {
      if (globalThis.document.visibilityState === 'hidden') flush();
    };
    globalThis.document.addEventListener('visibilitychange', onHidden);
    globalThis.addEventListener('pagehide', flush);
    return () => {
      globalThis.document.removeEventListener('visibilitychange', onHidden);
      globalThis.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const mutate = useCallback(
    (change: (document: RulesDocument) => RulesDocument, deferred: boolean) => {
      setDocument((current) => {
        if (!current) return current;
        const next = change(current);
        pending.current = next;

        if (timer.current !== null) clearTimeout(timer.current);
        if (deferred) {
          timer.current = setTimeout(() => {
            timer.current = null;
            const queued = pending.current;
            pending.current = null;
            if (queued) write(queued);
          }, SAVE_DEBOUNCE_MS);
        } else {
          timer.current = null;
          pending.current = null;
          write(next);
        }

        return next;
      });
    },
    [write],
  );

  const update = useCallback(
    (change: (document: RulesDocument) => RulesDocument) => mutate(change, false),
    [mutate],
  );

  const updateDeferred = useCallback(
    (change: (document: RulesDocument) => RulesDocument) => mutate(change, true),
    [mutate],
  );

  const replace = useCallback(
    (state: EngineStateMessage) => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = null;
      setDocument(state.document);
      applyState(state);
      setSaveError(null);
    },
    [applyState],
  );

  return {
    phase,
    loadError,
    document,
    statuses,
    engine,
    saving,
    saveError,
    update,
    updateDeferred,
    replace,
    refresh: load,
  };
}
