// Kokon on a phone (a browser on another device): the library of projects, and a project's screen
// with its image, versions and prompt. Laid out for an iPhone (safe areas, large round corners,
// sheets from the bottom); App.tsx shows it on screens up to 720 px wide (platform.ts isNarrow).

import { PhotoReview } from "./PhotoReview";
import { StatusTint } from "./StatusTint";
import { Check, ChevronLeft, EyeOff, Plus, Settings, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { urls } from "../lib/api";
import { haptic } from "../lib/haptics";
import { projectTitle, timeAgo } from "../lib/logic";
import { native } from "../lib/native";
import { deleteProject, deleteProjects, newProject, renameProject, setState, switchProject, useStore, type ProjectMeta } from "../lib/store";
import { Composer } from "./Composer";
import { DevelopImg } from "./Develop";
import { ExpandEditor } from "./ExpandEditor";
import { Gallery } from "./Gallery";
import { InpaintEditor } from "./InpaintEditor";
import { ProjectTitle } from "./Sidebar";
import { Stage } from "./Stage";
import { StatusIndicator, togglePrivateMode } from "./TopBar";
import { KokonMark } from "./Welcome";

/** The layout follows the visible part of the screen: when the keyboard opens, the app shrinks
 * above it (iOS keeps the page's height and slides it up instead), so the prompt and the image
 * stay in view. `--vv-h` / `--vv-top` feed `.phone-app`; `keyboard` on <html> while it is open. */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    // The keyboard is up when the visible height is well under the tallest seen in this
    // orientation (iOS shrinks innerHeight with it, so that can't be the reference).
    let tallest = 0;
    const turned = () => (tallest = 0);
    const set = () => {
      // Pinch zoom also shrinks the visual viewport: only follow it at 100 %.
      if (Math.abs(vv.scale - 1) > 0.01) return;
      tallest = Math.max(tallest, vv.height);
      root.style.setProperty("--vv-h", `${vv.height}px`);
      root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
      root.classList.toggle("keyboard", tallest - vv.height > 150);
    };
    set();
    vv.addEventListener("resize", set);
    vv.addEventListener("scroll", set);
    window.addEventListener("orientationchange", turned);
    return () => {
      vv.removeEventListener("resize", set);
      vv.removeEventListener("scroll", set);
      window.removeEventListener("orientationchange", turned);
      root.style.removeProperty("--vv-h");
      root.style.removeProperty("--vv-top");
      root.classList.remove("keyboard");
    };
  }, []);
}

export function PhoneApp() {
  const overlay = useStore((s) => s.overlay);
  // On a phone the sidebar's place is the library, a screen of its own.
  const library = useStore((s) => s.sidebar) || overlay === "gallery";
  useVisualViewport();
  // No Layers lab on a phone (a window narrowed with it open): its layers are only looked at.
  useEffect(() => {
    if (overlay === "layers") setState({ overlay: null });
  }, [overlay]);
  return (
    <div className="phone-app">
      {library ? <Library /> : <ProjectScreen />}
      {overlay === "inpaint" && <InpaintEditor />}
      {overlay === "expand" && <ExpandEditor />}
      <PhotoReview />
      <StatusTint />
    </div>
  );
}

function ProjectScreen() {
  const overlay = useStore((s) => s.overlay);
  const privateMode = useStore((s) => s.privateMode);
  return (
    <div className="phone-screen project">
      <header className="phone-top">
        <button className="glass-btn" title="Projects" aria-label="Projects" onClick={() => setState({ sidebar: true })}>
          <ChevronLeft size={24} strokeWidth={2.2} />
        </button>
        <div className="phone-title">
          <ProjectTitle />
          {privateMode && (
            <button className="private-tag" onClick={togglePrivateMode} title="Private mode is on: tap to turn it off">
              <EyeOff size={12} /> Private
            </button>
          )}
        </div>
        <div className="phone-top-end">
          <StatusIndicator quiet />
          <button className="glass-btn" title="New image" aria-label="New image" onClick={newProject}>
            <SquarePen size={19} />
          </button>
        </div>
      </header>
      <div className="main">
        <Stage />
      </div>
      {overlay !== "inpaint" && overlay !== "expand" && <Composer />}
    </div>
  );
}

/** A sheet from the bottom of the screen, over a scrim that closes it. */
function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="popover sheet" role="dialog">
        {children}
      </div>
    </>,
    document.body,
  );
}

/** Press and hold (or a right click): `onHold`; the click that ends a hold is swallowed. */
function useLongPress(onHold: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      held.current = false;
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      timer.current = window.setTimeout(() => {
        held.current = true;
        onHold();
      }, 460);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.touches[0].clientX - s.x, e.touches[0].clientY - s.y) > 8) cancel();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      cancel();
      // The finger lifting after a hold would click whatever opened under it (the sheet's scrim).
      if (held.current) {
        e.preventDefault();
        // Here, not when the hold fires: iOS plays it only inside a touch's own handler.
        haptic();
      }
    },
    onTouchCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (!held.current) onHold();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!held.current) return;
      held.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}

/** The phone's home: the projects (or every image), private mode and Settings. */
function Library() {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const privateMode = useStore((s) => s.privateMode);
  const overlay = useStore((s) => s.overlay);
  const images = overlay === "gallery";
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [menu, setMenu] = useState<ProjectMeta | null>(null);
  const selecting = picked !== null;

  // "Open in project" in All images leaves the gallery: the library closes onto that project.
  const switchingTab = useRef(false);
  const wasImages = useRef(images);
  useEffect(() => {
    if (wasImages.current && !images && !switchingTab.current) setState({ sidebar: false });
    switchingTab.current = false;
    wasImages.current = images;
  }, [images]);

  const showTab = (img: boolean) => {
    if (img === images) return;
    haptic();
    switchingTab.current = true;
    setPicked(null);
    setState({ overlay: img ? "gallery" : null, sidebar: true });
  };
  const open = (id: string) => {
    switchProject(id);
    setState({ sidebar: false });
  };
  const toggle = (id: string) => {
    const next = new Set(picked ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const removePicked = async () => {
    if (!picked?.size) return;
    const n = picked.size;
    if (!(await native.confirm(`Remove ${n} ${n === 1 ? "project" : "projects"} from the list? Their images stay in All images.`, "Remove projects"))) return;
    deleteProjects([...picked]);
    setPicked(null);
  };

  return (
    <div className={`phone-screen library ${images ? "images" : ""}`}>
      <header className="lib-head">
        <div className="lib-title-row">
          <h1>
            <KokonMark size={22} />
            Kokon
          </h1>
          {!images && projects.length > 0 && (
            <button className="lib-text-btn" onClick={() => setPicked(selecting ? null : new Set())}>
              {selecting ? "Done" : "Select"}
            </button>
          )}
          <button className={`glass-btn ${privateMode ? "on" : ""}`} title={privateMode ? "Private mode is on: tap to turn it off" : "Private mode: nothing is saved"} aria-label="Private mode" aria-pressed={privateMode} onClick={togglePrivateMode}>
            <EyeOff size={19} />
          </button>
          <button className="glass-btn" title="Settings" aria-label="Settings" onClick={() => setState({ overlay: "settings" })}>
            <Settings size={19} />
          </button>
        </div>
        <div className="seg lib-seg" role="tablist">
          <button role="tab" aria-selected={!images} className={images ? "" : "on"} onClick={() => showTab(false)}>
            Projects
          </button>
          <button role="tab" aria-selected={images} className={images ? "on" : ""} onClick={() => showTab(true)}>
            All images
          </button>
        </div>
      </header>
      <div className="lib-body">
        {images ? (
          <Gallery />
        ) : (
          <div className="lib-scroll">
            {privateMode && (
              <div className="lib-private">
                <EyeOff size={18} />
                <span>
                  <strong>Private mode is on</strong>
                  Images are not saved, and are deleted when you turn it off.
                </span>
                <button className="lib-text-btn" onClick={togglePrivateMode}>
                  Turn off
                </button>
              </div>
            )}
            {projects.length === 0 ? (
              <div className="lib-empty">
                <strong>No projects yet</strong>
                <span>Each image you make or bring in starts one; its versions stay together.</span>
              </div>
            ) : (
              <div className="lib-grid">
                {projects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    p={p}
                    current={p.id === current && !selecting}
                    picked={selecting ? picked.has(p.id) : null}
                    onOpen={() => (selecting ? toggle(p.id) : open(p.id))}
                    onHold={() => (selecting ? toggle(p.id) : setMenu(p))}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {!images &&
        (selecting ? (
          <div className="lib-dock select">
            <span className="select-count">{picked.size ? `${picked.size} selected` : "Tap projects to select"}</span>
            <button className="btn danger" disabled={!picked.size} onClick={removePicked}>
              <Trash2 size={15} /> Remove
            </button>
          </div>
        ) : (
          <div className="lib-dock">
            <button
              className="lib-new"
              onClick={() => {
                newProject();
                setState({ sidebar: false });
              }}
            >
              <Plus size={20} strokeWidth={2.4} /> New image
            </button>
          </div>
        ))}
      {menu && <ProjectSheet p={menu} onOpen={() => (setMenu(null), open(menu.id))} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ProjectCard({ p, current, picked, onOpen, onHold }: { p: ProjectMeta; current: boolean; picked: boolean | null; onOpen: () => void; onHold: () => void }) {
  const press = useLongPress(onHold);
  return (
    <button className={`lib-card ${current ? "current" : ""} ${picked ? "picked" : ""}`} onClick={onOpen} {...press} aria-pressed={picked ?? undefined}>
      <span className="lib-cover">
        {p.cover && <DevelopImg src={urls.sourceThumb(p.cover)} lazy />}
        {picked !== null && <span className="pick-mark">{picked && <Check size={14} strokeWidth={3} />}</span>}
      </span>
      <span className="lib-card-title">{projectTitle(p.title)}</span>
      <span className="lib-card-sub">{timeAgo(p.updatedAt)}</span>
    </button>
  );
}

/** A project held down: its name (edit it in place), open, remove. */
function ProjectSheet({ p, onOpen, onClose }: { p: ProjectMeta; onOpen: () => void; onClose: () => void }) {
  const [name, setName] = useState(p.title);
  const save = () => {
    if (name.trim() && name.trim() !== p.title) renameProject(p.id, name);
  };
  return (
    <Sheet
      onClose={() => {
        save();
        onClose();
      }}
    >
      <div className="sheet-head">
        <span className="sheet-cover">{p.cover && <img src={urls.sourceThumb(p.cover)} alt="" draggable={false} />}</span>
        <label className="sheet-name">
          <span>Name</span>
          <input
            className="input"
            value={name}
            maxLength={120}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          />
        </label>
      </div>
      <button className="opt" onClick={onOpen}>
        <span className="check">
          <ChevronLeft size={17} style={{ transform: "scaleX(-1)" }} />
        </span>
        <span>Open</span>
      </button>
      <button
        className="opt danger"
        onClick={() => {
          onClose();
          deleteProject(p.id);
        }}
      >
        <span className="check">
          <X size={17} />
        </span>
        <span>Remove from list</span>
        <span className="sub">Images stay in All images</span>
      </button>
    </Sheet>
  );
}
