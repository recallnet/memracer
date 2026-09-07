/** Maximum number of normalized slug candidates tried before failing closed. */
export const DEFAULT_SLUG_ATTEMPTS = 100;

export type SlugEntity = "organization" | "project";

const SLUG_FALLBACKS: Record<SlugEntity, string> = {
  organization: "org",
  project: "project",
};

export interface SlugAllocationOptions {
  preferred: string;
  entity: SlugEntity;
  claim(candidate: string): Promise<boolean>;
  maxAttempts?: number;
}

export class SlugExhaustedError extends Error {
  constructor(readonly base: string, readonly attempts: number) {
    super(`could not allocate a unique slug for '${base}' after ${attempts} attempts`);
    this.name = "SlugExhaustedError";
  }
}

export function slugBase(value: string, entity: SlugEntity): string {
  return (
    value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || SLUG_FALLBACKS[entity]
  );
}

/** Try base, base-2, base-3... until the caller atomically claims a candidate. */
export async function allocateSlug(options: SlugAllocationOptions): Promise<string> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_SLUG_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  const base = slugBase(options.preferred, options.entity);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (await options.claim(candidate)) return candidate;
  }
  throw new SlugExhaustedError(base, maxAttempts);
}
