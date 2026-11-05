import type { ComponentType } from "react";
import { Composition } from "remotion";
import { Preload } from "./app/Preload";
import { CREATE_FRAMES, Create, REGION_FRAMES, Region, VERSIONS_FRAMES, Versions } from "./scenes/AppScenes";
import { AGENT_FRAMES, Agent } from "./scenes/Agent";
import { HARDWARE_FRAMES, Hardware, OUTRO_FRAMES, Outro } from "./scenes/Closing";
import { Layout } from "./scenes/Layout";
import { MAIN_FRAMES, Main } from "./scenes/Main";
import { MONTAGE_FRAMES, Montage } from "./scenes/Montage";
import { Hook, Intro } from "./scenes/Opening";
import { Banner } from "./scenes/Banner";
import { Update010, UPDATE_FRAMES } from "./scenes/Update010";
import { LENGTH } from "./app/timeline";
import { REELS, ReelScene, reelFrames } from "./scenes/Reels";
import { AppShot, PH_SLIDES } from "./scenes/ProductHunt";
import { Probe011 } from "./scenes/Probe011";
import { Update011, UPDATE011_FRAMES } from "./scenes/Update011";
import { Update012, UPDATE012_FRAMES } from "./scenes/Update012";
import { VREELS, VReelScene, vreelFrames } from "./scenes/VReels";
import { UseCases, USECASES_FRAMES, USECASES_IMAGES, UseCasesThumb } from "./scenes/UseCases";

const withPreload = (C: ComponentType) => () => (
  <>
    <Preload />
    <C />
  </>
);
const S = { fps: 30, width: 1920, height: 1080 };

export function Root() {
  return (
    <>
      <Composition id="KokonLaunch" component={withPreload(Main)} durationInFrames={MAIN_FRAMES} {...S} />
      <Composition id="Update011" component={withPreload(Update011)} durationInFrames={UPDATE011_FRAMES} {...S} />
      <Composition id="Update012" component={withPreload(Update012)} durationInFrames={UPDATE012_FRAMES} {...S} />
      <Composition id="Update012UHD" component={withPreload(() => <Update012 uhd />)} durationInFrames={UPDATE012_FRAMES} {...S} />
      <Composition id="Probe011" component={withPreload(Probe011)} durationInFrames={1} {...S} />
      <Composition id="UseCases" component={() => (<><Preload extra={USECASES_IMAGES} /><UseCases /></>)} durationInFrames={USECASES_FRAMES} {...S} />
      <Composition id="UseCasesHouse4" component={() => (<><Preload extra={USECASES_IMAGES} /><UseCases music="music-usecases-house4.m4a" /></>)} durationInFrames={USECASES_FRAMES} {...S} />
      <Composition id="UseCasesThumb" component={() => (<><Preload extra={USECASES_IMAGES} /><UseCasesThumb /></>)} durationInFrames={1} fps={30} width={1280} height={720} />
      <Composition id="Update010" component={withPreload(Update010)} durationInFrames={UPDATE_FRAMES} {...S} />
      <Composition id="Montage" component={withPreload(Montage)} durationInFrames={MONTAGE_FRAMES} {...S} />
      <Composition id="Agent" component={withPreload(Agent)} durationInFrames={AGENT_FRAMES} {...S} />
      <Composition id="Hardware" component={withPreload(Hardware)} durationInFrames={HARDWARE_FRAMES} {...S} />
      <Composition id="Outro" component={withPreload(Outro)} durationInFrames={OUTRO_FRAMES} {...S} />
      <Composition id="Intro" component={withPreload(Intro)} durationInFrames={LENGTH.intro} {...S} />
      <Composition id="Hook" component={withPreload(Hook)} durationInFrames={LENGTH.hook} {...S} />
      <Composition id="Create" component={withPreload(Create)} durationInFrames={CREATE_FRAMES} {...S} />
      <Composition id="Region" component={withPreload(Region)} durationInFrames={REGION_FRAMES} {...S} />
      <Composition id="Versions" component={withPreload(Versions)} durationInFrames={VERSIONS_FRAMES} {...S} />
      <Composition id="Layout" component={Layout} durationInFrames={8} {...S} />
      {Object.entries(REELS).map(([id, r]) => (
        <Composition key={id} id={id} component={withPreload(() => <ReelScene r={r} />)} durationInFrames={reelFrames(r)} fps={30} width={1080} height={1920} />
      ))}
      {Object.entries(PH_SLIDES).map(([id, C]) => (
        <Composition key={id} id={id} component={withPreload(() => <>{C()}</>)} durationInFrames={1} fps={30} width={1270} height={760} />
      ))}
      {Object.entries(VREELS).map(([id, r]) => (
        <Composition key={id} id={id} component={withPreload(() => <VReelScene r={r} />)} durationInFrames={vreelFrames(r)} fps={30} width={1080} height={1920} />
      ))}
      <Composition id="AppShot" component={withPreload(AppShot)} durationInFrames={1} fps={30} width={1600} height={1000} />
      <Composition id="Banner" component={withPreload(Banner)} durationInFrames={1} fps={30} width={2560} height={1440} />
    </>
  );
}
