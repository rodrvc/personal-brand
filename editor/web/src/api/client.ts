import type {
  AssetEntry,
  BrandTokens,
  CarouselDocument,
  CarouselSummary,
  CompositionPlanResponse,
  ContrastMeasurement,
  ExportJob,
  LayoutTemplate,
  OutputVersion,
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

export function listProfiles(): Promise<{ profiles: string[] }> {
  return request("/profiles");
}

export function getBrand(slug: string): Promise<BrandTokens> {
  return request(`/profiles/${slug}/brand`);
}

export function getTemplate(slug: string, id: string, params?: Record<string, unknown>): Promise<LayoutTemplate> {
  const query = params ? `?params=${encodeURIComponent(JSON.stringify(params))}` : "";
  return request(`/profiles/${slug}/template/${id}${query}`);
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

export function createCarouselFromPrompt(
  slug: string,
  body: { prompt: string; templateId?: string; id?: string },
): Promise<CompositionPlanResponse> {
  return request(`/profiles/${slug}/carousels`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

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

export function regenerate(slug: string, carouselId: string, target: RegenerateTarget): Promise<CarouselDocument> {
  return request(`/profiles/${slug}/carousels/${carouselId}/regenerate`, {
    method: "POST",
    body: JSON.stringify({ target }),
  });
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

export function exportCarousel(slug: string, carouselId: string): Promise<{ jobId: string }> {
  return request(`/profiles/${slug}/carousels/${carouselId}/export`, { method: "POST" });
}

export function getExportJob(slug: string, carouselId: string, jobId: string): Promise<ExportJob> {
  return request(`/profiles/${slug}/carousels/${carouselId}/export/${jobId}`);
}

export function listOutputs(slug: string, carouselId: string): Promise<{ versions: OutputVersion[] }> {
  return request(`/profiles/${slug}/carousels/${carouselId}/outputs`);
}
