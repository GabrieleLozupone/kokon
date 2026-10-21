// Remotion renders the app's own React components (../../src). The store, the service API,
// the native bridge and Tauri are swapped for mocks, so each frame's UI comes from state
// computed for that frame.
import { Config } from "@remotion/cli/config";
import path from "path";
import webpack from "webpack";

const root = process.cwd();
const app = path.resolve(root, "../../src");
const mock = (f: string) => path.resolve(root, "src/mocks", f);

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setConcurrency(4);
// Standard web video colour (BT.709, limited range): untagged full-range output shows grey
// blacks in browsers that hand the video straight to the GPU.
Config.setColorSpace("bt709");

Config.overrideWebpackConfig((c) => {
  const swap = (re: RegExp, file: string) =>
    new webpack.NormalModuleReplacementPlugin(re, (r: { context?: string; request: string }) => {
      if (r.context && path.resolve(r.context).startsWith(app)) r.request = mock(file);
    });
  return {
    ...c,
    module: {
      ...c.module,
      rules: [
        // Vite's "?raw" (the mark's SVG source, inlined by the wordmark) as webpack's asset/source.
        ...(c.module?.rules ?? []).map((r) => (r && typeof r === "object" && r.type === "asset/resource" ? { ...r, resourceQuery: { not: [/raw/] } } : r)),
        { resourceQuery: /raw/, type: "asset/source" },
        { test: /\.tsx?$/, include: app, enforce: "pre" as const, use: path.resolve(root, "loaders/vite-glob.cjs") },
      ],
    },
    resolve: {
      ...c.resolve,
      alias: {
        ...(c.resolve?.alias as Record<string, string>),
        // One React for the app's components and Remotion.
        react: path.dirname(require.resolve("react/package.json")),
        "react-dom": path.dirname(require.resolve("react-dom/package.json")),
        "@tauri-apps/api/core": mock("tauri.ts"),
        "@tauri-apps/api/window": mock("tauri.ts"),
        "@tauri-apps/api/webview": mock("tauri.ts"),
        "@tauri-apps/plugin-dialog": mock("tauri.ts"),
        "@tauri-apps/plugin-clipboard-manager": mock("tauri.ts"),
        "@tauri-apps/plugin-process": mock("tauri.ts"),
        "@tauri-apps/plugin-updater": mock("tauri.ts"),
        "@tauri-apps/plugin-opener": mock("tauri.ts"),
      },
    },
    plugins: [
      ...(c.plugins ?? []),
      swap(/^(\.\.?\/)+(lib\/)?store$/, "store.ts"),
      swap(/^(\.\.?\/)+(lib\/)?api$/, "api.ts"),
      swap(/^(\.\.?\/)+(lib\/)?native$/, "native.ts"),
      swap(/^\.\/Compare$/, "Compare.tsx"),
      swap(/^\.\/Cocoon$/, "Cocoon.tsx"),
      swap(/^\.\/jobMotion$/, "jobMotion.ts"),
    ],
  };
});
