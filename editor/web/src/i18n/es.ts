/**
 * Default (and, for now, only) locale: Spanish. Keys are English and
 * dot-namespaced by screen/component; values are the product copy shown to
 * the user, which stays Spanish per CLAUDE.md ("UI de producto ... es
 * decisión de producto, no técnica").
 *
 * `{name}`-style placeholders (e.g. `{count}`, `{slug}`) are interpolated
 * by `t()` in `./index.ts`.
 */
export const es = {
  // Shared across panes/routes — keep here, not under one screen's namespace
  "common.originAi": "IA",
  "common.filesCount": "{count} archivos",
  "common.pinnedNoRegenerate": "Fijado: no se puede regenerar hasta que lo liberes.",
  "common.newTextPlaceholder": "Texto",

  // Profile picker (routes/ProfilePickerRoute.tsx)
  "profilePicker.title": "Perfiles",
  "profilePicker.loading": "Cargando perfiles…",
  "profilePicker.empty": "No se encontraron perfiles en la raíz configurada.",
  "profilePicker.noBrandTitle": "Este perfil no tiene brand.json configurado",
  "profilePicker.noBrandHint": "Sin brand.json configurado",

  // Carousel list (routes/CarouselListRoute.tsx)
  "carouselList.back": "← Perfiles",
  "carouselList.title": "{slug} · Carruseles",
  "carouselList.new": "Nuevo carrusel",
  "carouselList.loading": "Cargando…",
  "carouselList.empty": "Este perfil aún no tiene carruseles.",
  "carouselList.columnTitle": "Título",
  "carouselList.columnStatus": "Estado",
  "carouselList.columnUpdated": "Actualizado",
  "carouselList.columnSlides": "Láminas",
  "carouselList.open": "Abrir",
  "carouselList.status.draft": "Borrador",
  "carouselList.status.exported": "Exportado",
  "carouselList.status.published": "Publicado",
  "carouselList.sidePanel.assetsTab": "Assets",
  "carouselList.sidePanel.templatesTab": "Templates",

  // New carousel dialog (routes/NewCarouselDialog.tsx)
  "newCarousel.dialogTitle": "Nuevo carrusel",
  "newCarousel.cancel": "Cancelar",
  "newCarousel.creating": "Creando…",
  "newCarousel.titleRequired": "El título es obligatorio.",
  "newCarousel.create": "Crear",
  "newCarousel.titleLabel": "Título",
  "newCarousel.titlePlaceholder": "ej: Cómo armar tu primer carrusel",
  "newCarousel.brandLabel": "Marca",
  "newCarousel.templateLabel": "Template (opcional)",
  "newCarousel.hint":
    "El carrusel se crea vacío: entra directo al editor y cada pieza se compone desde ahí, cuando vos lo pidas.",

  // Editor route (routes/EditorRoute.tsx)
  "editorRoute.noTemplateUnsupported": "Este carrusel no tiene template; el editor todavía no lo soporta",
  "editorRoute.loading": "Cargando carrusel…",

  // Editor shell (editor/Editor.tsx)
  "editor.empty": "Este carrusel no tiene láminas.",

  // Top bar (editor/TopBar.tsx)
  "topbar.back": "← Carruseles",
  "topbar.status.draft": "borrador",
  "topbar.status.exported": "exportado",
  "topbar.status.published": "publicado",
  "topbar.subtitle": "{count} láminas · {w}×{h}",
  "topbar.tool.deselect": "Deseleccionar",
  "topbar.tool.addText": "Añadir texto",
  "topbar.tool.addAsset": "Añadir asset",
  "topbar.tool.undo": "Deshacer",
  "topbar.tool.redo": "Rehacer",
  "topbar.tool.toggleTheme": "Tema claro / oscuro",
  "topbar.tool.toggleThemeAriaLabel": "Cambiar tema",
  "topbar.export": "Exportar {count} PNG",

  // Status bar (editor/StatusBar.tsx)
  "statusBar.slideOfTotal": "Lámina {index} de {total}",
  "statusBar.textKind": "Texto",
  "statusBar.assetKind": "Asset",
  "statusBar.fontSize": " · {size} px",
  "statusBar.pinned": " · fijado",
  "statusBar.position": "x {x} · y {y}",
  "statusBar.pinnedPieces": "{pinned} de {total} piezas fijadas",
  "statusBar.saveError": "Error al guardar: {message}",
  "statusBar.saving": "Guardando…",
  "statusBar.saved": "Guardado",

  // Stage (editor/Stage.tsx)
  "stage.slideLabel": "Lámina {number}",
  "stage.stripAriaLabel": "Láminas",
  "stage.thumbKind.cover": "POR",
  "stage.thumbKind.closing": "FIN",
  "stage.addSlide": "Añadir lámina",

  // Prompt header (editor/PromptHeader.tsx)
  "promptHeader.relativeTime.justNow": "hace instantes",
  "promptHeader.relativeTime.minutes": "hace {count} min",
  "promptHeader.relativeTime.hours": "hace {count} h",
  "promptHeader.relativeTime.days": "hace {count} d",
  "promptHeader.slideCount": "{count} láminas",
  "promptHeader.draftedTexts": "{count} textos redactados",
  "promptHeader.libraryPieces": "{count} piezas de biblioteca",
  "promptHeader.generatedBackgrounds": "{count} fondos generados",
  "promptHeader.awaitingImage.one": "{count} imagen por generar",
  "promptHeader.awaitingImage.other": "{count} imágenes por generar",
  "promptHeader.savings": "{ratio}% de este carrusel salió de la biblioteca",
  "promptHeader.savingsHistory": " · hace un tiempo era {ratio}%",
  "promptHeader.regenerateUnpinned": "Regenerar lo no fijado",

  // Regenerate-unpinned confirmation dialog (editor/RegenerateUnpinnedDialog.tsx)
  "regenerateUnpinned.dialogTitle": "Regenerar lo no fijado",
  "regenerateUnpinned.cancel": "Cancelar",
  "regenerateUnpinned.regenerating": "Regenerando…",
  "regenerateUnpinned.confirm": "Regenerar",
  "regenerateUnpinned.summary.oneRegenerateOnePinned":
    "Se regenera {count} pieza de esta lámina, {pinned} fijada se conserva.",
  "regenerateUnpinned.summary.oneRegenerateManyPinned":
    "Se regenera {count} pieza de esta lámina, {pinned} fijadas se conservan.",
  "regenerateUnpinned.summary.manyRegenerateOnePinned":
    "Se regeneran {count} piezas de esta lámina, {pinned} fijada se conserva.",
  "regenerateUnpinned.summary.manyRegenerateManyPinned":
    "Se regeneran {count} piezas de esta lámina, {pinned} fijadas se conservan.",

  // Export dialog (editor/ExportDialog.tsx)
  "exportDialog.pollNotFound": "No se encontró la exportación. Cierra y exporta de nuevo.",
  "exportDialog.pollFailed": "No se pudo consultar el estado de la exportación. Intenta cerrar y exportar de nuevo.",
  "exportDialog.title": "Exportar carrusel",
  "exportDialog.cancel": "Cancelar",
  "exportDialog.exportAnyway": "Exportar igual",
  "exportDialog.close": "Cerrar",
  "exportDialog.pendingWarning":
    "Todavía hay piezas generándose en segundo plano. Si exportás ahora, el PNG puede salir con texto vacío o sin imagen en esas piezas.",
  "exportDialog.queuing": "Encolando exportación…",
  "exportDialog.exporting": "Exportando ({status})…",
  "exportDialog.donePrefix": "Exportación lista. Los PNG quedan en",
  "exportDialog.donePrefixVersioned": "Exportación lista · versión v{version}. Los PNG quedan en",
  "exportDialog.doneSuffix": "dentro del perfil.",

  // Generate image field (editor/GenerateImageField.tsx)
  "generateImage.toggleGenerate": "Generar imagen…",
  "generateImage.toggleRegenerate": "Regenerar…",
  "generateImage.promptPlaceholder": "Déjalo vacío y la IA decide según la guía de la marca",
  "generateImage.viewFinalPrompt": "Ver prompt final",
  "generateImage.cancel": "Cancelar",
  "generateImage.generating": "Generando…",
  "generateImage.generate": "Generar",
  "generateImage.composingPrompt": "Componiendo…",

  // Selection overlay (editor/SelectionOverlay.tsx)
  "selectionOverlay.locked": "Bloqueado",
  "selectionOverlay.pinned": "Fijado",
  "selectionOverlay.generateImage": "Generar imagen…",

  // Properties panel tabs (editor/panels/PropertiesPanel.tsx)
  "propertiesPanel.tab.selection": "Selección",
  "propertiesPanel.tab.bucket": "Bucket",
  "propertiesPanel.tab.slide": "Lámina",
  "propertiesPanel.tab.brand": "Marca",
  "propertiesPanel.tab.templates": "Templates",

  // Selection pane (editor/panels/SelectionPane.tsx)
  "selectionPane.origin.library": "Biblioteca",
  "selectionPane.origin.manual": "Manual",
  "selectionPane.textHeadingFallback": "Texto",
  "selectionPane.assetHeadingFallback": "Asset",
  "selectionPane.pinned": "fijado",
  "selectionPane.fontSizeLabel": "Tamaño",
  "selectionPane.lineHeightLabel": "Interlínea",
  "selectionPane.positionLabel": "Posición",
  "selectionPane.positionInherited": "heredada",
  "selectionPane.rotationLabel": "Rotación",
  "selectionPane.resetToTemplate": "Restablecer al template",
  "selectionPane.colorHeading": "Color",
  "selectionPane.colorLockHint": "marca",
  "selectionPane.colorHintPrefix": "Los {count} colores de la marca. Son",
  "selectionPane.colorHintSuffix": ", no configuración: si un color no está aquí, no existe para esta pieza.",
  "selectionPane.noAiHint": "Esta pieza no pasó por IA — no hay imagen que generar ni regenerar.",
  "selectionPane.piecesHeading": "Piezas de la lámina",
  "selectionPane.piecesHintPrefix": "Fija",
  "selectionPane.piecesHintMiddle": "lo que te gustó y regenera",
  "selectionPane.piecesHintSuffix": "el texto, o generá la imagen que falte.",
  "selectionPane.backgroundLayerName": "Fondo",
  "selectionPane.pinAction": "Fijar",
  "selectionPane.regenerateAction": "Regenerar",
  "selectionPane.footerNote":
    'Fija lo que quieras conservar; "Regenerar lo no fijado" redacta de nuevo solo los textos.',

  // Slide pane (editor/panels/SlidePane.tsx)
  "slidePane.kind.cover": "Portada",
  "slidePane.kind.step": "Paso",
  "slidePane.kind.closing": "Cierre",
  "slidePane.kindHeading": "Tipo de lámina",
  "slidePane.kindHint": "El tipo decide qué zonas quedan fijas y cómo se numera.",
  "slidePane.structureHeading": "Estructura",
  "slidePane.structureLockHint": "template",
  "slidePane.bleedBackground": "Fondo a sangre",
  "slidePane.footerLogo": "Footer + logo",
  "slidePane.margins": "Márgenes",
  "slidePane.structureNote":
    "Estas zonas no se arrastran. Se cambian en el template y el cambio entra en todas las láminas a la vez, así el carrusel no se desalinea lámina a lámina.",
  "slidePane.backgroundHeading": "Fondo de esta lámina",
  "slidePane.backgroundMode.color": "Color",
  "slidePane.backgroundMode.library": "Biblioteca",
  "slidePane.backgroundMode.ai": "IA",
  "slidePane.libraryHint": "Elige una pieza desde la pestaña Bucket para usarla como fondo.",
  "slidePane.aiNote": "La IA hace solo el fondo. No dibuja letras sobre la imagen: eso lo pone el template encima, porque un modelo de imagen las deforma.",
  "slidePane.contrastHeading": "Contraste",
  "slidePane.contrastMeasuring": "Midiendo…",
  "slidePane.contrastPass": "AA ✓",
  "slidePane.contrastFail": "AA ✗",
  "slidePane.contrastHint": "Medido contra el fondo real de cada lámina, no estimado.",

  // Brand pane (editor/panels/BrandPane.tsx)
  "brandPane.loading": "Cargando…",
  "brandPane.emptyHeading": "Guía de marca",
  "brandPane.emptyHint": "Esta marca no tiene guía de estilo todavía.",
  "brandPane.emptyNotePrefix": "Se detecta desde",
  "brandPane.emptyNoteMiddle": "y",
  "brandPane.emptyNoteSuffix":
    "en la carpeta del perfil. Agrega esos archivos para que la IA redacte y genere imágenes con el estilo de la marca.",
  "brandPane.paletteHeading": "Paleta",
  "brandPane.typographyHeading": "Tipografía",
  "brandPane.styleKeywordsHeading": "Keywords de estilo",
  "brandPane.toneHeading": "Tono",
  "brandPane.toneStyleLabel": "Estilo:",
  "brandPane.toneAvoidLabel": "Evitar:",
  "brandPane.positioningHeading": "Posicionamiento",
  "brandPane.imageDirectionHeading": "Dirección de imagen",
  "brandPane.logoRulesHeading": "Reglas de logo",
  "brandPane.sourcesHeading": "Fuentes",
  "brandPane.sourcesEmpty": "Ninguna todavía",
  "brandPane.sourcesNote": "Esta guía se edita en los archivos del perfil — el editor solo la consume.",

  // Bucket pane (editor/panels/BucketPane.tsx)
  "bucketPane.savingsSuffix": "de este carrusel salió de la biblioteca.",
  "bucketPane.savingsHistory": " Hace un tiempo era {ratio}%.",
  "bucketPane.savingsNoHistory": " Sin historial previo aún.",
  "bucketPane.usedHint": "Borde verde = ya está en este carrusel. ↻ = veces reutilizado.",
  "bucketPane.candidatesHeading": "Candidatos generados",
  "bucketPane.candidatesHint": "Al fijar una pieza, entra a la biblioteca clasificada.",
  "bucketPane.reclassifyPlaceholder": "Reclasificar candidato…",
  "bucketPane.uploadHeading": "Subir asset",
  "bucketPane.uploadDropzone": "Arrastra un archivo aquí o haz click para subir",
  "bucketPane.outputsHeading": "outputs/ · versiones exportadas",
  "bucketPane.outputMeta": "{count} PNG · {date}",
  "bucketPane.dateUnavailable": "fecha no disponible",
  "bucketPane.useAsBackground": "Usar de fondo",
  "bucketPane.backgroundButton": "Fondo",
  "bucketPane.outputsEmpty": "Aún no hay exportaciones de este carrusel.",
  "bucketPane.outputsNote": "Cada exportación crea una versión nueva. Nada se sobrescribe.",
  "bucketPane.assetKind.background": "Fondos",
  "bucketPane.assetKind.character": "Personajes",
  "bucketPane.assetKind.photo": "Fotos",
  "bucketPane.assetKind.logo": "Logos",
  "bucketPane.assetKind.font": "Fuentes",
  "bucketPane.assetKind.decoration": "Decoraciones",
  "bucketPane.assetKind.unclassified": "Sin clasificar",

  // Assets pane (editor/panels/AssetsPane.tsx)
  "assetsPane.loading": "Cargando assets de {slug}…",
  "assetsPane.heading": "Assets",
  "assetsPane.emptyPrefix": "La marca",
  "assetsPane.emptySuffix": "todavía no tiene assets en su biblioteca.",

  // Templates pane (editor/panels/TemplatesPane.tsx)
  "templatesPane.loading": "Cargando templates de {slug}…",
  "templatesPane.heading": "Templates",
  "templatesPane.emptyPrefix": "La marca",
  "templatesPane.emptySuffix": "no tiene ningún template disponible.",
  "templatesPane.noOwnTemplates": "Esta marca no tiene templates propios todavía — se muestran los defaults del motor.",
  "templatesPane.inUse": "en uso",
  "templatesPane.originBrand": "Marca",
  "templatesPane.originEngine": "Motor",
} as const;
