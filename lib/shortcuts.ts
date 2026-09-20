/**
 * Maps `browser.commands.getAll()` results onto the options page's shortcut
 * reference. The display is derived from the live bindings rather than a
 * hand-maintained copy of the manifest, so it cannot drift from reality — and
 * it stays honest for users who rebound or cleared the shortcut at
 * chrome://extensions/shortcuts.
 */

/** The subset of `chrome.commands.Command` this mapping reads. */
export interface CommandInfo {
  name?: string | undefined;
  description?: string | undefined;
  shortcut?: string | undefined;
}

export interface CommandShortcut {
  id: string;
  description: string;
  /** Individual keys, e.g. ['Alt', 'Shift', 'E']. Empty when unbound. */
  keys: readonly string[];
}

/** Modifier glyphs Chrome uses in macOS shortcut strings (no '+' separators). */
const MAC_MODIFIER = /^[⌃⌥⇧⌘]/u;

function splitShortcut(shortcut: string): string[] {
  if (shortcut.includes('+')) {
    return shortcut.split('+').filter((key) => key.length > 0);
  }
  // macOS reports e.g. '⌥⇧E': peel modifier glyphs, keep the rest as one key
  // so 'F5'-style bindings are not split into characters.
  const keys: string[] = [];
  let rest = shortcut;
  while (MAC_MODIFIER.test(rest)) {
    const glyph = [...rest][0] as string;
    keys.push(glyph);
    rest = rest.slice(glyph.length);
  }
  if (rest.length > 0) keys.push(rest);
  return keys;
}

/**
 * `_execute_action` has no manifest description slot Chrome reports back, so
 * callers may provide fallbacks per command name.
 */
export function commandShortcuts(
  commands: readonly CommandInfo[],
  descriptions: Readonly<Record<string, string>> = {},
): CommandShortcut[] {
  return commands.map((command) => {
    const id = command.name ?? '';
    return {
      id,
      description: command.description || descriptions[id] || id,
      keys: command.shortcut ? splitShortcut(command.shortcut) : [],
    };
  });
}
