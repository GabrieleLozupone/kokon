import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowDownToLine, EyeOff, PanelLeft, Redo2, Settings, SquarePen, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, configure } from "./lib/api";
import { native } from "./lib/native";
import {
  addExampleProjects, addInputs, dismissToast, getState, newProject, redoVersion, refreshStatus, selectItem, setPrivateMode, setState, startEvents, startTour, submitComposer, toastError, toastInfo, undoKey, undoVersion, useStore,
} from "./lib/store";
import { Composer, importPaths } from "./components/Composer";
import { ExpandEditor } from "./components/ExpandEditor";
import { Gallery } from "./components/Gallery";
import { InpaintEditor } from "./components/InpaintEditor";
import { Settings as SettingsDialog } from "./components/Settings";
import { Setup } from "./components/Setup";
import { ProjectTitle, Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { Tour } from "./components/Tour";
import { IconButton } from "./components/ui";
import { shortcut } from "./lib/platform";
import { PromptTips } from "./components/PromptTips";
import { WhatsNew, whatsNewDue } from "./components/WhatsNew";
import { UpscalerCompare } from "./components/Upscalers";
import { KokonMark, Welcome } from "./components/Welcome";
import { autoCheckForUpdate, installUpdate } from "./lib/updates";
import type { GenerationRecord } from "./lib/types";

const isTauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?|heic|heif)$/i;

function StatusIndicator() {
  const connected = useStore((s) => s.connected);
  const server = useStore((s) => s.server);
  const busy = useStore((s) => Object.values(s.jobs).some((j) => !["done", "failed", "cancelled"].includes(j.status)));
  let cls = "dot";
  let text = "Connecting";
  let title = "";
  if (connected) {
    switch (server.state) {
      case "ready":
        cls = "dot ready";
        text = busy ? "Working" : "Ready";
        title = server.owned ? "Model loaded" : "Using an inference server that was already running";
        break;
      case "starting":
        cls = "dot busy";
        text = "Loading model";
        break;
      case "error":
        cls = "dot error";
        text = server.error?.message ?? "Inference server error";
        title = "Open Diagnostics";
        break;
      default:
        text = "Model not loaded";
        title = "Click to load the model now";
    }
  }
  return (
    <button
      className="status"
      title={title}
      onClick={() => {
        if (server.state === "error") setState({ overlay: "settings" });
        else if (server.state === "stopped" && connected) api.startBackend().then(refreshStatus, toastError);
      }}
    >
      <span className={cls} />
      <span style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </button>
  );
}

/** Undo / Redo between versions: back to the image the current one was made from. */
function HistoryButtons() {
  const canUndo = useStore((s) => undoKey(s) !== null);
  const canRedo = useStore((s) => s.redo.length > 0);
  if (!canUndo && !canRedo) return null;
  return (
    <>
      <IconButton title={`Undo: back to the previous version (${shortcut("Z")})`} onClick={undoVersion} disabled={!canUndo}>
        <Undo2 size={18} />
      </IconButton>
      <IconButton title={`Redo (${shortcut("Y")})`} onClick={redoVersion} disabled={!canRedo}>
        <Redo2 size={18} />
      </IconButton>
    </>
  );
}

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

/** "Update" pill in the top bar once a newer release is found; one click installs it. */
function UpdatePill() {
  const update = useStore((s) => s.update);
  if (!update) return null;
  const busy = update.phase !== "available";
  const click = async () => {
    const running = Object.values(getState().jobs).some((j) => !["done", "failed", "cancelled"].includes(j.status));
    const msg = `Install Kokon ${update.version} now? Kokon closes and restarts in a few seconds${running ? "; the images being made now are stopped" : ""}. Your images, settings and models stay.`;
    if (await native.confirm(update.notes ? `${msg}

What's new:
${update.notes}` : msg, "Update Kokon")) installUpdate();
  };
  const label =
    update.phase === "downloading" ? `Downloading${update.progress != null ? ` ${Math.round(update.progress * 100)}%` : "…"}` : update.phase === "installing" ? "Installing…" : `Update to ${update.version}`;
  return (
    <button className="update-pill" onClick={click} disabled={busy} title={`Kokon ${update.version} is available`}>
      <ArrowDownToLine size={14} /> {label}
    </button>
  );
}

function PrivateToggle() {
  const on = useStore((s) => s.privateMode);
  const toggle = () => setPrivateMode(!on, () => native.confirm("Turn off private mode? The images made in private mode will be deleted.", "Private mode"));
  return on ? (
    <button className="private-pill" onClick={toggle} title="Private mode is on: images are not saved and are deleted when you turn it off or close the app. Click to turn it off.">
      <EyeOff size={15} /> Private
    </button>
  ) : (
    <IconButton title="Private mode: nothing is saved to the gallery or your Pictures folder" onClick={toggle}>
      <EyeOff size={18} />
    </IconButton>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="toasts" role="status">
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
        if (!isTauri) {
          // Running in browser dev mode outside Tauri shell:
          // Initialize interactive preview session with sample images so the full UI is visible & testable
          const sampleBase: GenerationRecord = {
            id: "/examples/cabin.jpg",
            prompt: "A cozy wooden cabin in the mountains",
            negative_prompt: "",
            model: "Qwen-Image-2.1-Turbo",
            sampler: "euler",
            scheduler: "turbo",
            steps: 8,
            cfg: 1.0,
            strength: null,
            seed: 41,
            width: 1600,
            height: 893,
            working_width: 1600,
            working_height: 893,
            file_path: "/examples/cabin.jpg",
            mode: "generate",
            favorite: false,
            notes: [],
            duration_ms: 1100,
            created_at: new Date().toISOString(),
            quality: "fast",
            resolution: "auto",
            mask_input_id: null,
            outpaint: null,
            extra_paths: [],
            parent_id: null,
            request: null,
            pipeline: null,
            references: [],
          };

          const sampleGen: GenerationRecord = {
            id: "/examples/cabin-winter.jpg",
            prompt: "A cozy wooden cabin during a serene winter snowfall",
            negative_prompt: "",
            model: "Qwen-Image-2.1-Turbo",
            sampler: "euler",
            scheduler: "turbo",
            steps: 8,
            cfg: 1.0,
            strength: null,
            seed: 42,
            width: 1600,
            height: 893,
            working_width: 1600,
            working_height: 893,
            file_path: "/examples/cabin-winter.jpg",
            mode: "edit",
            favorite: false,
            notes: [],
            duration_ms: 1250,
            created_at: new Date().toISOString(),
            quality: "fast",
            resolution: "auto",
            mask_input_id: null,
            outpaint: null,
            extra_paths: [],
            parent_id: null,
            request: null,
            pipeline: null,
            references: [
              {
                index: 0,
                input_id: "/examples/cabin.jpg",
                original_path: "/examples/cabin.jpg",
                width: 1600,
                height: 893,
              },
            ],
          };

          setState({
            needsSetup: false,
            projects: [
              {
                id: "p-cabin",
                title: "Cabin in Snow",
                named: true,
                updatedAt: Date.now(),
                cover: "/examples/cabin-winter.jpg",
                count: 2,
              },
            ],
            session: [
              { key: "base", kind: "gen", gen: sampleBase },
              { key: "edit", kind: "gen", gen: sampleGen },
            ],
            selected: "edit",
            compare: "slider",
            overlay: null,
            connected: true,
            server: {
              state: "ready",
              owned: true,
              error: null,
            },
          });
          setBoot("ok");
          return;
        }

        const conn = await native.connect();
        if (cancelled) return;
        configure(conn.baseUrl, conn.token);
        startEvents();
        const cfg = await api.config();
        const st = await refreshStatus();
        // First launch: the welcome screen, once (Settings → General shows it again).
        const ui = (cfg.ui ?? {}) as Record<string, unknown>;
        const welcomeSeen = !!ui.welcomeSeen;
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
    if (isTauri) {
      try {
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
      } catch {
        /* running outside Tauri */
      }
    }
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
        <div className="topbar">
          <div className="brand">
            {!sidebar && !needsSetup && (
              <>
                <IconButton title="Show sidebar" onClick={() => setState({ sidebar: true })}>
                  <PanelLeft size={18} />
                </IconButton>
                <IconButton title="New image" onClick={newProject}>
                  <SquarePen size={18} />
                </IconButton>
              </>
            )}
            {overlay === "gallery" ? <span className="project-title">All images</span> : !needsSetup && <ProjectTitle />}
          </div>
          <div className="toolbar">
            {!needsSetup && <HistoryButtons />}
            <UpdatePill />
            {!needsSetup && <PrivateToggle />}
            <StatusIndicator />
            <IconButton title="Settings" onClick={() => setState({ overlay: "settings" })}>
              <Settings size={18} />
            </IconButton>
          </div>
        </div>
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
      {compareUpscalers && <UpscalerCompare />}
      <Tour />
      <Toasts />
    </div>
  );
}
