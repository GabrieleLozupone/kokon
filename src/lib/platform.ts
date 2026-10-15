// Platform-specific wording for labels (shortcut handlers accept Ctrl and ⌘ everywhere).

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** "Ctrl+Z" on Windows, "⌘Z" on macOS. */
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

export const fileManager = isMac ? "Finder" : "Explorer";

/** Applies the theme by adding/removing classes on <html>. Call before React mounts to avoid flash. */
export function applyTheme(theme: "system" | "light" | "dark") {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.classList.remove("theme-light", "theme-dark");
  if (theme !== "system") {
    html.classList.add(`theme-${theme}`);
  }
}
