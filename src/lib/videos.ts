// Video guides on YouTube (decision 11-04): opened in the browser, never embedded, so nothing is
// fetched from Google until the user clicks. src-tauri open_link allows https://youtu.be/.
import { t } from "./i18n";

// Titles are getters: read when shown, so they follow the UI language.
export const VIDEOS = {
  /** What Kokon can do: remove people, restore, colorize, try-ons, home, text (85 s). */
  useCases: { url: "https://youtu.be/WDbHxkbpU4s", get title() { return t("misc.videoUseCasesTitle"); } },
  /** 0.12: Layers lab, Blend into scene, PSD, paint with colours, Mac engine (2:21). */
  update012: { url: "https://youtu.be/eGr9yYe7NVc", get title() { return t("misc.videoUpdate012Title"); } },
  /** 0.11: use Kokon from your phone or another computer (77 s). */
  remote011: { url: "https://youtu.be/XnC_7P2_cww", get title() { return t("misc.videoRemote011Title"); } },
} as const;

