'use client';

import { useEffect, useState } from 'react';
import { applyTheme, storedTheme, THEMES, type Theme } from '../lib/theme';

const LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Three states, shown as three. A two-state switch cannot express "follow the
 * operating system", and that is the one most people want — it is the default
 * here, and the only one that changes with the desktop while the console is
 * open.
 *
 * Until mounted, no button is marked selected. The server does not know what is
 * in this browser's storage, so marking one on the server would mark the wrong
 * one and then correct itself — the page would be right and the
 * control would lie for a frame. The colours themselves do not wait: those are
 * settled before first paint by the script in the head.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(storedTheme());
  }, []);

  function choose(next: Theme) {
    applyTheme(next);
    setTheme(next);
  }

  return (
    <div role="radiogroup" aria-label="Color mode" className="flex shrink-0 rounded-lg bg-well p-0.5">
      {THEMES.map((option) => {
        const active = theme === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={LABEL[option]}
            onClick={() => choose(option)}
            className={`h-10 rounded-md px-3 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-link md:h-[30px] ${
              active ? 'bg-panel font-medium text-body shadow-sm' : 'text-muted hover:text-body'
            }`}
            // Until the stored choice is known, nothing is marked selected —
            // but the buttons are there and they work, so a person who clicks
            // immediately is not waiting on an effect.
            style={theme === null ? { opacity: 0.6 } : undefined}
          >
            {LABEL[option]}
          </button>
        );
      })}
    </div>
  );
}
