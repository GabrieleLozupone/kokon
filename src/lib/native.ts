// Native integrations through the Tauri shell.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";

export interface Connection { baseUrl: string; token: string; version: string }

export const native = {
  connect: () => invoke<Connection>("connect"),
  copyImage: (path: string) => invoke<void>("copy_image", { path }),
  readClipboardImage: async (): Promise<Uint8Array | null> => {
    const buf = await invoke<ArrayBuffer>("read_clipboard_image");
    const bytes = new Uint8Array(buf);
    return bytes.length ? bytes : null;
  },
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  dataFolder: () => invoke<string>("data_folder"),
  /** https links to github.com / huggingface.co only. */
  openLink: (url: string) => invoke<void>("open_link", { url }),
  pickImages: async (): Promise<string[]> => {
    const r = await open({ multiple: true, directory: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic", "heif"] }] });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },
  pickFile: async (extensions: string[], defaultPath?: string, kind = "Model"): Promise<string | null> => {
    const r = await open({ multiple: false, directory: false, defaultPath, filters: [{ name: kind, extensions }] });
    return typeof r === "string" ? r : null;
  },
  pickFolder: async (defaultPath?: string): Promise<string | null> => {
    const r = await open({ multiple: false, directory: true, defaultPath });
    return typeof r === "string" ? r : null;
  },
  confirm: (message: string, title: string) => ask(message, { title, kind: "warning" }),
  isFullscreen: () => getCurrentWindow().isFullscreen(),
  setFullscreen: (on: boolean) => getCurrentWindow().setFullscreen(on),
  setTheme: async (theme: "light" | "dark" | null) => getCurrentWindow().setTheme(theme),
  // Kokon's own title bar (the system one is off on Windows and Linux).
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onResized: (f: () => void) => getCurrentWindow().onResized(f),
  saveAs: (defaultName: string) =>
    save({
      defaultPath: defaultName,
      filters: [
        { name: "PNG", extensions: ["png"] },
        { name: "JPEG", extensions: ["jpg"] },
        { name: "WebP", extensions: ["webp"] },
      ],
    }),
};
