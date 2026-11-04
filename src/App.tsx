import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, configure, setSignedOutHandler } from "./lib/api";
import { native } from "./lib/native";
import { inBrowser, isNarrow, useNarrow } from "./lib/platform";
import { macEngineOfferDue } from "./lib/logic";
import {
  addExampleProjects, closeStarPrompt, loadProjects, dismissToast, getState, initStarPrompt, redoVersion, refreshLoras, refreshStatus, selectItem, setState, startEvents, startTour, submitComposer, toastError, toastInfo, undoVersion, useStore,
} from "./lib/store";
import { Composer, importPaths, uploadFiles } from "./components/Composer";
import { Login } from "./components/Login";
import { ExpandEditor } from "./components/ExpandEditor";
import { Gallery } from "./components/Gallery";
import { InpaintEditor } from "./components/InpaintEditor";
import { LayersEditor } from "./components/LayersEditor";
import { Settings as SettingsDialog } from "./components/Settings";
import { Setup } from "./components/Setup";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { Tour } from "./components/Tour";
import { PromptTips } from "./components/PromptTips";
import { Shortcuts } from "./components/Shortcuts";
import { AiCheck } from "./components/AiCheck";
import { WhatsNew, whatsNewDue } from "./components/WhatsNew";
import { MacEngineOffer } from "./components/MacEngineOffer";
import { UpscalerCompare } from "./components/Upscalers";
import { KokonMark, Welcome } from "./components/Welcome";
import { PhoneApp } from "./components/PhoneApp";
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

/** Browser: a lease while the tab is open, so the service does not exit under it (the desktop
 * app holds its lease from Rust). The service drops it 45 s after the last beat. */
function startBrowserHeartbeat() {
  const id = `web-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  const beat = () => api.heartbeat(id).catch(() => {});
  beat();
  window.setInterval(beat, 15_000);
}

export default function App() {
  const overlay = useStore((s) => s.overlay);
  const needsSetup = useStore((s) => s.needsSetup);
  const compareUpscalers = useStore((s) => s.compareUpscalers);
  const sidebar = useStore((s) => s.sidebar);
  const editing = useStore((s) => s.composer.refs.length > 0 && s.session.length > 0);
  const [boot, setBoot] = useState<"connecting" | "login" | "ok" | string>("connecting");
  // Bumped after signing in, to run the start-up again.
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const narrow = useNarrow();
  // First launch: the tour starts once the main window is free (after welcome and setup).
  const tourPending = useRef(false);
  const tourDue = boot === "ok" && !needsSetup && !overlay;
  useEffect(() => {
    if (!tourDue || !tourPending.current) return;
    tourPending.current = false;
    // The tour points at the desktop layout; a phone has its own.
    if (!isNarrow()) startTour();
  }, [tourDue]);

  // Connect to (or start) the local service.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const conn = await native.connect();
        if (cancelled) return;
        configure(conn.baseUrl, conn.token);
        if (inBrowser) {
          // Another device: sign in first. A session that ends later (new password) reloads the page.
          if (!(await api.session()).signed_in) {
            if (!cancelled) setBoot("login");
            return;
          }
          setSignedOutHandler(() => location.reload());
          startBrowserHeartbeat();
        }
        // The project list (shared by every device) before anything adds to it.
        await loadProjects().catch(() => {});
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
        // After an app update: what's new, with the engine and model downloads the release offers
        // (they can be postponed there). Closing it goes on with afterStartScreens.
        const whatsNew = cfg.setupComplete && whatsNewDue(ui, st?.engine);
        // Otherwise, once on a Mac: Kokon's Mac engine (before the model loads, on the engine chosen).
        const macOffer = !inBrowser && welcomeSeen && !whatsNew && macEngineOfferDue(st, ui, cfg.setupComplete);
        setState({ needsSetup: !cfg.setupComplete, ...(!welcomeSeen ? { overlay: "welcome" } : whatsNew ? { overlay: "whats-new" } : macOffer ? { overlay: "mac-engine" } : {}) });
        setBoot("ok");
        if (!inBrowser) autoCheckForUpdate();
        // Own model files that run but don't suit Kokon's 8 steps (the base model instead of Turbo).
        if (cfg.setupComplete && !inBrowser)
          api.models().then((m) => {
            const w = m.active.source === "user" ? m.slots.find((x) => x.role === "diffusion")?.info?.warning : null;
            if (w) toastError(new ApiError({ code: "model_warning", message: w, suggestion: "Settings → Models: download the official files, or use other files of your own." }, 200));
          }, () => {});
        // Preload the model so the first generation starts immediately. After What's new or the Mac offer instead
        // (afterStartScreens): not a file or engine about to be replaced, and on the engine the user picks.
        if (cfg.setupComplete && !whatsNew && !macOffer && st && st.server.state === "stopped") api.startBackend().then(refreshStatus, () => refreshStatus());
      } catch (e) {
        setBoot(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Browser: files dropped from this device are uploaded.
  useEffect(() => {
    if (!inBrowser) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const all = Array.from(e.dataTransfer?.files ?? []);
      const files = all.filter((f) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name));
      if (files.length) uploadFiles(files);
      else if (all.length) toastInfo("Only image files can be added.");
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // Native file drops (paths) — efficient: the service reads the files itself.
  useEffect(() => {
    if (inBrowser) return;
    // The listener arrives asynchronously: if the effect was already cleaned up (StrictMode's
    // second mount in development), drop it at once instead of keeping two that add each image twice.
    let un: (() => void) | undefined;
    let gone = false;
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
      .then((u) => (gone ? u() : (un = u)))
      .catch(() => {});
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  // Clipboard paste: browser image data first, native clipboard as a fallback.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (getState().overlay) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
        return;
      }
      if (e.clipboardData?.getData("text")) return;
      try {
        const png = await native.readClipboardImage();
        if (png) uploadFiles([new File([png as BlobPart], "pasted.png", { type: "image/png" })]);
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

  if (boot === "login") {
    return (
      <div className="app" style={{ display: "grid", placeItems: "center" }}>
        <Login
          onSignedIn={() => {
            setBoot("connecting");
            setAttempt((n) => n + 1);
          }}
        />
      </div>
    );
  }

  if (boot !== "ok") {
    return (
      <div className="app" style={{ display: "grid", placeItems: "center" }}>
        <BareTitleBar />
        {boot === "connecting" ? (
          <BootSplash />
        ) : (
          <div className="failed">
            <strong>{inBrowser ? "Could not reach Kokon" : "Could not start the local service"}</strong>
            <span>{boot}</span>
            <button className="btn" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }

  // Settings and the other dialogs, over either layout.
  const dialogs = (
    <>
      {overlay === "settings" && <SettingsDialog />}
      {overlay === "welcome" && <Welcome />}
      {overlay === "whats-new" && <WhatsNew />}
      {overlay === "mac-engine" && <MacEngineOffer />}
      {overlay === "prompt-tips" && <PromptTips />}
      {overlay === "shortcuts" && <Shortcuts />}
      {overlay === "ai-check" && <AiCheck />}
      {compareUpscalers && <UpscalerCompare />}
    </>
  );

  // A phone: its own layout (components/PhoneApp.tsx); setup keeps the usual one.
  if (narrow && !needsSetup) {
    return (
      <div className="app phone">
        <PhoneApp />
        {dialogs}
        <Toasts />
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
          {overlay === "layers" && <LayersEditor />}
          {dragging && <div className="drop-hint">{editing ? "Drop to add as a reference image" : "Drop an image to start editing it"}</div>}
        </div>
        {!needsSetup && overlay !== "inpaint" && overlay !== "expand" && overlay !== "gallery" && <Composer />}
      </div>
      {dialogs}
      <Tour />
      <Toasts />
    </div>
  );
}
