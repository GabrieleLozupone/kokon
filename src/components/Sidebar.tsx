import { Check, Images, PanelLeftClose, Pencil, Settings, SquarePen, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { urls } from "../lib/api";
import { timeAgo } from "../lib/logic";
import { native } from "../lib/native";
import { deleteProject, deleteProjects, newProject, renameProject, setState, switchProject, useStore } from "../lib/store";
import { IconButton, NameField } from "./ui";
import { KokonMark } from "./Welcome";

/** The Kokon mark and name: the sidebar's head, and the top bar's while the sidebar is hidden. */
export function Wordmark() {
  return (
    <span className="wordmark" data-tauri-drag-region>
      <KokonMark size={18} />
      Kokon
    </span>
  );
}

/** Navigation: start something new, browse every image, or go back to a project. "Select"
 * (or Ctrl/⌘-click, Shift-click for a range) picks several projects to remove at once. */
export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.projectId);
  const empty = useStore((s) => s.session.length === 0);
  const overlay = useStore((s) => s.overlay);
  const gallery = overlay === "gallery";
  const [renaming, setRenaming] = useState<string | null>(null);
  // Selection: null = off; otherwise the picked project ids (and the last one clicked, for Shift).
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const selecting = picked !== null;

  // Esc leaves the selection; projects that are gone leave it too.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPicked(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selecting]);
  useEffect(() => {
    if (!picked) return;
    const ids = new Set(projects.map((p) => p.id));
    if ([...picked].some((id) => !ids.has(id))) setPicked(new Set([...picked].filter((id) => ids.has(id))));
  }, [projects, picked]);

  const toggle = (id: string, range: boolean) => {
    const next = new Set(picked ?? []);
    if (range && anchor) {
      const a = projects.findIndex((p) => p.id === anchor);
      const b = projects.findIndex((p) => p.id === id);
      if (a >= 0 && b >= 0) for (const p of projects.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(p.id);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    setAnchor(id);
  };

  const removePicked = async () => {
    if (!picked?.size) return;
    const n = picked.size;
    const ok = await native.confirm(`Remove ${n} ${n === 1 ? "project" : "projects"} from the list? Their images stay in All images.`, "Remove projects");
    if (!ok) return;
    deleteProjects([...picked]);
    setPicked(null);
  };

  return (
    <aside className={`sidebar ${selecting ? "selecting" : ""}`}>
      <div className="side-head" data-tauri-drag-region>
        <Wordmark />
        <IconButton title="Hide sidebar" onClick={() => setState({ sidebar: false })}>
          <PanelLeftClose size={18} />
        </IconButton>
      </div>
      <nav className="side-nav">
        <button className={`side-item ${empty && !gallery ? "on" : ""}`} onClick={newProject}>
          <SquarePen size={16} /> New image
        </button>
        <button className={`side-item ${gallery ? "on" : ""}`} onClick={() => setState({ overlay: gallery ? null : "gallery" })}>
          <Images size={16} /> All images
        </button>
      </nav>
      {projects.length > 0 && (
        <div className="side-label">
          <span>Projects</span>
          <button className="side-select" onClick={() => setPicked(selecting ? null : new Set())} title={selecting ? "Stop selecting (Esc)" : "Select several projects to remove them at once (or Ctrl/⌘-click)"}>
            {selecting ? "Done" : "Select"}
          </button>
        </div>
      )}
      <div className="side-list">
        {projects.map((p) => {
          const on = picked?.has(p.id) ?? false;
          return (
            <div
              key={p.id}
              role={selecting ? "checkbox" : "button"}
              aria-checked={selecting ? on : undefined}
              tabIndex={0}
              className={`proj ${p.id === current && !gallery && !selecting ? "on" : ""} ${on ? "picked" : ""}`}
              onClick={(e) => {
                if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) toggle(p.id, e.shiftKey);
                else switchProject(p.id);
              }}
              onDoubleClick={() => !selecting && setRenaming(p.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (selecting) toggle(p.id, e.shiftKey);
                  else switchProject(p.id);
                } else if (e.key === "F2" && !selecting) setRenaming(p.id);
                else if ((e.key === "Delete" || e.key === "Backspace") && selecting) removePicked();
              }}
              title={selecting ? p.title : `${p.title}\nDouble-click or F2 to rename · Ctrl/⌘-click to select several`}
            >
              <span className="cover">
                {p.cover && <img src={urls.sourceThumb(p.cover)} alt="" draggable={false} loading="lazy" />}
                {selecting && <span className="pick-mark">{on && <Check size={13} strokeWidth={3} />}</span>}
              </span>
              <span className="proj-text">
                {renaming === p.id ? (
                  <NameField value={p.title} onSave={(v) => renameProject(p.id, v)} onDone={() => setRenaming(null)} />
                ) : (
                  <span className="proj-title">{p.title}</span>
                )}
                <span className="proj-sub">
                  {p.count} {p.count === 1 ? "image" : "images"} · {timeAgo(p.updatedAt)}
                </span>
              </span>
              {!selecting && (
                <>
                  <button
                    className="proj-rm"
                    title="Rename"
                    aria-label="Rename project"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming(p.id);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="proj-rm"
                    title="Remove from list (images stay in All images)"
                    aria-label="Remove project"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteProject(p.id);
                    }}
                  >
                    <X size={14} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {selecting && (
        <div className="select-bar">
          <span className="select-count">{picked.size ? `${picked.size} selected` : "Pick projects"}</span>
          <button className="link-btn" onClick={() => setPicked(picked.size === projects.length ? new Set() : new Set(projects.map((p) => p.id)))}>
            {picked.size === projects.length ? "None" : "All"}
          </button>
          <span className="spacer" />
          <button className="btn small danger" disabled={!picked.size} onClick={removePicked} title="Remove from the list; the images stay in All images">
            <Trash2 size={13} /> Remove
          </button>
          <IconButton title="Cancel (Esc)" onClick={() => setPicked(null)}>
            <X size={15} />
          </IconButton>
        </div>
      )}
      <div className="side-foot">
        <button className={`side-item settings ${overlay === "settings" ? "on" : ""}`} onClick={() => setState({ overlay: "settings" })}>
          <Settings size={18} /> Settings
        </button>
      </div>
    </aside>
  );
}

/** The open project's name in the top bar; click to rename (also before the first image). */
export function ProjectTitle() {
  const id = useStore((s) => s.projectId);
  const meta = useStore((s) => s.projects.find((p) => p.id === s.projectId));
  const [editing, setEditing] = useState(false);
  if (editing) return <NameField className="title-field" value={meta?.title ?? ""} onSave={(v) => renameProject(id, v)} onDone={() => setEditing(false)} />;
  return (
    <button className={`project-title ${meta ? "" : "placeholder"}`} title="Rename project" onClick={() => setEditing(true)}>
      {meta?.title ?? "Untitled project"}
      <Pencil size={13} className="title-pencil" />
    </button>
  );
}
