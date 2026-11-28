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
| Add | Agregar |
| press (a button or key) / press and hold | presiona / mantén presionado |
| hair | cabello |
| trigger words (LoRA) | palabras de activación |
| Slider / Flicker / Changes (compare) | Deslizador / Parpadeo / Cambios |
| Enter key | Enter |
| Space key | Espacio / barra espaciadora |

## Spain vs Latin America

Reviewed by a native Latin American speaker (issue #60): where the two differ, the Latin American word is used, as long as it is understood in Spain too.

- **Configuración** for Settings (Windows and most Latin American apps); Spain also uses "Ajustes".
- **Agregar** for Add (Latin American apps), including the Add action button and remote.openOnDevice ("Compartir → Agregar a pantalla de inicio").
- **Enter** for the Enter key (printed on Latin American keyboards); Spain says "Intro".
- **presiona / Mantén presionado** for press / press and hold; Spain says "pulsa / Mantén pulsado".
- **video** without accent (Latin America, also accepted by the RAE); Spain writes "vídeo".
- **stickers**: used in both regions (WhatsApp).
- **laptop** (promptTips.negative*, feminine "la laptop"); Spain says "portátil".
- **moto** for the scooter in the examples: neutral.
- **básquetbol** / **cancha** / **driblando** in the monkey example; Spain says "baloncesto" / "pista" / "botando".
- **malecón**, **manubrio**, **canasta** (promptTips.detailsPrompt2); Spain says "paseo marítimo", "manillar", "cesta".
- **gato naranja**, **cafetería** (promptTips.severalPrompt1): "café" alone can read as the drink.
- **cabello** for hair; **suelo** for ground (both regions), **piso** for a tiled floor.
- **lugar** rather than "sitio", **manualmente** rather than "a mano", **conectado a la corriente** rather than "enchufado".
- **wifi** lowercase (RAE); some regions write "Wi-Fi".

## Non-literal choices / doubtful keys

- layerDoc.colourRed etc. and inpaint.colour*: masculine singular "rojo/azul/verde/amarillo" so they fit "en las marcas de color {colour}", "Objeto nuevo ({colour})" and the capitalised "{colour}: un objeto".
- layerDoc.wantPlaceholder, lab.nothingAtMarks: "las marcas de color {colour}" to avoid gender agreement with "marcas".
- layerDoc.helpObject: "Completa el objeto {name}, …" ({name} is a lowercased layer name, gender unknown).
- layerDoc.fillReady / fillHolesTitle: "se pintan con la acción Agregar" (the English "as an Add" refers to the Add action button).
- composer.advancedOverridesLabel_*: "{count} cambio(s) respecto al perfil" rather than a literal "overrides".
- composer.thisResult / thisImage: "este resultado" / "esta imagen", inserted into "Editando {name}" etc.
- stage.doingGenerateFrom: "Creando a partir de {name}" (the English "Creating image 2" would read as making image 2).
- stage.layersFrameTooltip: "Stage" translated as "el área de trabajo".
- settings.promptPlusIntro: "el modelo de lenguaje integrado en el modelo de imagen" (the English "the model's own language model").
- whatsNew.v0_12_1_fixesText: "an hour early" → "iba una hora atrasada" (the saved time was behind the real time).
- welcome.title / setup.titleWelcome: "Te damos la bienvenida a Kokon" (gender-neutral, as Microsoft/Google do) instead of "Bienvenido/a".
- welcome.lead: "Como un capullo de seda" (cocoon); bare "capullo" is a mild insult in Spain, "de seda" removes the ambiguity. Alternative: "Como una crisálida".
- promptTips example prompts: translated (the model understands Spanish), text meant to be drawn ("NIGHT JAZZ", "24 OCTOBER", "Friday 24 October · Teatro Verdi · 21:00") left in English as the images were made from it.
- logic.minutesAgo/hoursAgo/daysAgo: "hace {count} min / h / d".
- advanced.vaeTiling: "VAE por mosaicos"; settings.flashAttention and advanced.sampler kept in English (technical terms).
- ownModels.wrongRole*: "es un archivo de tipo …", piece names kept in English lowercase as the notes ask ("diffusion", "vae", "text encoder", "vision projector").
- aiCheck.contentCredentials: kept "Content Credentials" (standard name).
