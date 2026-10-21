// Where it runs (Windows and Linux: NVIDIA, AMD, Intel; macOS: Apple Silicon), then the end card.
// The facts match the website's requirements (site/index.html).
import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { siAmd, siApple, siDebian, siFedora, siGithub, siIntel, siLinux, siNvidia } from "simple-icons";
import { Mark } from "../app/Mark";
import { Backdrop, inOut, prog } from "../app/motion";
import { Sfx } from "../app/sound";
import { LENGTH, OUTRO } from "../app/timeline";

const font = '"Inter Variable", Inter, sans-serif';
const PAPER = "#F7F6F2";

function Brand({ path, color, size = 34 }: { path: string; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d={path} fill={color} />
    </svg>
  );
}

function WindowsLogo({ size = 34 }: { size?: number }) {
  const g = size * 0.06;
  const h = (size - g) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      {[0, 1].flatMap((r) => [0, 1].map((c) => <rect key={`${r}${c}`} x={c * (h + g)} y={r * (h + g)} width={h} height={h} fill={PAPER} />))}
    </svg>
  );
}

function Row({ icon, title, sub, show }: { icon: ReactNode; title: string; sub: string; show: number }) {
  const f = useCurrentFrame();
  const p = prog(f, show, 18);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "16px 0", borderTop: "1px solid rgba(255,255,255,0.08)", opacity: p, transform: `translateX(${(1 - p) * 24}px)` }}>
      <div style={{ width: 54, height: 54, borderRadius: 14, background: "rgba(255,255,255,0.06)", display: "grid", placeItems: "center", flex: "none" }}>{icon}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 25, fontWeight: 600, color: "#f2f2f2", letterSpacing: "-0.02em" }}>{title}</span>
        <span style={{ fontSize: 18, color: "rgba(240,240,240,0.55)" }}>{sub}</span>
      </div>
    </div>
  );
}

function Card({ icon, title, show, children }: { icon: ReactNode; title: string; show: number; children: ReactNode }) {
  const f = useCurrentFrame();
  const p = prog(f, show, 26);
  return (
    <div
      style={{
        width: 560,
        padding: "30px 32px 18px",
        borderRadius: 28,
        background: "linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.025))",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.09), 0 40px 100px rgba(0,0,0,0.5)",
        opacity: p,
        transform: `translateY(${(1 - p) * 50}px)`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 18 }}>
        {icon}
        <span style={{ fontSize: 34, fontWeight: 650, color: PAPER, letterSpacing: "-0.03em" }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

export const HARDWARE_FRAMES = LENGTH.hardware;

export function Hardware() {
  const f = useCurrentFrame();
  const t = prog(f, 0, 22);
  const exit = prog(f, HARDWARE_FRAMES - 14, 14, inOut);
  const chips = ["Native installer", "No Python", "Offline after setup", "Free and open source"];
  return (
    <AbsoluteFill style={{ fontFamily: font, opacity: 1 - exit }}>
      <Backdrop glow={0.9} />
      <div style={{ position: "absolute", top: 110, left: 0, right: 0, textAlign: "center", fontSize: 76, fontWeight: 660, letterSpacing: "-0.045em", color: "#f4f4f2", opacity: t, transform: `translateY(${(1 - t) * 24}px)`, filter: `blur(${(1 - t) * 8}px)` }}>
        Runs on the computer you have.
      </div>
      <div style={{ position: "absolute", top: 265, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 36 }}>
        <Card icon={<WindowsLogo />} title="Windows 10 and 11" show={14}>
          <Row icon={<Brand path={siNvidia.path} color={`#${siNvidia.hex}`} />} title="NVIDIA · CUDA" sub="12 GB of VRAM or more · 8 GB beta" show={34} />
          <Row icon={<Brand path={siAmd.path} color="#f2f2f2" />} title="AMD · Vulkan" sub="12 GB or more · beta" show={42} />
          <Row icon={<Brand path={siIntel.path} color="#f2f2f2" />} title="Intel Arc · Vulkan" sub="12 GB or more · beta" show={50} />
        </Card>
        <Card icon={<Brand path={siApple.path} color={PAPER} size={36} />} title="macOS 15 or newer" show={20}>
          <Row icon={<Brand path={siApple.path} color="#f2f2f2" />} title="Apple Silicon · Metal" sub="M1 or newer · beta" show={40} />
          <Row icon={<span style={{ fontSize: 22, fontWeight: 700, color: "#f2f2f2" }}>32</span>} title="32 GB recommended" sub="16 GB works, more slowly" show={48} />
          <Row icon={<span style={{ fontSize: 22, color: "#f2f2f2" }}>⌘</span>} title="Same app, same features" sub="One codebase for every system" show={56} />
        </Card>
        <Card icon={<Brand path={siLinux.path} color={PAPER} size={36} />} title="Linux · beta" show={26}>
          <Row icon={<Brand path={siDebian.path} color="#f2f2f2" />} title=".deb · Ubuntu, Debian, Mint" sub="Ubuntu 22.04, Debian 12, Mint 21 or newer" show={46} />
          <Row icon={<Brand path={siFedora.path} color="#f2f2f2" />} title=".rpm · Fedora" sub="Fedora 40 or newer" show={54} />
          <Row icon={<Brand path={siNvidia.path} color={`#${siNvidia.hex}`} />} title="NVIDIA CUDA · AMD Vulkan" sub="12 GB or more · 8 GB beta · Intel Arc too" show={62} />
        </Card>
      </div>
      <div style={{ position: "absolute", top: 880, left: 0, right: 0, display: "flex", justifyContent: "center", gap: 16 }}>
        {chips.map((c, i) => {
          const p = prog(f, 80 + i * 6, 18);
          return (
            <span key={c} style={{ padding: "14px 26px", borderRadius: 999, background: "rgba(255,255,255,0.07)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)", color: "#eaeaea", fontSize: 24, fontWeight: 500, opacity: p, transform: `translateY(${(1 - p) * 16}px) scale(${0.96 + p * 0.04})` }}>
              {c}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

export const OUTRO_FRAMES = LENGTH.outro;

export function Outro() {
  const f = useCurrentFrame();
  const a = prog(f, 0, 30);
  const b = prog(f, 22, 24);
  const c = prog(f, OUTRO.try - 4, 20); // kokon.app arrives with "Try it now."
  const d = prog(f, OUTRO.knows + 10, 24);
  const fade = prog(f, OUTRO_FRAMES - 24, 24, inOut);
  return (
    <AbsoluteFill style={{ fontFamily: font, background: "#050505", alignItems: "center", justifyContent: "center", opacity: 1 - fade }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 42%, rgba(247,246,242,0.06) 0%, transparent 45%)" }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30, marginTop: -40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 36, opacity: a, transform: `scale(${0.94 + a * 0.06})`, filter: `blur(${(1 - a) * 8}px)` }}>
          <Mark size={120} color={PAPER} />
          <span style={{ fontSize: 128, fontWeight: 620, color: PAPER, letterSpacing: "-0.045em", lineHeight: 1 }}>Kokon</span>
        </div>
        <div style={{ fontSize: 40, color: "rgba(247,246,242,0.8)", letterSpacing: "-0.02em", opacity: b, transform: `translateY(${(1 - b) * 14}px)` }}>Free and open source. For Windows, macOS and Linux.</div>
        <div style={{ marginTop: 18, padding: "18px 40px", borderRadius: 999, background: PAPER, color: "#0d0d0d", fontSize: 34, fontWeight: 650, letterSpacing: "-0.02em", opacity: c, transform: `translateY(${(1 - c) * 14}px)` }}>
          kokon.app
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 24, color: "rgba(247,246,242,0.62)", opacity: c, transform: `translateY(${(1 - c) * 14}px)` }}>
          <Brand path={siGithub.path} color="rgba(247,246,242,0.62)" size={22} />
          github.com/GabrieleLozupone/kokon
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 80, fontSize: 24, color: "rgba(247,246,242,0.5)", opacity: d }}>Designed and built by Gabriele Lozupone, with the help of Claude Code.</div>
      <Sfx name="hit" at={0} gain={0.8} />
    </AbsoluteFill>
  );
}
