// Layers lab in the project: once an image has been split, the project shows its layered image
// (one frame per split image in the version strip, the composite on the Stage) instead of the lab's
// own versions; clicking it opens that image's layers.

import { Layers, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { docId, docsVersion, jobLayer, waitingMarks, labItems, leftovers, loadLab, saveLab, subscribeDocs, type LabStore, type LayerDoc } from "../lib/layerDoc";
import { editSource, itemOrigin, itemSource, removeSessionItem, setState, useStore, type SessionItem } from "../lib/store";
import type { JobView } from "../lib/types";
import { urls } from "../lib/api";
import { useJobPercent } from "./jobMotion";
import { renderDoc } from "./LayerDoc";

/** Opens `doc`'s layers: the prompt goes to its photo (or one of its layers), which picks the
 * document (LayersEditor). */
export function openLab(doc: LayerDoc) {
  if (!(doc.photo && editSource(doc.photo, false))) doc.layers.some((l) => editSource(l.source, false));
  setState({ overlay: "layers" });
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The open project's lab (its documents), and the versions that belong to a lab: key -> document
 * id (null: an earlier lab's leftover, hidden too). */
export function useLab(): Lab {
  const projectId = useStore((s) => s.projectId);
  const session = useStore((s) => s.session);
  const v = useSyncExternalStore(subscribeDocs, docsVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => loadLab(projectId), [projectId, v]);
  // Once per project: leftovers of a lab whose document was replaced before documents were kept
  // per image (found by the names the lab gives its images).
  useEffect(() => {
    if (store.swept || !session.some((i) => i.input || i.gen)) return;
    const found = leftovers(session.map((i) => ({ source: itemSource(i), name: i.input?.original_name ? decode(i.input.original_name) : null, input: i.kind === "input" })));
    saveLab(projectId, { ...store, made: [...new Set([...store.made, ...found])], swept: true });
  }, [store, session, projectId]);
  const hidden = useMemo(
    () =>
      labItems(
        store,
        session.map((i) => ({ key: i.key, source: itemSource(i), from: itemOrigin(i).from[0] ?? null, mask: i.gen?.mask_input_id ?? i.request?.mask?.replace(/^input:/, "") ?? null })),
      ),
    [store, session],
  );
  return { store, hidden };
}

export const docById = (lab: Lab, id: string | null | undefined) => (id ? lab.store.docs.find((d) => docId(d) === id) ?? null : null);

/** The layered image as an object URL (redrawn when a layer changes; the old one stays until then). */
export function useLabImage(doc: LayerDoc | null, maxSide: number): string | null {
  const key = doc ? JSON.stringify([doc.width, doc.height, doc.layers.map((l) => [l.source, l.hidden, l.dx, l.dy, l.s, l.follows, l.at])]) : "";
  const [url, setUrl] = useState<string | null>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    let gone = false;
    renderDoc(doc, maxSide)
      .then((c) => new Promise<Blob | null>((res) => c.toBlob(res, "image/png")))
      .then((b) => {
        if (gone || !b) return;
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = URL.createObjectURL(b);
        setUrl(shown.current);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, maxSide]);
  useEffect(() => () => void (shown.current && URL.revokeObjectURL(shown.current)), []);
  return url;
}

export type Lab = { store: LabStore; hidden: Map<string, string | null> };
export interface LabJob {
  item: SessionItem;
  job: JobView;
  doc: LayerDoc;
  /** jobLayer's answer: a layer id, "shadows", or null. */
  layer: string | null;
}

/** The lab's edits being made, or failed (the Stage's job card and the version strip do not show
 * them: they are lab versions). */
export function useLabJobs(lab: Lab): LabJob[] {
  const session = useStore((s) => s.session);
  const jobs = useStore((s) => s.jobs);
  return useMemo(
    () =>
      session.flatMap((i) => {
        const job = i.kind === "job" && i.jobId ? jobs[i.jobId] : undefined;
        const doc = docById(lab, lab.hidden.get(i.key));
        if (!job || !doc || job.status === "done" || job.status === "cancelled") return [];
        return [{ item: i, job, doc, layer: jobLayer(doc, i.request?.images?.[0], i.request?.mask?.replace(/^input:/, "")) }];
      }),
    [lab, session, jobs],
  );
}

const PHASE: Partial<Record<JobView["status"], string>> = { queued: "Waiting", starting_backend: "Starting the engine", enhancing_prompt: "Writing the prompt" };

/** The edit's percentage, the same as its job card's. */
export function JobPct({ job, item }: { job: JobView; item: SessionItem }) {
  const { pct } = useJobPercent(job, item.request);
  return <>{Math.floor(pct)}%</>;
}

function JobPill({ j }: { j: LabJob }) {
  const layer = j.doc.layers.find((l) => l.id === j.layer);
  const auto = j.layer === "scene" ? j.doc.scenes?.find((e) => e.one && e.source === j.item.request?.images?.[0]) : undefined;
  const what = auto?.blend ? "the blend" : j.layer === "shadows" || auto ? "the shadows" : j.layer === "scene" ? "the scene" : layer ? (layer.base ? "the background" : layer.name) : "";
  if (j.job.status === "failed")
    return (
      <span className="lab-progress failed" title={j.job.error?.detail ?? undefined}>
        {what ? `${what}: ` : ""}
        {j.job.error?.message ?? "the edit failed"}
        <button className="lab-dismiss" title="Dismiss" onClick={() => removeSessionItem(j.item.key)}>
          <X size={13} />
        </button>
      </span>
    );
  return (
    <span className="lab-progress">
      <Loader2 className="spin" size={13} />
      {PHASE[j.job.status] ? `${PHASE[j.job.status]}${what ? ` · ${what}` : ""}` : `Generating${what ? ` ${what}` : ""}`} · <JobPct job={j.job} item={j.item} />
    </span>
  );
}

/** "Generating the background · 38%": the lab edits in progress (or failed) of `doc`. */
export function LabJobs({ lab, doc, className }: { lab: Lab; doc: LayerDoc; className?: string }) {
  const list = useLabJobs(lab).filter((j) => docId(j.doc) === docId(doc));
  if (!list.length) return null;
  return (
    <div className={`lab-jobs ${className ?? ""}`}>
      {list.map((j) => (
        <JobPill key={j.item.key} j={j} />
      ))}
    </div>
  );
}

/** The Stage while a lab version is selected: the layered image to look at; its button opens the lab. */
export function LabFrame({ doc, lab }: { doc: LayerDoc; lab: Lab }) {
  const url = useLabImage(doc, 1600);
  return (
    <div className="stage-frame">
      <LabJobs lab={lab} doc={doc} className="on-stage" />
      <div className="lab-frame" style={{ aspectRatio: `${doc.width} / ${doc.height}` }}>
        {url ? <img src={url} alt="The layered image" draggable={false} /> : <Loader2 className="spin" size={22} />}
        {/* The pencil's marks sent for new objects, until the objects are there. */}
        {url && waitingMarks(doc).map((m) => <img key={m} className="lab-marks" src={urls.input(m)} alt="" draggable={false} />)}
        <button className="lab-open" onClick={() => openLab(doc)} title="Open this image's layers in the Layers lab">
          <Layers size={14} /> Open Layers lab
        </button>
      </div>
    </div>
  );
}

/** The version strip's frame for the lab (with the percentage of an edit being made). */
export function LabThumb({ doc, job }: { doc: LayerDoc; job?: LabJob }) {
  const url = useLabImage(doc, 160);
  const making = job && job.job.status !== "failed";
  return (
    <>
      {url && <img className={making ? "dim" : ""} src={url} alt="" draggable={false} />}
      {making && (
        <span className="frame-pct">
          <JobPct job={job.job} item={job.item} />
        </span>
      )}
    </>
  );
}
