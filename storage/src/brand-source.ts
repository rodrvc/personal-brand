import { NotFoundError, type BrandRepository } from "./contracts/index.ts";

/**
 * The one place that decides where a brand is served from (D12): "storage" iff `brands.cutover_at` is set.
 * A brand storage has never heard of is still a folder. S12 removes this resolver with the folder path.
 */
export async function resolveBrandSource(brands: Pick<BrandRepository, "getBySlug">, slug: string): Promise<"storage" | "folder"> {
  try {
    return (await brands.getBySlug(slug)).value.cutoverAt ? "storage" : "folder";
  } catch (error) {
    if (error instanceof NotFoundError) return "folder";
    throw error;
  }
}
