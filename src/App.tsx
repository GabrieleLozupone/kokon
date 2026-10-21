import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, configure } from "./lib/api";
import { native } from "./lib/native";
import {
  addExampleProjects, addInputs, closeStarPrompt, dismissToast, getState, initStarPrompt, redoVersion, refreshLoras, refreshStatus, selectItem, setState, startEvents, startTour, submitComposer, toastError, toastInfo, undoVersion, useStore,
} from "./lib/store";
import { Composer, importPaths } from "./components/Composer";
import { ExpandEditor } from "./components/ExpandEditor";
import { Gallery } from "./components/Gallery";
import { InpaintEditor } from "./components/InpaintEditor";
import { Settings as SettingsDialog } from "./components/Settings";
import { Setup } from "./components/Setup";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { Tour } from "./components/Tour";
import { PromptTips } from "./components/PromptTips";
import { Shortcuts } from "./components/Shortcuts";
import { WhatsNew, whatsNewDue } from "./components/WhatsNew";
import { UpscalerCompare } from "./components/Upscalers";
import { KokonMark, Welcome } from "./components/Welcome";
import { BareTitleBar } from "./components/TitleBar";
import { TopBar } from "./components/TopBar";
import { autoCheckForUpdate } from "./lib/updates";

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i;
const REPO_URL = "https://github.com/GabrieleLozupone/kokon";

/** Same breathing mark as the HTML splash in index.html, so startup looks like one step;
 * a line of text appears if connecting to the local service takes a while. */
function BootSplash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 3000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="boot-splash">
      <KokonMark size={56} />
      <span className={`muted boot-text ${slow ? "on" : ""}`}>Starting Kokon…</span>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="toasts" role="status">
      <StarPrompt />
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <div className="body">
            <div>{t.message}</div>
            {t.suggestion && <div className="sugg">{t.suggestion}</div>}
            {t.detail && (
              <button onClick={() => setOpen(open === t.id ? null : t.id)} style={{ marginTop: 4 }}>
                {open === t.id ? "Hide details" : "Details"}
              </button>
            )}
            {open === t.id && <pre>{t.detail}</pre>}
          </div>
          <button onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Once, after a few images made with Kokon (store.ts): a star helps other people find it. */
function StarPrompt() {
  const on = useStore((s) => s.starPrompt);
  if (!on) return null;
  const star = () => {
    native.openLink(REPO_URL).catch(toastError);
    closeStarPrompt();
  };
  return (
    <div className="star-prompt">
      <div className="body">
        <strong>Enjoying Kokon?</strong>
        <div className="sugg">A star on GitHub helps other people find it. This is the only time we ask.</div>
        <div className="star-actions">
          <button className="btn primary" onClick={star}>
            <Star size={14} /> Star on GitHub
          </button>
          <button className="btn ghost" onClick={closeStarPrompt}>
            No thanks
          </button>
        </div>
      </div>
      <button onClick={closeStarPrompt} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

async function uploadBlobs(files: File[]) {
  const recs = [];
  for (const f of files) {
    try {
      recs.push(await api.upload(f, f.name || "pasted.png"));
    } catch (e) {
      toastError(e);
    }
  }
  addInputs(recs);
}

export default function App() {
  const overlay = useStore((s) => s.overlay);
  const needsSetup = useStore((s) => s.needsSetup);
  const compareUpscalers = useStore((s) => s.compareUpscalers);
  const sidebar = useStore((s) => s.sidebar);
  const editing = useStore((s) => s.composer.refs.length > 0 && s.session.length > 0);
  const [boot, setBoot] = useState<"connecting" | "ok" | string>("connecting");
  const [dragging, setDragging] = useState(false);
  // First launch: the tour starts once the main window is free (after welcome and setup).
  const tourPending = useRef(false);
  const tourDue = boot === "ok" && !needsSetup && !overlay;
  useEffect(() => {
    if (!tourDue || !tourPending.current) return;
    tourPending.current = false;
    startTour();
  }, [tourDue]);

  // Connect to (or start) the local service.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = await native.connect();
        if (cancelled) return;
        configure(conn.baseUrl, conn.token);
        startEvents();
        const cfg = await api.config();
        const st = await refreshStatus();
        refreshLoras();
        // First launch: the welcome screen, once (Settings → General shows it again).
        const ui = (cfg.ui ?? {}) as Record<string, unknown>;
        const welcomeSeen = !!ui.welcomeSeen;
        initStarPrompt(ui);
        // ...with example projects to look at, and the tour through the first one.
        if (!welcomeSeen && !ui.tourSeen) {
          tourPending.current = true;
          addExampleProjects().catch(() => {});
        }
        // After an app update: what's new, with the engine download when the release needs a
        // newer one (it can be postponed there; offered again only for another release).
        const whatsNew = cfg.setupComplete && whatsNewDue(ui, st?.engine);
        const engineUpdate = whatsNew && !!st?.engine?.update_needed;
        setState({ needsSetup: !cfg.setupComplete, ...(!welcomeSeen ? { overlay: "welcome" } : whatsNew ? { overlay: "whats-new" } : {}) });
        setBoot("ok");
        autoCheckForUpdate();
        // Preload the model so the first generation starts immediately (not an engine about to be replaced).
        if (cfg.setupComplete && !engineUpdate && st && st.server.state === "stopped") api.startBackend().then(refreshStatus, () => refreshStatus());
      } catch (e) {
        setBoot(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Native file drops (paths) — efficient: the service reads the files itself.
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          const paths = p.paths.filter((x) => IMAGE_EXT.test(x));
          if (paths.length) importPaths(paths);
          else if (p.paths.length) toastInfo("Only image files can be added.");
        }
      })
      .then((u) => (un = u))
      .catch(() => {});
    return () => un?.();
  }, []);

  // Clipboard paste: browser image data first, native clipboard as a fallback.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (getState().overlay) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        uploadBlobs(files);
        return;
      }
      if (e.clipboardData?.getData("text")) return;
      try {
        const png = await native.readClipboardImage();
        if (png) uploadBlobs([new File([png as BlobPart], "pasted.png", { type: "image/png" })]);
      } catch {
        /* nothing to paste */
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Keyboard: arrows browse the session, Ctrl+Enter generates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select");
      const s = getState();
      if (s.overlay) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submitComposer();
        return;
      }
      if (typing) return;
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector(".viewer")) {
        e.preventDefault();
        setState({ overlay: "shortcuts" });
        return;
      }
      // Undo / Redo between versions (the brush editor has its own while it is open).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoVersion();
        else undoVersion();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoVersion();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        const i = s.session.findIndex((x) => x.key === s.selected);
        const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        const n = s.session[Math.max(0, Math.min(s.session.length - 1, i + d))];
        if (n) selectItem(n.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (boot !== "ok") {
    return (
      <div className="app" style={{ display: "grid", placeItems: "center" }}>
        <BareTitleBar />
        {boot === "connecting" ? (
          <BootSplash />
        ) : (
          <div className="failed">
            <strong>Could not start the local service</strong>
            <span>{boot}</span>
            <button className="btn" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      {sidebar && !needsSetup && <Sidebar />}
      <div className="workspace">
        <TopBar />
        <div className="main">
          {needsSetup ? <Setup /> : <Stage />}
          {overlay === "gallery" && <Gallery />}
          {overlay === "inpaint" && <InpaintEditor />}
          {overlay === "expand" && <ExpandEditor />}
          {dragging && <div className="drop-hint">{editing ? "Drop to add as a reference image" : "Drop an image to start editing it"}</div>}
        </div>
        {!needsSetup && overlay !== "inpaint" && overlay !== "expand" && overlay !== "gallery" && <Composer />}
      </div>
      {overlay === "settings" && <SettingsDialog />}
      {overlay === "welcome" && <Welcome />}
      {overlay === "whats-new" && <WhatsNew />}
      {overlay === "prompt-tips" && <PromptTips />}
      {overlay === "shortcuts" && <Shortcuts />}
      {compareUpscalers && <UpscalerCompare />}
      <Tour />
      <Toasts />
    </div>
  );
}
