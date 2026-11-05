# Voiceover script: "Kokon 0.12" video (2026-11-03)

About 3 min, for Reddit (it autoplays muted, so the on-screen text carries every message on its
own), then YouTube. Built on Gabriele's two screen recordings, shown whole and in order (Layers
lab on the Halloween poster, then Colours on the kitchen); the voice comments what is on screen
as it happens. Same voice as the 0.10 and 0.11 videos (Chatterbox base, built-in voice, one
sentence at a time, calmer and expressive). "0.12" is spelled out for the voice. Honest claims
only: Blend into scene is experimental; the inpaint result is pasted on the original outside the
painted area; Mac times measured on an M2 Pro 16 GB, 1024², Qwen-Image 2.1 Turbo, 8 steps
(sd.cpp 276 s, Kokon's Mac engine ~65 s).

| # | Shot | Window | Line |
|---|---|---|---|
| 1 | Opening: the poster | 0:00–0:04 | Kokon zero point twelve. |
| 2 | Layers (lab) opens | 0:04–0:07 | This is the new Layers lab. |
| 3 | First click, on the text | 0:07–0:12 | Click each thing you want on its own layer. |
| 4 | The clicks, one name each | 0:12–0:42 | The text. The bats. The ghosts. The spider. And the girl. |
| 5 | Fast or Quality | 0:43–0:47 | Quality: the AI redraws each edge as a clean cut-out. |
| 6 | Stickers and fill, 8x | 0:47–1:00 | Each object becomes its own layer, and the background behind them is painted in. |
| 7 | The layers appear | 1:00–1:04 | Same picture, but every piece moves on its own. |
| 8 | Hide, move, resize | 1:04–1:18 | Hide the bats. Move the spider: the street behind it is already there. Make the girl bigger. |
| 9 | Expand on the spider | 1:26–1:42 | The spider was cut off by the frame. Edit just its layer: extend it, and ask to complete it. |
| 10 | Spider completed | 1:45–1:48 | Only the spider changes. |
| 11 | Blend dialog | 1:48–1:54 | Blend into scene is experimental. The AI reads where each object stands: dry ground, soft shadows, under it. |
| 12 | Blending, 6x | 1:54–1:58 | Then it draws the shadows, or reflections on wet or shiny ground. |
| 13 | Result, strength | 1:58–2:07 | Too strong? Turn it down. Then export to PSD, and keep going in Photoshop or similar. |
| 14 | Paint area opens | 2:07–2:11 | Next: painting with colours. |
| 15 | Red area, box on the image | 2:11–2:25 | Paint where something should go. Then say what goes there, right on the picture. |
| 16 | Blue area | 2:25–2:33 | Blue: a pizza on a plate. |
| 17 | Prompt+ review | 2:38–2:47 | Prompt+ turns it into one detailed request. |
| 18 | Result | 2:52–3:01 | The bottle and the pizza, where you painted them. Only what you painted changes. |
| 19 | Mac engine card | 3:01–3:13 | On a Mac, Kokon now runs its own engine: about a minute for a one-megapixel image on an M2 Pro, four times faster than before. |
| 20 | End card | last 8 s | Kokon zero point twelve is out now. Haven't tried it yet? Get it today. It's free, and it runs on your own computer. |

Round 2 (Gabriele, 11-03): not placed in the video any more: line 8 sentences 1 and 3 ("Hide the bats.", "Make the girl
bigger.": the girl is only moved), line 16 ("Blue: a pizza on a plate."), line 18 sentence 1 ("The bottle and the
pizza…"). Line 20 added for the end card.

Takes: `gen_voice.py audition-012` (every sentence in two tones, calmer and expressive, three
seeds each, in voice/update-0.12/audition-<stamp>), then
`gen_voice.py build-012 --from <that folder> --pick LINE.SENTENCE:SEED,...`, which writes
voice/update-0.12/final-<stamp>/ and copies the lines to video/public/voice-0.12 with their
sentence spans in video/src/app/voice-0.12.json.
