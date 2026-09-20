import { defineConfig } from 'wxt';

/**
 * WXT configuration.
 *
 * Security posture is encoded here on purpose — see docs/security.md.
 * Anything that widens the attack surface (permissions, CSP, host access)
 * must be changed HERE and justified in docs/permissions.md in the same commit.
 */
export default defineConfig({
  srcDir: '.',
  // Chrome and Edge are both built and both shipped — `npm run build` and
  // `npm run build:edge`. Nothing in this codebase is Chrome-specific: the two
  // builds produce a byte-identical manifest and byte-identical JS, so there is
  // one artifact verified twice rather than two artifacts. The Edge build is
  // proven in a real Edge, not assumed from Chromium parity — see
  // docs/edge.md. Firefox and Safari stay available to `wxt build -b` but are
  // neither built nor verified here, so do not claim them.
  manifestVersion: 3,

  // Auto-imports are disabled: every symbol in this codebase has a visible
  // import. Implicit globals defeat lint rules and make review harder.
  imports: false,

  // Preact JSX is configured entirely through tsconfig.json
  // (`jsx: "react-jsx"` + `jsxImportSource: "preact"`), which Vite's transform
  // reads directly. That is why there is no framework plugin and no Babel in
  // this project — see docs/architecture.md ("Preact without a Vite plugin").

  manifest: {
    // `name` IS the Chrome Web Store listing title — the dashboard has no
    // separate title field — so this is the keyword-bearing form, carrying the
    // phrase users actually search (30 of the 75 characters Chrome allows).
    // Everywhere the tail would look absurd the product is just "Headerman":
    // `short_name`, the toolbar tooltip below, the page titles and the in-app
    // headings. See docs/single-purpose.md, "On the name".
    name: 'Headerman — HTTP Header Editor',
    short_name: 'Headerman',
    // Must stay consistent with docs/single-purpose.md.
    description:
      'Edit the HTTP request and response headers of the sites you choose. No account, no telemetry, no debugger permission.',

    // --- SECURITY: permission surface -------------------------------------
    // Every entry below MUST have a row in docs/permissions.md.
    // Never add <all_urls> or wildcard host_permissions.
    //
    // NOTE ON `declarativeNetRequestWithHostAccess`: the plain
    // `declarativeNetRequest` permission shows the "Block content on any page"
    // install warning and grants implicit reach. The WithHostAccess variant
    // shows NO install warning and can only act on hosts the user has
    // explicitly granted. That is strictly the smaller ask, and it is the
    // permission this product's whole pitch rests on — we never request
    // `debugger`, which is what the incumbent asks every user for at install.
    permissions: ['storage', 'declarativeNetRequestWithHostAccess', 'activeTab'],
    optional_permissions: [],

    // Granted at install: NOTHING. The extension starts with zero site access.
    host_permissions: [],

    // The envelope Chrome requires before `permissions.request()` may ask for a
    // user-named origin. Declaring it grants nothing and shows no warning; every
    // origin actually requested is a specific host and is checked by
    // `assertOriginIsNarrow()` in lib/permissions.ts first, which rejects
    // `<all_urls>`, `*://*/*`, wildcard TLDs and wildcards over public suffixes.
    // See docs/permissions.md, "Why the envelope is broad and the grant is not".
    //
    // It must be the `*` scheme, not `http://*/*` + `https://*/*`: Chrome
    // requires a REQUESTED pattern to be contained in a DECLARED one, and
    // `*://api.example.com/*` is not contained in an `http`-scheme declaration.
    // Verified against Chrome 150 — requesting it fails with "Only permissions
    // specified in the manifest may be requested."
    optional_host_permissions: ['*://*/*'],

    // --- SECURITY: CSP ----------------------------------------------------
    // Locked down. No remote code, no eval, no wasm-unsafe-eval.
    //
    // `connect-src 'none'` is the browser-enforced half of "nothing leaves this
    // device": the extension pages can open no connection at all, to anywhere,
    // whatever any dependency's code asks for. That is exactly what PRIVACY.md
    // claims, so it is what the policy says — not `'self'`, which would be a
    // weaker claim kept only for Vite's modulepreload polyfill, and that
    // polyfill returns before its `fetch` in any browser with native
    // modulepreload support. `scripts/verify-bundle.mjs` pins this to `'none'`.
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; connect-src 'none';",
    },

    action: {
      default_title: 'Headerman',
    },

    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },

    // Keyboard shortcuts are surfaced to users on the options page.
    // Chrome allows at most 4 suggested_key commands.
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Alt+Shift+E',
        },
        description: 'Open the extension popup',
      },
    },
  },
});
