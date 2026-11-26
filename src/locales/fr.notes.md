# French translation notes (fr.json)

1616 keys, same order as en.json. "Vous" throughout; buttons in the infinitive; French typography
applied by script: U+00A0 before ":" and "%" and inside « », U+202F before ; ? !, U+00A0 between a
number and its unit (224 Mo, 12 Go, 3 px, 20 s).

## Glossary

| English | French |
|---|---|
| edit (noun / verb) | modification / modifier |
| image / project / gallery | image / projet / galerie |
| All images | Toutes les images |
| New image | Nouvelle image |
| brush / eraser / pencil / mask | pinceau / gomme / crayon / masque |
| Paint area | Peindre une zone |
| expand (outpaint) | Étendre (button), extension (noun) |
| upscale / upscaler | Agrandir, agrandissement / agrandisseur (the photographic "enlarger"); "modèle d'agrandissement" where it is the model |
| layers / Layers lab | calques / Labo des calques; "Layers (lab)" = Calques (labo) |
| Fast / Balanced / Quality | Rapide / Équilibré / Qualité |
| quality preset | préréglage de qualité |
| memory preset (12/16/24/32 GB) | profil (kept apart from the quality préréglage) |
| Settings | Paramètres |
| More like this / Subtle / Strong | Dans le même esprit / Léger / Marqué |
| Regenerate / Again | Régénérer / Encore |
| Redraw at this size | Redessiner à cette taille |
| Clean edges / Quick cut-out | Bords nets / Détourage rapide |
| cut-out (verb/noun) | détourer / détourage |
| stickers | autocollants |
| Fill the holes | Combler les trous |
| Blend into scene / Blend (layer) | Fondre dans la scène / Fusion |
| Shadows / Automatic shadows | Ombres / Ombres automatiques |
| Private mode | Mode privé |
| reference image | image de référence |
| seed | graine |
| steps | étapes |
| sampler | échantillonneur |
| graphics card / GPU / VRAM | carte graphique / GPU / VRAM |
| graphics chip | puce graphique |
| download | télécharger |
| engine / service | moteur / service |
| inference server | serveur d'inférence |
| text encoder / vision projector / decoder | encodeur de texte / projecteur de vision / décodeur |
| prompt | prompt (masc.) |
| prompt enhancer | assistant de prompt |
| Slider / Flicker / Changes | Curseur / Alternance / Différences |
| Undo / Redo | Annuler / Rétablir |
| Remove (from list/project) / Delete (from disk) | Retirer / Supprimer |
| Dismiss | Fermer |
| Tour / Welcome screen | Visite guidée / Écran d'accueil |
| Favorite | Favori |
| GB / MB / KB / GiB / MiB | Go / Mo / Ko / Gio / Mio (French units, as NOTES.md suggests) |

## Non-literal choices and doubts

- Units: GB/MB → Go/Mo everywhere (also in prose like "224 Mo", "12 Go"), to match logic.sizeGB/sizeMB. MP, px, 2K, 4K unchanged.
- Keys: "Esc" and "Shift" kept as written (hard rule), so "Shift+clic", "(Esc)". Microsoft French would say "Maj" and "Échap"; switch if preferred. "Enter"/"Space" localized as "Entrée"/"Espace" (shortcuts.keyEnter/keySpace and in sentences).
- stage.doing*From, composer.painted*, composer.editingName/expanding/addingAtMarks: {name} is a bare "image 2", which in French needs an article ("de l'image 2"). Written with a colon instead: "Modification : {name}", "Modification de la zone peinte : {name}". Same idea for stage.linkFrom ("source : {names}") and stage.linkNewSeedOf ("nouvelle graine, source : {names}"), and composer.editTitleShown ("Modifier l'image affichée ({name})").
- layerDoc.colour* / inpaint.colour*: masculine colour nouns (rouge, bleu, vert, jaune), used as "les marques en {colour}" so they never need agreement.
- layers.objectShadow: "{name} (ombre)" — no colon, since layer names can become file names.
- aiCheck.markedAs / saysItIs: "Marquée comme {what}" / "Se décrit comme {what}"; the source* fragments are feminine (une image): "créée avec l'IA générative", "une capture d'écran"…
- aiCheck.contentCredentials: kept in English (standard name); aiCheck.c2paPresent "Présents (non vérifiés ici)".
- settings.idleUnload: "Libérer la carte graphique après inactivité (minutes)" (label whose value is minutes).
- settings.prefixCache8bit: "8 bits".
- logic.minutesAgo / hoursAgo / daysAgo: "il y a {count} min / h / j". Durations: "{seconds} s", "{minutes} min {seconds} s".
- logic.installLeft and stage.timeLeft: "encore {time}" (avoids gender agreement with an unknown unit).
- logic.modeInpaint / stage.doingInpaint: "Retouche de zone" (no common French word for inpainting).
- logic.refineBest: "Meilleure" (qualité implied).
- blendChoice.theyFall: "Direction" (label of the direction picker; "Elles tombent" reads badly as a label).
- blend.shadowsFallFront/Back: "Vers l'objectif" / "À l'opposé de l'objectif".
- shortcuts.scroll "Molette", shortcuts.middleDrag "Glisser (bouton du milieu)": a bit longer than English on a key cap.
- remote.openOnDevice: iOS French "Partager → Sur l'écran d'accueil"; Android/Chrome "Ajouter à l'écran d'accueil".
- phoneStage.holdToSave: iOS French "Enregistrer dans Photos".
- stage.showInExplorer: "Afficher dans l'Explorateur"; showInFinder: "Afficher dans le Finder".
- stage.layersFrameTooltip: "Stage" rendered as "la vue principale".
- composer.advancedOverridesLabel_*: "{count} réglage(s) personnalisé(s) actif(s)" for "overrides".
- welcome.lead: the cocoon sentence slightly reworded ("rien n'en sort sans vous").
- Example prompts (promptTips.*Prompt*, welcome.slide*Text, tour.describeText, phoneStage.idea*, stage.emptyTip, layerDoc.helpObject) translated into natural French using the "tu" imperative that people type to the model ("Remplace…", "Rends la pièce…"); text drawn in the image ("NIGHT JAZZ", "24 OCTOBER", "Friday 24 October · Teatro Verdi · 21:00", 'KOKON CAFÉ') unchanged. If the examples should stay English (the model works best in English), these are the keys to revert.
- promptTips.negativeLesson: "« Une plage déserte », pas « personne sur la plage »" (French "pas de gens" would itself be the negative trap).
- settings.benchText / benchPasteHint: "chip-specific path" → "optimisation propre à la puce".
- settings.modelMemoryHint: "macOS cannot swap memory the GPU is using" → "ne peut pas déplacer vers le disque la mémoire utilisée par le GPU".
