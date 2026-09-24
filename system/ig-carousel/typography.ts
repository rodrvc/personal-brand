import type { BrandRoles, BrandTokens } from "./brand-schema.js";

export const TYPE_ROLES = ["chip", "title", "subtitle", "data", "label", "footer"] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];

export interface TypeStyle {
  font: keyof BrandTokens["fonts"];
  color: keyof BrandRoles;
}

const DEFAULT_STYLES: Record<TypeRole, TypeStyle> = {
  chip: { font: "body", color: "surface" },
  title: { font: "body", color: "onSurface" },
  subtitle: { font: "body", color: "accent" },
  data: { font: "body", color: "onSurface" },
  label: { font: "body", color: "onSurfaceMuted" },
  footer: { font: "body", color: "onSurfaceMuted" },
};

export const DEFAULT_TYPE_SCALE = [20, 24, 28, 32, 40, 48, 56, 64, 72, 88, 104, 120, 144];

export function typeStyle(brand: BrandTokens, role: TypeRole): TypeStyle {
  return { ...DEFAULT_STYLES[role], ...brand.typography?.[role] };
}

/** The brand's scale step closest to a measured size. */
export function snapToScale(brand: BrandTokens, px: number): number {
  const scale = brand.typeScale?.length ? brand.typeScale : DEFAULT_TYPE_SCALE;
  return scale.reduce((best, size) => (Math.abs(size - px) < Math.abs(best - px) ? size : best), scale[0]!);
}
