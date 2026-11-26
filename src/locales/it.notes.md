# Italian translation notes (it.json)

1616 keys, informal "tu", imperative buttons ("Salva", "Annulla", "Apri"). Straight ' apostrophes as in en.json; “ ” kept for example prompts.

## Glossary
| English | Italiano |
|---|---|
| edit (noun / verb) | modifica / modifica, modificare |
| image | immagine |
| project | progetto |
| gallery / All images | galleria / Tutte le immagini |
| brush / mask / eraser / pencil | pennello / maschera / gomma / matita |
| Paint area | Dipingi area (painted area = area dipinta) |
| expand (outpaint) | Espandi / espansione |
| upscale (action) / upscaler (model) | Ingrandisci, ingrandimento / upscaler |
| layers / Layers lab | livelli / Lab livelli; "Layers (lab)" = "Livelli (lab)" |
| Fast / Balanced / Quality | Veloce / Bilanciato / Qualità |
| Settings / General / Models / Performance | Impostazioni / Generali / Modelli / Prestazioni |
| More like this · Subtle · Strong | Altre simili · Leggera · Forte |
| Regenerate | Rigenera |
| Redraw at this size | Ridisegna a questa misura |
| Private mode | Modalità privata |
| reference image | immagine di riferimento |
| seed / sampler / steps | seed / sampler / passaggi |
| graphics card / GPU / VRAM | scheda video / GPU / VRAM (memoria della GPU) |
| download | scarica (verb), download (noun) |
| engine / service / inference server | motore / servizio / server di inferenza |
| Generate | Genera |
| cut-out / Quick cut-out / Clean edges | scontorno / Scontorno rapido / Bordi puliti |
| stickers | adesivi |
| Fill the holes | Riempi i buchi |
| Blend into scene / Blend layer | Integra nella scena / livello Integrazione |
| Slider / Flicker / Changes (compare) | Cursore / Alterna / Differenze |
| strength | intensità |
| text encoder, VAE, LoRA, Prompt+, preset, prompt | unchanged |

## Non-literal or doubtful choices
- layerDoc.colour* / inpaint.colour*: singular masculine ("rosso", "blu"…). Sentences built as "dove hai segnato in {colour}" so the colour name needs no agreement with "marks"; also fits "Nuovo oggetto (rosso)" and "Rosso: un oggetto".
- lab.what*: include the article ("l'integrazione", "le ombre"), since lab.generatingWhat is "Sto generando {what}". A layer name in {what} reads without article, which is fine.
- stage.doing*From / composer.editingName etc.: "Modifica di {name}", "Modifico {name}": no article before {name} ("immagine 2"), treated as a label.
- stage.doingInpaint: "Ritocco dell'area" (process noun); logic.modeInpaint: "Area dipinta" (mode label).
- common.on / common.off: "Attivo" / "Disattivato" (used in the Prompt+ menu and settings selects).
- shortcuts.keyEnter / keySpace: "Invio" / "Spazio" (Italian keyboards); Shift kept as "Shift", also in "Shift+clic".
- shortcuts.scroll: "Rotella" (mouse wheel), shorter than "Scorri".
- photoReview.flip: "Specchia" (the code mirrors the selfie, not an upside-down flip).
- zoomPan.zoomIn/Out: "Aumenta lo zoom" / "Riduci lo zoom", to avoid clashing with "Ingrandisci" (upscale).
- settings.switch: "Passa al nuovo" (switch to the newer model file).
- welcome.title / setup.titleWelcome: "Ti diamo il benvenuto in Kokon" (gender-neutral, as Apple/Google Italian do).
- gallery.favorite / stage.favorite (tooltips): "Aggiungi ai preferiti"; phoneStage.favorite (also a short button label): "Preferita".
- topBar.private / phoneApp.privateTag: "Privata" (agrees with "modalità").
- logic.minutesAgo/hoursAgo/daysAgo: "{count} min fa", "{count} h fa", "{count} g fa". Compact durations ("{minutes}m {seconds}s") kept as in English.
- logic.planRenderOutput(Via): "render {work} → file {out}" ("output" rendered as the saved file); sizeMenus.output: "File {width}×{height}…".
- remote.openOnDevice: iOS "Condividi → Aggiungi alla schermata Home"; Android Chrome "Aggiungi a schermata Home".
- phoneStage.holdToSave: iOS menu item "Salva in Foto".
- settings.supportText: "tip" → "una piccola donazione".
- aiCheck.markedAs / saysItIs: "Indicata come {what}" / "Dichiara di essere {what}" (image = feminine); source phrases written to fit after both.
- promptTips example prompts are translated (the point of each still holds); text drawn in the image ("NIGHT JAZZ", "24 OCTOBER", "Friday 24 October · Teatro Verdi · 21:00", ‘KOKON CAFÉ’) left in English. These prompts were generated in English, so the shown images match the English text, not the Italian one.
- promptTips.textLesson: "In Qualità scegli Qualità (2K nativo)".
- promptTips.checklist: "Promemoria" rather than "Checklist".
- ownModels.wrongRole*: piece names kept technical and lowercase ("file diffusion", "file vae").
- sidebar.removeConfirm_one, gallery.deleteManyConfirm_one, phoneApp.removeProjectsConfirm_one: {count} dropped ("il progetto", "l'immagine").
- layerDoc.layersCount_one / editTogetherHint_one: identical to _other, as in English.
