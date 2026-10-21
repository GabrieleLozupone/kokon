import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and no browser auto-open.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // warmup: compile the app as soon as the dev server starts, not when the window asks for it.
  server: { port: 1420, strictPort: true, host: "127.0.0.1", warmup: { clientFiles: ["./src/main.tsx"] } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { include: ["src/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
