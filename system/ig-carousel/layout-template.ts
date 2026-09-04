import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/**
 * A layout template: `system/ig-carousel/layouts/<id>.json` (the generic
 * default, shipped with the engine) deep-merged with
 * `profiles/<slug>/templates/<id>.json` (a brand's override), when present.
 *
 * Templates declare *geometry*, brand *role* names (`colorRole`, resolved
 * against `brand.roles` at render time — see brand-schema.ts's `color()`)
 * and copy *keys* — never a hex value, a literal brand name, or real copy.
 * That is what keeps `system/ig-carousel/layouts/*.json` inside the "no
 * brand literals under system/" rule design.md and CLAUDE.md both state.
 */

/** Matches a `#rgb`/`#rrggbb`/`#rrggbbaa` literal anywhere inside a string. */
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

/**
 * A non-empty string that must name a role/policy, never a color literal —
 * an override that puts a hex value where `colorRole` or a zone policy goes
 * would silently defeat design.md D5 (no hex outside `brand.json`). `key`
 * names the offending field in the error message so a failing override
 * points straight at the field to fix.
 */
function roleStringSchema(key: string) {
  return z
    .string()
    .min(1)
    .refine((value) => !HEX_LITERAL.test(value), {
      message: `${key} must be a role/policy name, not a hex color literal`,
    });
}

const geometrySchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int().optional(),
  rotation: z.number(),
});

const textSlotSchema = z.object({
  name: z.string().min(1),
  type: z.literal("text"),
  geometry: geometrySchema,
  fontKey: z.string().min(1),
  fontSize: z.number().int().positive(),
  lineHeight: z.number().positive(),
  align: z.enum(["left", "center", "right"]),
  /** A brand ROLE name (brand.roles keys, e.g. "onSurface", "accent") — never a color key or hex. */
  colorRole: roleStringSchema("colorRole"),
});

const assetSlotSchema = z.object({
  name: z.string().min(1),
  type: z.literal("asset"),
  geometry: geometrySchema,
  fit: z.enum(["cover", "contain"]).optional(),
});

const slotSchema = z.discriminatedUnion("type", [textSlotSchema, assetSlotSchema]);
export type LayoutSlot = z.infer<typeof slotSchema>;

const marginsSchema = z.object({
  top: z.number().int(),
  right: z.number().int(),
  bottom: z.number().int(),
  left: z.number().int(),
});

const zonesSchema = z.object({
  background: z.object({
    /** How the background zone is painted; the engine interprets the policy name, the template only names it. */
    policy: roleStringSchema("zones.background.policy"),
  }),
  footer: z.object({
    height: z.number().int().nonnegative(),
    /** "auto" picks a logo variant from the library by contrast (D8); "none" lets a profile disable the footer logo entirely. */
    logo: z.enum(["auto", "none"]),
    pagination: z.boolean(),
  }),
  margins: marginsSchema,
});
export type LayoutZones = z.infer<typeof zonesSchema>;

const slideKindSchema = z.enum(["cover", "step", "closing"]);

const layoutTemplateSchema = z.object({
  id: z.string().min(1),
  canvas: z.object({
    w: z.literal(1080),
    h: z.literal(1350),
  }),
  zones: zonesSchema,
  slides: z.record(slideKindSchema, z.object({ slots: z.array(slotSchema) })),
});

export type LayoutTemplate = z.infer<typeof layoutTemplateSchema>;

export class LayoutTemplateError extends Error {}

function zodPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      out += out.length === 0 ? key : `.${key}`;
    }
  }
  return out || "(root)";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges `override` onto `base`. Arrays are replaced wholesale (a
 * profile that overrides `slides.cover.slots` supplies the full slot list
 * for that kind, not a patch of one slot by index) — plain objects merge
 * key by key. This is what lets `zones.footer.height: 140` alone override
 * the default without the profile repeating `logo`/`pagination`.
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return merged;
  }
  return override;
}

/**
 * Loads the default template from `system/ig-carousel/layouts/<id>.json`
 * and, if `profiles/<slug>/templates/<id>.json` exists, deep-merges it on
 * top. The resolved result is validated as a whole so an invalid override
 * (a typo'd key, a missing geometry field) fails naming that key, not the
 * default's.
 */
export function loadLayoutTemplate(profileDir: string, id: string): LayoutTemplate {
  const engineDir = dirname(fileURLToPath(import.meta.url));
  const defaultPath = join(engineDir, "layouts", `${id}.json`);

  let defaultRaw: unknown;
  try {
    defaultRaw = JSON.parse(readFileSync(defaultPath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new LayoutTemplateError(`No default layout template found for id "${id}" at ${defaultPath}`);
    }
    throw error;
  }

  const overridePath = join(profileDir, "templates", `${id}.json`);
  let resolved = defaultRaw;
  if (existsSync(overridePath)) {
    let overrideRaw: unknown;
    try {
      overrideRaw = JSON.parse(readFileSync(overridePath, "utf-8"));
    } catch (error) {
      throw new LayoutTemplateError(`Invalid JSON in template override at ${overridePath}: ${(error as Error).message}`);
    }
    resolved = deepMerge(defaultRaw, overrideRaw);
  }

  const result = layoutTemplateSchema.safeParse(resolved);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw new LayoutTemplateError(
      `Invalid layout template "${id}" (resolved from ${defaultPath}${
        existsSync(overridePath) ? ` + ${overridePath}` : ""
      }): ${zodPath(issue.path)} — ${issue.message}`,
    );
  }
  return result.data;
}
