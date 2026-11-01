import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// Tauri expects a fixed dev port and no browser auto-open.
export default defineConfig({
  plugins: [react()],
  // A browser page compares it with the service's after an app update (store.ts refreshStatus).
  define: { __KOKON_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  // warmup: compile the app as soon as the dev server starts, not when the window asks for it.
  server: { port: 1420, strictPort: true, host: "127.0.0.1", warmup: { clientFiles: ["./src/main.tsx"] } },
  // onnxruntime-web (layers lab, lib/sam.ts) finds its .wasm next to its own module: no pre-bundling.
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
