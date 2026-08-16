/**
 * Typed message contracts between extension surfaces.
 *
 * The only module allowed to touch `runtime.sendMessage` / `runtime.onMessage`;
 * ESLint enforces that everywhere else. Every message declares a request and a
 * response schema and both directions are validated at runtime, so a
 * version-skewed surface gets a typed error instead of `undefined` leaking into
 * the UI. The transport is injectable and the router is pure, so the contracts
 * are testable without a browser. See docs/architecture.md.
 */

import { browser } from '#imports';
import './zod-config';
import { z } from 'zod';
import { ruleStatusSchema } from './dnr';
import { entitlementSchema } from './licensing';
import { importReportSchema } from './modheader';
import { rulesDocumentSchema } from './rules';
import { backupSummarySchema } from './rules-storage';

/**
 * Everything a surface needs to render the rule list: the rules themselves, the
 * status of each one, and whether the browser actually took the rule set.
 *
 * `verification` is flattened to `{ ok, detail }` for the wire; the engine's own
 * discriminated union is reassembled by the caller if it needs it.
 */
export const engineStateSchema = z.object({
  document: rulesDocumentSchema,
  statuses: z.array(ruleStatusSchema),
  grantedOrigins: z.array(z.string()),
  installedRuleCount: z.number().int().nonnegative(),
  /** Non-null when the browser refused the rule set. */
  engineError: z.string().nullable(),
  verification: z.object({ ok: z.boolean(), detail: z.string().nullable() }),
  /** Non-null when the stored rules could not be read and were quarantined. */
  recoveryError: z.string().nullable(),
  quarantinedAt: z.string().nullable(),
});
export type EngineStateMessage = z.infer<typeof engineStateSchema>;

/** Envelope discriminator. Bumped only if the envelope shape itself changes. */
export const PROTOCOL_VERSION = 1;

/**
 * The message catalogue. Adding a message means adding a row here — there is no
 * other way to send one.
 */
export const MESSAGE_CONTRACTS = {
  /** Liveness probe. Used by the popup to confirm the service worker responds. */
  'runtime:ping': {
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      respondedAt: z.number().int().nonnegative(),
      extensionVersion: z.string(),
    }),
  },
  /** Read the foundation's install/onboarding state. */
  'install:getState': {
    request: z.object({}),
    response: z.object({
      installedAt: z.number().int().nonnegative(),
      onboardingCompletedAt: z.number().int().nonnegative().nullable(),
      privacyDisclosureAcknowledged: z.boolean(),
    }),
  },
  /** Mark onboarding (and the current privacy disclosure) as seen. */
  'onboarding:complete': {
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
  },
  /** Current entitlement, evaluated from the local cache. Works offline. */
  'license:getEntitlement': {
    request: z.object({}),
    response: entitlementSchema,
  },

  // Header rules.

  /**
   * Read the rule set and recompile it. Surfaces call this on open and after a
   * permission change, so a rule that just became applicable stops saying it
   * is waiting for site access.
   */
  'rules:getState': {
    request: z.object({}),
    response: engineStateSchema,
  },

  /** Write the whole rule set and reinstall it. Returns the new state. */
  'rules:save': {
    request: z.object({ document: rulesDocumentSchema }),
    response: engineStateSchema,
  },

  /**
   * Import rules from a ModHeader export or from one of our own export files.
   * A snapshot is taken first, always — see lib/rules-engine.ts.
   */
  'rules:import': {
    request: z.object({
      source: z.enum(['modheader', 'file']),
      json: z.string(),
      mode: z.enum(['merge', 'replace']),
      /** Sites to put on every imported rule. ModHeader had blanket access; we never do. */
      sites: z.array(z.string()),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      report: importReportSchema.nullable(),
      state: engineStateSchema.nullable(),
    }),
  },

  /** Serialise the rule set for the user to save. No server, no account. */
  'rules:export': {
    request: z.object({ profileIds: z.array(z.string()) }),
    response: z.object({ json: z.string(), fileName: z.string() }),
  },

  'rules:listBackups': {
    request: z.object({}),
    response: z.object({ backups: z.array(backupSummarySchema) }),
  },

  'rules:createBackup': {
    request: z.object({}),
    response: z.object({
      created: backupSummarySchema.nullable(),
      dropped: z.array(backupSummarySchema),
      error: z.string().nullable(),
    }),
  },

  'rules:restoreBackup': {
    request: z.object({ backupId: z.string().min(1) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      state: engineStateSchema.nullable(),
      dropped: z.array(backupSummarySchema),
    }),
  },
} as const;

export type MessageType = keyof typeof MESSAGE_CONTRACTS;

export type MessageRequest<K extends MessageType> = z.infer<
  (typeof MESSAGE_CONTRACTS)[K]['request']
>;
export type MessageResponse<K extends MessageType> = z.infer<
  (typeof MESSAGE_CONTRACTS)[K]['response']
>;

export type MessagingFailureReason =
  /** Nothing is listening — typically the service worker could not start. */
  | 'no-receiver'
  /** The receiving side does not know this message type. */
  | 'unknown-message'
  /** Request payload failed its schema. */
  | 'invalid-request'
  /** Response payload failed its schema (version skew between surfaces). */
  | 'invalid-response'
  /** The handler threw. */
  | 'handler-error'
  /** Message was not one of ours at all. */
  | 'foreign-message';

export class MessagingError extends Error {
  readonly reason: MessagingFailureReason;
  readonly messageType: string;

  constructor(messageType: string, reason: MessagingFailureReason, detail: string) {
    super(`message[${messageType}]: ${reason} — ${detail}`);
    this.name = 'MessagingError';
    this.reason = reason;
    this.messageType = messageType;
  }
}

const requestEnvelopeSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  type: z.string(),
  payload: z.unknown(),
});
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

const responseEnvelopeSchema = z.union([
  z.object({ protocol: z.literal(PROTOCOL_VERSION), ok: z.literal(true), data: z.unknown() }),
  z.object({
    protocol: z.literal(PROTOCOL_VERSION),
    ok: z.literal(false),
    error: z.object({ reason: z.string(), message: z.string() }),
  }),
]);
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** Build a validated request envelope. Throws on an invalid payload (programmer error). */
export function encodeRequest<K extends MessageType>(
  type: K,
  payload: MessageRequest<K>,
): RequestEnvelope {
  const contract = MESSAGE_CONTRACTS[type];
  const parsed = contract.request.safeParse(payload);
  if (!parsed.success) {
    throw new MessagingError(type, 'invalid-request', issuesOf(parsed.error));
  }
  return { protocol: PROTOCOL_VERSION, type, payload: parsed.data };
}

export type DecodedRequest =
  | { ok: true; type: MessageType; payload: unknown }
  | { ok: false; error: MessagingError };

/** Validate an inbound message. Foreign messages are rejected, not guessed at. */
export function decodeRequest(message: unknown): DecodedRequest {
  const envelope = requestEnvelopeSchema.safeParse(message);
  if (!envelope.success) {
    return {
      ok: false,
      error: new MessagingError('<unknown>', 'foreign-message', issuesOf(envelope.error)),
    };
  }

  const type = envelope.data.type;
  if (!isMessageType(type)) {
    return {
      ok: false,
      error: new MessagingError(type, 'unknown-message', 'no contract registered for this type'),
    };
  }

  const parsed = MESSAGE_CONTRACTS[type].request.safeParse(envelope.data.payload);
  if (!parsed.success) {
    return { ok: false, error: new MessagingError(type, 'invalid-request', issuesOf(parsed.error)) };
  }

  return { ok: true, type, payload: parsed.data };
}

export function isMessageType(value: string): value is MessageType {
  return Object.prototype.hasOwnProperty.call(MESSAGE_CONTRACTS, value);
}

export type MessageHandlers = {
  [K in MessageType]: (payload: MessageRequest<K>) => Promise<MessageResponse<K>>;
};

/**
 * Pure request router. No browser APIs — give it a message, get an envelope.
 * `registerMessageHandlers` is a thin adapter over this.
 */
export function createMessageRouter(
  handlers: MessageHandlers,
): (message: unknown) => Promise<ResponseEnvelope> {
  return async (message: unknown): Promise<ResponseEnvelope> => {
    const decoded = decodeRequest(message);
    if (!decoded.ok) {
      return errorEnvelope(decoded.error);
    }

    const handler = handlers[decoded.type] as (payload: unknown) => Promise<unknown>;
    let result: unknown;
    try {
      result = await handler(decoded.payload);
    } catch (cause) {
      return errorEnvelope(
        new MessagingError(
          decoded.type,
          'handler-error',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }

    // Validate on the way out too: a handler returning the wrong shape is a bug
    // we want to see here, not three surfaces downstream.
    const parsed = MESSAGE_CONTRACTS[decoded.type].response.safeParse(result);
    if (!parsed.success) {
      return errorEnvelope(
        new MessagingError(decoded.type, 'invalid-response', issuesOf(parsed.error)),
      );
    }

    return { protocol: PROTOCOL_VERSION, ok: true, data: parsed.data };
  };
}

function errorEnvelope(error: MessagingError): ResponseEnvelope {
  return {
    protocol: PROTOCOL_VERSION,
    ok: false,
    error: { reason: error.reason, message: error.message },
  };
}

export function decodeResponse<K extends MessageType>(
  type: K,
  raw: unknown,
): { ok: true; data: MessageResponse<K> } | { ok: false; error: MessagingError } {
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      error: new MessagingError(type, 'no-receiver', 'no response — is the service worker running?'),
    };
  }

  const envelope = responseEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return {
      ok: false,
      error: new MessagingError(type, 'invalid-response', issuesOf(envelope.error)),
    };
  }

  if (!envelope.data.ok) {
    const reason = envelope.data.error.reason as MessagingFailureReason;
    return { ok: false, error: new MessagingError(type, reason, envelope.data.error.message) };
  }

  const parsed = MESSAGE_CONTRACTS[type].response.safeParse(envelope.data.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: new MessagingError(type, 'invalid-response', issuesOf(parsed.error)),
    };
  }

  return { ok: true, data: parsed.data as MessageResponse<K> };
}

/** Injectable transport, so `sendMessage` is testable without a browser. */
export type MessageTransport = (envelope: RequestEnvelope) => Promise<unknown>;

const runtimeTransport: MessageTransport = (envelope) => browser.runtime.sendMessage(envelope);

/**
 * Rejects with `MessagingError` rather than resolving to something unvalidated —
 * callers render the error state instead of carrying on with a guess.
 */
export async function sendMessage<K extends MessageType>(
  type: K,
  payload: MessageRequest<K>,
  transport: MessageTransport = runtimeTransport,
): Promise<MessageResponse<K>> {
  const envelope = encodeRequest(type, payload);

  let raw: unknown;
  try {
    raw = await transport(envelope);
  } catch (cause) {
    throw new MessagingError(
      type,
      'no-receiver',
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  const decoded = decodeResponse(type, raw);
  if (!decoded.ok) throw decoded.error;
  return decoded.data;
}

/**
 * Register the single top-level `onMessage` listener.
 *
 * MV3 requires listeners to be registered synchronously during service worker
 * startup, so this must be called from the top level of the background script.
 */
export function registerMessageHandlers(handlers: MessageHandlers): void {
  const route = createMessageRouter(handlers);

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
      // Not one of our envelopes: leave it for whoever it belongs to.
      if (!requestEnvelopeSchema.safeParse(message).success) return false;

      route(message).then(sendResponse, (cause: unknown) => {
        sendResponse(
          errorEnvelope(
            new MessagingError(
              '<router>',
              'handler-error',
              cause instanceof Error ? cause.message : String(cause),
            ),
          ),
        );
      });

      // Keep the message channel open for the async response.
      return true;
    },
  );
}
