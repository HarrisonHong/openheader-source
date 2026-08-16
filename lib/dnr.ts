/**
 * Compiles header rules into declarativeNetRequest rules — and, just as
 * importantly, explains every rule that will NOT apply.
 *
 * A rule is never silently a no-op. The incumbent's documentation says an
 * unsupported rule "will not take effect, but will still be retained", and that
 * one behaviour produced its worst reviews. So every rule gets a status, and
 * every non-active status names the field that caused it in a sentence a user
 * can act on.
 *
 * Nothing here touches the browser. Which resource types exist, whether a regex
 * is RE2-compatible, which origins are granted — all of it arrives through
 * `CompileContext`, so tests and the service worker run the same code path.
 */

import './zod-config';
import { z } from 'zod';
import { deriveOrigins, hostnameOf, missingOrigins } from './match-patterns';
import { assertOriginIsNarrow } from './permissions';
import type { HeaderEdit, HeaderRule, Matcher, ResourceType, RulesDocument } from './rules';
import { RESOURCE_TYPES } from './rules';

// These mirror `chrome.declarativeNetRequest` rather than importing its
// generated types: the compiler has to run under vitest with no browser
// present, and the shapes are small and stable.

export interface DnrHeaderInfo {
  header: string;
  operation: 'set' | 'append' | 'remove';
  value?: string;
}

export interface DnrCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  resourceTypes?: ResourceType[];
  requestMethods?: string[];
}

export type DnrAction =
  | { type: 'modifyHeaders'; requestHeaders?: DnrHeaderInfo[]; responseHeaders?: DnrHeaderInfo[] }
  | { type: 'allow' };

export interface DnrRule {
  id: number;
  priority: number;
  action: DnrAction;
  condition: DnrCondition;
}

/**
 * Priority bands.
 *
 * declarativeNetRequest has no "excluded regex" condition, so a URL-shaped
 * exclusion becomes a higher-priority `allow` rule: Chrome applies only those
 * `modifyHeaders` rules whose priority beats any matching `allow`. An `allow` is
 * request-scoped, not rule-scoped, so rules needing one sit in a suppressible
 * band and rules that don't sit above the allow band, out of reach of anyone
 * else's exclusion.
 *
 * One interaction survives that: two rules that both use URL-shaped exclusions
 * share the suppressible band. `compileDocument` warns on those rules rather
 * than letting it surprise anyone. See docs/architecture.md, "Exclusions".
 */
export const PRIORITY_SUPPRESSIBLE = 1;
export const PRIORITY_ALLOW = 2;
export const PRIORITY_PLAIN = 3;

/**
 * Chrome's cap on "unsafe" dynamic rules, which is what `modifyHeaders` counts
 * as. Exceeding it makes `updateDynamicRules` reject the entire batch — one rule
 * over the line and none of the user's rules apply — so the compiler stops short
 * and says which ones it left out.
 */
export const MAX_DYNAMIC_RULES = 5000;

/**
 * Request headers Chrome permits `append` on. Every other request header
 * silently ignores the operation, so appending to one is reported as
 * unsupported instead. Source: chrome.declarativeNetRequest ModifyHeaderInfo.
 */
export const APPENDABLE_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'access-control-request-headers',
  'cache-control',
  'connection',
  'content-language',
  'cookie',
  'forwarded',
  'if-match',
  'if-none-match',
  'keep-alive',
  'range',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'want-digest',
  'x-forwarded-for',
];

export interface RegexSupport {
  supported: boolean;
  /** Present when unsupported. A sentence, not a code. */
  reason?: string;
}

/**
 * Static RE2 compatibility check.
 *
 * Chrome compiles `regexFilter` with RE2: no backtracking, so no lookaround and
 * no backreferences. Chrome rejects such a pattern at install time and says
 * nothing, so we catch it first. The service worker also asks Chrome directly
 * via `isRegexSupported()`; this is the pure first pass, and the one the UI can
 * run while the user types.
 */
export function checkRegexSupport(pattern: string): RegexSupport {
  if (pattern.trim() === '') {
    return { supported: false, reason: 'The pattern is empty.' };
  }

  try {
    new RegExp(pattern);
  } catch (cause) {
    return {
      supported: false,
      reason: `Not a valid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  if (/\(\?=|\(\?!/.test(pattern)) {
    return {
      supported: false,
      reason:
        'Lookahead ((?= …) or (?! …)) is not supported. Chrome matches with RE2, which has no lookaround.',
    };
  }
  if (/\(\?<[=!]/.test(pattern)) {
    return {
      supported: false,
      reason:
        'Lookbehind ((?<= …) or (?<! …)) is not supported. Chrome matches with RE2, which has no lookaround.',
    };
  }
  if (/\\[1-9]/.test(pattern.replace(/\\\\/g, ''))) {
    return {
      supported: false,
      reason: 'Backreferences (\\1, \\2, …) are not supported. Chrome matches with RE2.',
    };
  }
  if (/\(\?>/.test(pattern)) {
    return {
      supported: false,
      reason: 'Atomic groups ((?> …)) are not supported. Chrome matches with RE2.',
    };
  }

  return { supported: true };
}

/**
 * Statuses are Zod schemas rather than bare interfaces because they cross the
 * service-worker boundary: `lib/messaging.ts` validates them in both directions,
 * so a version-skewed popup gets a typed error instead of a half-rendered badge.
 *
 * `engine-refused` is the odd one out: it is not a property of the rule, but what
 * a rule that compiled cleanly becomes when Chrome rejects the ruleset it was
 * part of. `updateDynamicRules` is atomic, so one rule the browser dislikes takes
 * every other rule down with it, and a rule still reading "Active" at that moment
 * is this product's worst possible lie. `lib/rules-engine.ts` applies it.
 */
export const RULE_STATUS_STATES = [
  'active',
  'inactive',
  'needs-permission',
  'unsupported',
  'engine-refused',
] as const;
export const ruleStatusStateSchema = z.enum(RULE_STATUS_STATES);
export type RuleStatusState = z.infer<typeof ruleStatusStateSchema>;

export const PROBLEM_CODES = [
  'no-match',
  'no-headers',
  'empty-header-name',
  'invalid-header-name',
  'invalid-header-value',
  'append-not-supported',
  'empty-value',
  'invalid-domain',
  'invalid-url',
  'regex-unsupported',
  'non-ascii-url-filter',
  'no-sites',
  'site-too-broad',
  'undecidable-site',
  'no-resource-types',
  'rule-limit-exceeded',
  'withheld-by-safeguard',
  'shared-exclusion-band',
  'url-filter-special-characters',
  'value-ignored-on-remove',
  'unsupported-resource-type',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const PROBLEM_FIELDS = [
  'match',
  'exclude',
  'sites',
  'headers',
  'resourceTypes',
  'rule',
] as const;
export type ProblemField = (typeof PROBLEM_FIELDS)[number];

export const ruleProblemSchema = z.object({
  code: z.enum(PROBLEM_CODES),
  /** A complete sentence, shown verbatim to the user. */
  message: z.string(),
  /** Which part of the rule to highlight. */
  field: z.enum(PROBLEM_FIELDS).optional(),
  matcherId: z.string().optional(),
  headerId: z.string().optional(),
});
export type RuleProblem = z.infer<typeof ruleProblemSchema>;

export const INACTIVE_REASONS = ['rule-disabled', 'profile-inactive'] as const;
export type InactiveReason = (typeof INACTIVE_REASONS)[number];

export const ruleStatusSchema = z.object({
  ruleId: z.string(),
  profileId: z.string(),
  state: ruleStatusStateSchema,
  /** One sentence describing the state. Never empty. */
  summary: z.string(),
  /** Reasons the rule cannot work. Non-empty exactly when state is 'unsupported'. */
  problems: z.array(ruleProblemSchema),
  /** Things worth knowing that do not stop the rule working. */
  warnings: z.array(ruleProblemSchema),
  /** Host permissions this rule needs but does not have. */
  missingOrigins: z.array(z.string()),
  /** Host permissions this rule needs in total. */
  requiredOrigins: z.array(z.string()),
  /** Ids of the declarativeNetRequest rules this rule produced. */
  dnrRuleIds: z.array(z.number()),
  inactiveReason: z.enum(INACTIVE_REASONS).optional(),
});
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

export interface CompileContext {
  /** Host permission patterns Chrome reports as granted. */
  grantedOrigins: readonly string[];
  /** Resource types the running browser supports. Defaults to all known ones. */
  supportedResourceTypes?: readonly string[];
  /** Overridable so the service worker can defer to Chrome's own checker. */
  regexSupport?: (pattern: string) => RegexSupport;
  /** First declarativeNetRequest rule id to allocate. */
  startId?: number;
  maxRules?: number;
}

export interface CompileResult {
  dnrRules: DnrRule[];
  statuses: RuleStatus[];
  /**
   * Set when the compiler caught itself breaking its own invariant. Not a rule
   * problem — a bug in this module — so `lib/rules-engine.ts` reports it through
   * `EngineState.engineError`, the channel the UI already renders loudly.
   */
  compileError: string | null;
}

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const URL_FILTER_SPECIALS = /[|^*]/;

/**
 * Compiles a whole document. Rules in inactive profiles and disabled rules are
 * still analysed, so the UI can show "this will not work when you turn it on"
 * rather than waiting for the user to discover it.
 */
export function compileDocument(
  document: RulesDocument,
  context: CompileContext,
): CompileResult {
  const regexSupport = context.regexSupport ?? checkRegexSupport;
  const supportedResourceTypes = new Set(context.supportedResourceTypes ?? RESOURCE_TYPES);
  const maxRules = context.maxRules ?? MAX_DYNAMIC_RULES;

  let nextId = context.startId ?? 1;
  const dnrRules: DnrRule[] = [];
  const statuses: RuleStatus[] = [];
  const compileErrors: string[] = [];

  // Computed up front so a rule can be told it shares the band with others.
  const suppressible = new Set<string>();
  for (const profile of document.profiles) {
    for (const rule of profile.rules) {
      if (!document.activeProfileIds.includes(profile.id) || !rule.enabled) continue;
      if (urlShapedExclusions(rule).length > 0) suppressible.add(rule.id);
    }
  }

  for (const profile of document.profiles) {
    const profileActive = document.activeProfileIds.includes(profile.id);

    for (const rule of profile.rules) {
      const analysis = analyseRule(rule, { regexSupport, supportedResourceTypes });
      const required = requiredOriginsFor(rule);
      const missing = missingOrigins(required, context.grantedOrigins);

      // Site access joins the same problem list as every other check, before
      // anything is installed. Deciding it later would let a rule be reported as
      // "won't apply" and still be handed to Chrome.
      analysis.problems.push(...siteAccessProblems(rule, required));

      const installable =
        profileActive && rule.enabled && analysis.problems.length === 0 && missing.length === 0;

      let ruleDnr: DnrRule[] = [];
      if (installable) {
        ruleDnr = buildDnrRules(analysis, suppressible.has(rule.id), nextId);
        if (dnrRules.length + ruleDnr.length > maxRules) {
          // Never truncate quietly — reported like any other rule that can't apply.
          analysis.problems.push({
            code: 'rule-limit-exceeded',
            field: 'rule',
            message:
              `This rule was not installed: Chrome allows at most ${maxRules} header rules at once, ` +
              'and that limit is already reached. Disable or delete some rules, then re-enable this one.',
          });
          ruleDnr = [];
        } else {
          nextId += ruleDnr.length;
          dnrRules.push(...ruleDnr);
        }
      }

      if (suppressible.has(rule.id) && suppressible.size > 1 && ruleDnr.length > 0) {
        analysis.warnings.push({
          code: 'shared-exclusion-band',
          field: 'exclude',
          message:
            `${suppressible.size} active rules use URL or regex exclusions. Chrome applies those as ` +
            'shared exemptions, so a request excluded by one of these rules is exempt from all of ' +
            'them. Use domain exclusions where you can — those are per-rule and exact.',
        });
      }

      let status = buildStatus({
        rule,
        profileId: profile.id,
        profileActive,
        analysis,
        required,
        missing,
        dnrRuleIds: ruleDnr.map((entry) => entry.id),
      });

      // The invariant: only an `active` rule may own browser rules. A rule that
      // says "won't apply" while Chrome applies it would put a header the user
      // believes is parked — routinely a bearer token — onto every host they
      // granted for some other reason. Status and installation both come from
      // the one problem list above, so this cannot fire today; it is here so
      // that if it ever does, the rules are withdrawn rather than shipped.
      //
      // Withdrawing rather than throwing is deliberate: a throw here would
      // reject `applyRules` after `rules:save` had already stored the document,
      // so the user would be told the save failed when it hadn't, every reload
      // would hit the same throw, and no surface would be left to edit the
      // offending rule from. The compiler's own failure goes out through
      // `compileError`, which `lib/rules-engine.ts` renders as an engine error.
      if (status.state !== 'active' && status.dnrRuleIds.length > 0) {
        for (const entry of ruleDnr) {
          const index = dnrRules.indexOf(entry);
          if (index !== -1) dnrRules.splice(index, 1);
        }

        analysis.problems.push({
          code: 'withheld-by-safeguard',
          field: 'rule',
          message:
            'This rule was not applied: a safety check found it was about to be applied while ' +
            'also reporting that it would not be, so nothing was installed for it. Your rule is ' +
            'saved and unchanged — this is a fault in the extension, and worth reporting.',
        });
        compileErrors.push(
          `Rule "${rule.name || rule.id}" reported "${status.state}" while producing browser rules. ` +
            'Nothing was applied for it.',
        );

        status = buildStatus({
          rule,
          profileId: profile.id,
          profileActive,
          analysis,
          required,
          missing,
          dnrRuleIds: [],
        });
      }

      statuses.push(status);
    }
  }

  return {
    dnrRules,
    statuses,
    compileError:
      compileErrors.length > 0
        ? `The extension caught itself about to apply a rule it had already reported as not applying. ${compileErrors.join(' ')}`
        : null,
  };
}

/**
 * Problems with the sites a rule may touch.
 *
 * These live alongside `analyseRule`'s output rather than in `buildStatus`
 * because they decide whether the rule is installed, not just what the badge
 * says. `modifyHeaders` needs host access to the request URL and, for anything
 * that isn't a top-level navigation, to its initiator — so a rule whose sites
 * cannot be derived must install nothing, not merely say so.
 */
function siteAccessProblems(rule: HeaderRule, required: readonly string[]): RuleProblem[] {
  const problems: RuleProblem[] = [];

  if (required.length === 0) {
    const derived = deriveOrigins(rule.match);
    problems.push({
      code: derived.undecidable.length > 0 ? 'undecidable-site' : 'no-sites',
      field: 'sites',
      message:
        derived.undecidable.length > 0
          ? 'Chrome needs to know which sites this rule may touch, and a regex or "URL contains" condition does not say. Add the sites under Site access.'
          : 'This rule names no sites, so Chrome will not let it change any headers. Add at least one site.',
    });
  }

  for (const site of required) {
    const reason = siteTooBroadReason(site);
    if (reason !== null) {
      problems.push({ code: 'site-too-broad', field: 'sites', message: reason });
    }
  }

  return problems;
}

/**
 * Why a site pattern asks for too much, or null when it does not.
 *
 * Exported because the importer refuses such a pattern at the door
 * (`lib/rules-engine.ts`) and has to say exactly what the compiler would have
 * said about it afterwards — one sentence, written once.
 */
export function siteTooBroadReason(site: string): string | null {
  try {
    assertOriginIsNarrow(site);
    return null;
  } catch (cause) {
    return `"${site}" asks for access to more of the web than this extension will ever request. ${
      cause instanceof Error ? cause.message : String(cause)
    }`;
  }
}

interface RuleAnalysis {
  problems: RuleProblem[];
  warnings: RuleProblem[];
  matchConditions: DnrCondition[];
  /** Domain exclusions, expressible natively and exactly. */
  excludedDomains: string[];
  /** Exclusions that need an `allow` rule. */
  allowConditions: DnrCondition[];
  requestHeaders: DnrHeaderInfo[];
  responseHeaders: DnrHeaderInfo[];
  resourceTypes: ResourceType[];
  requestMethods: string[];
  /** Domains every enabled matcher agrees on, used to scope `allow` rules. */
  matchDomains: string[];
  /**
   * True when `matchDomains` covers EVERY branch this rule matches on. False as
   * soon as a URL or regex condition sits alongside them, because those domains
   * then do not describe where the rule applies — and an `allow` scoped to them
   * would stop excluding on the other branch.
   */
  matchIsDomainsOnly: boolean;
}

function analyseRule(
  rule: HeaderRule,
  options: {
    regexSupport: (pattern: string) => RegexSupport;
    supportedResourceTypes: ReadonlySet<string>;
  },
): RuleAnalysis {
  const problems: RuleProblem[] = [];
  const warnings: RuleProblem[] = [];

  const resourceTypes: ResourceType[] = [];
  for (const type of rule.resourceTypes) {
    if (options.supportedResourceTypes.has(type)) resourceTypes.push(type);
    else {
      warnings.push({
        code: 'unsupported-resource-type',
        field: 'resourceTypes',
        message: `This version of Chrome does not know the resource type "${type}", so it was left out of the rule.`,
      });
    }
  }
  if (resourceTypes.length === 0) {
    problems.push({
      code: 'no-resource-types',
      field: 'resourceTypes',
      message: 'This rule applies to no request types, so it can never match. Choose at least one.',
    });
  }

  const requestHeaders: DnrHeaderInfo[] = [];
  const responseHeaders: DnrHeaderInfo[] = [];
  const enabledHeaders = rule.headers.filter((header) => header.enabled);

  if (enabledHeaders.length === 0) {
    problems.push({
      code: 'no-headers',
      field: 'headers',
      message: 'This rule changes no headers. Add a header, or turn one of the existing ones on.',
    });
  }

  for (const header of enabledHeaders) {
    const info = analyseHeader(header, problems, warnings);
    if (!info) continue;
    if (header.target === 'request') requestHeaders.push(info);
    else responseHeaders.push(info);
  }

  const enabledMatch = rule.match.filter((matcher) => matcher.enabled);
  if (enabledMatch.length === 0) {
    problems.push({
      code: 'no-match',
      field: 'match',
      message: 'This rule matches nothing. Add a domain, URL or pattern for it to apply to.',
    });
  }

  const matchDomains: string[] = [];
  const otherMatchConditions: DnrCondition[] = [];
  for (const matcher of enabledMatch) {
    if (matcher.kind === 'domain') {
      const host = validDomain(matcher, problems, 'match');
      if (host) matchDomains.push(host);
      continue;
    }
    const condition = urlConditionOf(matcher, problems, warnings, 'match', options.regexSupport);
    if (condition) otherMatchConditions.push(condition);
  }

  const matchConditions: DnrCondition[] = [];
  if (matchDomains.length > 0) matchConditions.push({ requestDomains: matchDomains });
  matchConditions.push(...otherMatchConditions);

  const excludedDomains: string[] = [];
  const allowConditions: DnrCondition[] = [];
  for (const matcher of rule.exclude.filter((entry) => entry.enabled)) {
    if (matcher.kind === 'domain') {
      const host = validDomain(matcher, problems, 'exclude');
      if (host) excludedDomains.push(host);
      continue;
    }
    const condition = urlConditionOf(matcher, problems, warnings, 'exclude', options.regexSupport);
    if (condition) allowConditions.push(condition);
  }

  return {
    problems,
    warnings,
    matchConditions,
    excludedDomains,
    allowConditions,
    requestHeaders,
    responseHeaders,
    resourceTypes,
    requestMethods: [...rule.requestMethods],
    matchDomains,
    matchIsDomainsOnly: otherMatchConditions.length === 0,
  };
}

function analyseHeader(
  header: HeaderEdit,
  problems: RuleProblem[],
  warnings: RuleProblem[],
): DnrHeaderInfo | null {
  const name = header.name.trim();

  if (name === '') {
    problems.push({
      code: 'empty-header-name',
      field: 'headers',
      headerId: header.id,
      message: 'A header with no name cannot be sent. Give it a name or turn it off.',
    });
    return null;
  }

  if (!HEADER_NAME_PATTERN.test(name)) {
    problems.push({
      code: 'invalid-header-name',
      field: 'headers',
      headerId: header.id,
      message: `"${name}" is not a valid HTTP header name. Header names may not contain spaces, colons or non-ASCII characters.`,
    });
    return null;
  }

  if (header.operation === 'remove') {
    if (header.value !== '') {
      warnings.push({
        code: 'value-ignored-on-remove',
        field: 'headers',
        headerId: header.id,
        message: `"${name}" is set to Remove, so its value is ignored.`,
      });
    }
    return { header: name, operation: 'remove' };
  }

  if (header.operation === 'append' && header.target === 'request') {
    if (!APPENDABLE_REQUEST_HEADERS.includes(name.toLowerCase())) {
      problems.push({
        code: 'append-not-supported',
        field: 'headers',
        headerId: header.id,
        message:
          `Chrome cannot append to the request header "${name}" — it allows appending only to: ` +
          `${APPENDABLE_REQUEST_HEADERS.join(', ')}. Use Set instead, or change the header.`,
      });
      return null;
    }
  }

  // Chrome refuses a header value holding NUL, CR or LF — and it refuses the
  // WHOLE ruleset over it, because `updateDynamicRules` is atomic. Left
  // uncaught, one newline pasted along with a bearer token stops every rule in
  // the profile applying. Caught here it is an ordinary problem, so it costs the
  // one rule it belongs to and that rule says why. The realistic source is a
  // copy-paste, not an attack: values arrive from the editor, from a shared
  // export and from a ModHeader import, and none of those three trims anything.
  const offending = firstRejectedValueCharacter(header.value);
  if (offending !== null) {
    problems.push({
      code: 'invalid-header-value',
      field: 'headers',
      headerId: header.id,
      message:
        `The value of "${name}" contains ${describeCharacter(offending)}, which Chrome will not ` +
        'accept in a header value. A line break copied along with a token is the usual cause — ' +
        're-copy the value without it.',
    });
    return null;
  }

  if (header.value === '') {
    // Chrome accepts an empty value for `set`, but it is almost always a typo.
    warnings.push({
      code: 'empty-value',
      field: 'headers',
      headerId: header.id,
      message: `"${name}" has an empty value, so it will be sent as an empty header.`,
    });
  }

  return { header: name, operation: header.operation, value: header.value };
}

/**
 * The first character Chrome will not accept in a header value, or null.
 *
 * The set is exactly NUL, CR and LF, and that is measured rather than read off
 * the RFC: Chrome 151.0.7922.137 was probed over CDP with one `modifyHeaders`
 * rule per candidate value. It REJECTED NUL (0x00), CR (0x0d) and LF (0x0a),
 * and ACCEPTED tab (0x09), space, SOH (0x01), ESC (0x1b), DEL (0x7f), obs-text
 * (0x80), U+00E9, CJK and emoji. Do not widen this back towards printable
 * ASCII: everything above is a value that works today, and turning one of those
 * rules into "Won't apply" would be a working rule silently ceasing to work —
 * blamed on a restriction Chrome does not impose. This is deliberately NOT
 * `isPrintableAscii`, which stays strict for `urlFilter`, where byte-wise
 * matching genuinely cannot match a non-ASCII character.
 */
function firstRejectedValueCharacter(value: string): string | null {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x00 || code === 0x0a || code === 0x0d) return character;
  }
  return null;
}

/** A character named so a user can find it in a value they cannot see it in. */
function describeCharacter(character: string): string {
  if (character === '\n') return 'a line break';
  if (character === '\r') return 'a carriage return';
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) {
    return `a control character (0x${code.toString(16).padStart(2, '0')})`;
  }
  return `"${character}"`;
}

function validDomain(
  matcher: Matcher,
  problems: RuleProblem[],
  field: 'match' | 'exclude',
): string | null {
  const host = hostnameOf(matcher.value);
  if (!host) {
    problems.push({
      code: 'invalid-domain',
      field,
      matcherId: matcher.id,
      message: `"${matcher.value}" is not a valid domain. Use a host name such as api.example.com.`,
    });
    return null;
  }
  return host;
}

function urlConditionOf(
  matcher: Matcher,
  problems: RuleProblem[],
  warnings: RuleProblem[],
  field: 'match' | 'exclude',
  regexSupport: (pattern: string) => RegexSupport,
): DnrCondition | null {
  const value = matcher.value.trim();

  if (value === '') {
    problems.push({
      code: field === 'match' ? 'no-match' : 'invalid-url',
      field,
      matcherId: matcher.id,
      message: 'This condition is empty. Fill it in, or turn it off.',
    });
    return null;
  }

  if (matcher.kind === 'regex') {
    const support = regexSupport(value);
    if (!support.supported) {
      problems.push({
        code: 'regex-unsupported',
        field,
        matcherId: matcher.id,
        message: `Chrome cannot use this regular expression. ${support.reason ?? ''}`.trim(),
      });
      return null;
    }
    return { regexFilter: value };
  }

  if (!isPrintableAscii(value)) {
    problems.push({
      code: 'non-ascii-url-filter',
      field,
      matcherId: matcher.id,
      message:
        'Chrome only matches URL patterns made of ASCII characters. Use the percent-encoded form of the URL, or switch this condition to a regular expression.',
    });
    return null;
  }

  if (URL_FILTER_SPECIALS.test(value)) {
    warnings.push({
      code: 'url-filter-special-characters',
      field,
      matcherId: matcher.id,
      message:
        'The characters * ^ and | have special meaning in URL patterns: * matches anything, ^ matches a separator, and | anchors the start or end. Use a regular expression if you meant them literally.',
    });
  }

  if (matcher.kind === 'url-prefix' || matcher.kind === 'url-exact') {
    if (!isAbsoluteUrl(value)) {
      problems.push({
        code: 'invalid-url',
        field,
        matcherId: matcher.id,
        message: `"${value}" is not a complete URL. Include the scheme, for example https://api.example.com/v1.`,
      });
      return null;
    }
  }

  switch (matcher.kind) {
    case 'url-prefix':
      return { urlFilter: `|${value}` };
    case 'url-exact':
      return { urlFilter: `|${value}|` };
    default:
      return { urlFilter: value };
  }
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** `urlFilter` is compared byte-wise, so anything outside printable ASCII can
 * never match — reported, rather than left to quietly never fire. */
function isPrintableAscii(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function urlShapedExclusions(rule: HeaderRule): Matcher[] {
  return rule.exclude.filter((matcher) => matcher.enabled && matcher.kind !== 'domain');
}

function buildDnrRules(analysis: RuleAnalysis, suppressible: boolean, startId: number): DnrRule[] {
  const rules: DnrRule[] = [];
  let id = startId;

  const base = (): DnrCondition => {
    const condition: DnrCondition = { resourceTypes: analysis.resourceTypes };
    if (analysis.requestMethods.length > 0) condition.requestMethods = analysis.requestMethods;
    return condition;
  };

  const action: DnrAction = { type: 'modifyHeaders' };
  if (analysis.requestHeaders.length > 0) action.requestHeaders = analysis.requestHeaders;
  if (analysis.responseHeaders.length > 0) action.responseHeaders = analysis.responseHeaders;

  for (const matchCondition of analysis.matchConditions) {
    const condition: DnrCondition = { ...base(), ...matchCondition };
    if (analysis.excludedDomains.length > 0) {
      condition.excludedRequestDomains = analysis.excludedDomains;
    }
    rules.push({
      id: id++,
      priority: suppressible ? PRIORITY_SUPPRESSIBLE : PRIORITY_PLAIN,
      action,
      condition,
    });
  }

  // Exclusions Chrome has no condition field for become `allow` rules, scoped
  // as tightly as the rule's own match allows.
  //
  // Domain scoping applies only when the rule matches on domains alone. With a
  // URL or regex condition alongside them, `matchDomains` no longer describes
  // where the rule applies, and a domain-scoped `allow` would leave the other
  // branch unexcluded — an exclusion that silently stops excluding. Unscoped
  // errs the other way: it can only over-suppress, inside the band that already
  // carries the `shared-exclusion-band` warning.
  for (const allowCondition of analysis.allowConditions) {
    const condition: DnrCondition = { ...base(), ...allowCondition };
    if (
      analysis.matchIsDomainsOnly &&
      analysis.matchDomains.length > 0 &&
      !allowCondition.requestDomains
    ) {
      condition.requestDomains = analysis.matchDomains;
    }
    rules.push({ id: id++, priority: PRIORITY_ALLOW, action: { type: 'allow' }, condition });
  }

  return rules;
}

/**
 * The sites the user named, plus anything its matchers imply. A rule that ends
 * up with none is reported as unsupported: better to ask for one origin than to
 * fall back on broad access.
 */
export function requiredOriginsFor(rule: HeaderRule): string[] {
  const derived = deriveOrigins(rule.match);
  return [...new Set([...rule.sites, ...derived.origins])].sort();
}

function buildStatus(input: {
  rule: HeaderRule;
  profileId: string;
  profileActive: boolean;
  analysis: RuleAnalysis;
  required: string[];
  missing: string[];
  dnrRuleIds: number[];
}): RuleStatus {
  const { rule, analysis, required, missing } = input;
  // Site-access problems are already in here, decided before anything was
  // installed, so the badge and the browser agree by construction.
  const problems = analysis.problems;

  const base = {
    ruleId: rule.id,
    profileId: input.profileId,
    problems,
    warnings: analysis.warnings,
    missingOrigins: missing,
    requiredOrigins: required,
    dnrRuleIds: input.dnrRuleIds,
  };

  if (!input.profileActive) {
    return {
      ...base,
      state: 'inactive',
      inactiveReason: 'profile-inactive',
      summary: 'Not applied: this profile is not active.',
    };
  }

  if (!rule.enabled) {
    return {
      ...base,
      state: 'inactive',
      inactiveReason: 'rule-disabled',
      summary: 'Not applied: this rule is turned off.',
    };
  }

  if (problems.length > 0) {
    return {
      ...base,
      state: 'unsupported',
      summary:
        problems.length === 1
          ? (problems[0]?.message ?? 'This rule cannot be applied.')
          : `This rule cannot be applied — ${problems.length} problems.`,
    };
  }

  if (missing.length > 0) {
    return {
      ...base,
      state: 'needs-permission',
      summary: `Waiting for site access: ${missing.join(', ')}.`,
    };
  }

  return {
    ...base,
    state: 'active',
    summary:
      input.dnrRuleIds.length > 0
        ? 'Active — Chrome is applying this rule.'
        : 'Active, but it produced no browser rules. Please report this.',
  };
}

export function statusesById(statuses: readonly RuleStatus[]): Map<string, RuleStatus> {
  return new Map(statuses.map((status) => [status.ruleId, status]));
}
