# Design System

Lives in `ui/`. Two files define everything visual; components consume tokens and
never hard-code values.

| File | Role |
| --- | --- |
| `ui/tokens.css` | Design tokens — the single source of truth |
| `ui/base.css` | Base layer + component styles, built from tokens |
| `ui/*.tsx` | Preact primitives |
| `ui/states/*.tsx` | Empty / loading / error / offline states |
| `ui/index.ts` | Public barrel — import from here |

## Tokens

Colour, spacing, radii, type scale, motion and layout are CSS custom properties
prefixed `--ui-`. **No hard-coded values in components.** If you need a value that
is not a token, add the token.

`ui/tokens.test.ts` parses `ui/tokens.css` and fails the build if a token is
missing or a contrast pair drops below AA — so the check runs against the file
that actually ships, not a copy.

## Dark mode

Driven entirely by `prefers-color-scheme`. **There is no in-extension theme
toggle**, and the test asserts there is no `[data-theme]` hook either. The
extension should look like part of the browser, and the browser already knows the
user's preference.

Both themes are defined from the start. `ui/tokens.test.ts` asserts that **every**
colour token defined in light mode is overridden in dark mode — retrofitting dark
mode is the most common polish failure, so an unhandled token is a test failure.

## Accessibility — a release requirement, not a nice-to-have

| Requirement | How |
| --- | --- |
| WCAG AA contrast, both themes | Machine-verified in `ui/tokens.test.ts` (4.5:1 text, 3:1 UI) |
| Visible focus rings | `:focus-visible` in `ui/base.css`; never `outline: none` without a replacement |
| Full keyboard operation | Native elements throughout — `<button>`, `<input type="checkbox" role="switch">` |
| Correct ARIA roles | `role="alert"` on errors, `role="status"` + `aria-live` on loading/offline, `aria-busy` on pending buttons |
| Screen-reader labels | Every `Spinner` requires a `label`; `VisuallyHidden` for text-free controls |
| Skip link | `.ui-skip-link` on the options page |
| Reduced motion | `prefers-reduced-motion` honoured in `ui/base.css` |

The rule of thumb: use the native element. Every custom `div`-with-handlers
re-implements focus, keyboard and semantics, usually incompletely.

## Popup sizing

Chromium clamps popups to **800x600**. Well-behaved extensions use 320–400px.

- Fixed width: **360px** (`--ui-popup-width`).
- Height follows content, with internal scrolling past **560px**
  (`--ui-popup-max-height`) so browser zoom still has headroom.
- The header and footer are fixed; only `.ui-popup__body` scrolls.

Enforced in `entrypoints/popup/popup.css` and asserted in `ui/tokens.test.ts`.

## Typography

`system-ui` first in `--ui-font-sans`, so the UI renders in the same typeface as
the browser chrome around it. A popup set in a web font reads as a foreign page
embedded in the browser — which is exactly what it is, and exactly what it should
not look like.

Type scale is deliberately small (11–18px): extension UI sits next to browser
chrome, not next to web content.

## Every state is designed

All four are reusable primitives, built now rather than improvised later:

| State | Component | Notes |
| --- | --- | --- |
| Empty | `EmptyState` | Title + explanation + optional action |
| Loading | `LoadingState` | `role="status"`, announced politely |
| Error | `ErrorState` | `role="alert"`, shows the real detail, optional retry |
| Offline | `OfflineState` | Informational, never blocking — see [licensing.md](licensing.md) |

`useAsync()` maps a promise onto exactly these states, so a surface that fetches
anything gets all of them by construction. `PermissionsPanel` in
`entrypoints/options/App.tsx` and `components/BackupsPanel.tsx` are the
references.

A storage read has one state beyond those: the record was readable but did not
validate. That must never become "you have no data" — see `loadDocument()` in
`lib/rules-engine.ts`, which quarantines the bytes and hands back a
`recoveryError` for `components/EngineAlerts.tsx` to show.

### A fifth state, specific to this product: "on, but not working"

A header rule can be saved, enabled, and still not applying — the site access is
missing, the rule itself cannot work, or the browser refused the whole set.
`StatusBadge` plus `components/RuleStatusDetail.tsx` render that state everywhere
a rule appears, with the specific reason. Colour never carries the meaning alone:
the badge says "Won't apply", "Needs site access" or "Browser refused" in words,
and the reason sits next to it.

Those last two are deliberately different words. "Won't apply" sends the user to
look at the rule; "Browser refused" means there is nothing wrong with this rule
and the answer is one level up, in the `EngineAlerts` callout — sending someone
hunting through a rule that is fine would waste their time.

`components/EngineAlerts.tsx` is the same idea one level up, for the four
failures that would otherwise look like "the extension just stopped": the browser
refused the rule set, the browser kept something different from what we
installed, the stored rules were unreadable, or a save failed.

## Form primitives

`TextField`, `Select` and `ChipGroup` all wrap native elements — `<input>`,
`<select>`, `<input type="checkbox">` inside a `<fieldset>` — so keyboard
operation, focus rings and screen-reader semantics come for free and cannot
drift. Hints and errors are wired through `aria-describedby`, so the reason a
field was rejected is spoken, not merely coloured.

## Adding a component

1. Add styles to `ui/base.css` using tokens only.
2. Add the `.tsx` primitive in `ui/`.
3. Export it from `ui/index.ts`.
4. Check keyboard operation and focus visibility in both themes.
5. If you added a colour token, add its contrast pair to `ui/tokens.test.ts`.

## Icons

`public/icon/{16,32,48,128}.png`, committed as finished artwork. There is no
generation step — replacing an icon means replacing the PNG.

The mark is an amber rounded tile carrying a heavy near-black bar above two cream
bars: the shape of a `Key: Value` header line above a message body. It uses few,
thick strokes because thin or detailed art turns to mush at 16px, and it was
checked at true 16px against white, Chrome's light toolbar (`#DEE1E6`), and both
dark toolbar shades.

Two size rules that look like mistakes and are not — both asserted in
`tests/icons.test.ts`, which also proves each declared icon still resolves to a
real file and keeps its antialiased alpha channel:

- **128 carries 16px of transparent padding on each side** — 96×96 of artwork in
  a 128×128 canvas, which is what Google's store-icon spec asks for. Do not scale
  the art up to fill the canvas.
- **16/32/48 use the full canvas.** Padding an already-tiny toolbar icon only
  makes it smaller.
