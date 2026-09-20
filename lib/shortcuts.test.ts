import { describe, expect, it } from 'vitest';
import { commandShortcuts } from './shortcuts';

describe('commandShortcuts', () => {
  it('splits a Windows/Linux binding into individual keys', () => {
    const [shortcut] = commandShortcuts([
      { name: '_execute_action', description: 'Open the extension popup', shortcut: 'Alt+Shift+E' },
    ]);
    expect(shortcut).toEqual({
      id: '_execute_action',
      description: 'Open the extension popup',
      keys: ['Alt', 'Shift', 'E'],
    });
  });

  it('reports an unbound command with no keys instead of inventing a default', () => {
    const [shortcut] = commandShortcuts([{ name: '_execute_action', shortcut: '' }]);
    expect(shortcut?.keys).toEqual([]);
  });

  it('splits macOS modifier glyphs without breaking multi-character keys', () => {
    const [glyphs] = commandShortcuts([{ name: 'a', shortcut: '⌥⇧E' }]);
    expect(glyphs?.keys).toEqual(['⌥', '⇧', 'E']);

    const [fnKey] = commandShortcuts([{ name: 'b', shortcut: '⌘F5' }]);
    expect(fnKey?.keys).toEqual(['⌘', 'F5']);
  });

  it('falls back to a caller-supplied description, then the command name', () => {
    const [withFallback] = commandShortcuts([{ name: '_execute_action', shortcut: 'Alt+E' }], {
      _execute_action: 'Open the extension popup',
    });
    expect(withFallback?.description).toBe('Open the extension popup');

    const [bare] = commandShortcuts([{ name: 'mystery', shortcut: '' }]);
    expect(bare?.description).toBe('mystery');
  });
});
