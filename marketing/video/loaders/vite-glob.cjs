// Vite's import.meta.glob (the upscaler sample crops in Upscalers.tsx) has no webpack
// equivalent; the video never shows those crops, so the call becomes an empty map.
module.exports = function viteGlob(source) {
  return source.replace(/import\.meta\.glob\([^)]*\)/g, "({})");
};
