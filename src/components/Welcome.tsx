import { ChevronLeft, ChevronRight, CloudOff, Cpu, EyeOff, Infinity as Unlimited } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import mark from "../assets/kokon-mark.svg?raw";
import demo from "../assets/showcase/kokon-demo.mp4";
import expand from "../assets/showcase/expand.jpg";
import poster from "../assets/showcase/fatto-in-casa.jpg";
import relight from "../assets/showcase/relight.jpg";
import remove from "../assets/showcase/remove.jpg";
import replace from "../assets/showcase/replace.jpg";
import restyle from "../assets/showcase/restyle.jpg";
import text from "../assets/showcase/text.jpg";
import { api } from "../lib/api";
import { WHATS_NEW_VERSION } from "./WhatsNew";
import { inBrowser, isMac } from "../lib/platform";
import { autoCheckEnabled } from "../lib/updates";
import { setState, toastError, useStore } from "../lib/store";
import { t } from "../lib/i18n";
import { Trans } from "./Trans";

const machine = isMac ? "Mac" : "PC";

/** The Kokon mark in the current text color (light and dark themes). */
export function KokonMark({ size = 40 }: { size?: number }) {
  const svg = mark.replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="currentColor"').replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  return <span className="kokon-mark" aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Remembers that the welcome screen was seen (in the app config, so it survives updates)
 * and the update-check choice made on it. */
async function markSeen(updateCheck: boolean) {
  try {
    const cfg = await api.config();
    const ui = (cfg.ui ?? {}) as Record<string, unknown>;
    // A new install starts on this release: its "what's new" notes are not shown.
    if (!ui.welcomeSeen || autoCheckEnabled(ui) !== updateCheck) await api.saveConfig({ ...cfg, ui: { whatsNewSeen: WHATS_NEW_VERSION, ...ui, welcomeSeen: true, updateCheck } });
  } catch (e) {
    toastError(e);
  }
}

const promises = () => [
  { icon: Cpu, title: t("welcome.madeOnTitle", { machine }), text: t("welcome.madeOnText") },
  { icon: CloudOff, title: t("welcome.onlineTitle"), text: t("welcome.onlineText") },
  { icon: Unlimited, title: t("welcome.noLimitsTitle"), text: t("welcome.noLimitsText") },
  { icon: EyeOff, title: t("welcome.privateTitle"), text: t("welcome.privateText") },
];

/** First launch (and Settings → General → Show welcome screen): what Kokon is and why it is private. */
export function Welcome() {
  const needsSetup = useStore((s) => s.needsSetup);
  const [updateCheck, setUpdateCheck] = useState(true);
  useEffect(() => {
    api.config().then((c) => setUpdateCheck(autoCheckEnabled(c.ui)), () => {});
  }, []);
  const choice = useRef(updateCheck);
  choice.current = updateCheck;
  const close = () => {
    setState({ overlay: null });
    markSeen(choice.current);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-scrim">
      <div className="welcome" role="dialog" aria-label={t("welcome.title")}>
        <KokonMark size={44} />
        <h1>{t("welcome.title")}</h1>
        <p className="welcome-lead">{t("welcome.lead", { machine })}</p>
        <div className="welcome-grid">
          {promises().map(({ icon: Icon, title, text }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>
        {!inBrowser && (
          <label className="welcome-check">
            <input type="checkbox" checked={updateCheck} onChange={(e) => setUpdateCheck(e.target.checked)} />
            {t("welcome.updateCheck")}
          </label>
        )}
        <button className="btn primary big" onClick={close}>
          {needsSetup ? t("welcome.setUp") : t("welcome.startCreating")}
        </button>
        <span className="muted welcome-foot">{t("welcome.openAgain")}</span>
      </div>
    </div>
  );
}

const slides = (): { src: string; video?: boolean; title: string; prompt: string }[] => [
  { src: demo, video: true, title: t("welcome.slideDemoTitle"), prompt: t("welcome.slideDemoText") },
  { src: remove, title: t("welcome.slideRemoveTitle"), prompt: t("welcome.slideRemoveText") },
  { src: replace, title: t("welcome.slideReplaceTitle"), prompt: t("welcome.slideReplaceText") },
  { src: relight, title: t("welcome.slideRelightTitle"), prompt: t("welcome.slideRelightText") },
  { src: restyle, title: t("welcome.slideRestyleTitle"), prompt: t("welcome.slideRestyleText") },
  { src: text, title: t("welcome.slideTextTitle"), prompt: t("welcome.slideTextText") },
  { src: expand, title: t("welcome.slideExpandTitle"), prompt: t("welcome.slideExpandText") },
];

/** What Kokon can do, shown while the model downloads (the wait is the best moment for it). */
export function Showcase() {
  const [i, setI] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const SLIDES = slides();
  const slide = SLIDES[i];
  const go = (d: number) => setI((n) => (n + d + SLIDES.length) % SLIDES.length);
  // Photos advance every 6 s; the video advances when it ends.
  useEffect(() => {
    if (slide.video) return;
    const t = window.setTimeout(() => go(1), 6000);
    return () => window.clearTimeout(t);
  }, [i]);
  return (
    <div className="showcase">
      <div className="showcase-head">
        <strong>{t("welcome.showcaseTitle")}</strong>
        <span className="muted">{t("welcome.slideCount", { n: i + 1, total: SLIDES.length })}</span>
      </div>
      <div className="showcase-media">
        {slide.video ? (
          <video ref={video} key={slide.src} src={slide.src} poster={poster} autoPlay muted playsInline onEnded={() => go(1)} />
        ) : (
          <img key={slide.src} src={slide.src} alt={t("welcome.slideAlt", { title: slide.title })} />
        )}
        <button className="showcase-nav prev" onClick={() => go(-1)} aria-label={t("welcome.previous")}>
          <ChevronLeft size={18} />
        </button>
        <button className="showcase-nav next" onClick={() => go(1)} aria-label={t("common.next")}>
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="showcase-caption">
        <strong>{slide.title}</strong>
        <span>{slide.prompt}</span>
      </div>
      <div className="showcase-dots">
        {SLIDES.map((s, n) => (
          <button key={s.src} className={n === i ? "on" : ""} onClick={() => setI(n)} aria-label={s.title} />
        ))}
      </div>
    </div>
  );
}

/** Shown once everything is installed, before the first Start. */
export function ReadyTips() {
  return (
    <div className="ready-tips">
      <strong>{t("welcome.readyTitle")}</strong>
      <ol>
        <li>{t("welcome.readyDrop")}</li>
        <li>
          <Trans k="welcome.readyNewImage" tags={{ b: (s) => <b>{s}</b> }} />
        </li>
        <li>
          <Trans k="welcome.readyPaint" tags={{ b: (s) => <b>{s}</b> }} />
        </li>
      </ol>
      <span className="muted">{t("welcome.readyPrivate")}</span>
    </div>
  );
}
