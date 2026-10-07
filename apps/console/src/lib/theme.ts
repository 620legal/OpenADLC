export const THEME_KEY = 'fleetadlc.theme';
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/**
 * Runs before first paint, inlined into the document head.
 *
 * It has to be a string rather than an imported function because it runs before
 * any bundle has loaded — the onboarding page is server-rendered on purpose, and
 * applying the mode from a React effect means the browser paints the default
 * first. A white flash on a dark desktop at six in the morning is the kind of
 * thing that gets a console closed.
 *
 * `system` writes no attribute at all, which is what lets the media query in
 * `globals.css` answer, and what makes an OS change take effect live with no
 * listener and no reload.
 *
 * Wrapped in try/catch because `localStorage` throws outright in a browser with
 * site data blocked, and a console that fails to render is worse than one that
 * forgot your preference.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

/** What is stored, or `system` when nothing is — including when storage throws. */
export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Applies a choice and remembers it.
 *
 * `system` *removes* the attribute rather than resolving the media query and
 * writing the answer: resolving it would freeze the mode at whatever the OS said
 * when the button was clicked, and "system" that stops following the system is
 * the bug this is meant to avoid.
 */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);

  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A private window, or site data blocked. The choice holds for this page.
  }
}
