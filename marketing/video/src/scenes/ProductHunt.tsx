// Product Hunt gallery (1270×760, the size PH shows): one still per slide, rendered with
// `npm run ph`. The same message as kokon.app: Nano Banana-style edits on your own computer,
// a before/after per edit, the comparison with the cloud and ComfyUI, and what it runs on.
import type { ReactNode } from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { AppWindow } from "../app/AppWindow";
import { appState, genItem, PROJECTS, PROMPTS, ref } from "../app/fixtures";
import { CAT, REMOVED, STREET } from "./AppScenes";
import { Mark } from "../app/Mark";

const font = '"Inter Variable", Inter, sans-serif';
const INK = "#f6f6f3";
const DIM = "rgba(240,240,240,0.66)";

function Frame({ bg, children }: { bg?: string; children: ReactNode }) {
  return (
    <AbsoluteFill style={{ background: "#070707", fontFamily: font, color: INK, overflow: "hidden" }}>
      {bg && <Img src={staticFile(`img/${bg}`)} style={{ position: "absolute", inset: -60, width: 1390, height: 880, objectFit: "cover", filter: "blur(50px) brightness(0.35) saturate(1.2)" }} />}
      {children}
      <div style={{ position: "absolute", right: 34, bottom: 26, display: "flex", alignItems: "center", gap: 10, fontSize: 20, fontWeight: 620, color: DIM }}>
        <Mark size={20} color={DIM} />
        kokon.app
      </div>
    </AbsoluteFill>
  );
}

function Title({ kicker, children, top = 54 }: { kicker?: string; children: ReactNode; top?: number }) {
  return (
    <div style={{ position: "absolute", left: 60, right: 60, top, textAlign: "center" }}>
      {kicker && <div style={{ fontSize: 17, fontWeight: 650, letterSpacing: "0.16em", textTransform: "uppercase", color: DIM }}>{kicker}</div>}
      <div style={{ marginTop: kicker ? 10 : 0, fontSize: 50, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.05 }}>{children}</div>
    </div>
  );
}

/** Before and after side by side, the prompt under them. */
function Pair({ before, after, mode, prompt, kicker, title }: { before: string; after: string; mode: string; prompt: string; kicker: string; title: string }) {
  const W = 560;
  const H = 400;
  const shot = (id: string, label: string) => (
    <div style={{ position: "relative", width: W, height: H, borderRadius: 18, overflow: "hidden", boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 24px 70px rgba(0,0,0,0.55)" }}>
      <Img src={staticFile(`img/${id}.jpg`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      <span style={{ position: "absolute", top: 14, left: 14, padding: "5px 12px", borderRadius: 999, background: "rgba(10,10,10,0.6)", fontSize: 16, fontWeight: 600 }}>{label}</span>
    </div>
  );
  return (
    <Frame bg={`${after}.jpg`}>
      <Title kicker={kicker}>{title}</Title>
      <div style={{ position: "absolute", top: 196, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 30 }}>
        {shot(before, "Before")}
        {shot(after, "After")}
      </div>
      <div style={{ position: "absolute", top: 628, left: 75, right: 75, display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", borderRadius: 20, background: "rgba(22,22,22,0.88)", boxShadow: "0 0 0 1px rgba(255,255,255,0.12)" }}>
        <span style={{ padding: "5px 12px", borderRadius: 999, background: "rgba(255,255,255,0.1)", fontSize: 16, fontWeight: 600 }}>{mode}</span>
        <span style={{ fontSize: 19, color: "#e8e8e5" }}>{prompt}</span>
      </div>
    </Frame>
  );
}

const HERO_STATE = (() => {
  const base = appState();
  return appState({
    session: [genItem(STREET), genItem(REMOVED), genItem(CAT)],
    selected: "street-removed",
    compare: "slider",
    composer: { ...base.composer, refs: [ref("street-removed")] },
    projects: [{ id: "current", title: "Italian street café", updatedAt: Date.now() - 20_000, cover: "gen:street-cat", count: 3 }, ...PROJECTS],
    projectId: "current",
  });
})();

function Hero() {
  return (
    <Frame bg="street-removed.jpg">
      <div style={{ position: "absolute", left: 60, top: 0, bottom: 0, width: 450, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <Mark size={58} color={INK} />
        <div style={{ marginTop: 26, fontSize: 54, fontWeight: 720, letterSpacing: "-0.045em", lineHeight: 1.02 }}>Edit photos by describing the change.</div>
        <div style={{ marginTop: 20, fontSize: 23, lineHeight: 1.4, color: DIM }}>Like Nano Banana, but on your own computer. Free, private, no limits. Nothing to set up.</div>
      </div>
      {/* The real window (today's components), the scooter removed and the before/after slider on. */}
      <div style={{ position: "absolute", left: 556, top: 157, width: 1440 * 0.47, height: 900 * 0.47, borderRadius: 12, overflow: "hidden", boxShadow: "0 0 0 1px rgba(255,255,255,0.14), 0 40px 120px rgba(0,0,0,0.7)" }}>
        <div style={{ transform: "scale(0.47)", transformOrigin: "0 0" }}>
          <AppWindow state={HERO_STATE} width={1440} height={900} split={0.58} />
        </div>
      </div>
    </Frame>
  );
}

const ROWS: [string, string, string, string][] = [
  ["Your photos stay on your computer", "Yes", "No, uploaded", "Yes"],
  ["Free, no limits", "Yes, it's your GPU", "Daily limits or a subscription", "Yes"],
  ["Works offline", "Yes", "No", "Yes"],
  ["Setup", "One installer", "An account", "Python, nodes, model files"],
  ["Who picks the model and settings", "Kokon, tested for your GPU", "The service", "You"],
  ["Edit with one sentence", "Yes", "Yes", "After building a workflow"],
];

function Compare() {
  const cols = "300px 250px 270px 290px";
  return (
    <Frame>
      <Title kicker="Compare">Easy like the cloud. Private like your PC.</Title>
      <div style={{ position: "absolute", top: 170, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <div style={{ borderRadius: 18, overflow: "hidden", boxShadow: "0 0 0 1px rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)" }}>
          <div style={{ display: "grid", gridTemplateColumns: cols, fontSize: 18, fontWeight: 650, color: DIM }}>
            <div style={{ padding: "16px 20px" }} />
            <div style={{ padding: "16px 20px", color: INK, background: "rgba(255,255,255,0.06)" }}>Kokon</div>
            <div style={{ padding: "16px 20px" }}>ChatGPT, Gemini (Nano Banana)</div>
            <div style={{ padding: "16px 20px" }}>ComfyUI</div>
          </div>
          {ROWS.map((r) => (
            <div key={r[0]} style={{ display: "grid", gridTemplateColumns: cols, fontSize: 18, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
              <div style={{ padding: "15px 20px", color: "rgba(240,240,240,0.8)" }}>{r[0]}</div>
              <div style={{ padding: "15px 20px", fontWeight: 650, background: "rgba(255,255,255,0.06)" }}>{r[1]}</div>
              <div style={{ padding: "15px 20px", color: "rgba(240,240,240,0.55)" }}>{r[2]}</div>
              <div style={{ padding: "15px 20px", color: "rgba(240,240,240,0.55)" }}>{r[3]}</div>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}

function Runs() {
  const items: [string, string][] = [
    ["Windows, Mac, Linux", "One installer each. No Python, no ComfyUI."],
    ["NVIDIA, AMD, Intel, Apple Silicon", "12 GB of VRAM (8 GB in beta) or an M-series Mac."],
    ["Private by design", "Photos and prompts never leave your computer. Private mode keeps nothing."],
    ["Works with your AI agent", "Built-in MCP server: Claude Code or Cursor make images on your GPU."],
    ["Free and open source", "AGPL-3.0. Images for non-commercial use (model license)."],
  ];
  return (
    <Frame bg="cabin-winter.jpg">
      <Title kicker="Runs on the computer you have">Free, private, and no limits.</Title>
      <div style={{ position: "absolute", top: 172, left: 170, right: 170, display: "grid", gap: 11 }}>
        {items.map(([h, t]) => (
          <div key={h} style={{ padding: "13px 24px", borderRadius: 16, background: "rgba(18,18,18,0.8)", boxShadow: "0 0 0 1px rgba(255,255,255,0.1)" }}>
            <div style={{ fontSize: 22, fontWeight: 680 }}>{h}</div>
            <div style={{ marginTop: 4, fontSize: 18, color: DIM }}>{t}</div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** The window alone, for kokon.app (site/assets/img/app-screenshot.webp). */
export function AppShot() {
  return (
    <AbsoluteFill style={{ background: "#0a0a0a" }}>
      <div style={{ transform: `scale(${1600 / 1440})`, transformOrigin: "0 0" }}>
        <AppWindow state={HERO_STATE} width={1440} height={900} split={0.58} />
      </div>
    </AbsoluteFill>
  );
}

export const PH_SLIDES: Record<string, () => ReactNode> = {
  "ph-1-hero": Hero,
  "ph-2-remove": () => <Pair before="street" after="street-removed" mode="Remove" prompt={PROMPTS.remove} kicker="Paint an area" title="Only that area changes." />,
  "ph-3-season": () => <Pair before="cabin" after="cabin-winter" mode="Edit" prompt={PROMPTS.winter} kicker="One sentence" title="Change the season, the light, the weather." />,
  "ph-4-text": () => <Pair before="bakery" after="bakery-text" mode="Edit" prompt={PROMPTS.text} kicker="Text in images" title="It spells the words right." />,
  "ph-5-replace": () => <Pair before="room" after="room-sofa" mode="Edit" prompt={PROMPTS.replace} kicker="Replace, add, restyle, expand" title="Any edit, in plain words." />,
  "ph-6-compare": Compare,
  "ph-7-runs": Runs,
};
