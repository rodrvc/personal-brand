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
export type { LayoutSlot, LayoutTemplate } from "../../../../system/ig-carousel/layout-template.ts";

import type { CarouselDocument, SlideKind } from "../../../../system/ig-carousel/carousel-document.ts";

export interface CarouselSummary {
  id: string;
  title: string;
  status: CarouselDocument["status"];
  updatedAt: string;
  slideCount: number;
}

export type AssetKind = "background" | "character" | "photo" | "logo" | "decoration" | "unclassified";
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
