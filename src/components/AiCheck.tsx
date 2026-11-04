// "Check an image": what an image's AI markings say (the service's /provenance/check). Kokon marks
// everything it makes or changes with the model twice, in the file's metadata and with an
// invisible watermark (EU AI Act Art. 50(2), docs/ai-marking.md); this is the free check anyone
// can run on any image. The image is read on the computer running Kokon and not kept.

import { Copy, ScanSearch, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AiCheckReport } from "../lib/api";
import { native } from "../lib/native";
import { setState, toastError, toastInfo } from "../lib/store";

/** The IPTC Digital Source Type in plain words. */
const SOURCE_WORDS: Record<string, string> = {
  trainedAlgorithmicMedia: "made with generative AI",
  compositeWithTrainedAlgorithmicMedia: "made or changed with generative AI",
  algorithmicallyEnhanced: "enhanced by software (not generated)",
  digitalCapture: "a photo from a camera",
  algorithmicMedia: "made by an algorithm (not AI)",
  compositeSynthetic: "a composite with synthetic parts",
  composite: "a composite of several images",
  screenCapture: "a screenshot",
};

/** The headline and its tone. */
function verdict(r: AiCheckReport): { title: string; tone: "ai" | "none" } {
  if (r.watermark.kokon) return { title: "Made or changed with AI in Kokon", tone: "ai" };
  if (r.metadata.ai) return { title: `Marked as ${SOURCE_WORDS[r.metadata.digital_source_type ?? ""] ?? "made with AI"}`, tone: "ai" };
  return { title: "No AI marking found", tone: "none" };
}

export function AiCheck() {
  const close = () => setState({ overlay: null });
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [report, setReport] = useState<AiCheckReport | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = async () => {
    const [file] = await native.pickImageFiles();
    if (!file) return;
    setBusy(true);
    setReport(null);
    setName(file.name);
    try {
      setReport(await api.checkImage(file));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!report) return;
    native.copyText(JSON.stringify({ file: name, ...report }, null, 2)).then(() => toastInfo("Report copied"), toastError);
  };

  const v = report && verdict(report);
  const wm = report?.watermark;
  const md = report?.metadata;
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="tips ai-check" role="dialog" aria-label="Check an image for AI marking">
        <div className="tips-head">
          <ScanSearch size={20} />
          <h1>Check an image</h1>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="tips-body">
          <p className="muted">
            Kokon marks every image it makes or changes with AI twice: in the file's information, and with an invisible watermark that stays when the file is copied,
            resized or turned into a JPEG. Check any image here. It is read on the computer running Kokon and not kept.
          </p>
          <div className="ai-check-pick">
            <button className="btn primary" onClick={choose} disabled={busy}>
              {busy ? "Checking…" : report ? "Check another image" : "Choose an image"}
            </button>
            {name && <span className="muted ai-check-name">{name}</span>}
          </div>
          {report && v && wm && md && (
            <section className="ai-check-result" aria-live="polite">
              <h2 className={v.tone === "ai" ? "ai-yes" : ""}>{v.title}</h2>
              {v.tone === "none" && <p className="muted">That does not prove it was not made with AI: markings can be removed, and not every app adds them.</p>}
              <dl>
                <dt>Invisible watermark</dt>
                <dd>
                  {!wm.checked
                    ? "Not checked: the watermark model is not installed."
                    : wm.kokon
                      ? `Kokon's (TrustMark, reads "${wm.text}")`
                      : wm.found
                        ? `A TrustMark watermark from another app (reads "${wm.text}")`
                        : "None found"}
                </dd>
                <dt>File information</dt>
                <dd>{md.digital_source_type ? `Says it is ${SOURCE_WORDS[md.digital_source_type] ?? md.digital_source_type}` : "Says nothing about how it was made"}</dd>
                {md.creator_tool && (
                  <>
                    <dt>Made with</dt>
                    <dd>{md.creator_tool}</dd>
                  </>
                )}
                <dt>Content Credentials</dt>
                <dd>{md.c2pa_manifest ? "Present (not verified here)" : "None"}</dd>
              </dl>
              <div className="ai-check-foot">
                <span className="muted" title={report.sha256}>
                  {report.width}×{report.height} · SHA-256 {report.sha256.slice(0, 12)}…
                </span>
                <button className="btn" onClick={copy}>
                  <Copy size={14} /> Copy report
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Settings → General: what Kokon marks, and the check. */
export function AiMarkingCard() {
  return (
    <div className="repo-card ai-marking-card">
      <ScanSearch size={22} className="support-mark" aria-hidden />
      <div className="body">
        <strong>AI marking</strong>
        <span className="muted">Images Kokon makes or changes say so in their file information and in an invisible watermark, as the EU AI Act asks. Please don't remove them.</span>
      </div>
      <button className="btn" onClick={() => setState({ overlay: "ai-check" })}>
        Check an image
      </button>
    </div>
  );
}
