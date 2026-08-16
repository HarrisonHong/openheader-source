import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MESSAGE_CONTRACTS,
  MessagingError,
  PROTOCOL_VERSION,
  createMessageRouter,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  isMessageType,
  sendMessage,
} from './messaging';
import type { MessageHandlers, MessageResponse, MessageTransport } from './messaging';

function emptyEngineState(): MessageResponse<'rules:getState'> {
  return {
    document: { profiles: [], activeProfileIds: [] },
    statuses: [],
    grantedOrigins: [],
    installedRuleCount: 0,
    engineError: null,
    verification: { ok: true, detail: null },
    recoveryError: null,
    quarantinedAt: null,
  };
}

function makeHandlers(overrides: Partial<MessageHandlers> = {}): MessageHandlers {
  return {
    'runtime:ping': async () => ({
      ok: true as const,
      respondedAt: 1_700_000_000_000,
      extensionVersion: '0.1.0',
    }),
    'install:getState': async () => ({
      installedAt: 1_700_000_000_000,
      onboardingCompletedAt: null,
      privacyDisclosureAcknowledged: false,
    }),
    'onboarding:complete': async () => ({ ok: true as const }),
    'rules:getState': async () => emptyEngineState(),
    'rules:save': async () => emptyEngineState(),
    'rules:import': async () => ({ ok: true, error: null, report: null, state: null }),
    'rules:export': async () => ({ json: '[]', fileName: 'header-rules.json' }),
    'rules:listBackups': async () => ({ backups: [] }),
    'rules:createBackup': async () => ({ created: null, dropped: [], error: null }),
    'rules:restoreBackup': async () => ({ ok: true, error: null, state: null, dropped: [] }),
    'license:getEntitlement': async () => ({
      state: 'unlicensed' as const,
      tier: 'free' as const,
      entitled: false,
      graceEndsAt: null,
      graceDaysRemaining: null,
      revalidationDue: false,
    }),
    ...overrides,
  };
}

describe('messaging contracts', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  describe('the catalogue is the only way in', () => {
    it('recognises declared types', () => {
      for (const type of Object.keys(MESSAGE_CONTRACTS)) {
        expect(isMessageType(type)).toBe(true);
      }
    });

    it('rejects undeclared types', () => {
      expect(isMessageType('runtime:doSomethingClever')).toBe(false);
      // Inherited object properties must not count as contracts.
      expect(isMessageType('toString')).toBe(false);
      expect(isMessageType('constructor')).toBe(false);
    });

    it('every contract declares both a request and a response schema', () => {
      for (const [type, contract] of Object.entries(MESSAGE_CONTRACTS)) {
        expect(contract.request, `${type}.request`).toBeDefined();
        expect(contract.response, `${type}.response`).toBeDefined();
      }
    });
  });

  describe('encodeRequest', () => {
    it('stamps the protocol version', () => {
      expect(encodeRequest('runtime:ping', {})).toEqual({
        protocol: PROTOCOL_VERSION,
        type: 'runtime:ping',
        payload: {},
      });
    });

    it('strips undeclared keys instead of putting them on the wire', () => {
      const badPayload = { unexpected: true } as never;
      expect(encodeRequest('runtime:ping', badPayload).payload).toEqual({});
    });

    it('throws MessagingError on a payload that violates the contract', () => {
      expect(() => encodeRequest('runtime:ping', 'not-an-object' as never)).toThrow(MessagingError);
    });
  });

  describe('decodeRequest', () => {
    it.each([
      ['null', null],
      ['a string', 'ping'],
      ['a message from another extension', { greeting: 'hello' }],
      ['an envelope with the wrong protocol', { protocol: 99, type: 'runtime:ping', payload: {} }],
    ])('treats %s as a foreign message', (_name, message) => {
      const result = decodeRequest(message);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('foreign-message');
    });

    it('rejects a well-formed envelope with an unknown type', () => {
      const result = decodeRequest({
        protocol: PROTOCOL_VERSION,
        type: 'runtime:notARealMessage',
        payload: {},
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('unknown-message');
    });

    it('rejects a known type carrying a payload that violates the contract', () => {
      const result = decodeRequest({
        protocol: PROTOCOL_VERSION,
        type: 'runtime:ping',
        payload: 'not-an-object',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('invalid-request');
    });

    it('accepts a valid envelope', () => {
      const result = decodeRequest(encodeRequest('runtime:ping', {}));
      expect(result).toMatchObject({ ok: true, type: 'runtime:ping' });
    });
  });

  describe('router', () => {
    it('dispatches to the matching handler and validates the response', async () => {
      const route = createMessageRouter(makeHandlers());
      const response = await route(encodeRequest('runtime:ping', {}));

      expect(response).toEqual({
        protocol: PROTOCOL_VERSION,
        ok: true,
        data: { ok: true, respondedAt: 1_700_000_000_000, extensionVersion: '0.1.0' },
      });
    });

    it('turns a thrown handler into a typed error envelope, not a crash', async () => {
      const route = createMessageRouter(
        makeHandlers({
          'runtime:ping': async () => {
            throw new Error('service worker exploded');
          },
        }),
      );

      const response = await route(encodeRequest('runtime:ping', {}));
      expect(response).toMatchObject({
        ok: false,
        error: { reason: 'handler-error' },
      });
      if (response.ok) return;
      expect(response.error.message).toContain('service worker exploded');
    });

    it('rejects a handler that returns the wrong shape', async () => {
      const route = createMessageRouter(
        makeHandlers({
          // A handler that drifts from the contract must be caught here, not
          // three surfaces downstream.
          'runtime:ping': async () => ({ ok: true, respondedAt: 'soon' }) as never,
        }),
      );

      const response = await route(encodeRequest('runtime:ping', {}));
      expect(response).toMatchObject({ ok: false, error: { reason: 'invalid-response' } });
    });

    it('does not invoke any handler for a foreign message', async () => {
      const ping = vi.fn(async () => ({
        ok: true as const,
        respondedAt: 0,
        extensionVersion: '0.1.0',
      }));
      const route = createMessageRouter(makeHandlers({ 'runtime:ping': ping }));

      await route({ someOtherExtension: true });
      expect(ping).not.toHaveBeenCalled();
    });
  });

  describe('decodeResponse', () => {
    it('reports a missing response as no-receiver', () => {
      const result = decodeResponse('runtime:ping', undefined);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('no-receiver');
    });

    it('propagates the reason from an error envelope', () => {
      const result = decodeResponse('runtime:ping', {
        protocol: PROTOCOL_VERSION,
        ok: false,
        error: { reason: 'handler-error', message: 'boom' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('handler-error');
    });

    it('rejects a response whose payload drifted from the contract', () => {
      const result = decodeResponse('runtime:ping', {
        protocol: PROTOCOL_VERSION,
        ok: true,
        data: { ok: true, respondedAt: 1, extensionVersion: 7 },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe('invalid-response');
    });
  });

  describe('sendMessage', () => {
    it('round-trips through a transport', async () => {
      const route = createMessageRouter(makeHandlers());
      const transport: MessageTransport = (envelope) => route(envelope);

      const response = await sendMessage('runtime:ping', {}, transport);
      expect(response.extensionVersion).toBe('0.1.0');
    });

    it('surfaces a dead service worker as no-receiver', async () => {
      const transport: MessageTransport = () =>
        Promise.reject(new Error('Could not establish connection.'));

      await expect(sendMessage('runtime:ping', {}, transport)).rejects.toMatchObject({
        name: 'MessagingError',
        reason: 'no-receiver',
      });
    });

    it('surfaces an undefined response as no-receiver rather than returning undefined', async () => {
      const transport: MessageTransport = () => Promise.resolve(undefined);
      await expect(sendMessage('runtime:ping', {}, transport)).rejects.toBeInstanceOf(
        MessagingError,
      );
    });

    it('rejects rather than returning an unvalidated value', async () => {
      const transport: MessageTransport = () =>
        Promise.resolve({ protocol: PROTOCOL_VERSION, ok: true, data: { totally: 'wrong' } });

      await expect(sendMessage('runtime:ping', {}, transport)).rejects.toMatchObject({
        reason: 'invalid-response',
      });
    });
  });
});
