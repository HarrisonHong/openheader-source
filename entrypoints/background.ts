import { browser, defineBackground } from '#imports';
import { getLicenseProvider } from '../lib/licensing';
import type { EngineStateMessage } from '../lib/messaging';
import { registerMessageHandlers } from '../lib/messaging';
import type { EngineState } from '../lib/rules-engine';
import {
  applyRules,
  exportRules,
  importRules,
  listBackups,
  restoreBackup,
  snapshot,
} from '../lib/rules-engine';
import { rulesDocument, summariseBackup } from '../lib/rules-storage';
import type { InstallState } from '../lib/storage';
import {
  MAX_QUARANTINE_GENERATIONS,
  PRIVACY_DISCLOSURE_VERSION,
  defaultInstallState,
  installState,
} from '../lib/storage';

/**
 * MV3 service worker.
 *
 * Chrome terminates this worker at any moment, with no warning and no chance to
 * flush, so it holds no module-scope mutable state: anything a later event reads
 * was written to `lib/storage.ts` by an earlier one. Listeners are registered
 * synchronously at the top level, so a worker revived to deliver an event
 * actually has a listener for it, and each handler reads state, acts, and writes
 * state. See docs/architecture.md.
 */
export default defineBackground(() => {
  browser.runtime.onInstalled.addListener((details) => {
    // The listener has to stay sync, so the async work is fire-and-forget.
    void handleInstalledEvent(details.reason);
  });

  // Dynamic rules survive a browser restart, but the permissions behind them may
  // not. Recompiling on startup means a revoked origin turns into a visible
  // "waiting for site access" rather than a rule that quietly stopped working.
  browser.runtime.onStartup.addListener(() => {
    void reapply('startup');
  });

  // Granting or revoking site access changes which rules can apply, so the
  // ruleset is rebuilt the moment it happens rather than at the next save.
  browser.permissions.onAdded.addListener(() => {
    void reapply('permission granted');
  });
  browser.permissions.onRemoved.addListener(() => {
    void reapply('permission revoked');
  });

  registerMessageHandlers({
    'runtime:ping': async () => ({
      ok: true as const,
      respondedAt: Date.now(),
      extensionVersion: browser.runtime.getManifest().version,
    }),

    'install:getState': async () => {
      const state = await installState.getOrThrow();
      return {
        installedAt: state.installedAt,
        onboardingCompletedAt: state.onboardingCompletedAt,
        privacyDisclosureAcknowledged:
          state.acknowledgedPrivacyVersion >= PRIVACY_DISCLOSURE_VERSION,
      };
    },

    'onboarding:complete': async () => {
      await installState.update((current) => ({
        ...current,
        onboardingCompletedAt: current.onboardingCompletedAt ?? Date.now(),
        acknowledgedPrivacyVersion: PRIVACY_DISCLOSURE_VERSION,
        // Acknowledging a disclosure means it was shown. Keeps the invariant
        // `acknowledged <= shown` true even if the page was opened directly.
        shownPrivacyVersion: Math.max(current.shownPrivacyVersion, PRIVACY_DISCLOSURE_VERSION),
      }));
      return { ok: true as const };
    },

    'license:getEntitlement': async () => getLicenseProvider().getEntitlement(),

    'rules:getState': async () => toMessage(await applyRules()),

    'rules:save': async ({ document }) => {
      await rulesDocument.set(document);
      return toMessage(await applyRules({ document }));
    },

    'rules:import': async ({ source, json, mode, sites }) => {
      const outcome = await importRules({ source, json, mode, sites });
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, report: null, state: null };
      }
      return {
        ok: true,
        error: null,
        report: outcome.report,
        state: toMessage(await applyRules({ document: outcome.document })),
      };
    },

    'rules:export': async ({ profileIds }) => exportRules(profileIds),

    'rules:listBackups': async () => ({
      backups: (await listBackups()).map(summariseBackup),
    }),

    'rules:createBackup': async () => {
      const outcome = await snapshot('manual');
      if (!outcome) {
        return {
          created: null,
          dropped: [],
          error:
            'There is nothing to back up yet: no rules have been saved on this device. Create a rule first.',
        };
      }
      return { created: outcome.created, dropped: outcome.dropped, error: null };
    },

    'rules:restoreBackup': async ({ backupId }) => {
      const outcome = await restoreBackup(backupId);
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, state: null, dropped: [] };
      }
      return {
        ok: true,
        error: null,
        state: toMessage(await applyRules({ document: outcome.document })),
        dropped: outcome.replacedBy?.dropped ?? [],
      };
    },
  });
});

/**
 * Flattens the engine's discriminated `verification` union for the wire, so the
 * message contract stays a plain object schema.
 */
function toMessage(state: EngineState): EngineStateMessage {
  return {
    document: state.document,
    statuses: state.statuses,
    grantedOrigins: state.grantedOrigins,
    installedRuleCount: state.installedRuleCount,
    engineError: state.engineError,
    verification: state.verification.ok
      ? { ok: true, detail: null }
      : { ok: false, detail: state.verification.detail },
    recoveryError: state.recoveryError,
    quarantinedAt: state.quarantinedAt,
  };
}

/**
 * Rebuilds the ruleset outside a message handler. Nothing is listening for the
 * result, so a failure has nowhere to go but the console — which is exactly why
 * it is logged rather than swallowed.
 */
async function reapply(trigger: string): Promise<void> {
  try {
    const state = await applyRules();
    if (state.engineError) {
      console.warn(`[background] ${trigger}: ${state.engineError}`);
    }
    if (!state.verification.ok) {
      console.warn(
        `[background] ${trigger}: the browser's rule set does not match what was installed — ${state.verification.detail}`,
      );
    }
  } catch (cause) {
    console.warn(`[background] ${trigger}: could not apply header rules: ${describeCause(cause)}`);
  }
}

const WELCOME_PAGE = '/welcome.html';

type WelcomeDecision = { open: false } | { open: true; notice: 'privacy' | null };

/**
 * Whether to put the welcome page in front of the user, and whether it may
 * honestly say the disclosure changed. Chrome Web Store policy (effective
 * 2026-08-01) requires proactive notice when disclosed data practices change
 * after install.
 *
 * There are three states here, and a bare `shown < current` would collapse them
 * into two. `shown === current` has nothing to say. `0 < shown < current` means
 * a newer disclosure genuinely exists, so the change banner is truthful. But
 * `shown === 0` means no disclosure is on record as having reached this user at
 * all — never shown, the tab failed to open, or the record was quarantined —
 * and calling that a change would be a lie.
 */
function decideWelcome(
  reason: string,
  shownPrivacyVersion: number,
  disclosureVersion: number,
): WelcomeDecision {
  if (reason === 'install') return { open: true, notice: null };
  if (reason !== 'update') return { open: false };
  if (shownPrivacyVersion >= disclosureVersion) return { open: false };
  return { open: true, notice: shownPrivacyVersion > 0 ? 'privacy' : null };
}

/**
 * The listener cannot await, so a rejection from `handleInstalled` — a storage
 * write refused for quota, a backend that vanished mid-event — would surface
 * only as a bare unhandled rejection. Every other failure path here says what
 * went wrong; so does this one.
 */
export async function handleInstalledEvent(
  reason: string,
  disclosureVersion: number = PRIVACY_DISCLOSURE_VERSION,
): Promise<void> {
  try {
    await handleInstalled(reason, disclosureVersion);
  } catch (cause) {
    console.warn(
      `[background] onInstalled ("${reason}") did not complete: ${describeCause(cause)}. ` +
        'Install state may be stale until the next event.',
    );
  }
}

/**
 * Exported for `tests/background.test.ts`; the listener above stays synchronous.
 * `disclosureVersion` is injected rather than read from the module so the
 * re-notice path is exercisable at any disclosure version, the same way
 * `lib/licensing.ts` injects its clock.
 */
export async function handleInstalled(
  reason: string,
  disclosureVersion: number = PRIVACY_DISCLOSURE_VERSION,
): Promise<void> {
  const version = browser.runtime.getManifest().version;
  const now = Date.now();

  // Before anything else touches storage. An update is the moment rules
  // historically vanish in this category, so snapshot the set before this build
  // gets a chance to migrate or rewrite it.
  if (reason === 'update') {
    try {
      await snapshot('before-update', now);
    } catch (cause) {
      console.warn(
        `[background] could not back up your rules before this update: ${describeCause(cause)}`,
      );
    }
  }

  // Rules are installed on both install and update: a fresh profile has none,
  // and an update must not leave the previous build's compiled rules in place.
  await reapply(`onInstalled (${reason})`);

  let previous: InstallState;
  try {
    previous = await installState.getOrThrow();
  } catch (cause) {
    // Not readable is not ours to destroy: it may have been written by a newer
    // build, which lib/storage.ts refuses to downgrade. Copy it aside, say so,
    // then carry on from a known-good baseline.
    previous = defaultInstallState();
    await announceUnreadableInstallState(cause);
  }

  const decision = decideWelcome(reason, previous.shownPrivacyVersion, disclosureVersion);

  let shownPrivacyVersion = previous.shownPrivacyVersion;
  if (decision.open) {
    const base = browser.runtime.getURL(WELCOME_PAGE);
    try {
      await browser.tabs.create({
        url: decision.notice === 'privacy' ? `${base}?notice=privacy` : base,
      });
      shownPrivacyVersion = disclosureVersion;
    } catch (cause) {
      // Record nothing as shown, so the notice is retried rather than lost.
      console.warn(`[background] could not open the welcome page: ${describeCause(cause)}`);
    }
  }

  await installState.set({
    ...previous,
    installedAt: previous.installedAt === 0 ? now : previous.installedAt,
    lastSeenVersion: version,
    shownPrivacyVersion,
  });
}

async function announceUnreadableInstallState(cause: unknown): Promise<void> {
  const detail = describeCause(cause);
  const result = await installState.quarantine(detail);

  if (!result.quarantined) {
    console.warn(
      `[background] install state is unreadable: ${detail}. Continuing from defaults; ` +
        `nothing was preserved (${result.reason}).`,
    );
    return;
  }

  console.warn(
    `[background] install state is unreadable: ${detail}. Continuing from defaults; ` +
      `the raw record was preserved at "${result.key}".`,
  );
  if (result.displaced) {
    console.warn(
      `[background] quarantine is full at ${MAX_QUARANTINE_GENERATIONS} generations: dropped the ` +
        `oldest copy "${result.displaced.key}" (${result.displaced.detail}) to keep the newest record.`,
    );
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
