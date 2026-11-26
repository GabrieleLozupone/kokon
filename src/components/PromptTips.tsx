import { Check, ExternalLink, Lightbulb, X } from "lucide-react";
import { useEffect, useState } from "react";
import { native } from "../lib/native";
import { focusPrompt, setState, toastError, updateComposer, useStore } from "../lib/store";
import { t } from "../lib/i18n";
import bikePlain from "../assets/prompt-tips/bike-plain.webp";
import bikeRich from "../assets/prompt-tips/bike-rich.webp";
import deskBad from "../assets/prompt-tips/desk-bad.webp";
import deskGood from "../assets/prompt-tips/desk-good.webp";
import monkeyBad from "../assets/prompt-tips/monkey-bad.webp";
import monkeyGood from "../assets/prompt-tips/monkey-good.webp";
import posterBad from "../assets/prompt-tips/poster-bad.webp";
import posterGood from "../assets/prompt-tips/poster-good.webp";
import roomBetter from "../assets/prompt-tips/room-better.webp";
import roomBlueChair from "../assets/prompt-tips/room-blue-chair.webp";
import roomBlueWall from "../assets/prompt-tips/room-blue-wall.webp";
import roomCozy from "../assets/prompt-tips/room-cozy.webp";
import room from "../assets/prompt-tips/room.webp";
import streetMulti from "../assets/prompt-tips/street-multi.webp";
import street from "../assets/prompt-tips/street.webp";

export const PROMPT_GUIDE_URL = "https://kokon.app/prompt-guide/";

type Tab = "create" | "edit";
interface Side { kind: "bad" | "ok" | "good" | "src"; label: string; prompt: string; img: string; note?: string }
/** `before`: the photo an edit starts from, shown first. */
interface Rule { title: string; why: string; before?: string; sides: Side[]; lesson: string }

// Every image is a real Kokon result (Qwen-Image 2.1 Turbo, Fast, same seed on both sides).
const rules = (): Record<Tab, Rule[]> => ({
  create: [
    {
      title: t("promptTips.actionTitle"),
      why: t("promptTips.actionWhy"),
      sides: [
        { kind: "bad", label: t("promptTips.actionLabel1"), prompt: t("promptTips.actionPrompt1"), img: monkeyBad, note: t("promptTips.actionNote1") },
        { kind: "good", label: t("promptTips.actionLabel2"), prompt: t("promptTips.actionPrompt2"), img: monkeyGood, note: t("promptTips.actionNote2") },
      ],
      lesson: t("promptTips.actionLesson"),
    },
    {
      title: t("promptTips.negativeTitle"),
      why: t("promptTips.negativeWhy"),
      sides: [
        { kind: "bad", label: t("promptTips.negativeLabel1"), prompt: t("promptTips.negativePrompt1"), img: deskBad, note: t("promptTips.negativeNote1") },
        { kind: "good", label: t("promptTips.negativeLabel2"), prompt: t("promptTips.negativePrompt2"), img: deskGood },
      ],
      lesson: t("promptTips.negativeLesson"),
    },
    {
      title: t("promptTips.textTitle"),
      why: t("promptTips.textWhy"),
      sides: [
        { kind: "bad", label: t("promptTips.textLabel1"), prompt: t("promptTips.textPrompt1"), img: posterBad, note: t("promptTips.textNote1") },
        { kind: "good", label: t("promptTips.textLabel2"), prompt: t("promptTips.textPrompt2"), img: posterGood },
      ],
      lesson: t("promptTips.textLesson"),
    },
    {
      title: t("promptTips.detailsTitle"),
      why: t("promptTips.detailsWhy"),
      sides: [
        { kind: "ok", label: t("promptTips.detailsLabel1"), prompt: t("promptTips.detailsPrompt1"), img: bikePlain },
        { kind: "good", label: t("promptTips.detailsLabel2"), prompt: t("promptTips.detailsPrompt2"), img: bikeRich },
      ],
      lesson: t("promptTips.detailsLesson"),
    },
  ],
  edit: [
    {
      title: t("promptTips.betterTitle"),
      why: t("promptTips.betterWhy"),
      before: room,
      sides: [
        { kind: "bad", label: t("promptTips.betterLabel1"), prompt: t("promptTips.betterPrompt1"), img: roomBetter, note: t("promptTips.betterNote1") },
        { kind: "good", label: t("promptTips.betterLabel2"), prompt: t("promptTips.betterPrompt2"), img: roomCozy },
      ],
      lesson: t("promptTips.betterLesson"),
    },
    {
      title: t("promptTips.nameTitle"),
      why: t("promptTips.nameWhy"),
      before: room,
      sides: [
        { kind: "bad", label: t("promptTips.nameLabel1"), prompt: t("promptTips.namePrompt1"), img: roomBlueChair, note: t("promptTips.nameNote1") },
        { kind: "good", label: t("promptTips.nameLabel2"), prompt: t("promptTips.namePrompt2"), img: roomBlueWall },
      ],
      lesson: t("promptTips.nameLesson"),
    },
    {
      title: t("promptTips.severalTitle"),
      why: t("promptTips.severalWhy"),
      before: street,
      sides: [
        { kind: "good", label: t("promptTips.severalLabel1"), prompt: t("promptTips.severalPrompt1"), img: streetMulti },
      ],
      lesson: t("promptTips.severalLesson"),
    },
  ],
});

const checklist = (): Record<Tab, string[]> => ({
  create: [t("promptTips.checkCreateSubject"), t("promptTips.checkCreateQuotes"), t("promptTips.checkCreatePositive"), t("promptTips.checkCreateRegenerate")],
  edit: [t("promptTips.checkEditVerb"), t("promptTips.checkEditPositions"), t("promptTips.checkEditCombine"), t("promptTips.checkEditPaint")],
});

/** The prompt guide inside the app: the same examples as kokon.app/prompt-guide, smaller,
 * bundled so it works offline. "Try it" copies an example into the prompt box. */
export function PromptTips() {
  const hasImages = useStore((s) => s.composer.refs.length > 0);
  const [tab, setTab] = useState<Tab>(hasImages ? "edit" : "create");
  const close = () => setState({ overlay: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const tryIt = (prompt: string) => {
    updateComposer({ prompt });
    close();
    focusPrompt(true);
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="tips" role="dialog" aria-label={t("promptTips.dialogLabel")}>
        <div className="tips-head">
          <Lightbulb size={20} />
          <h1>{t("promptTips.title")}</h1>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </div>
        <p className="tips-lead">{t("promptTips.lead")}</p>
        <div className="seg tips-tabs" role="tablist">
          <button className={tab === "create" ? "on" : ""} role="tab" aria-selected={tab === "create"} onClick={() => setTab("create")}>
            {t("promptTips.tabCreate")}
          </button>
          <button className={tab === "edit" ? "on" : ""} role="tab" aria-selected={tab === "edit"} onClick={() => setTab("edit")}>
            {t("promptTips.tabEdit")}
          </button>
        </div>

        <div className="tips-body">
          {rules()[tab].map((r, i) => (
            <section className="tips-rule" key={r.title}>
              <h2>
                <span className="tips-num">{String(i + 1).padStart(2, "0")}</span>
                {r.title}
              </h2>
              <p className="tips-why">{r.why}</p>
              <div className="tips-pair" style={{ gridTemplateColumns: `repeat(${r.sides.length + (r.before ? 1 : 0)}, minmax(0, 1fr))` }}>
                {[...(r.before ? [{ kind: "src", label: t("promptTips.original"), prompt: "", img: r.before } as Side] : []), ...r.sides].map((s) => (
                  <div className="tips-side" key={s.label}>
                    <span className={`tips-tag ${s.kind}`}>
                      {s.kind === "bad" ? <X size={12} /> : s.kind === "good" ? <Check size={12} /> : null}
                      {s.label}
                    </span>
                    <img src={s.img} alt="" loading="lazy" />
                    {s.prompt && <div className="tips-prompt">{s.prompt}</div>}
                    {s.note && <span className="tips-note">{s.note}</span>}
                    {s.kind === "good" && s.prompt && tab === "create" && (
                      <button className="btn tips-try" onClick={() => tryIt(s.prompt)}>
                        {t("promptTips.tryIt")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="tips-lesson">{r.lesson}</p>
            </section>
          ))}

          <section className="tips-rule">
            <h2>{t("promptTips.checklist")}</h2>
            <ul className="tips-check">
              {checklist()[tab].map((c) => (
                <li key={c}>
                  <Check size={14} /> {c}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <button className="btn tips-more" onClick={() => native.openLink(PROMPT_GUIDE_URL).catch(toastError)}>
          {t("promptTips.moreExamples")} <ExternalLink size={13} />
        </button>
      </div>
    </div>
  );
}
