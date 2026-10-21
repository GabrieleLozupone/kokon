# Voiceover script — v2 (approved 2026-10-10), 0.10 update (2026-10-20)

Tone: direct and plain-spoken, a little cheeky, confident. Short sentences, one idea each: the
app is yours and it stays on your PC. The Hook's "yours" comes back in the Outro. Times are the
scene windows in the current cut; the redesign times the scenes to these lines.

| # | Scene | Window | Line |
|---|---|---|---|
| 1 | Intro (the mark) | 0:00–0:03.4 | Introducing Kokon. |
| 2 | Hook (wall of edits) | 0:03.4–0:07.8 | Another image editor? Nope. This one is yours. |
| 3 | Create | 0:07.8–0:23.6 | Kokon runs on your PC, and everything stays there. Describe an image in a few words. Prompt Plus writes the full prompt, and your graphics card makes it. No cloud. No account. No subscription. |
| 4 | Region | 0:23.6–0:39.5 | Want to change just one thing? Paint over it, and say what you want. Remove the scooter. Add a cat. Everything else stays exactly as it was. |
| 5 | Versions | 0:39.5–0:44.6 | Changed your mind? Every version is saved. |
| 6 | Montage | 0:44.0–1:00.9 | Change the season. Fix the sign. Restyle a portrait. Swap the furniture. Expand the frame. Shoot a product ad. One sentence each. |
| 7 | Agent | 1:00.3–1:10.3 | Use an AI agent? Kokon works with it too. Just ask for an image. |
| 8 | Hardware | 1:09.7–1:17.7 | Windows, Mac or Linux. NVIDIA, AMD, Intel or Apple silicon. It runs on what you have. |
| 9 | Outro | 1:17.1–1:25.1 | Kokon. Free, open source, and yours. Try it now. Your PC already knows what to do. |

About 130 words. The take is generated with `gen_voice.py final` (voice, seeds and pauses per
line are in FINAL there); files land in voice/final/, one per line, mastered to -16 LUFS.

0.10 update (2026-10-20): Prompt+ in Create, Linux in Hardware. Only the changed sentences were
read again, with `gen_voice.py redo` / `splice` (the rest is the approved take, cut from
voice/final/raw): line 3 sentences 1-2 and line 8 sentence 0. Like the approved take, the new
lines are short sentences read one at a time with a pause between them; one long sentence
sounded rushed next to the rest. Line 6's "Shoot a product ad." is
no longer played (the montage has five edits, so the Agent scene still lands on the drop); the
line keeps its text so the file and its sentence numbers stay as approved. "Prompt Plus" is
spelled out for the voice; on screen it is "Prompt+".
