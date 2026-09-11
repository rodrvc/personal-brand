// Document/brand/template shapes come straight from the engine
// (system/ig-carousel/carousel-document.ts, brand-schema.ts,
// layout-template.ts) as type-only imports: erased at build time, so
// editor/web never bundles engine code, only its types. This is what keeps
// this file from drifting from the schema the server actually validates
// against (design.md D1's module boundary is about runtime code, not types).
export type {
  AssetObject,
  CarouselDocument,
  Geometry,
  PieceSource,
  Prompt,
  Slide,
  SlideBackground,
  SlideKind,
  SlideObject,
  TemplateRef,
  TextObject,
} from "../../../../system/ig-carousel/carousel-document.ts";
export type { BrandRoles, BrandTokens } from "../../../../system/ig-carousel/brand-schema.ts";
export type {
  LayoutSlot,
  LayoutTemplate,
  LayoutTemplateOrigin,
  LayoutTemplateSummary,
} from "../../../../system/ig-carousel/layout-template.ts";
// Same rationale as above: `AssetKind` is derived from `ASSET_KINDS` in the
// server's asset index, so the client union can never drift from the list
// the server actually validates against (this is what let "font" go missing
// here before — a hand-copied union silently fell behind).
export type { AssetKind } from "../../../../system/assets/index.ts";

import type { CarouselDocument, SlideKind } from "../../../../system/ig-carousel/carousel-document.ts";
import type { AssetKind } from "../../../../system/assets/index.ts";

export interface CarouselSummary {
  id: string;
  title: string;
  status: CarouselDocument["status"];
  updatedAt: string;
  slideCount: number;
}

export interface ProfileListingEntry {
  slug: string;
  /** False when the profile has no `brand.json` yet — the picker shows it disabled with a hint instead of letting it fail once opened. */
  hasBrand: boolean;
}

export type AssetStatus = "candidate" | "approved" | "hidden";

export interface AssetEntry {
  id: string;
  kind: AssetKind;
  status: AssetStatus;
  origin: "manual" | "ai";
  tags?: string[];
  path: string;
  usageCount?: number;
  createdAt?: string;
  costCents?: number;
}

export interface ContrastMeasurement {
  label: string;
  ratio: number;
  passesAA: boolean;
  note?: string;
}

export interface StatsResponse {
  carouselId: string;
  libraryRatio: number;
  history: Array<{ carouselId: string; updatedAt: string; libraryRatio: number }>;
}

export interface CompositionPlanVisualSlot {
  slideIndex: number;
  slot: string;
  kind: string;
  source: "library" | "generate";
  assetId?: string;
  estimatedCostCents?: number;
}

export interface CompositionPlanTextSlot {
  slideIndex: number;
  slot: string;
  limits: { headline: number; body?: number };
}

export interface CompositionPlanResponse {
  carouselId: string;
  templateId: string;
  plan: {
    promptText: string;
    slideKinds: SlideKind[];
    visualSlots: CompositionPlanVisualSlot[];
    textSlots: CompositionPlanTextSlot[];
  };
  estimatedCostCents: number;
  libraryPieces: number;
  generatedPieces: number;
}

/** Response from `POST /carousels` (editor-ui spec's "New carousel opens empty") — an inert create: the document has its slides' structure and no generated content, no job id. */
export interface CreateCarouselResponse {
  document: CarouselDocument;
}

export interface OutputVersion {
  version: number;
  path: string;
  createdAt: string;
  fileCount: number;
}

export interface ExportJob {
  jobId: string;
  slug: string;
  carouselId: string;
  status: "queued" | "running" | "done" | "error";
  error?: string;
  version?: number;
}

/** Mirrors `system/ig-carousel/brand-style.ts`'s `BrandStyle` — the read-only guide shown in the "Marca" tab. */
export interface BrandStyle {
  palette: Array<{ key: string; hex: string; role?: string }>;
  fonts: { logo?: string; body?: string; handwritten?: string };
  styleKeywords: string[];
  tone: { style: string[]; avoid: string[] };
  positioning?: string;
  imageDirection?: string;
  logoRules?: string;
  sources: string[];
}
