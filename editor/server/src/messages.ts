export const messages = {
  aiUnavailable: {
    copy: "La redacción con IA no está disponible: falta configurar la variable OPENAI_API_KEY.",
    image: "La generación de imágenes con IA no está disponible: falta configurar la variable OPENAI_API_KEY.",
    chat: "El chat con IA no está disponible: falta configurar la variable OPENAI_API_KEY.",
  },
  profileWithoutBrand: (slug: string) => `El perfil "${slug}" no tiene brand.json.`,
  uploadTooLarge: "El archivo es demasiado grande para subirlo (máximo ~28 MB). Adjunta una versión más liviana.",
  imageToolUnavailable:
    "Este equipo no puede procesar imágenes (convertir HEIC, reducir fotos o preparar el afiche): hoy eso solo funciona en macOS.",
  heicNotConverted: "No se pudo convertir la foto HEIC. Expórtala como JPG y vuelve a adjuntarla.",
  photoNotReduced: "La imagen es demasiado grande y no se pudo reducir. Adjunta una versión más liviana (menos de 6 MB).",
  proposal: {
    unknownAction: (type: string) => `La propuesta pedía «${type}», que este chat todavía no puede hacer.`,
    malformed: (detail?: string) => `La propuesta vino mal formada${detail ? ` (${detail})` : ""}.`,
    nothingProposed: "No se propone nada.",
    notPending: "Esa propuesta ya no está pendiente.",
    missingData: (data: string[]) =>
      `Para armar el afiche me falta ${data.length > 1 ? `${data.slice(0, -1).join(", ")} y ${data.at(-1)}` : data[0]}. ¿Me lo indicas? Si el evento no tiene alguno, dímelo y lo saco del afiche.`,
    insteadOf: (layoutText: string) => `lo que va en lugar de «${layoutText}»`,
    dataNames: {
      chip: "la categoría",
      title: "el nombre del evento",
      subtitle: "el subtítulo",
      date: "la fecha",
      time: "la hora",
      place: "el lugar",
      entry: "la entrada",
      price: "el precio",
      label: "una etiqueta",
      footer: "el pie",
      body: "un texto",
    } as Record<string, string>,
    needsLayoutReference: "Para recrear el afiche adjunta una referencia de tipo carrusel.",
    invalidResult: (path: string, detail: string) => `El resultado no es válido en "${path}": ${detail}`,
    imageNotPlaced: (slide: number | undefined, image: string) =>
      `No quedó en la lámina ${slide ?? "nueva"} la imagen «${image}». No se guardó nada.`,
    imageRemovedMeanwhile: (slide: number | undefined, image: string) =>
      `No quedó en la lámina ${slide ?? "nueva"} la imagen «${image}»: otro guardado la quitó al mismo tiempo.`,
  },
  action: {
    noSuchSlide: (slideId: string) => `La lámina "${slideId}" no existe en el carrusel.`,
    textPinned: (n: number) => `El texto de la lámina ${n} está fijado.`,
    noTextSlot: (n: number) => `La lámina ${n} no tiene ese espacio de texto.`,
    backgroundPinned: (n: number) => `El fondo de la lámina ${n} está fijado.`,
    imagePinned: (n: number) => `La imagen de la lámina ${n} está fijada.`,
    noImageSlot: (n: number, slot: string) => `La lámina ${n} no tiene el espacio de imagen "${slot}".`,
    notInLibrary: (assetId: string) => `La imagen "${assetId}" no está aprobada en la biblioteca.`,
    noInsertPosition: (position: number) => `No hay una posición ${position} donde insertar la lámina.`,
    noSuchObject: (n: number) => `La lámina ${n} no tiene ese objeto.`,
    objectLocked: (n: number) => `Ese objeto de la lámina ${n} está bloqueado: desbloquéalo primero.`,
  },
} as const;
