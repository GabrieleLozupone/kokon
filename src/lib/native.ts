// Native integrations through the Tauri shell. In a browser (the UI served by kokon-service to
// other devices) there is no shell: files come in by upload and go out by download, and what
// needs the computer's own folders is hidden by the components (`inBrowser`).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { inBrowser } from "./platform";

export interface Connection { baseUrl: string; token: string; version: string }

/** Copying images in a browser needs a secure page (https, e.g. through Tailscale, or localhost). */
export const canCopyImage = !inBrowser || (typeof window !== "undefined" && window.isSecureContext && !!navigator.clipboard?.write && typeof ClipboardItem !== "undefined");

/** The browser's clipboard takes PNG only. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not copy the image."))), "image/png"));
}

export const native = {
  /** In a browser the API is on the page's own server, signed in by cookie. */
  connect: () => (inBrowser ? Promise.resolve<Connection>({ baseUrl: "/api/v1", token: "", version: "" }) : invoke<Connection>("connect")),
  /** Desktop: the image file at `path`. */
  copyImage: (path: string) => invoke<void>("copy_image", { path }),
  /** Browser: the image at `url` (see `canCopyImage`). */
  copyImageUrl: async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Could not read the image.");
    const png = await asPng(await res.blob());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  },
  /** Text to the clipboard. A browser page on plain http (the LAN) has no clipboard API: the old
   * copy command still works there. */
  copyText: async (text: string) => {
    if (!inBrowser) return writeText(text);
    if (window.isSecureContext && navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("Could not copy the text.");
  },
  readClipboardImage: async (): Promise<Uint8Array | null> => {
    if (inBrowser) return null;
    const buf = await invoke<ArrayBuffer>("read_clipboard_image");
    const bytes = new Uint8Array(buf);
    return bytes.length ? bytes : null;
  },
  reveal: (path: string) => invoke<void>("reveal", { path }),
  openFolder: (path: string) => invoke<void>("open_folder", { path }),
  dataFolder: () => invoke<string>("data_folder"),
  /** https links to github.com / huggingface.co only (desktop). */
  openLink: async (url: string) => {
    if (inBrowser) window.open(url, "_blank", "noopener,noreferrer");
    else await invoke<void>("open_link", { url });
  },
  /** Desktop: paths of the images picked. */
  pickImages: async (): Promise<string[]> => {
    const r = await open({ multiple: true, directory: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic", "heif"] }] });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },
  /** Browser: the images picked on this device, to upload. The input stays in the page until it
   * answers: iOS Safari drops a detached one while the Camera is open (Take Photo never came
   * back; the photo library, quicker, did). */
  pickImageFiles: (): Promise<File[]> =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = "image/*,.heic,.heif";
      input.hidden = true;
      const done = (files: File[]) => {
        input.remove();
        resolve(files);
      };
      input.onchange = () => done(Array.from(input.files ?? []));
      input.oncancel = () => done([]);
      document.body.appendChild(input);
      input.click();
    }),
  pickFile: async (extensions: string[], defaultPath?: string, kind = "Model"): Promise<string | null> => {
    const r = await open({ multiple: false, directory: false, defaultPath, filters: [{ name: kind, extensions }] });
    return typeof r === "string" ? r : null;
  },
  pickFolder: async (defaultPath?: string): Promise<string | null> => {
    const r = await open({ multiple: false, directory: true, defaultPath });
    return typeof r === "string" ? r : null;
  },
  confirm: (message: string, title: string) => (inBrowser ? Promise.resolve(window.confirm(message)) : ask(message, { title, kind: "warning" })),
  isFullscreen: async () => (inBrowser ? !!document.fullscreenElement : getCurrentWindow().isFullscreen()),
  setFullscreen: async (on: boolean) => {
    if (!inBrowser) return getCurrentWindow().setFullscreen(on);
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  },
  setTheme: async (theme: "light" | "dark" | null) => (inBrowser ? undefined : getCurrentWindow().setTheme(theme)),
  // Kokon's own title bar (the system one is off on Windows and Linux).
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onResized: async (f: () => void): Promise<() => void> => {
    if (!inBrowser) return getCurrentWindow().onResized(f);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  },
  saveAs: (defaultName: string) => {
    const isVideo = defaultName.toLowerCase().endsWith(".webm") || defaultName.toLowerCase().endsWith(".mp4");
    return save({
      defaultPath: defaultName,
      filters: isVideo
        ? [
            { name: "WebM Video", extensions: ["webm"] },
            { name: "MP4 Video", extensions: ["mp4"] },
          ]
        : [
            { name: "PNG", extensions: ["png"] },
            { name: "JPEG", extensions: ["jpg"] },
            { name: "WebP", extensions: ["webp"] },
          ],
    });
  },
  /** Browser: saves the file at `url` on this device (the browser's downloads). */
  download: (url: string, name: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
