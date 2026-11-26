import { Check, CircleAlert, Download, FileSearch, FolderOpen, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/logic";
import { native } from "../lib/native";
import { toastError } from "../lib/store";
import type { GpuBackend, InstallItem, ModelFileInfo, ModelRole, ModelScan, ModelSlot, ModelsStatus } from "../lib/types";
import { t } from "../lib/i18n";
import { Trans } from "./Trans";

const ROLES: { role: ModelRole; official: string }[] = [
  { role: "diffusion", official: "turbo_q4_k" },
  { role: "vae", official: "vae" },
  { role: "text_encoder", official: "text_encoder" },
  { role: "vision_projector", official: "vision_projector" },
];

/** The name of each piece, shown on its row. */
function roleLabel(role: ModelRole): string {
  switch (role) {
    case "diffusion":
      return t("ownModels.roleImageModel");
    case "vae":
      return t("ownModels.roleVae");
    case "text_encoder":
      return t("ownModels.roleTextEncoder");
    case "vision_projector":
      return t("ownModels.roleVisionProjector");
  }
}

/** "<file> is a <kind> file": a file of another piece chosen for this row. */
function wrongRole(file: string, role: ModelRole): string {
  switch (role) {
    case "diffusion":
      return t("ownModels.wrongRoleDiffusion", { file });
    case "vae":
      return t("ownModels.wrongRoleVae", { file });
    case "text_encoder":
      return t("ownModels.wrongRoleTextEncoder", { file });
    case "vision_projector":
      return t("ownModels.wrongRoleVisionProjector", { file });
  }
}

/** A file of the user's, the official file downloaded into `downloadDir`, or (vision projector
 * only) nothing because the text encoder has the vision weights. */
type Choice = { kind: "path"; path: string } | { kind: "download" } | { kind: "none" };

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** "Found 3 of 4; 1 piece will be downloaded · 2 files of other models skipped". */
function foundSummary(found: number, downloads: number, skipped: number): string {
  const head = downloads ? t("ownModels.foundWithDownloads", { found, count: downloads }) : t("ownModels.found", { found });
  return skipped ? t("ownModels.foundSkipped", { summary: head, count: skipped }) : head;
}

function describe(f: ModelFileInfo): string {
  return [f.weights, formatBytes(f.size), f.official ? t("ownModels.officialFile") : null].filter(Boolean).join(" · ");
}

/** Setup's "Use models I already have", as a guided flow: choose the folder (e.g. ComfyUI's
 * models folder), check what was found (one row per piece, changed only where needed), use
 * them. Pieces the user lacks are the official files, downloaded into a folder of their choice.
 * Files are used where they are. */
export function OwnModels(props: {
  models: ModelsStatus;
  /** The chosen preset's official model files (sizes of what can be downloaded). */
  officialFiles: InstallItem[];
  vramMib: number | null;
  /** The engine chosen in Setup (FP8 files are slow on Vulkan). */
  backend?: GpuBackend | null;
  /** A scan to start from (Setup's "Search another folder"). */
  initialScan: ModelScan | null;
  /** Resolves once Setup has checked the new files (the button spins until then). */
  onSaved: (s: ModelsStatus) => Promise<void>;
}) {
  const { models } = props;
  const inUse = models.active.source === "user";
  const [scan, setScan] = useState<ModelScan | null>(props.initialScan);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  // Pick each file without a folder scan.
  const [manual, setManual] = useState(false);
  // Changing files that are in use (otherwise their summary is shown).
  const [editing, setEditing] = useState(!inUse || models.missing.length > 0 || !!props.initialScan);
  // The row whose options are open.
  const [open, setOpen] = useState<ModelRole | null>(null);
  // Files chosen with "Choose a file…" (not in the scan), and the current profile's own files.
  const [extra, setExtra] = useState<ModelFileInfo[]>([]);
  const [downloadDir, setDownloadDir] = useState(models.default_download_dir);
  const [choice, setChoice] = useState<Record<ModelRole, Choice>>(() => {
    const c: Record<ModelRole, Choice> = { diffusion: { kind: "download" }, vae: { kind: "download" }, text_encoder: { kind: "download" }, vision_projector: { kind: "download" } };
    if (inUse) {
      for (const s of models.slots) if (s.role) c[s.role] = { kind: "path", path: s.path };
      if (!models.slots.some((s) => s.role === "vision_projector")) c.vision_projector = { kind: "none" };
    }
    return c;
  });

  // The user profile's files, with what they are (missing ones are shown as such).
  useEffect(() => {
    if (inUse) setExtra(models.slots.filter((s) => s.info).map((s) => s.info!));
  }, [models]);

  const known = useMemo(() => {
    const all = [...(scan?.files ?? []), ...extra];
    return all.filter((f, i) => all.findIndex((g) => g.path === f.path) === i);
  }, [scan, extra]);
  const info = (path: string) => known.find((f) => f.path === path) ?? null;

  const applyPicks = (s: ModelScan) => {
    const te = s.picks.text_encoder ? s.files.find((f) => f.path === s.picks.text_encoder) : null;
    setChoice(() => {
      const n = {} as Record<ModelRole, Choice>;
      for (const { role } of ROLES) {
        const p = s.picks[role];
        n[role] = p ? { kind: "path", path: p } : { kind: "download" };
      }
      // A text encoder with the vision weights: no projector needed.
      if (te?.has_vision) n.vision_projector = { kind: "none" };
      return n;
    });
  };

  // A search from the missing-files card that did not find everything: continue from it.
  useEffect(() => {
    if (!props.initialScan) return;
    setScan(props.initialScan);
    applyPicks(props.initialScan);
    setEditing(true);
  }, [props.initialScan]);

  const chooseFolder = async () => {
    const dir = await native.pickFolder(scan?.dir ?? models.scan_dir ?? models.user_scan_dir ?? undefined);
    if (!dir) return;
    setScanning(true);
    try {
      const s = await api.scanModels(dir);
      setScan(s);
      applyPicks(s);
      setEditing(true);
      setOpen(null);
    } catch (e) {
      toastError(e);
    } finally {
      setScanning(false);
    }
  };

  const browse = async (role: ModelRole) => {
    const cur = choice[role];
    const p = await native.pickFile(["gguf", "safetensors"], cur.kind === "path" ? cur.path : scan?.dir);
    if (!p) return;
    try {
      const f = await api.inspectModel(p);
      setExtra((x) => [...x.filter((g) => g.path !== f.path), f]);
      pick(role, { kind: "path", path: p }, f);
    } catch (e) {
      toastError(e);
    }
  };

  const pick = (role: ModelRole, c: Choice, f: ModelFileInfo | null = c.kind === "path" ? info(c.path) : null) => {
    setChoice((x) => ({ ...x, [role]: c, ...(role === "text_encoder" && f?.has_vision ? { vision_projector: { kind: "none" } } : {}) }));
    setOpen(null);
  };

  const teInfo = choice.text_encoder.kind === "path" ? info(choice.text_encoder.path) : null;
  const teHasVision = !!teInfo?.has_vision;
  const officialSize = (role: ModelRole) => {
    const id = ROLES.find((r) => r.role === role)!.official;
    // By family: the text encoder of the preset, the image model the official files use.
    return props.officialFiles.find((f) => f.id === id || f.id.startsWith(`${id}_`))?.size ?? 0;
  };

  // What each row says, and whether the set can be used.
  const rows = ROLES.map(({ role }) => {
    const label = roleLabel(role);
    const c = role === "vision_projector" && teHasVision ? ({ kind: "none" } as Choice) : choice[role];
    let state: "ok" | "download" | "bad";
    let text: string;
    let detail: string | null = null;
    if (c.kind === "none" && teHasVision) [state, text] = ["ok", t("ownModels.notNeededIncluded")];
    else if (c.kind === "none") [state, text] = ["bad", t("ownModels.neededForEditing")];
    else if (c.kind === "download") [state, text] = ["download", scan ? t("ownModels.notFoundWillDownload", { size: formatBytes(officialSize(role)) }) : t("ownModels.willDownload", { size: formatBytes(officialSize(role)) })];
    else {
      const f = info(c.path);
      const slot = models.slots.find((s) => s.path === c.path);
      detail = c.path;
      if (slot && !slot.exists) [state, text] = ["bad", t("ownModels.notFound")];
      else if (!f) [state, text] = ["ok", fileName(c.path)];
      else if (f.role !== role) [state, text] = ["bad", f.role ? wrongRole(fileName(c.path), f.role) : f.problem ?? t("ownModels.notQwenFile")];
      else if (!f.compatible) [state, text] = ["bad", f.problem ?? t("ownModels.notUsable")];
      else [state, text] = ["ok", `${fileName(c.path)} · ${describe(f)}`];
    }
    const candidates = known.filter((f) => f.role === role && f.compatible);
    return { role, label, c, state, text, detail, candidates };
  });
  const canSave = rows.every((r) => r.state !== "bad");
  const downloads = rows.filter((r) => r.c.kind === "download");
  const found = rows.filter((r) => r.c.kind === "path").length;
  const dit = choice.diffusion.kind === "path" ? info(choice.diffusion.path) : null;
  const tooLarge = !!dit && props.vramMib != null && dit.size / 2 ** 20 > props.vramMib - 4096;
  // RX 9070 XT (#38): FP8 safetensors 3.07 s/it on Vulkan, the Q4_K GGUF 1.75 s/it.
  const slowFp8 = !!dit && dit.role === "diffusion" && dit.weights === "FP8" && props.backend === "vulkan";
  const skipped = scan ? scan.files.filter((f) => !f.compatible).length : 0;

  const save = async () => {
    const slot = (c: Choice): ModelSlot | null => (c.kind === "path" ? { path: c.path } : c.kind === "download" ? { download: downloadDir } : null);
    setSaving(true);
    try {
      const s = await api.setUserModels({
        diffusion_model: slot(rows[0].c)!,
        vae: slot(rows[1].c)!,
        text_encoder: slot(rows[2].c)!,
        vision_projector: slot(rows[3].c),
        scan_dir: scan?.dir ?? models.scan_dir ?? models.user_scan_dir,
      });
      await props.onSaved(s);
      setEditing(false);
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };

  const icon = (state: "ok" | "download" | "bad") => (state === "ok" ? <Check size={16} /> : state === "download" ? <Download size={16} /> : <CircleAlert size={16} />);

  // Step 1: where are the models?
  if (editing && !scan && !manual && !inUse) {
    return (
      <div className="own-start">
        <FolderOpen size={26} strokeWidth={1.6} />
        <strong>{t("ownModels.chooseFolderTitle")}</strong>
        <span className="muted">
          <Trans k="ownModels.chooseFolderHint" tags={{ code: (s) => <code>{s}</code> }} />
        </span>
        <button className="btn primary big" onClick={chooseFolder} disabled={scanning}>
          {scanning ? <Loader2 className="spin" size={16} /> : <FolderOpen size={16} />} {scanning ? t("ownModels.lookingForModels") : t("ownModels.chooseFolder")}
        </button>
        <button className="link-btn" onClick={() => setManual(true)}>
          {t("ownModels.pickEachFile")}
        </button>
      </div>
    );
  }

  return (
    <div className="own-models">
      <div className="own-head">
        <div>
          <strong>{!editing ? t("ownModels.usingOwnFiles") : scan ? t("ownModels.inFolder", { folder: folderName(scan.dir) }) : t("ownModels.yourFiles")}</strong>
          <span className="muted">
            {!editing
              ? t("ownModels.notTestedSummary")
              : scan
                ? foundSummary(found, downloads.length, skipped)
                : t("ownModels.chooseEachPiece")}
          </span>
        </div>
        {editing ? (
          <button className="btn" onClick={chooseFolder} disabled={scanning}>
            {scanning ? <Loader2 className="spin" size={14} /> : <FolderOpen size={14} />} {scan || inUse ? t("ownModels.anotherFolder") : t("ownModels.searchFolder")}
          </button>
        ) : (
          <button className="btn" onClick={() => setEditing(true)}>
            {t("ownModels.changeFiles")}
          </button>
        )}
      </div>

      <div className="own-list">
        {rows.map((r) => (
          <div className={`own-row ${r.state}`} key={r.role}>
            <div className="own-row-main">
              {icon(r.state)}
              <div className="own-row-text">
                <span className="own-row-label">{r.label}</span>
                <span className="own-row-value">{r.text}</span>
                {r.detail && <span className="own-row-path">{r.detail}</span>}
              </div>
              {editing && (
                <button className="btn small" onClick={() => setOpen(open === r.role ? null : r.role)} aria-expanded={open === r.role}>
                  {t("ownModels.change")}
                </button>
              )}
            </div>
            {editing && open === r.role && (
              <div className="own-options">
                {r.candidates.map((f) => (
                  <button key={f.path} className={`own-option ${r.c.kind === "path" && r.c.path === f.path ? "on" : ""}`} onClick={() => pick(r.role, { kind: "path", path: f.path }, f)}>
                    <span>{fileName(f.path)}</span>
                    <span className="muted">{describe(f)}</span>
                  </button>
                ))}
                {r.role === "vision_projector" && teHasVision && (
                  <button className={`own-option ${r.c.kind === "none" ? "on" : ""}`} onClick={() => pick(r.role, { kind: "none" })}>
                    <span>{t("ownModels.notNeeded")}</span>
                    <span className="muted">{t("ownModels.visionIncluded")}</span>
                  </button>
                )}
                <button className={`own-option ${r.c.kind === "download" ? "on" : ""}`} onClick={() => pick(r.role, { kind: "download" })}>
                  <span>
                    <Download size={13} /> {t("ownModels.downloadOfficial")}
                  </span>
                  <span className="muted">{formatBytes(officialSize(r.role))}</span>
                </button>
                <button className="own-option" onClick={() => browse(r.role)}>
                  <span>
                    <FileSearch size={13} /> {t("ownModels.chooseFile")}
                  </span>
                  <span className="muted">{t("ownModels.fileTypes")}</span>
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {editing && downloads.length > 0 && (
        <div className="own-download">
          <span className="muted">
            <Trans k="ownModels.downloadsGoTo" vars={{ dir: downloadDir }} tags={{ strong: (s) => <strong>{s}</strong> }} />
          </span>
          <button
            className="link-btn"
            onClick={async () => {
              const d = await native.pickFolder(downloadDir);
              if (d) setDownloadDir(d);
            }}
          >
            {t("ownModels.change")}
          </button>
        </div>
      )}

      {editing && tooLarge && (
        <div className="setup-note">
          {t("ownModels.tooLarge", { size: formatBytes(dit!.size), vram: Math.round((props.vramMib ?? 0) / 1024) })}
        </div>
      )}

      {dit?.role === "diffusion" && dit.compatible && dit.warning && <div className="setup-note">{dit.warning}</div>}

      {editing && slowFp8 && (
        <div className="setup-note">{t("ownModels.slowFp8")}</div>
      )}

      {editing && (
        <div className="own-actions">
          <button className="btn primary" disabled={!canSave || saving} onClick={save}>
            {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />} {saving ? t("ownModels.checkingFiles") : t("ownModels.useTheseFiles")}
          </button>
          {inUse && models.missing.length === 0 && (
            <button className="btn ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          )}
          {!tooLarge && <span className="muted">{t("ownModels.notTestedWarning")}</span>}
        </div>
      )}
    </div>
  );
}
