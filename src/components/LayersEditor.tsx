// Layers lab (experimental): the layer document of the image being edited (LayerDoc.tsx; one per
// image of the project), else the split that makes one for it (LayerSplit.tsx). The document follows
// the edits made to its layers.

import { useEffect, useRef, useState } from "react";
import { docFor, docId, loadLab, putDoc, reconcile, saveLab, type DocLayer, type LayerDoc as Doc } from "../lib/layerDoc";
import { editSource, getState, itemOrigin, itemSource, toastError, toastInfo, useStore } from "../lib/store";
import { readScene } from "./LabScene";
import { LayerDoc, pasteCrop, shadowImage } from "./LayerDoc";
import { LayerSplit } from "./LayerSplit";

export function LayersEditor() {
  const projectId = useStore((s) => s.projectId);
  return <LayersLab key={projectId} projectId={projectId} />;
}

function LayersLab({ projectId }: { projectId: string }) {
  const session = useStore((s) => s.session);
  // The image the prompt edits picks the document: the one split from it or the one that made it.
  const [doc, setDoc] = useState<Doc | null>(() => docFor(loadLab(projectId), getState().composer.refs[0]?.source));
  const [splitting, setSplitting] = useState(false);

  const latest = useRef(doc);
  const making = useRef(new Set<string>());
  const update = (d: Doc) => {
    latest.current = d;
    // Saved into the project's lab as it is now (other documents, what earlier labs made).
    saveLab(projectId, putDoc(loadLab(projectId), d));
    setDoc(d);
  };

  // A shadow edit's result -> its shadow layer (a new one, or the next version of the one it redoes).
  useEffect(() => {
    if (!doc?.pending?.length) return;
    for (const p of doc.pending) {
      // Any painted edit of the image made for this shadow (the area may have been painted again).
      const done = session.find((i) => i.gen?.mask_input_id && itemOrigin(i).from[0] === p.source && !doc.known.includes(`gen:${i.gen.id}`));
      if (!done?.gen) continue;
      const result = `gen:${done.gen.id}`;
      if (making.current.has(result)) continue;
      making.current.add(result);
      const obj = p.of ? doc.layers.find((l) => l.id === p.of) : undefined;
      const name = obj ? `${obj.name} shadow` : "Shadows";
      shadowImage({ ...p, mask: done.gen.mask_input_id ?? p.mask }, result, doc.width, doc.height, name).then(
        (rec) => {
          const d = latest.current!;
          const src = `input:${rec.id}`;
          const known = [...d.known, result, src];
          const pending = (d.pending ?? []).map((x) => (x.source === p.source ? { ...x, layer: x.layer ?? `fx-${result}` } : x));
          const target = p.layer && d.layers.find((l) => l.id === p.layer);
          let layers: DocLayer[];
          if (target) layers = d.layers.map((l) => (l.id === target.id ? { ...l, source: src, history: [...l.history, src] } : l));
          else {
            const layer: DocLayer = { id: `fx-${result}`, name, source: src, history: [src], hidden: false, base: false, effect: true, follows: p.of ?? undefined, at: p.at, dx: 0, dy: 0, s: 1 };
            const at = obj ? d.layers.findIndex((l) => l.id === obj.id) + 1 : d.layers.findIndex((l) => l.base);
            layers = [...d.layers];
            layers.splice(at < 0 ? layers.length : at, 0, layer);
          }
          update({ ...d, layers, pending, known });
        },
        (e) => toastError(e),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, doc]);

  // A whole-image edit's result (Shadows, New objects, Edit together) -> read back into layers: new
  // objects at the top, each object's shadow just under it (following it), new looks as the
  // objects' next versions. The newest result of each edit; a later one makes the next versions of
  // the same layers.
  useEffect(() => {
    if (!doc?.scenes?.length) return;
    for (const e of doc.scenes) {
      const made = session.filter((i) => i.gen && itemOrigin(i).from[0] === e.source && !doc.known.includes(`gen:${i.gen.id}`));
      const done = made[made.length - 1];
      if (!done?.gen) continue;
      const result = `gen:${done.gen.id}`;
      if (making.current.has(result)) continue;
      making.current.add(result);
      readScene(doc, e, result).then(
        (r) => {
          const d = latest.current!;
          const seen = made.map((i) => `gen:${i.gen!.id}`);
          const madeBy = { ...(e.made ?? {}) };
          let layers = d.layers;
          const nextVersion = (id: string, src: string) => (layers = layers.map((l) => (l.id === id ? { ...l, source: src, history: [...l.history, src] } : l)));
          for (const o of r.objects) {
            const have = madeBy[o.colour] && layers.find((l) => l.id === madeBy[o.colour]);
            if (have) nextVersion(have.id, o.src);
            else {
              const id = `new-${result}-${o.colour}`;
              madeBy[o.colour] = id;
              layers = [{ id, name: o.name, source: o.src, history: [o.src], hidden: false, base: false, dx: 0, dy: 0, s: 1 }, ...layers];
            }
          }
          for (const s of r.shadows) {
            // Automatic shadows: the one layer, just above the background, replaced by the next result.
            if (s.of === "all") {
              const have = layers.find((l) => l.auto);
              if (have) nextVersion(have.id, s.src);
              else {
                const layer: DocLayer = { id: `fx-${result}-all`, name: "Shadows", source: s.src, history: [s.src], hidden: false, base: false, effect: true, auto: true, dx: 0, dy: 0, s: 1 };
                const at = layers.findIndex((l) => l.base);
                layers = [...layers];
                layers.splice(at < 0 ? layers.length : at, 0, layer);
              }
              continue;
            }
            // A new object's shadow follows the new layer; an object's, the object (from where it was).
            const isNew = r.objects.some((o) => o.colour === s.of);
            const obj = isNew ? madeBy[s.of] : s.of;
            const key = isNew ? `${s.of}:shadow` : s.of;
            const have = layers.find((l) => l.id === madeBy[key]) ?? layers.find((l) => l.effect && l.follows === obj);
            if (have) {
              nextVersion(have.id, s.src);
              continue;
            }
            const owner = layers.find((l) => l.id === obj);
            const id = `fx-${result}-${key}`;
            madeBy[key] = id;
            const place = isNew ? { dx: 0, dy: 0, s: 1 } : { dx: e.places[obj]?.dx ?? 0, dy: e.places[obj]?.dy ?? 0, s: e.places[obj]?.s ?? 1 };
            const layer: DocLayer = { id, name: `${owner?.name ?? "Object"} shadow`, source: s.src, history: [s.src], hidden: false, base: false, effect: true, follows: obj, at: place, dx: 0, dy: 0, s: 1 };
            const at = layers.findIndex((l) => l.id === obj);
            layers = [...layers];
            layers.splice(at < 0 ? layers.findIndex((l) => l.base) : at + 1, 0, layer);
          }
          for (const l of r.looks) nextVersion(l.id, l.src);
          const srcs = [...r.objects.map((o) => o.src), ...r.shadows.map((s) => s.src), ...r.looks.map((l) => l.src)];
          update({ ...d, layers, known: [...d.known, ...seen, ...srcs], scenes: (d.scenes ?? []).map((x) => (x.source === e.source ? { ...x, made: madeBy } : x)) });
          if (r.notes.length) toastInfo(r.notes.join(" "));
        },
        (err) => toastError(err),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, doc]);

  // An edit of an object's crop -> shrunk back into place, the layer's next version (the newest
  // result of each crop; the others are marked seen).
  useEffect(() => {
    if (!doc) return;
    for (const l of doc.layers)
      for (const f of l.feeds ?? []) {
        if (!f.rect) continue;
        const made = session.filter((i) => i.gen && itemOrigin(i).from[0] === f.source && !doc.known.includes(`gen:${i.gen.id}`));
        const done = made[made.length - 1];
        if (!done?.gen) continue;
        const result = `gen:${done.gen.id}`;
        if (making.current.has(result)) continue;
        making.current.add(result);
        pasteCrop(f, result, doc.width, doc.height, l.name).then(
          (rec) => {
            const d = latest.current!;
            const src = `input:${rec.id}`;
            const seen = made.map((i) => `gen:${i.gen!.id}`);
            update({
              ...d,
              layers: d.layers.map((x) => (x.id === l.id ? { ...x, source: src, history: [...x.history, src] } : x)),
              known: [...d.known, ...seen, src],
            });
          },
          (e) => toastError(e),
        );
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, doc]);

  // Edits made to a layer (from the prompt under this view, or after closing it) become its version.
  useEffect(() => {
    if (!doc) return;
    const items = session.flatMap((i) => {
      const source = itemSource(i);
      return source ? [{ source, from: itemOrigin(i).from[0] ?? null, mask: i.gen?.mask_input_id ?? null }] : [];
    });
    const next = reconcile(doc, items);
    if (next !== doc) update(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, doc]);

  if (!doc || splitting)
    return (
      <LayerSplit
        onSplit={(d) => {
          update(d);
          setSplitting(false);
        }}
        onBack={doc ? () => setSplitting(false) : undefined}
      />
    );
  return (
    <LayerDoc
      key={docId(doc)}
      projectId={projectId}
      doc={doc}
      onChange={update}
      onNewSplit={() => {
        // Split this document's photo again (the prompt may be on one of its layers).
        if (doc.photo && !editSource(doc.photo, false)) {
          toastError(new Error("The photo these layers were split from is no longer in the project."));
          return;
        }
        setSplitting(true);
      }}
    />
  );
}
