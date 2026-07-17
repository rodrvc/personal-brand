/**
 * Data shape the render engine accepts. The engine is fully agnostic of where
 * this data comes from (future callers may hit adondepo.cl's public API) —
 * it only ever consumes this JSON contract.
 */
export interface Slide {
  image: string;
  title: string;
  subtitle: string;
  meta: string;
  category?: string;
}

export interface CarouselInput {
  slides: Slide[];
}

/**
 * A template renders a single slide to a full HTML document string.
 * Keeping this as a plain function type (rather than a class hierarchy)
 * keeps each variant trivially testable in isolation: given a Slide, assert
 * on the returned markup.
 */
export type SlideTemplate = (slide: Slide) => string;

/**
 * A group template renders up to 3 slides (grouped for the "list-format"
 * variant) to a single full HTML document string. Distinct from
 * SlideTemplate because this variant's unit of rendering is a group of
 * events, not a single event.
 */
export type SlideGroupTemplate = (
  slides: Slide[],
  options?: { headerLabel?: string; city?: string },
) => string;
