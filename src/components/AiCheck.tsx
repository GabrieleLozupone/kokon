// "Check an image": what an image's AI markings say (the service's /provenance/check). Kokon marks
// everything it makes or changes with the model twice, in the file's metadata and with an
// invisible watermark (EU AI Act Art. 50(2), docs/ai-marking.md); this is the free check anyone
// can run on any image. The image is read on the computer running Kokon and not kept.

import { Copy, ScanSearch, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type AiCheckReport } from "../lib/api";
import { t } from "../lib/i18n";
import { native } from "../lib/native";
import { setState, toastError, toastInfo } from "../lib/store";

/** The IPTC Digital Source Type in plain words (undefined for a type it doesn't know). */
function sourceWords(type: string): string | undefined {
  switch (type) {
    case "trainedAlgorithmicMedia":
      return t("aiCheck.sourceTrainedAlgorithmicMedia");
    case "compositeWithTrainedAlgorithmicMedia":
      return t("aiCheck.sourceCompositeWithTrainedAlgorithmicMedia");
    case "algorithmicallyEnhanced":
      return t("aiCheck.sourceAlgorithmicallyEnhanced");
    case "digitalCapture":
      return t("aiCheck.sourceDigitalCapture");
    case "algorithmicMedia":
      return t("aiCheck.sourceAlgorithmicMedia");
    case "compositeSynthetic":
      return t("aiCheck.sourceCompositeSynthetic");
    case "composite":
      return t("aiCheck.sourceComposite");
    case "screenCapture":
      return t("aiCheck.sourceScreenCapture");
    default:
      return undefined;
  }
}

/** The headline and its tone. */
function verdict(r: AiCheckReport): { title: string; tone: "ai" | "none" } {
  if (r.watermark.kokon) return { title: t("aiCheck.verdictKokon"), tone: "ai" };
  if (r.metadata.ai) return { title: t("aiCheck.markedAs", { what: sourceWords(r.metadata.digital_source_type ?? "") ?? t("aiCheck.madeWithAi") }), tone: "ai" };
  return { title: t("aiCheck.noMarking"), tone: "none" };
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
    native.copyText(JSON.stringify({ file: name, ...report }, null, 2)).then(() => toastInfo(t("aiCheck.reportCopied")), toastError);
  };

  const v = report && verdict(report);
  const wm = report?.watermark;
  const md = report?.metadata;
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="tips ai-check" role="dialog" aria-label={t("aiCheck.dialogLabel")}>
        <div className="tips-head">
          <ScanSearch size={20} />
          <h1>{t("aiCheck.title")}</h1>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </div>
        <div className="tips-body">
          <p className="muted">{t("aiCheck.intro")}</p>
          <div className="ai-check-pick">
            <button className="btn primary" onClick={choose} disabled={busy}>
              {busy ? t("aiCheck.checking") : report ? t("aiCheck.checkAnother") : t("aiCheck.choose")}
            </button>
            {name && <span className="muted ai-check-name">{name}</span>}
          </div>
          {report && v && wm && md && (
            <section className="ai-check-result" aria-live="polite">
              <h2 className={v.tone === "ai" ? "ai-yes" : ""}>{v.title}</h2>
              {v.tone === "none" && <p className="muted">{t("aiCheck.noProof")}</p>}
              <dl>
                <dt>{t("aiCheck.watermark")}</dt>
                <dd>
                  {!wm.checked
                    ? t("aiCheck.watermarkNotChecked")
                    : wm.kokon
                      ? t("aiCheck.watermarkKokon", { text: wm.text ?? "" })
                      : wm.found
                        ? t("aiCheck.watermarkOther", { text: wm.text ?? "" })
                        : t("aiCheck.watermarkNone")}
                </dd>
                <dt>{t("aiCheck.fileInfo")}</dt>
                <dd>{md.digital_source_type ? t("aiCheck.saysItIs", { what: sourceWords(md.digital_source_type) ?? md.digital_source_type }) : t("aiCheck.saysNothing")}</dd>
                {md.creator_tool && (
                  <>
                    <dt>{t("aiCheck.madeWith")}</dt>
                    <dd>{md.creator_tool}</dd>
                  </>
                )}
                <dt>{t("aiCheck.contentCredentials")}</dt>
                <dd>{md.c2pa_manifest ? t("aiCheck.c2paPresent") : t("aiCheck.c2paNone")}</dd>
              </dl>
              <div className="ai-check-foot">
                <span className="muted" title={report.sha256}>
                  {t("aiCheck.sizeHash", { width: report.width, height: report.height, hash: report.sha256.slice(0, 12) })}
                </span>
                <button className="btn" onClick={copy}>
                  <Copy size={14} /> {t("aiCheck.copyReport")}
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
        <strong>{t("aiCheck.markingTitle")}</strong>
        <span className="muted">{t("aiCheck.markingText")}</span>
      </div>
      <button className="btn" onClick={() => setState({ overlay: "ai-check" })}>
        {t("aiCheck.title")}
      </button>
    </div>
  );
}
