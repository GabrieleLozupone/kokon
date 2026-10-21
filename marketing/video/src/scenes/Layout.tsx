// Key app states at the video's window size, rendered at 1:1 to measure click targets.
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppWindow } from "../app/AppWindow";
import { appState, gen, genItem, jobItem, LORA, PROMPTS, ref, settingsState } from "../app/fixtures";
import { Preload } from "../app/Preload";

export function Layout() {
  const f = useCurrentFrame();
  const a = gen("street", "generate", PROMPTS.street);
  const base = appState();
  const states = [
    appState({ composer: { ...base.composer, prompt: PROMPTS.idea, enhance: true } }),
    appState({ composer: { ...base.composer, prompt: PROMPTS.street } }),
    appState({ session: [genItem(a)], selected: "street", composer: { ...base.composer, refs: [ref("street")] } }),
    appState({ session: [genItem(a)], selected: "street", composer: { ...base.composer, refs: [ref("street")], mask: { inputId: "m", refKey: "ref-street" }, inpaintAction: "remove", prompt: PROMPTS.remove } }),
    (() => {
      const j = jobItem("j1", "inpaint", PROMPTS.remove, "street-removed", "street", 3, "remove");
      return appState({ session: [genItem(a), j.item], selected: "j1", jobs: { j1: j.job } });
    })(),
    // 5-7: the 0.10 update video: the LoRA pill (off, then on), Settings → LoRA (beta).
    appState({ loras: [LORA], session: [genItem(a)], selected: "street", composer: { ...base.composer, prompt: PROMPTS.idea } }),
    appState({ loras: [LORA], session: [genItem(a)], selected: "street", composer: { ...base.composer, prompt: PROMPTS.idea, loras: [LORA.id] } }),
    settingsState({ session: [genItem(a)], selected: "street" }),
  ];
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Preload />
      <AppWindow state={states[Math.min(f, states.length - 1)]} width={1440} height={900} />
    </AbsoluteFill>
  );
}
