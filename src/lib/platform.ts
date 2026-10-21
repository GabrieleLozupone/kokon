// Platform-specific wording for labels (shortcut handlers accept Ctrl and ⌘ everywhere).

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** "Ctrl+Z" on Windows, "⌘Z" on macOS. */
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

export const isLinux = typeof navigator !== "undefined" && !isMac && /Linux/i.test(navigator.platform || navigator.userAgent);

export const fileManager = isMac ? "Finder" : isLinux ? "the file manager" : "Explorer";
