// The top bar: the project's title, then undo/redo, the update pill, the status capsule,
// private mode, shortcuts and (only while the sidebar is hidden) Settings, then the window's
// buttons. Its own file so the launch video (marketing/video) shows the same bar.
import { ArrowDownToLine, CircleHelp, EyeOff, PanelLeft, Redo2, Settings, SquarePen, Undo2 } from "lucide-react";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { shortcut } from "../lib/platform";
import { getState, isMissingModel, newProject, openModelSetup, redoVersion, refreshStatus, setPrivateMode, setState, toastError, undoKey, undoVersion, useStore } from "../lib/store";
import { installUpdate } from "../lib/updates";
import { SilkSpin } from "./Cocoon";
import { ProjectTitle, Wordmark } from "./Sidebar";
import { WindowControls } from "./TitleBar";
import { IconButton } from "./ui";

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
        title = isMissingModel(server.error) ? "Find or download the missing file" : "Open Diagnostics";
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
        if (server.state === "error" && isMissingModel(server.error)) openModelSetup();
        else if (server.state === "error") setState({ overlay: "settings" });
        else if (server.state === "stopped" && connected) api.startBackend().then(refreshStatus, toastError);
      }}
    >
      {cls === "dot busy" || (cls === "dot ready" && busy) ? <SilkSpin size={18} /> : <span className={cls} />}
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

export function TopBar() {
  const overlay = useStore((s) => s.overlay);
  const needsSetup = useStore((s) => s.needsSetup);
  const sidebar = useStore((s) => s.sidebar);
  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        {(!sidebar || needsSetup) && <Wordmark />}
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
      <div className="toolbar" data-tauri-drag-region>
        {!needsSetup && <HistoryButtons />}
        <UpdatePill />
        <StatusIndicator />
        {!needsSetup && <PrivateToggle />}
        <IconButton title="Shortcuts (?)" onClick={() => setState({ overlay: "shortcuts" })}>
          <CircleHelp size={18} />
        </IconButton>
        {/* Settings lives at the foot of the sidebar; here only while the sidebar is hidden. */}
        {(!sidebar || needsSetup) && (
          <IconButton title="Settings" onClick={() => setState({ overlay: "settings" })}>
            <Settings size={18} />
          </IconButton>
        )}
      </div>
      <WindowControls />
    </div>
  );
}
