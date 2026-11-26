# Spanish (es) translation notes

Neutral international Spanish: "tú", no "vosotros", no voseo. Buttons in the infinitive ("Guardar", "Cancelar"), sentence case, ¿ ¡ on questions/exclamations. "computer" → "equipo" (or "PC" where the English says PC), never "ordenador"/"computadora".

## Glossary

| English | Spanish |
|---|---|
| edit (noun / verb) | edición / editar |
| image | imagen |
| project | proyecto |
| gallery / All images | galería / Todas las imágenes |
| brush / mask / eraser / pencil | pincel / máscara / borrador / lápiz |
| Paint area (button) | Pintar zona |
| painted area | zona pintada |
| inpainting (progress) | Retocando zona |
| Expand (outpaint) | Expandir (expansión) |
| Upscale (button) / upscaling | Ampliar / ampliando, ampliación |
| upscaler | escalador |
| layers / Layers lab | capas / Laboratorio de capas ("Capas (lab)" as title) |
| Fast / Balanced / Quality | Rápido / Equilibrado / Calidad |
| preset (quality or VRAM preset) | perfil |
| LUT presets | preajustes |
| Settings (screen) | Configuración |
| settings (generic parameters) | ajustes |
| More like this / Subtle / Strong | Más como esta / Sutil / Fuerte |
| Regenerate | Regenerar |
| Redraw at this size | Redibujar a este tamaño |
| Clean edges / Quick cut-out | Limpiar bordes / Recorte rápido |
| Fill the holes | Rellenar huecos |
| Blend into scene / Blend layer | Integrar en la escena / Integración |
| Automatic shadows | Sombras automáticas |
| stickers | stickers |
| Private mode | Modo privado |
| reference image | imagen de referencia |
| seed / steps / sampler | semilla / pasos / sampler |
| graphics card / GPU / VRAM | tarjeta gráfica / GPU / VRAM ("memoria de la GPU") |
| download | descargar / descarga |
| engine / service | motor / servicio |
| prompt | prompt (masculine: "el prompt") |
| LoRA | LoRA (masculine: "el LoRA", plural "los LoRA") |
| Remove (from list/project) / Delete (from disk) | Quitar / Eliminar |
| Add | Añadir |
| Slider / Flicker / Changes (compare) | Deslizador / Parpadeo / Cambios |
| Enter key | Intro |
| Space key | Espacio / barra espaciadora |

## Spain vs Latin America (for the native reviewer)

- **Configuración** for Settings (Windows and most Latin American apps); Spain also uses "Ajustes" (Android/iOS in Spain). Chose the one used everywhere on Windows.
- **Añadir** vs **Agregar**: chose "Añadir" (standard in Spain, understood everywhere); Latin American apps often say "Agregar".
- **Intro** for the Enter key (Spanish keyboards, Google/Microsoft Spain); Latin American keyboards usually print "Enter".
- **video** without accent (Latin America, also accepted by the RAE); Spain writes "vídeo" (remote.video, remote.videoTitle, whatsNew.watchVideo, topBar.videoGuides "Videotutoriales").
- **Compartir → Añadir a pantalla de inicio** (remote.openOnDevice): iOS Spanish wording; Android in Latin America may show "Agregar a la pantalla principal".
- **stickers**: used in both regions (WhatsApp); Spain also says "pegatinas", Latin America "calcomanías".
- **portátil** (promptTips.negative*): Spain; Latin America says "laptop". Kept because the example point (a "no X" prompt) still works.
- **moto** for the scooter in the examples (welcome.slideRemoveText, tour.versionsText, promptTips.severalPrompt1): neutral; "patinete/escúter" (Spain) and "motoneta" (Latin America) differ.
- **baloncesto** / **cancha**: "baloncesto" is Spain, Latin America says "básquetbol" but understands it; "cancha" is the Latin American word (Spain says "pista"), understood in Spain.
- **pelo** for hair (both), **suelo** for ground/floor (Spain; Latin America also says "piso" for floor).
- **Mantén pulsado** for "press and hold": Spain; Latin America often says "Mantén presionado".
- **wifi** lowercase (RAE); some regions write "Wi-Fi".

## Non-literal choices / doubtful keys

- layerDoc.colourRed etc. and inpaint.colour*: masculine singular "rojo/azul/verde/amarillo" so they fit "en las marcas de color {colour}", "Objeto nuevo ({colour})" and the capitalised "{colour}: un objeto".
- layerDoc.wantPlaceholder, lab.nothingAtMarks: "las marcas de color {colour}" to avoid gender agreement with "marcas".
- layerDoc.helpObject: "Completa el objeto {name}, …" ({name} is a lowercased layer name, gender unknown).
- layerDoc.fillReady / fillHolesTitle: "se pintan con la acción Añadir" (the English "as an Add" refers to the Add action button).
- composer.advancedOverridesLabel_*: "{count} cambio(s) respecto al perfil" rather than a literal "overrides".
- composer.thisResult / thisImage: "este resultado" / "esta imagen", inserted into "Editando {name}" etc.
- stage.doingGenerateFrom: "Creando a partir de {name}" (the English "Creating image 2" would read as making image 2).
- stage.layersFrameTooltip: "Stage" translated as "el área de trabajo".
- settings.promptPlusIntro: "el propio modelo de lenguaje del modelo" mirrors the English; could be smoothed to "el modelo de lenguaje integrado".
- whatsNew.v0_12_1_fixesText: "an hour early" → "iba una hora atrasada" (the saved time was behind the real time).
- welcome.title / setup.titleWelcome: "Te damos la bienvenida a Kokon" (gender-neutral, as Microsoft/Google do) instead of "Bienvenido/a".
- welcome.lead: "Como un capullo de seda" (cocoon); bare "capullo" is a mild insult in Spain, "de seda" removes the ambiguity. Alternative: "Como una crisálida".
- promptTips example prompts: translated (the model understands Spanish), text meant to be drawn ("NIGHT JAZZ", "24 OCTOBER", "Friday 24 October · Teatro Verdi · 21:00") left in English as the images were made from it.
- logic.minutesAgo/hoursAgo/daysAgo: "hace {count} min / h / d".
- advanced.vaeTiling: "VAE por mosaicos"; settings.flashAttention and advanced.sampler kept in English (technical terms).
- ownModels.wrongRole*: piece names kept in English lowercase as the notes ask ("diffusion", "vae", "text encoder", "vision projector").
- aiCheck.contentCredentials: kept "Content Credentials" (standard name).
