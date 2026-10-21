# Voiceover script: "Kokon 0.10" update video (2026-10-20)

About 40 s, for Reddit (it autoplays muted, so the on-screen text carries every message on its
own), YouTube and the site. Same voice and delivery as the launch take (Chatterbox base, one
sentence at a time, 0.4 s between sentences). "Prompt Plus" is spelled out for the voice; on
screen it is "Prompt+". Honest claims only: Prompt+ uses Qwen3-VL 8B, the text encoder
Qwen-Image 2.1 already loads (0.10.0 still offers an engine update, so no "nothing to
download"); LoRA is beta, tested on Windows, native Qwen-Image 2.1 LoRAs only, no catalog.

| # | Shot | Window | Line |
|---|---|---|---|
| 1 | Title (the mark, "0.10") | 0:00–0:03 | Kokon zero point ten is here. |
| 2 | Prompt+ (type, write, hatch) | 0:03–0:13 | Type a few words. Prompt Plus writes the full prompt. Then Kokon makes the image. |
| 3 | One model, two jobs | 0:13–0:21 | One model, two jobs. The model that reads your prompt now writes it, too. No second model to download. |
| 4 | LoRA (beta) | 0:21–0:27.5 | Your own LoRAs, in beta. Load one in Settings. Turn it on with one click. |
| 5 | The new look | 0:27.5–0:33.5 | And a calmer new look, spun from silk. |
| 6 | End card | 0:33.5–0:40.7 | Free, for Windows, Mac and Linux. Get it at kokon dot app. |

Takes: `gen_voice.py audition` (every sentence, a few seeds each, in voice/update-0.10/audition-<stamp>),
then `gen_voice.py build --from <that folder> --pick LINE.SENTENCE:SEED,...`, which writes
voice/update-0.10/final-<stamp>/ and copies the lines to video/public/voice-0.10 with their
sentence spans in video/src/app/voice-0.10.json. The launch take (voice/final, public/voice,
voice.json) is never touched.
