import { ArrowLeft, FolderOpen, Heart, Loader2, Maximize2, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { native } from "../lib/native";
import { forgetGeneration, openGeneration, setState, toastError, useStore } from "../lib/store";
import { MODE_LABEL, neighbourAfterRemoval, previewIndex } from "../lib/logic";
import type { GenerationRecord } from "../lib/types";
import { IconButton, Seg } from "./ui";
import { Fullscreen, isTyping, NavArrows, navKey, useMouseActive, ZoomImage, type ViewerNav } from "./Viewer";

const PAGE = 60;
/** Most images the server returns in one request. */
const MAX_PAGE = 500;

export function Gallery() {
  const version = useStore((s) => s.galleryVersion);
  const [q, setQ] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [sort, setSort] = useState<"recent" | "oldest">("recent");
  const [items, setItems] = useState<GenerationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  // The image open in the preview, by id (the list can shift under it), with its last
  // position for when it leaves the list.
  const [view, setView] = useState<{ id: string; at: number } | null>(null);
  const ids = useMemo(() => items.map((g) => g.id), [items]);
  const index = view ? previewIndex(ids, view.id, view.at) : null;
  const loaded = useRef(0);
  loaded.current = items.length;

  /** Loads `count` images from `offset` (the first page replaces the list). */
  const load = useCallback(
    async (offset: number, count = PAGE) => {
      setLoading(true);
      try {
        const got: GenerationRecord[] = [];
        let all = 0;
        do {
          const r = await api.gallery({ q, favorites, sort, limit: Math.min(MAX_PAGE, count - got.length), offset: offset + got.length });
          got.push(...r.items);
          all = r.total;
          if (r.items.length === 0) break;
        } while (got.length < count && offset + got.length < all);
        setItems((prev) => (offset === 0 ? got : [...prev, ...got]));
        setTotal(all);
      } catch (e) {
        toastError(e);
      } finally {
        setLoading(false);
      }
    },
    [q, favorites, sort],
  );

  // A new search, filter or sort starts from the first page; a refresh (a new image was made)
  // reloads as many as were loaded, so the image in the preview stays in the list.
  const lastLoad = useRef(load);
  useEffect(() => {
    const refresh = lastLoad.current === load;
    lastLoad.current = load;
    const t = window.setTimeout(() => load(0, refresh ? Math.max(PAGE, loaded.current) : PAGE), q && !refresh ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [load, version, q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setState({ overlay: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A new search or filter closes the preview. When the image it shows has left the list,
  // it moves onto the one now at that position (back to the grid when nothing is left).
  useEffect(() => setView(null), [q, favorites, sort]);
  useEffect(() => {
    if (!view || loading || ids.includes(view.id)) return;
    setView(index === null ? null : { id: ids[index], at: index });
  }, [view, index, ids, loading]);

  // Browsing near the end of what is loaded fetches the next page.
  useEffect(() => {
    if (index !== null && !loading && items.length < total && index >= items.length - 3) load(items.length);
  }, [index, loading, items.length, total, load]);

  const go = useCallback((i: number) => ids[i] && setView({ id: ids[i], at: i }), [ids]);

  /** Before an image leaves the list: if the preview shows it, move to its neighbour. */
  const idsNow = useRef(ids);
  idsNow.current = ids;
  const leaving = (id: string) =>
    setView((v) => {
      if (v?.id !== id) return v;
      const next = neighbourAfterRemoval(idsNow.current, id);
      return next ? { id: next, at: v.at } : null;
    });

  const reopen = (g: GenerationRecord) => openGeneration(g).catch(toastError);

  const toggleFav = async (g: GenerationRecord) => {
    try {
      const r = await api.setFavorite(g.id, !g.favorite);
      if (favorites && !r.favorite) leaving(g.id);
      setItems((list) => (favorites && !r.favorite ? list.filter((x) => x.id !== g.id) : list.map((x) => (x.id === g.id ? r : x))));
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async (g: GenerationRecord) => {
    try {
      await api.deleteGeneration(g.id);
      leaving(g.id);
      setItems((list) => list.filter((x) => x.id !== g.id));
      setTotal((t) => t - 1);
      forgetGeneration(g.id);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="overlay">
      <div className="overlay-head">
        <IconButton title="Back (Esc)" onClick={() => setState({ overlay: null })}>
          <ArrowLeft size={18} />
        </IconButton>
        <h2>Gallery</h2>
        <span className="muted">{total}</span>
      </div>
      <div className="gallery-bar">
        <label className="search">
          <Search size={15} />
          <input type="text" placeholder="Search prompts" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        </label>
        <IconButton title={favorites ? "Show all" : "Favorites only"} active={favorites} onClick={() => setFavorites((f) => !f)}>
          <Heart size={17} fill={favorites ? "currentColor" : "none"} />
        </IconButton>
        <div style={{ width: 170 }}>
          <Seg
            value={sort}
            options={[
              { value: "recent", label: "Recent" },
              { value: "oldest", label: "Oldest" },
            ]}
            onChange={setSort}
          />
        </div>
      </div>
      <div
        className="grid"
        ref={gridRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (!loading && items.length < total && el.scrollTop + el.clientHeight > el.scrollHeight - 400) load(items.length);
        }}
      >
        {items.map((g, i) => (
          <div
            key={g.id}
            className="card"
            onClick={() => {
              (document.activeElement as HTMLElement | null)?.blur();
              setView({ id: g.id, at: i });
            }}
            title={g.prompt}
          >
            <img src={urls.genThumb(g.id)} alt="" loading="lazy" draggable={false} />
            <div className={`card-actions ${g.favorite ? "fav" : ""}`} onClick={(e) => e.stopPropagation()}>
              <button title={g.favorite ? "Remove from favorites" : "Favorite"} onClick={() => toggleFav(g)}>
                <Heart size={14} fill={g.favorite ? "currentColor" : "none"} />
              </button>
              <button
                title="Delete"
                onClick={async () => {
                  if (await native.confirm("Delete this image from the gallery and disk?", "Delete")) remove(g);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="card-meta">{g.prompt}</div>
          </div>
        ))}
        {!loading && items.length === 0 && <div className="muted" style={{ gridColumn: "1/-1", textAlign: "center", padding: 48 }}>{q || favorites ? "Nothing matches." : "Your generations will appear here."}</div>}
        {loading && (
          <div style={{ gridColumn: "1/-1", display: "grid", placeItems: "center", padding: 24 }}>
            <Loader2 className="spin" size={20} />
          </div>
        )}
      </div>
      {index !== null && view && (
        <Preview
          g={items[index]}
          index={index}
          total={total}
          count={items.length}
          onGo={go}
          onClose={() => setView(null)}
          onOpen={reopen}
          onFavorite={toggleFav}
          onDelete={remove}
        />
      )}
    </div>
  );
}

/** One gallery image, large, over the grid (which keeps its scroll position underneath):
 * arrows browse the gallery, F goes full screen, Enter opens it in its project. */
function Preview(props: {
  g: GenerationRecord;
  index: number;
  total: number;
  count: number;
  onGo: (i: number) => void;
  onClose: () => void;
  onOpen: (g: GenerationRecord) => void;
  onFavorite: (g: GenerationRecord) => void;
  onDelete: (g: GenerationRecord) => void;
}) {
  const { g, index, total, count, onGo, onClose, onOpen } = props;
  const [full, setFull] = useState(false);
  const [active, wake] = useMouseActive();
  const nav = useMemo<ViewerNav>(
    () => ({
      prev: index > 0 ? () => onGo(index - 1) : undefined,
      next: index < count - 1 ? () => onGo(index + 1) : undefined,
      pos: `${index + 1} / ${total}`,
    }),
    [index, count, total, onGo],
  );
  const del = async () => {
    if (await native.confirm("Delete this image from the gallery and disk?", "Delete")) props.onDelete(g);
  };

  useEffect(() => {
    if (full) return; // full screen has its own keys
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") onClose();
      else if (k === "f" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) setFull(true);
      else if (e.key === "Enter") onOpen(g);
      else if (!navKey(e, nav)) return;
      e.preventDefault();
      // Captured before the gallery's own Esc, which would close the whole gallery.
      e.stopPropagation();
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [full, nav, g, onClose, onOpen]);

  return (
    <div className="preview" role="dialog" aria-label="Image preview">
      <div className="overlay-head">
        <IconButton title="Back to all images (Esc)" onClick={onClose}>
          <ArrowLeft size={18} />
        </IconButton>
        <span className="preview-prompt" title={g.prompt}>
          {g.prompt || MODE_LABEL[g.mode]}
        </span>
        <span className="muted preview-pos">{nav.pos}</span>
      </div>
      <div className="preview-stage" onPointerMove={wake} onMouseEnter={wake}>
        <img key={g.id} className="preview-img" src={urls.gen(g.id)} alt={g.prompt} draggable={false} onDoubleClick={() => setFull(true)} />
        <NavArrows nav={nav} visible={active} />
      </div>
      <div className="preview-bar">
        <span className="dims muted">
          {g.width}×{g.height}
        </span>
        <span className="spacer" />
        <IconButton title={g.favorite ? "Remove from favorites" : "Favorite"} active={g.favorite} onClick={() => props.onFavorite(g)}>
          <Heart size={17} fill={g.favorite ? "currentColor" : "none"} />
        </IconButton>
        <IconButton title="Delete" onClick={del}>
          <Trash2 size={17} />
        </IconButton>
        <IconButton title="Full screen (F)" onClick={() => setFull(true)}>
          <Maximize2 size={17} />
        </IconButton>
        <button className="btn primary" title="Open in its project to keep editing (Enter)" onClick={() => onOpen(g)}>
          <FolderOpen size={15} /> Open in project
        </button>
      </div>
      {full && (
        <Fullscreen hint="Scroll or click to zoom · Drag to pan" onClose={() => setFull(false)} nav={nav}>
          <ZoomImage key={g.id} src={urls.gen(g.id)} alt={g.prompt} />
        </Fullscreen>
      )}
    </div>
  );
}
