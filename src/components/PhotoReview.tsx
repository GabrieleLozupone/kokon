// A photo just taken with a phone's camera, shown before it is uploaded, with a Flip button:
// Safari's camera gives selfies as the sensor sees them, while the Camera app saves them
// mirrored (Settings → Camera → Mirror Front Camera), so a selfie can look flipped.

import { FlipVertical2, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { haptic } from "../lib/haptics";
import { isNarrow } from "../lib/platform";
import { useBlackStatusBar } from "../lib/theme";
import { t } from "../lib/i18n";

interface Pending {
  file: File;
  url: string;
  done: (file: File | null) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => (listeners.add(f), () => listeners.delete(f));
const settle = (file: File | null) => {
  const p = pending;
  if (!p) return;
  pending = null;
  URL.revokeObjectURL(p.url);
  listeners.forEach((f) => f());
  p.done(file);
};

/** Safari names a picture taken with "Take Photo" image.jpg; ones from the photo library keep
 * their own names. */
export const takenWithCamera = (f: File) => f.name === "image.jpg";

/** On a phone, a photo just taken waits for "Use photo" (flipped or not); the others pass as
 * they are. A cancelled photo is left out. */
export async function reviewPhotos(files: File[]): Promise<File[]> {
  if (!isNarrow()) return files;
  const out: File[] = [];
  for (const f of files) {
    if (!takenWithCamera(f)) {
      out.push(f);
      continue;
    }
    const kept = await new Promise<File | null>((done) => {
      pending = { file: f, url: URL.createObjectURL(f), done };
      listeners.forEach((l) => l());
    });
    if (kept) out.push(kept);
  }
  return out;
}

/** `file` mirrored left to right, as a JPEG. The orientation in its EXIF is applied first
 * (createImageBitmap's default), so the result is what the screen showed. */
async function mirrored(file: File): Promise<File> {
  const bmp = await createImageBitmap(file);
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext("2d")!;
  ctx.translate(bmp.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise<Blob | null>((ok) => cv.toBlob(ok, "image/jpeg", 0.92));
  cv.width = cv.height = 0;
  if (!blob) throw new Error(t("photoReview.flipFailed"));
  return new File([blob], file.name, { type: "image/jpeg" });
}

/** The review screen, mounted once by the phone layout. */
export function PhotoReview() {
  const p = useSyncExternalStore(subscribe, () => pending);
  const [flip, setFlip] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFlip(false);
    setBusy(false);
  }, [p]);
  if (!p) return null;
  return <Review p={p} flip={flip} setFlip={setFlip} busy={busy} setBusy={setBusy} />;
}

function Review({ p, flip, setFlip, busy, setBusy }: { p: Pending; flip: boolean; setFlip: (f: (v: boolean) => boolean) => void; busy: boolean; setBusy: (b: boolean) => void }) {
  useBlackStatusBar();
  const use = async () => {
    setBusy(true);
    try {
      settle(flip ? await mirrored(p.file) : p.file);
    } catch {
      settle(p.file);
    }
  };
  return createPortal(
    <div className="photo-review" role="dialog" aria-label={t("photoReview.useThisPhotoAria")}>
      <div className="hold-save-head">
        <span>{t("photoReview.useThisPhoto")}</span>
        <button className="glass-btn" title={t("common.cancel")} aria-label={t("common.cancel")} onClick={() => settle(null)}>
          <X size={20} />
        </button>
      </div>
      <div className="photo-review-img">
        <img src={p.url} alt={t("photoReview.photoAlt")} draggable={false} style={flip ? { transform: "scaleX(-1)" } : undefined} />
      </div>
      <div className="photo-review-bar">
        <button
          className={`btn big ${flip ? "on" : ""}`}
          aria-pressed={flip}
          onClick={() => {
            haptic();
            setFlip((f) => !f);
          }}
        >
          {/* lucide's FlipVertical2 is the left-right mirror (its FlipHorizontal2 draws a horizontal axis) */}
          <FlipVertical2 size={18} /> {t("photoReview.flip")}
        </button>
        <button className="btn big primary" disabled={busy} onClick={use}>
          {t("photoReview.usePhoto")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
