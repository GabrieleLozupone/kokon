// Keyboard and mouse shortcuts, opened with "?".

import { Keyboard, X } from "lucide-react";
import { Fragment, useEffect } from "react";
import { isMac } from "../lib/platform";
import { setState } from "../lib/store";
import { t } from "../lib/i18n";

const MOD = isMac ? "⌘" : "Ctrl";

/** Each row: what it does, then the alternatives (each a list of keys pressed together). The key
 * names here are only shown, never matched against key events. */
function sections(): { title: string; rows: [string, string[][]][] }[] {
  const enter = t("shortcuts.keyEnter");
  const shift = t("shortcuts.keyShift");
  const esc = t("shortcuts.keyEsc");
  const drag = t("shortcuts.drag");
  return [
    {
      title: t("shortcuts.everywhere"),
      rows: [
        [t("shortcuts.generate"), [[enter], [MOD, enter]]],
        [t("shortcuts.newLine"), [[shift, enter]]],
        [t("shortcuts.lastPrompt"), [["↑"]]],
        [t("shortcuts.pasteImage"), [[MOD, "V"]]],
        [t("shortcuts.prevNextVersion"), [["←"], ["→"]]],
        [t("shortcuts.undoRedoVersion"), [[MOD, "Z"], [MOD, shift, "Z"]]],
        [t("shortcuts.renameProject"), [["F2"]]],
        [t("shortcuts.showShortcuts"), [["?"]]],
      ],
    },
    {
      title: t("shortcuts.viewing"),
      rows: [
        [t("shortcuts.fullScreen"), [["F"]]],
        [t("shortcuts.browseFullScreen"), [["←"], ["→"]]],
        [t("shortcuts.seeOriginal"), [["B"]]],
        [t("common.close"), [[esc]]],
      ],
    },
    {
      title: t("shortcuts.zoomSection"),
      rows: [
        [t("shortcuts.zoom"), [[t("shortcuts.scroll")], ["+"], ["−"]]],
        [t("shortcuts.fitActual"), [["0"], ["1"]]],
        [t("shortcuts.moveAround"), [[drag]]],
      ],
    },
    {
      title: t("shortcuts.painting"),
      rows: [
        [t("shortcuts.brushEraserMove"), [["B"], ["E"], ["H"]]],
        [t("shortcuts.brushSize"), [["["], ["]"]]],
        [t("shortcuts.otherTool"), [[t("shortcuts.rightClick")]]],
        [t("shortcuts.moveAround"), [[t("shortcuts.keySpace"), drag], [t("shortcuts.middleDrag")]]],
        [t("shortcuts.undoRedoStroke"), [[MOD, "Z"], [MOD, shift, "Z"]]],
        [t("common.cancel"), [[esc]]],
      ],
    },
  ];
}

export function Shortcuts() {
  const close = () => setState({ overlay: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" || e.key === "?") && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="tips shortcuts" role="dialog" aria-label={t("shortcuts.dialogLabel")}>
        <div className="tips-head">
          <Keyboard size={20} />
          <h1>{t("shortcuts.title")}</h1>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </div>
        <div className="tips-body shortcuts-body">
          {sections().map((s) => (
            <section className="tips-rule" key={s.title}>
              <h2>{s.title}</h2>
              {s.rows.map(([what, alts]) => (
                <div className="shortcut-row" key={what}>
                  <span>{what}</span>
                  <span className="keys">
                    {alts.map((keys, i) => (
                      <Fragment key={i}>
                        {i > 0 && <span className="muted">{t("shortcuts.or")}</span>}
                        {keys.map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                      </Fragment>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
