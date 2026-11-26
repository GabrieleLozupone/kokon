import { ArrowLeft, Check, FolderOpen, Heart, Loader2, Maximize2, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { native } from "../lib/native";
import { inBrowser, isNarrow } from "../lib/platform";
import { forgetGeneration, openGeneration, setState, toastError, useStore } from "../lib/store";
import { MODE_LABEL, neighbourAfterRemoval, previewIndex } from "../lib/logic";
import type { GenerationRecord } from "../lib/types";
import { DevelopImg } from "./Develop";
import { IconButton, Seg } from "./ui";
import { t } from "../lib/i18n";
import { Fullscreen, isTyping, NavArrows, navKey, SwipeNav, useMouseActive, ZoomImage, type ViewerNav } from "./Viewer";

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
  // Selection ("Select", or Ctrl/⌘-click, Shift-click for a range): null = off.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const selecting = picked !== null;
  const selectingNow = useRef(selecting);
  selectingNow.current = selecting;

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
    // Esc leaves the selection first, then the gallery.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectingNow.current) setPicked(null);
      else setState({ overlay: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A new search or filter closes the preview. When the image it shows has left the list,
  // it moves onto the one now at that position (back to the grid when nothing is left).
  useEffect(() => {
    setView(null);
    setPicked(null);
  }, [q, favorites, sort]);
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

  const toggle = (i: number, range: boolean) => {
    const next = new Set(picked ?? []);
    if (range && anchor !== null) for (const g of items.slice(Math.min(anchor, i), Math.max(anchor, i) + 1)) next.add(g.id);
    else if (next.has(items[i].id)) next.delete(items[i].id);
    else next.add(items[i].id);
    setPicked(next);
    setAnchor(i);
  };

  /** Deletes the picked images from the gallery and the disk, one by one (the ones that fail stay). */
  const removePicked = async () => {
    if (!picked?.size || deleting) return;
    const n = picked.size;
    if (!(await native.confirm(t("gallery.deleteManyConfirm", { count: n }), t("gallery.deleteManyTitle")))) return;
    setDeleting(true);
    const gone: string[] = [];
    let failed: unknown = null;
    for (const id of picked) {
      try {
        await api.deleteGeneration(id);
        gone.push(id);
        leaving(id);
        forgetGeneration(id);
      } catch (e) {
        failed ??= e;
      }
    }
    const out = new Set(gone);
    setItems((list) => list.filter((x) => !out.has(x.id)));
    setTotal((t) => t - gone.length);
    setPicked(failed ? new Set([...picked].filter((id) => !out.has(id))) : null);
    setDeleting(false);
    if (failed) toastError(failed);
  };

  return (
    <div className={`overlay ${selecting ? "selecting" : ""}`}>
      <div className="overlay-head">
        <IconButton title={t("gallery.backEsc")} onClick={() => setState({ overlay: null })}>
          <ArrowLeft size={18} />
        </IconButton>
        <h2>{t("gallery.title")}</h2>
        <span className="muted">{total}</span>
      </div>
      <div className="gallery-bar">
        <label className="search">
          <Search size={15} />
          <input type="text" placeholder={t("gallery.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus={!isNarrow()} />
        </label>
        <IconButton title={favorites ? t("gallery.showAll") : t("gallery.favoritesOnly")} active={favorites} onClick={() => setFavorites((f) => !f)}>
          <Heart size={17} fill={favorites ? "currentColor" : "none"} />
        </IconButton>
        <div style={{ width: 170 }}>
          <Seg
            value={sort}
            options={[
              { value: "recent", label: t("gallery.sortRecent") },
              { value: "oldest", label: t("gallery.sortOldest") },
            ]}
            onChange={setSort}
          />
        </div>
        {!inBrowser && (
          <IconButton title={t("gallery.openFolder")} onClick={() => api.config().then((c) => native.openFolder(c.outputDir)).catch(toastError)}>
            <FolderOpen size={17} />
          </IconButton>
        )}
        <span className="spacer" />
        {items.length > 0 && (
          <button className={`btn ${selecting ? "primary" : ""}`} onClick={() => setPicked(selecting ? null : new Set())} title={selecting ? t("gallery.stopSelecting") : t("gallery.selectTooltip")}>
            {selecting ? t("common.done") : t("gallery.select")}
          </button>
        )}
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
            className={`card ${picked?.has(g.id) ? "picked" : ""}`}
            role={selecting ? "checkbox" : undefined}
            aria-checked={selecting ? picked.has(g.id) : undefined}
            onClick={(e) => {
              (document.activeElement as HTMLElement | null)?.blur();
              if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) toggle(i, e.shiftKey);
              else setView({ id: g.id, at: i });
            }}
            title={g.prompt}
          >
            <DevelopImg src={urls.genThumb(g.id)} lazy />
            {selecting && <span className="pick-mark">{picked.has(g.id) && <Check size={14} strokeWidth={3} />}</span>}
            <div className={`card-actions ${g.favorite ? "fav" : ""}`} onClick={(e) => e.stopPropagation()}>
              <button title={g.favorite ? t("gallery.unfavorite") : t("gallery.favorite")} onClick={() => toggleFav(g)}>
                <Heart size={14} fill={g.favorite ? "currentColor" : "none"} />
              </button>
              <button
                title={t("common.delete")}
                onClick={async () => {
                  if (await native.confirm(t("gallery.deleteOneConfirm"), t("common.delete"))) remove(g);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="card-meta">{g.prompt}</div>
          </div>
        ))}
        {!loading && items.length === 0 && <div className="muted" style={{ gridColumn: "1/-1", textAlign: "center", padding: 48 }}>{q || favorites ? t("gallery.nothingMatches") : t("gallery.empty")}</div>}
        {loading && (
          <div style={{ gridColumn: "1/-1", display: "grid", placeItems: "center", padding: 24 }}>
            <Loader2 className="spin" size={20} />
          </div>
        )}
      </div>
      {selecting && (
        <div className="select-bar gallery-select">
          <span className="select-count">{picked.size ? t("gallery.selectedCount", { count: picked.size }) : t("gallery.clickToSelect")}</span>
          <button className="link-btn" onClick={() => setPicked(picked.size === items.length ? new Set() : new Set(items.map((g) => g.id)))}>
            {picked.size === items.length ? t("gallery.selectNone") : items.length < total ? t("gallery.selectAllLoaded", { count: items.length }) : t("gallery.selectAll", { count: items.length })}
          </button>
          <span className="spacer" />
          <button className="btn danger" disabled={!picked.size || deleting} onClick={removePicked}>
            {deleting ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} {t("common.delete")}
          </button>
          <IconButton title={t("gallery.cancelEsc")} onClick={() => setPicked(null)}>
            <X size={16} />
          </IconButton>
        </div>
      )}
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
    if (await native.confirm(t("gallery.deleteOneConfirm"), t("common.delete"))) props.onDelete(g);
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
    <div className="preview" role="dialog" aria-label={t("gallery.imagePreview")}>
      <div className="overlay-head">
        <IconButton title={t("gallery.backToAll")} onClick={onClose}>
          <ArrowLeft size={18} />
        </IconButton>
        <span className="preview-prompt" title={g.prompt}>
          {g.prompt || MODE_LABEL[g.mode]}
        </span>
        <span className="muted preview-pos">{nav.pos}</span>
      </div>
      <div className="preview-stage" onPointerMove={wake} onMouseEnter={wake}>
        <SwipeNav nav={nav} pageKey={g.id}>
          <div className="preview-img" onDoubleClick={() => setFull(true)}>
            {/* A phone shows the screen-sized preview here (full screen loads more when zoomed). */}
            <DevelopImg src={inBrowser && isNarrow() ? urls.genPreview(g.id) : urls.gen(g.id)} placeholder={urls.genThumb(g.id)} alt={g.prompt} />
          </div>
        </SwipeNav>
        <NavArrows nav={nav} visible={active} />
      </div>
      <div className="preview-bar">
        <span className="dims muted">
          {g.width}×{g.height}
        </span>
        <span className="spacer" />
        <IconButton title={g.favorite ? t("gallery.unfavorite") : t("gallery.favorite")} active={g.favorite} onClick={() => props.onFavorite(g)}>
          <Heart size={17} fill={g.favorite ? "currentColor" : "none"} />
        </IconButton>
        <IconButton title={t("common.delete")} onClick={del}>
          <Trash2 size={17} />
        </IconButton>
        <IconButton title={t("gallery.fullScreen")} onClick={() => setFull(true)}>
          <Maximize2 size={17} />
        </IconButton>
        <button className="btn primary" title={t("gallery.openInProjectTooltip")} onClick={() => onOpen(g)}>
          <FolderOpen size={15} /> {t("gallery.openInProject")}
        </button>
      </div>
      {full && (
        <Fullscreen hint={t("gallery.fullscreenHint")} onClose={() => setFull(false)} nav={nav}>
          <ZoomImage key={g.id} src={urls.gen(g.id)} source={`gen:${g.id}`} size={{ width: g.width, height: g.height }} alt={g.prompt} />
        </Fullscreen>
      )}
    </div>
  );
}
