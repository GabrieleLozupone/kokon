# Marketing

Launch material for Kokon. Everything visual here was made by Kokon itself or by its own UI code.

| Folder | What |
| --- | --- |
| `showcase/` | The before/after pairs and the hero image, generated with Kokon (prompts, seeds and times in `PROMPTS.md`). Web-sized JPEGs; the full-size PNGs stay in `%USERPROFILE%\Pictures\Kokon\marketing`. |
| `video/` | The launch video, made with [Remotion](https://www.remotion.dev) from the app's own React components. |
| `release-notes-0.9.0.md` | Body of the v0.9.0 GitHub release (already in the draft). |
| `../site/` | The one-page website (static HTML, no build step). |

## The video

`video/` renders the real `Sidebar`, `Stage`, `Composer` and timeline from `../src`. Webpack swaps
the app's store, service API, native bridge and Tauri modules for mocks (`video/src/mocks`), so
each frame's UI comes from a state computed for that frame. Change the app's UI and the video
follows on the next render. Two parts are copies with the same markup and classes, because
their state lives inside the component: the paint-area editor (`app/InpaintOverlay.tsx`) and
the before/after slider (`mocks/Compare.tsx`). The job card's motion (percentage, Prompt+ text,
cocoon, hatching) runs on timers in the app; in the video `mocks/jobMotion.ts` and
`mocks/Cocoon.tsx` drive the same code (`src/components/jobMotion.ts`, `drawCocoon`, `paintHatch`)
from the frame, through `<AppWindow card={…}>`, since Remotion renders frames out of order. CSS
loops follow the frame through `--vt` (`app/theme.css`).

```powershell
cd marketing/video
npm install
npm run studio                    # preview and scrub in the browser
npm run render                    # out/kokon-launch.mp4, 1920×1080, ~85 s, about 5 minutes
npx remotion render KokonLaunch out/kokon-launch-0.10.mp4   # same, to a new file (keep old renders)
```

Scenes (`src/scenes`): Intro (the mark assembles) → Hook (wall of before/afters) → Create (a few
words, Prompt+ writes the prompt, the image hatches) → Region (paint, remove, add) → Versions →
Montage (five edits, full frame) → Agent (MCP) → Hardware (Windows, macOS, Linux) → Outro. Each scene is also its own composition, so one can be rendered alone, for example
`npx remotion render Montage out/montage.mp4` (the voice and music play only in `KokonLaunch`).

**"Kokon 0.10" update video** (`Update010`, ~41 s, for Reddit, YouTube and the site): Prompt+
(a few words, the prompt written, the image hatching on the drop), "One model. Two jobs." (Prompt+
runs on the Qwen3-VL 8B text encoder Qwen-Image 2.1 already loads), your own LoRAs (beta: Settings,
then the LoRA pill), the new look, the end card. Its clock is `src/app/timeline010.ts` (beats,
shots, voice cues), its scenes `src/scenes/Update010.tsx`, its script `audio/voiceover-0.10.md`.
Until its own takes exist it plays the launch track's tail and no voice (`voice-0.10.json` holds
estimated spans, marked `_provisional`).

```powershell
python audio/gen_music.py update                                   # takes/update-<stamp>-N.wav (ACE-Step API running)
D:/AI/tts/.venv/Scripts/python audio/gen_voice.py audition         # voice/update-0.10/audition-<stamp>/
D:/AI/tts/.venv/Scripts/python audio/gen_voice.py build --from audio/voice/update-0.10/audition-<stamp> --pick 1.0:11,2.0:11,...
npx remotion render Update010 out/kokon-0.10-update.mp4            # in video/, 1920×1080
```

`src/app/timeline.ts` is the film's clock: scene lengths, the frame where each voice-over sentence
plays, the frames of the actions the voice names (Remove, Add, the montage cuts) and the music's
beat grid. Retime there and pictures, voice and music move together.

Sound (`src/app/sound.tsx`, all levels in one table):

- **Voice-over**: `public/voice/NN.wav`, one file per line of `audio/voiceover.md`, generated
  locally with [Chatterbox](https://github.com/resemble-ai/chatterbox) (MIT) by
  `audio/gen_voice.py final`, which also writes `src/app/voice.json` (where each sentence starts
  and ends) so sentences can be placed one by one. To change single sentences, `gen_voice.py redo`
  and `splice` keep the rest of the approved take (usage at the top of the script). The music ducks about 8 dB under it.
- **Music**: `public/music.m4a`, generated locally with [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5)
  (MIT, output usable commercially) by `audio/gen_music.py`: take `house-4`, 118 BPM, with two bars
  removed from its breakdown so the second drop (60.3 s) lands on the Agent scene.
- **Effects**: `public/sfx/*.wav`, synthesized from scratch by `audio/make_sfx.py` (no samples, no
  licences), kept sparse: typing only in the first demo, quiet clicks, a soft reveal in three
  variants that take turns when a result appears, whooshes only on big moves.

To regenerate music, start the ACE-Step API (`uv run acestep-api` in its folder) and run
`python audio/gen_music.py house`; takes land in `audio/takes/` (git-ignored).

The website uses a lighter copy: `site/assets/kokon.mp4` (CRF 25, ~17 MB; it autoplays muted and its "Watch with sound" button restarts it with sound) and
`site/assets/kokon-poster.jpg`. Browsers cache them for a week, so after replacing either one raise the
`?v=` number where the page links them (`site/index.html`, `site/sitemap.xml`, `site/assets/style.css`;
the same for `style.css` in every page that links it). To refresh them after a new render:

```powershell
ffmpeg -y -i marketing/video/out/kokon-launch-0.10.mp4 -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart site/assets/kokon.mp4
ffmpeg -y -ss 38.5 -i marketing/video/out/kokon-launch-0.10.mp4 -frames:v 1 -q:v 3 site/assets/kokon-poster.jpg
```

## The website

`site/index.html` plus `site/assets/`: one static page that links every download button to the
latest GitHub release. Open the file in a browser to preview it. To publish it, any static host
works; the simplest are:

- **GitHub Pages** (free once the repository is public): Settings → Pages → Deploy from a branch
  is limited to `/` or `/docs`, so either move `site/` to its own `gh-pages` branch or use a
  small Pages workflow that uploads `site/`.
- **Cloudflare Pages, Netlify or Vercel**: point them at the repository with `site` as the
  output folder and no build command.
