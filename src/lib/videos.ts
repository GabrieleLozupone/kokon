// Video guides on YouTube (decision 11-04): opened in the browser, never embedded, so nothing is
// fetched from Google until the user clicks. src-tauri open_link allows https://youtu.be/.
export const VIDEOS = {
  /** What Kokon can do: remove people, restore, colorize, try-ons, home, text (85 s). */
  useCases: { url: "https://youtu.be/WDbHxkbpU4s", title: "What you can do with Kokon" },
  /** 0.12: Layers lab, Blend into scene, PSD, paint with colours, Mac engine (2:21). */
  update012: { url: "https://youtu.be/eGr9yYe7NVc", title: "What's new in 0.12: Layers lab, colours" },
  /** 0.11: use Kokon from your phone or another computer (77 s). */
  remote011: { url: "https://youtu.be/XnC_7P2_cww", title: "Use Kokon from your phone" },
} as const;

