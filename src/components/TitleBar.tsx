// Kokon draws its own title bar: the window is one surface. On Windows and Linux the system
// bar is off (tauri.conf.json) and these are the window's buttons; on macOS the system keeps
// its traffic lights, drawn over Kokon's top bar (tauri.macos.conf.json), so there is nothing
// to draw here. Linux gets round GNOME-like buttons, Windows its own. The top bar and the sidebar's head are drag regions (data-tauri-drag-region).

import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { native } from "../lib/native";
import { isLinux, isMac } from "../lib/platform";

// macOS: room for the traffic lights on the left of the top bar (styles.css).
if (isMac && typeof document !== "undefined") document.documentElement.dataset.platform = "mac";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (isMac) return;
    let un: (() => void) | undefined;
    let gone = false;
    const sync = () => native.isMaximized().then((m) => !gone && setMaximized(m), () => {});
    sync();
    native.onResized(sync).then((u) => (gone ? u() : (un = u)), () => {});
    return () => {
      gone = true;
      un?.();
    };
  }, []);
  if (isMac) return null;
  return (
    <div className={`window-controls ${isLinux ? "linux" : ""}`}>
      <button className="win-btn" title="Minimize" aria-label="Minimize" onClick={() => native.minimize().catch(() => {})}>
        <Minus size={isLinux ? 14 : 16} strokeWidth={isLinux ? 2 : 1.6} />
      </button>
      <button className="win-btn" title={maximized ? "Restore" : "Maximize"} aria-label={maximized ? "Restore" : "Maximize"} onClick={() => native.toggleMaximize().catch(() => {})}>
        {maximized ? <Copy size={isLinux ? 11 : 13} strokeWidth={isLinux ? 2 : 1.6} style={{ transform: "scaleX(-1)" }} /> : <Square size={isLinux ? 11 : 13} strokeWidth={isLinux ? 2 : 1.6} />}
      </button>
      <button className="win-btn close" title="Close" aria-label="Close" onClick={() => native.close().catch(() => {})}>
        <X size={isLinux ? 14 : 17} strokeWidth={isLinux ? 2 : 1.6} />
      </button>
    </div>
  );
}

/** A bar to move the window by and its buttons, over screens without the top bar (startup). */
export function BareTitleBar() {
  return (
    <div className="bare-titlebar" data-tauri-drag-region>
      <WindowControls />
    </div>
  );
}
