import type {
  AssetEntry,
  BrandStyle,
  BrandTokens,
  CarouselDocument,
  CarouselSummary,
  CompositionPlanResponse,
  ContrastMeasurement,
  CreateCarouselResponse,
  ExportJob,
  LayoutTemplate,
  LayoutTemplateSummary,
  OutputVersion,
  ProfileListingEntry,
  StatsResponse,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // no JSON body
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function listProfiles(): Promise<{ profiles: ProfileListingEntry[] }> {
  return request("/profiles");
}

export function getBrand(slug: string): Promise<BrandTokens> {
  return request(`/profiles/${slug}/brand`);
}

/** The brand's optional style guide (palette/fonts/keywords/tone/positioning/image direction/logo rules) — always returns a (possibly all-empty) style, never 404s for a profile with no style files. */
export function getBrandStyle(slug: string): Promise<BrandStyle> {
  return request(`/profiles/${slug}/style`);
}

export function getTemplate(slug: string, id: string, params?: Record<string, unknown>): Promise<LayoutTemplate> {
  const query = params ? `?params=${encodeURIComponent(JSON.stringify(params))}` : "";
  return request(`/profiles/${slug}/template/${id}${query}`);
}

/** Every template available to a brand: engine defaults merged with that profile's own overrides (ACU-230). */
export function listTemplates(slug: string): Promise<{ templates: LayoutTemplateSummary[] }> {
  return request(`/profiles/${slug}/templates`);
}

export function listCarousels(slug: string): Promise<{ carousels: CarouselSummary[] }> {
  return request(`/profiles/${slug}/carousels`);
}

export function getCarousel(slug: string, id: string): Promise<CarouselDocument> {
  return request(`/profiles/${slug}/carousels/${id}`);
}

export function putCarousel(
  slug: string,
  doc: CarouselDocument,
  opts?: { snapshot?: boolean },
): Promise<CarouselDocument> {
  const query = opts?.snapshot ? "?snapshot=true" : "";
  return request(`/profiles/${slug}/carousels/${doc.id}${query}`, {
    method: "PUT",
    body: JSON.stringify(doc),
  });
}

/**
 * Creates a new, empty carousel (editor-ui spec's "New carousel opens
 * empty"): inert — no AI call, no cost, no job id. `title` is optional;
 * the server falls back to the carousel id when omitted.
 */
export function createCarousel(
  slug: string,
  body: { title?: string; templateId?: string; id?: string },
): Promise<CreateCarouselResponse> {
  return request(`/profiles/${slug}/carousels`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** API/script-only preview mode (`?mode=plan`): returns a plan without creating a document. Not called by editor/web — see routes/compose.ts's comment on why it's kept. */
export function previewCompositionPlan(
  slug: string,
  body: { prompt: string; templateId?: string; id?: string; slideCount?: number },
): Promise<CompositionPlanResponse> {
  return request(`/profiles/${slug}/carousels?mode=plan`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** API/script-only: executes a plan previously created via `previewCompositionPlan`. Not called by editor/web. */
export function applyPlan(slug: string, carouselId: string, templateId?: string): Promise<CarouselDocument> {
  return request(`/profiles/${slug}/carousels/${carouselId}/plan/apply`, {
    method: "POST",
    body: JSON.stringify(templateId ? { templateId } : {}),
  });
}

export interface RegenerateTarget {
  slideId: string;
  objectId?: string;
  scope?: "unpinned";
}

export interface RegenerateResponse {
  document: CarouselDocument;
  /** Actual cost this call just spent — 0 for a text redraft's negligible/untracked case or when nothing was generated. */
  costCents: number;
}

/**
 * `prompt` overrides the planner's own `suggestion` for a single-piece
 * image target (background or an asset object) — the text the user typed
 * or edited into the "Generar imagen…"/"Regenerar" field. Ignored for text
 * objects and for `scope: "unpinned"` (owner decision: image generation is
 * never automatic, so the bulk "Regenerar lo no fijado" button only
 * redrafts text — see routes/compose.ts's `regenerateUnpinned`).
 */
export function regenerate(
  slug: string,
  carouselId: string,
  target: RegenerateTarget,
  prompt?: string,
): Promise<RegenerateResponse> {
  return request(`/profiles/${slug}/carousels/${carouselId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ target, ...(prompt !== undefined ? { prompt } : {}) }),
  });
}

/**
 * "Ver prompt final" preview: returns the exact prompt `POST .../regenerate`
 * would send to the provider for this target (planner suggestion, or
 * `promptOverride` if given, plus brand style folded in) without spending
 * anything.
 */
export function previewRegeneratePrompt(
  slug: string,
  carouselId: string,
  target: RegenerateTarget,
  promptOverride?: string,
): Promise<{ prompt: string }> {
  return request(`/profiles/${slug}/carousels/${carouselId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ target, preview: true, ...(promptOverride !== undefined ? { prompt: promptOverride } : {}) }),
  });
}

export function getAiPricing(): Promise<{ imageModel: string; estimatedImageCostCents: number }> {
  return request(`/ai/pricing`);
}

export function getStats(slug: string, carouselId: string): Promise<StatsResponse> {
  return request(`/profiles/${slug}/carousels/${carouselId}/stats`);
}

export function slideHtmlUrl(slug: string, carouselId: string, index: number): string {
  return `/api/profiles/${slug}/carousels/${carouselId}/slides/${index}/html`;
}

export function slidePngUrl(slug: string, carouselId: string, index: number): string {
  return `/api/profiles/${slug}/carousels/${carouselId}/slides/${index}/png`;
}

export function getContrast(slug: string, carouselId: string, index: number): Promise<{ measurements: ContrastMeasurement[] }> {
  return request(`/profiles/${slug}/carousels/${carouselId}/slides/${index}/contrast`);
}

export function listAssets(slug: string): Promise<{ entries: AssetEntry[] }> {
  return request(`/profiles/${slug}/assets`);
}

export function patchAsset(
  slug: string,
  assetId: string,
  changes: Partial<{ kind: string; tags: string[]; status: string }>,
): Promise<AssetEntry> {
  return request(`/profiles/${slug}/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export async function uploadAsset(slug: string, file: File): Promise<AssetEntry> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/profiles/${slug}/assets`, { method: "POST", body: form });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as AssetEntry;
}

export function assetFileUrl(slug: string, relPathUnderAssets: string): string {
  return `/api/profiles/${slug}/assets/files/${relPathUnderAssets}`;
}

/** The generation sidecar's `prompt` for an AI-origin asset — used to prefill the "Regenerar" field with what was actually asked for last time. 404s for a manual/library asset. */
export function getAssetGeneration(slug: string, assetId: string): Promise<{ prompt?: string; model?: string; costCents?: number }> {
  return request(`/profiles/${slug}/assets/${assetId}/generation`);
}

/**
 * `allowPending: true` overrides the server's refusal (409) to export while
 * the carousel still has a piece the background compose job hasn't filled
 * in yet — ExportDialog sends it only after the user picks "Exportar
 * igual" in response to that 409.
 */
export function exportCarousel(
  slug: string,
  carouselId: string,
  options?: { allowPending?: boolean },
): Promise<{ jobId: string }> {
  return request(`/profiles/${slug}/carousels/${carouselId}/export`, {
    method: "POST",
    body: JSON.stringify({ allowPending: options?.allowPending === true }),
  });
}

export function getExportJob(slug: string, carouselId: string, jobId: string): Promise<ExportJob> {
  return request(`/profiles/${slug}/carousels/${carouselId}/export/${jobId}`);
}

export function listOutputs(slug: string, carouselId: string): Promise<{ versions: OutputVersion[] }> {
  return request(`/profiles/${slug}/carousels/${carouselId}/outputs`);
}
