import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { isNarrow } from "../lib/platform";

/** Largest w×h box with the given aspect that fits the container. */
export function useFit(aspect: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const w = Math.min(W, H * aspect);
      setBox({ w, h: w / aspect });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return { ref, box };
}

/** Button + anchored popover that closes on outside click / Escape. */
export function Popover(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: "top-start" | "top-end" | "bottom-end" | "bottom-start";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // A phone: the menu opens as a sheet along the bottom of the screen, the full width, instead of
  // next to its button (it would leave the screen on either side).
  const sheet = isNarrow();
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown: iOS sends no mouse events for a tap on the sheet's scrim. In the
    // capture phase: the image stops its own pointerdown (press to compare, the slider).
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) && !sheetRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const placement = props.placement ?? "top-start";
  // A popover taller than the room above (or below) its button would leave the window: it gets
  // at most that room and scrolls inside.
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!open || !ref.current || sheet) return;
    const fit = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const room = placement.startsWith("top") ? r.top - 8 - 12 : window.innerHeight - r.bottom - 6 - 12;
      setMaxHeight(Math.max(120, Math.floor(room)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, placement, sheet]);
  const pos: Record<string, React.CSSProperties> = {
    "top-start": { bottom: "calc(100% + 8px)", left: 0 },
    "top-end": { bottom: "calc(100% + 8px)", right: 0 },
    "bottom-end": { top: "calc(100% + 6px)", right: 0 },
    "bottom-start": { top: "calc(100% + 6px)", left: 0 },
  };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {props.trigger(open, () => setOpen((o) => !o))}
      {open &&
        (sheet ? (
          createPortal(
            <>
              <div className="sheet-scrim" />
              <div ref={sheetRef} className={`popover sheet ${props.className ?? ""}`}>
                {props.children(() => setOpen(false))}
              </div>
            </>,
            document.body,
          )
        ) : (
          <div className={`popover ${props.className ?? ""}`} style={{ ...pos[placement], maxHeight, overflowY: "auto" }}>
            {props.children(() => setOpen(false))}
          </div>
        ))}
    </div>
  );
}

export function Option(props: { selected?: boolean; onClick: () => void; icon?: ReactNode; label: string; sub?: string }) {
  return (
    <button className="opt" onClick={props.onClick} role="menuitemradio" aria-checked={!!props.selected}>
      <span className="check">{props.selected ? <Check size={15} /> : props.icon}</span>
      <span>{props.label}</span>
      {props.sub && <span className="sub">{props.sub}</span>}
    </button>
  );
}

export function Seg<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {props.options.map((o) => (
        <button key={o.value} className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)} role="radio" aria-checked={o.value === props.value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { on: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return <button className={`switch ${props.on ? "on" : ""}`} role="switch" aria-checked={props.on} aria-label={props.label} disabled={props.disabled} onClick={() => props.onChange(!props.on)} />;
}

/** Text that turns into a field while renaming: Enter or leaving saves, Escape cancels. */
export function NameField(props: { value: string; onSave: (v: string) => void; onDone: () => void; className?: string }) {
  const [v, setV] = useState(props.value);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && v.trim() !== props.value) props.onSave(v);
    props.onDone();
  };
  return (
    <input
      className={`name-field ${props.className ?? ""}`}
      value={v}
      autoFocus
      // No contact AutoFill bar over the keyboard on a phone.
      autoComplete="off"
      // Caret at the end, nothing selected: typing adds to the name instead of replacing it.
      onFocus={(e) => {
        const n = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(n, n);
        e.currentTarget.scrollLeft = e.currentTarget.scrollWidth;
      }}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      maxLength={120}
      spellCheck={false}
      aria-label={t("ui.projectName")}
    />
  );
}

export function IconButton(props: { title: string; onClick?: () => void; children: ReactNode; active?: boolean; disabled?: boolean; small?: boolean }) {
  return (
    <button className={`icon-btn ${props.small ? "sm" : ""} ${props.active ? "active" : ""}`} title={props.title} aria-label={props.title} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}
