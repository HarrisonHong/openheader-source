import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Security lint rules.
 *
 * These are not style preferences. They mechanically enforce the MV3 security
 * requirements documented in docs/security.md, so a violation fails the build
 * rather than getting caught (or not) in review.
 *
 * Proven to fail on violations by tests/security-lint.test.ts.
 */

const NO_HTML_INJECTION =
  'HTML injection sink. Build DOM with text nodes / JSX instead. See docs/security.md.';
const NO_DYNAMIC_CODE =
  'Dynamic code execution is forbidden by MV3 CSP and Chrome Web Store policy. See docs/security.md.';
const NO_AD_HOC_MESSAGING =
  'Cross-surface messaging must go through the typed contracts in lib/messaging.ts. See docs/architecture.md.';

/** @type {import('eslint').Linter.RulesRecord['no-restricted-properties']} */
const restrictedProperties = [
  'error',
  { property: 'innerHTML', message: NO_HTML_INJECTION },
  { property: 'outerHTML', message: NO_HTML_INJECTION },
  { property: 'insertAdjacentHTML', message: NO_HTML_INJECTION },
  { property: 'dangerouslySetInnerHTML', message: NO_HTML_INJECTION },
  { object: 'document', property: 'write', message: NO_HTML_INJECTION },
  { object: 'document', property: 'writeln', message: NO_HTML_INJECTION },
  { object: 'window', property: 'eval', message: NO_DYNAMIC_CODE },
  { object: 'globalThis', property: 'eval', message: NO_DYNAMIC_CODE },
];

const dangerousSyntax = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: NO_HTML_INJECTION,
  },
  {
    selector: "Property[key.name='dangerouslySetInnerHTML']",
    message: NO_HTML_INJECTION,
  },
  {
    selector:
      "MemberExpression[computed=true][property.value=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]",
    message: NO_HTML_INJECTION,
  },
  {
    selector: "NewExpression[callee.name='Function']",
    message: NO_DYNAMIC_CODE,
  },
  {
    selector: "CallExpression[callee.name='Function']",
    message: NO_DYNAMIC_CODE,
  },
  {
    // Remote code: no importing anything that is not a bundled literal specifier.
    selector: 'ImportExpression[source.type!="Literal"]',
    message: NO_DYNAMIC_CODE,
  },
];

const messagingSyntax = [
  {
    selector: "CallExpression[callee.property.name='sendMessage']",
    message: NO_AD_HOC_MESSAGING,
  },
  {
    selector: "MemberExpression[property.name='onMessage']",
    message: NO_AD_HOC_MESSAGING,
  },
  {
    // Computed access reaches the same API: browser.runtime['sendMessage'](…).
    selector: "MemberExpression[computed=true][property.value=/^(sendMessage|onMessage)$/]",
    message: NO_AD_HOC_MESSAGING,
  },
];

export const securityRules = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-script-url': 'error',
  'no-restricted-properties': restrictedProperties,
  'no-restricted-syntax': ['error', ...dangerousSyntax, ...messagingSyntax],
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.output/**', '.wxt/**', 'public/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      ...securityRules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    },
  },

  {
    // lib/messaging.ts is the ONE place allowed to touch the raw runtime
    // messaging API. Everything else goes through its typed contracts.
    files: ['lib/messaging.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...dangerousSyntax],
    },
  },

  {
    // Node-side tooling.
    files: ['scripts/**/*.mjs', '*.config.{ts,js}', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...dangerousSyntax],
    },
  },
);
