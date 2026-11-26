# Notes for translators

Context for keys whose meaning is not obvious from the English. Maintained with en.json.

layerDoc.colourRed: pencil colour name, lowercase; goes into "{colour}" of layerDoc.wantPlaceholder ("at the red marks"), lab.nothingAtMarks and lab.newObjectName, and (first letter capitalised by the code) layerDoc.colourTitle. Same for colourBlue / colourGreen / colourYellow. Pick a form that fits "at the {colour} marks" (gender/number agreement with "marks").
layerDoc.stickers: "stickers" = each object of the split cleaned into a cut-out with clean edges (like a sticker), not a decal.
layerDoc.makingStickers: see layerDoc.stickers.
layerDoc.quickCut: "Quick cut-out" = the fast, local matting of one object (vs "Clean edges", the AI redraw).
layerDoc.cleanEdges: "Clean edges" = the AI redraws the object's border as a clean cut-out; also referenced by name in other strings (keep the same wording there).
layerDoc.redraw: "Redraw at this size" = the AI draws a scaled-up object again at its new size (sharp); referenced by name in other strings.
layerDoc.fillHoles: "Fill the holes" = fill the gaps left in the background where the objects were cut out; referenced by name in other strings.
layerDoc.blend: "Blend into scene" = the AI adds shadows/reflections/contact round the objects so they sit in the scene; "Blend" is also the name of the layer it makes (layers.blend).
layerDoc.blendHint: _one "it" = the one object being blended.
layerDoc.editTogetherHint: only shown with 2+ selected objects in practice; _one kept identical to English _other so the English UI does not change.
layerDoc.layersCount: only shown with 2+ layers selected (both English forms are identical on purpose).
layerDoc.strength: strength of the Blend/Shadows layer (0–200 %).
layerDoc.scaleBadge: "{scale}×" = how much a layer is scaled up (e.g. "1.5×").
layerDoc.versionShort: "v{n}" = version number of a layer (v1, v2…).
layerDoc.phaseWaiting: status of the blend edit (capitalised sentence); layerDoc.progressWaiting is the same idea mid-sentence (lowercase, after " · ").
layerDoc.helpObject: {name} is the layer's name lowercased; the quoted part is an example prompt the user could type.
layerDoc.wantPlaceholder: the quoted part is an example of what to type ("a green glass bottle").
layerDoc.statusArea: "[ ]" are the bracket keys that change the brush size; keep them.
layerDoc.noAnswer: shown when the AI's reading of an object's scene returned nothing.
lab.whatBlend: noun phrase put into {what} of lab.phaseWhat / lab.generatingWhat / lab.failedWhat ("Generating the blend", "Waiting · the blend"). Same for whatShadows / whatScene / whatBackground; {what} can also be a layer name.
lab.editFailed: fallback error when an edit failed without a message; can follow "{what}: ".
layers.objectShadow: name of a shadow layer made for an object ("Bottle shadow"); {name} is the object's layer name.
layers.shadows: name of the Automatic shadows layer.
layers.blend: name of the layer "Blend into scene" makes.

lora.strength: how strongly the LoRA affects the image (slider 0–200 %)
lora.triggerWordsNone: placeholder of the empty trigger-words field ("none" = no trigger words)
lora.sizeFrom: {size} = file size, {source} = path of the file the user picked
aiCheck.markedAs: {what} is one of the aiCheck.source* phrases (or aiCheck.madeWithAi); keep those phrases grammatically fitting after "Marked as"
aiCheck.saysItIs: {what} is one of the aiCheck.source* phrases, or a raw IPTC term when unknown; fits after "Says it is"
aiCheck.source*: IPTC Digital Source Type in plain words; lowercase fragments inserted into aiCheck.markedAs / aiCheck.saysItIs
aiCheck.watermarkKokon: "reads" = the text decoded from the watermark; TrustMark is a product name
aiCheck.c2paNone: "None" = no Content Credentials (C2PA) in the file
aiCheck.contentCredentials: name of the C2PA standard ("Content Credentials"); may stay in English
advanced.seedRandom: placeholder of the empty seed field (a random seed is used)
advanced.referenceDetail: how detailed the reference (source) images given to the model are; options "1 MP" / "Full"
advanced.referenceDetailFull: full resolution of the reference images
advanced.editStrength: {value} is a number like 0.65
upscalers.strength: how much of the AI upscaler's result is kept versus a plain resize
upscalers.scenario*: labels of sample crops in the comparison ("1.4×" = enlargement factor)
upscalers.mosrLabel: MoSR is a model name
remote.openOnDevice: <url>…</url> wraps the address; "Share → Add to Home Screen" are the iPhone/Android menu names, use the names those systems show in the target language
remote.minChars / remote.minCharsSentence: minimum password length
settings.enhancerCustom / settings.enhancerBuiltin: shown after a Prompt+ instructions label: whether the user's own instructions or Kokon's built-in ones are in use
settings.enhancerT2i / settings.enhancerEdit / settings.enhancerCompose: names of the three Prompt+ instruction texts (for new images, edits, new images from reference images)
settings.promptPlusNoEngine: appended as a second sentence after settings.promptPlusIntro
settings.switch / settings.switchSize: button that switches to a newer model file ({size} = download size)
settings.prefixCache: cache of the edit's reference image + prompt reused across sampling steps; "8-bit" is its precision
settings.idleUnload: field label; the value is a number of minutes
settings.keepLoaded / settings.loadWhenNeeded: Mac memory mode (models stay in memory vs. loaded from SSD per step)
settings.show / settings.start: buttons next to "What's new", "Welcome screen" (Show) and "Tour" (Start)
settings.tabLora: settings tab name; LoRA stays as is

logic.minutesAgo: very short age in the project list ("5m ago"); keep it as short as possible (abbreviations ok).
logic.hoursAgo: same, hours ("3h ago").
logic.daysAgo: same, days ("2d ago").
logic.durationSeconds: compact duration, seconds ("45s").
logic.durationMinutesSeconds: compact duration ("2m 5s").
logic.durationMinutes: compact duration ("65m").
logic.sizeGB: file size; keep the unit symbol unless the language uses another one (French: Go).
logic.sizeMB: file size (French: Mo).
logic.sizeKB: file size (French: Ko).
logic.refineBest: quality preset name of an older two-pass render, shown in the Details panel.
logic.refineFast: quality preset name of an older two-pass render, shown in the Details panel.
logic.pipelineRefined: Details panel, older records: the image was re-rendered at {size} with preset {mode}; {steps} may be "?".
logic.planRenderOutputVia: Advanced panel: the model renders at {work} pixels, the file is enlarged to {out} with the upscaler {via}.
logic.benchDefault: replaces the engine's "default (paths above)" at the start of a benchmark step's label; the rest of the label stays English (engine text).
logic.overrideSampler: chip for a sampling setting changed this session; {value} is the sampler's internal name.
logic.overrideReference: chip for the "Reference detail" setting; {value} is its internal value.
logic.modeFromReferences: a new image made from reference images (people, objects) rather than an edit of one.
logic.modeExpand: outpainting (extending the image beyond its edges).
logic.cutoutModel: Layers lab status line: the cut-out (sticker) model is downloaded the first time only.
logic.cutoutMatting: Layers lab status line: the cut-out model is separating the object from its background.
logic.cutoutEdges: Layers lab status line: cleaning the cut-out's outline.
logic.installCheckingFile: verifying a downloaded model file (checksum).
logic.resultName: default name of an image added to the prompt from a result.
store.untitled: default project title before it has a prompt; stored in the project, so it stays in the language it was created in.
store.importedImage: name for an imported image whose file name is unknown.
blend.surfaceDry: Layers lab "Blend into scene": what the object stands on (choice list).
blend.shadowsFallUnder: Layers lab "Blend into scene": which way the object's shadow falls (choice list).
misc.videoUpdate012Title: title of a YouTube video (English); "colours" = painting with colours in the Layers lab.
api.stopped: shown when the user pressed Stop.
native.modelFilter: name of the file-type filter in the open-file dialog when picking a model file.
native.imagesFilter: name of the file-type filter in the open-file dialog when picking images.

# Notes for translators: D-composer.json (Composer, PromptTips, SizeMenus, Shortcuts, Tour, Welcome)

promptTips.*Prompt1 / promptTips.*Prompt2: example prompts the user sees and can copy into the prompt box ("Try it"). The model understands many languages but works best in English. Translate them only if the translated prompt still shows the same point (vague vs clear, "no laptop" vs a positive description, and so on). The text in quotes inside the poster prompts ("NIGHT JAZZ", "24 OCTOBER", "Friday 24 October · Teatro Verdi · 21:00") is what gets drawn on the image, and the images were made from the English text.
promptTips.*Label1 / *Label2: short tags above each example image (Vague / Clear, Negative / Positive…): bad vs good.
promptTips.*Note1 / *Note2: short comment on what went wrong (or right) in the example image above it.
promptTips.textLesson: "Switch Quality to Quality (native 2K)": the first "Quality" is the menu name, the second is the preset in it. Use the same words as composer.quality and composer.qualityQuality.
promptTips.nameLesson: "Paint area" is the button name (composer.paintArea).
welcome.slide*Text: captions under the before/after images, made of the steps and the prompt used (in “ ”). The quoted parts are example prompts the user may copy.
welcome.slideTextText: ‘KOKON CAFÉ’ is the text drawn on the sign in the image; keep it as is.
welcome.madeOnTitle, welcome.lead: {machine} is "Mac" or "PC".
welcome.readyNewImage, welcome.readyPaint: "New image" and "Paint area" are button names (composer.newImage, composer.paintArea); keep the <b>…</b> tags.
welcome.slideCount: "{n} / {total}" is the slide counter (3 / 7).
tour.*: "New image", "Paint area", "Slider", "Flicker", "Changes" are names of buttons in the app; use the same words as those buttons.
tour.compareText: "hold B": B is a keyboard key, keep it.
shortcuts.keyEnter / keyShift / keyEsc / keySpace: names of keyboard keys, shown on key caps. Use the name printed on keyboards in your language (or keep the English one if that is what keyboards show).
shortcuts.drag / scroll / rightClick / middleDrag: mouse actions shown like key caps (short).
shortcuts.fitActual: "Fit / 100 %": fit the image to the window, or show it at actual size.
composer.actionRemove / actionChange / actionReplace / actionAdd: what to do in the painted area (segmented buttons). Verbs in the imperative.
composer.painted*: the line saying what the prompt will do, e.g. "Clearing the painted area of image 1.2". {name} is an image name such as "image 1.2" or "this result", in lower case.
composer.editingName / expanding / addingAtMarks: same line; {name} as above.
composer.editTitleNone: "Edit " (with nothing after it): the button tooltip when there is no image yet.
composer.qualityFast / qualityBalanced / qualityQuality: names of the three quality presets (speed vs size). "~1.5K" next to Balanced is not translated.
composer.plus*: Prompt+ is a feature name (an AI rewrites the user's short prompt into a detailed English description). Keep "Prompt+" as is.
composer.plusWriteSub: "writes, then makes": Prompt+ writes the prompt, then makes the image right away.
composer.plusReviewSub: "you edit it first": Prompt+ writes the prompt into the box and waits for the user.
composer.detail*: how much the Prompt+ rewrite adds (Standard = short, Detailed = more context).
composer.percent: a LoRA weight, e.g. "80 %". Adjust the space before % to your language.
composer.loraClickOff / loraClickOn: {title} is the composer.loraOn / loraNone sentence.
composer.loraMissingShort: "missing": shown next to a LoRA whose file is gone.
composer.advancedOverridesLabel: {count} = number of advanced settings that override the quality preset.
composer.layersLab: "lab" = experimental feature.
composer.timeUnknown: shown instead of an estimated time before this computer's speed is measured.
composer.worksAt: the size the image is rendered at before upscaling.
composer.phMarks: placeholder in the prompt box when the user painted coloured marks; the quoted part is an example prompt.
sizeMenus.output: "Output 1920×1080 (16:9) · {pipeline}"; {pipeline} is a technical summary built elsewhere (lib/logic.ts planPipeline, still English).
sizeMenus.source: output size equal to the source image (image 1).

# Left in English on purpose
- Shortcuts: "Ctrl" / "⌘", single letter keys (F, B, E, H, V, Z), arrows, F2, "?", "+", "−", "[", "]", "0", "1".
- SizeMenus: "1K", "1.5K", "2K", "~1 MP", "~2.4 MP" (technical sizes); ratios like "16:9"; sizes "1920×1080".
- Composer: "LoRA" and "Prompt+" (feature names), "~1.5K"; the `{w}×{h}` size lines and the `{size} · ~{time}` plan hint (numbers only).
- Built outside my files and still English: imageName() ("Image 1.2"), formatDuration() ("12s", "1m 5s"), planPipeline() ("… render → … output"), plan.aspect_label and plan.notes (from the server), withActionVerb() (adds an English verb to the prompt sent to the model; that one is a prompt, not UI).

topBar.installConfirmNotes: {message} is the whole topBar.installConfirm(Running) sentence; {notes} are the release notes from GitHub (English, not translated).
topBar.private: short pill label meaning "private mode is on".
topBar.ready: status capsule: the model is loaded and idle. topBar.working: images are being made.
sidebar.projectTooltip_one: multi-line tooltip; {ago} is a relative time already translated elsewhere (e.g. "2 hours ago"). "version" = an image version inside a project.
sidebar.selectNone: "select none" link (deselect all); sidebar.selectAll: "select all".
sidebar.removeConfirm_one: projects are only removed from the sidebar list; images stay in the "All images" gallery (keep that name the same as sidebar.allImages).
app.starTitle: a GitHub "star" for the Kokon repository. app.starOnGitHub: button that opens GitHub to star the repo.
whatsNew.v0_12_1_moreLikeThisText: "More like this", "Subtle", "Strong" and "Regenerate" are names of buttons in the app: use the same words as their translations.
whatsNew.v0_12_1_redrawText: "Layers lab" and "Versions" are names of a panel and a section in the app.
whatsNew.v0_12_1_projectFolderText: "Settings → General → A folder for each project" is a path of menu items: match their translations.
whatsNew.withSize: {label} is a title or button text, {size} a download size like "1.2 GB".
whatsNew.watchVideo: {version} is "0.12", the release the video is about.
whatsNew.progressLeft: {left} is a time left already translated (e.g. "about 3 min left").
ownModels.wrongRoleDiffusion: the piece names here ("diffusion", "vae", "text encoder", "vision projector") are technical model-file types, lowercase on purpose.
ownModels.willDownload: starts lowercase on purpose (it is the second half of ownModels.notFoundWillDownload when no folder was searched); keep it lowercase if the language allows.
ownModels.foundSkipped_one: {summary} is ownModels.found or ownModels.foundWithDownloads.
ownModels.downloadsGoTo: {dir} is a folder path; keep the <strong> tags around it.
ownModels.chooseFolderHint: <code>ComfyUI\models</code> is a folder path: don't translate it.
ownModels.fileTypes: file extensions, keep ".gguf" and ".safetensors" as they are.
setup.gb: unit, {n} is a whole number of gigabytes.
setup.withDriver: {line} is the memory line before it (setup.vramRam etc.), {version} the graphics driver version.
setup.presetAndFolder: {preset} is a preset name like "16 GB"; {dir} the install folder path.
setup.optDownloadMissingDetail: {files} is a comma-separated list of model piece names from the service (English).
setup.needsAbout / setup.notEnoughSpace / setup.paused / setup.rate: fragments of a status line joined with " · " or " — "; they start lowercase on purpose.
setup.failedNote_one: "Check again" is the name of a button (setup.checkAgain): use the same words.
setup.promptPlusEngine: "Install" is the name of the install button (setup.install, "Install · {size}"). Prompt+ is a feature name: keep it.
setup.licenseFoot: legal text: keep license names (Qwen Research License, WTFPL, CC BY 4.0) and model/author names unchanged.
setup.engineMetalBeta / setup.engineVulkanBeta: Metal, Vulkan and CUDA are graphics API names: keep them; only "(beta)" is translated.
setup.foundSomeThere / setup.notInFolder: "Your files" is the heading of the own-models card (ownModels.yourFiles): use the same words.

stage.doingAutoFrom / doingEditFrom / doingInpaintFrom / doingOutpaintFrom / doingUpscaleFrom / doingGenerateFrom: title of a version being made; {name} is the source image already lowercased, e.g. "image 2" → "Editing image 2".
stage.doingAuto … stage.doingUpscale: same title without a source image ("v3 · Creating").
stage.linkNewSeedOf / stage.linkFrom: lowercase fragment in a timeline tooltip after " · "; {names} is like "image 2 + image 3".
stage.moreLikeThisSubtle / stage.moreLikeThisStrong: how different the "More like this" variation is from the image (variation strength), not a quality.
stage.percentValue: a percentage with a space before % (LUT intensity, LoRA weight); adapt spacing to the language.
stage.percentAria: screen-reader label for the progress percentage.
stage.timeLeft: {time} is a formatted duration ("1 min 20 s"), shown after " · " in the progress line.
stage.promptWithYours: tooltip; {prompt} is the prompt the enhancer wrote, {original} the user's own prompt; keep the blank line.
stage.infoCfg / stage.infoLut: technical terms (classifier-free guidance scale / colour look-up table); usually kept as-is.
stage.upscaleVia: {upscaler} is a model name like "Real-ESRGAN 4×" or "Lanczos".
stage.showInFinder / stage.showInExplorer: macOS Finder / Windows Explorer; use the OS's localized name for the app.
stage.emptyTip: the quoted example prompt is a suggestion shown to the user; translate it too.
layerSplit.layerName: default name of a new layer ("Layer 1"); also becomes the saved file name.
layerSplit.splittingLayer: progress; {name} is the layer name, {n} of {total} the step.
layerSplit.layerPercent: share of the image a layer covers; {pct} is already a formatted number.
layerSplit.viewActive: view button showing only the active (selected) layer.
layerSplit.exportFailed: rare internal-ish error when a canvas can't be encoded to PNG.
blendChoice.lead_one / _other: one vs several objects being blended into the scene.
blendChoice.hardShadows / softShadows: shadow kind (hard = direct sunlight).
blendChoice.theyFall: label of "where the shadows fall" (a direction picker).
blendChoice.foot / splitChoice.timeFor: {time} is "about 20 s" / "about 2 min" (aboutSeconds/aboutMinutes).
splitChoice.fast / splitChoice.quality: the two ways to cut objects out; "Clean edges (Quality)" and "Quick cut-out (Fast)" in splitChoice.lead are names of buttons elsewhere in the layers editor.
compare.modeFlicker: the view alternates the original and the result; compare.subFlicker describes it.
compare.changedShare: {pct} is a number or "<1".
viewer.browseHint: ← → are the arrow keys.

inpaint.colourRed: mark colour name, lower case as inside a sentence; the app capitalises the first letter for the swatch tooltip ("Red (1)"). Same for colourBlue / colourGreen / colourYellow.
inpaint.colours: the "Colours" painting mode (one colour per thing to add), opposite of inpaint.oneArea (a single mask).
inpaint.selectColours: "Select" = the click-to-select-an-object tool (SAM), shortcut S; (S), (B), (E), (H) are keyboard keys and must stay as written.
inpaint.brushSizeTooltip: "[ and ]" are the keyboard keys that change the brush size.
inpaint.undo: {shortcut} is e.g. "Ctrl+Z" / "⌘Z".
expand.posTopLeft: where the image sits in the enlarged canvas, fills {position} in expand.anchorTitle ("Image top left: the new space on the right, bottom"). Same for the other expand.pos* keys.
expand.spaceRight: the side(s) where the new space goes, fills {sides} in expand.anchorTitle (via expand.spaceBoth when two). Same for the other expand.space* keys.
expand.spaceBoth: joins the horizontal and vertical side phrases, {x} then {y}.
expand.sideLeft: label of the field with how much to add on the left side (px or %).
gallery.selectAllLoaded: "loaded" = only the images loaded so far (the gallery loads in pages).
phoneStage.holdToSave: "Save to Photos" is the iOS menu item's own label: use the iOS wording of the target language.
phoneStage.ideaFox: example prompt shown as a suggestion; tapping it fills the prompt box. Same for ideaReadingNook / ideaMonkey.
phoneStage.again: "Again" = generate again with the same prompt and settings, new seed.
phoneApp.privateTag: short badge meaning "private mode is on".
lut.before: hold to see the image before the LUT (without it).
lut.intensity: strength of the LUT colour look, 0-100 %.
zoomPan.fit: fit the image to the screen (button, keep short).
