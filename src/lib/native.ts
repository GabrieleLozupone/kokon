// Native integrations through the Tauri shell with browser-safe fallbacks.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";

export const isTauri =
  typeof window !== "undefined" &&
  (Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) ||
    Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__));

export interface Connection { baseUrl: string; token: string; version: string }

export const native = {
  connect: () => (isTauri ? invoke<Connection>("connect") : Promise.reject(new Error("Not in Tauri"))),
  copyImage: (path: string) => (isTauri ? invoke<void>("copy_image", { path }) : Promise.resolve()),
  readClipboardImage: async (): Promise<Uint8Array | null> => {
    if (!isTauri) return null;
    const buf = await invoke<ArrayBuffer>("read_clipboard_image");
    const bytes = new Uint8Array(buf);
    return bytes.length ? bytes : null;
  },
  reveal: (path: string) => (isTauri ? invoke<void>("reveal", { path }) : Promise.resolve()),
  openFolder: (path: string) => (isTauri ? invoke<void>("open_folder", { path }) : Promise.resolve()),
  dataFolder: () => (isTauri ? invoke<string>("data_folder") : Promise.resolve("")),
  /** https links to github.com / huggingface.co only. */
  openLink: (url: string) => {
    if (isTauri) return invoke<void>("open_link", { url });
    window.open(url, "_blank");
    return Promise.resolve();
  },
  pickImages: async (): Promise<string[]> => {
    if (!isTauri) return [];
    const r = await open({ multiple: true, directory: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic", "heif"] }] });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },
  pickFile: async (extensions: string[], defaultPath?: string): Promise<string | null> => {
    if (!isTauri) return null;
    const r = await open({ multiple: false, directory: false, defaultPath, filters: [{ name: "Model", extensions }] });
    return typeof r === "string" ? r : null;
  },
  pickFolder: async (defaultPath?: string): Promise<string | null> => {
    if (!isTauri) return null;
    const r = await open({ multiple: false, directory: true, defaultPath });
    return typeof r === "string" ? r : null;
  },
  confirm: (message: string, title: string) => (isTauri ? ask(message, { title, kind: "warning" }) : Promise.resolve(window.confirm(message))),
  isFullscreen: async (): Promise<boolean> => {
    if (isTauri) {
      try {
        return await getCurrentWindow().isFullscreen();
      } catch {
        return false;
      }
    }
    return typeof document !== "undefined" && document.fullscreenElement !== null;
  },
  setFullscreen: async (on: boolean): Promise<void> => {
    if (isTauri) {
      try {
        await getCurrentWindow().setFullscreen(on);
      } catch {}
      return;
    }
    try {
      if (typeof document !== "undefined") {
        if (on && !document.fullscreenElement) {
          await document.documentElement.requestFullscreen?.().catch(() => {});
        } else if (!on && document.fullscreenElement) {
          await document.exitFullscreen?.().catch(() => {});
        }
      }
    } catch {}
  },
  saveAs: (defaultName: string) =>
    isTauri
      ? save({
          defaultPath: defaultName,
          filters: [
            { name: "PNG", extensions: ["png"] },
            { name: "JPEG", extensions: ["jpg"] },
            { name: "WebP", extensions: ["webp"] },
          ],
        })
      : Promise.resolve(null),
};
