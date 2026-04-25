import type { Page } from "patchright";

export interface ChatgptModel {
  slug: string;
  title?: string;
  description?: string;
  /** Whether the slug is selectable in the picker (`list`) or hidden (`hidden`). */
  visibility?: string;
  tags?: string[];
}

export interface ModelsResponse {
  models: ChatgptModel[];
  categories?: unknown[];
}

/**
 * Fetches the model catalogue available to the current account.
 * GET /backend-api/models?history_and_training_disabled=false
 *
 * Runs inside the page so the React app's Bearer token is attached.
 */
export async function fetchModels(page: Page, _accessToken?: string): Promise<ChatgptModel[]> {
  try {
    const result = await page.evaluate(async () => {
      const r = await fetch("/backend-api/models?history_and_training_disabled=false", {
        headers: { Accept: "application/json", "OAI-Language": "en-US" },
        credentials: "include",
      });
      if (!r.ok) return null;
      return await r.json();
    });
    if (!result) return [];
    const json = result as ModelsResponse;
    return json.models ?? [];
  } catch {
    return [];
  }
}

/**
 * Picks the best slug for "GPT-5.5 Pro" from the catalogue.
 * The exact slug varies (gpt-5-5-pro, gpt-5.5-pro, gpt-5-pro, …) so we
 * match flexibly on the slug + title.
 */
export function findProSlug(models: ChatgptModel[]): string | null {
  const candidates = models.filter((m) => {
    const blob = `${m.slug ?? ""} ${m.title ?? ""}`.toLowerCase();
    return (
      blob.includes("pro") &&
      (blob.includes("5.5") || blob.includes("5-5") || blob.includes("5_5") || blob.includes("5pro"))
    );
  });
  if (candidates.length === 0) {
    // Fallback: any "pro" model
    const fallback = models.find((m) => (m.slug ?? "").toLowerCase().includes("pro"));
    return fallback?.slug ?? null;
  }
  // Prefer one whose slug actually contains 'pro'
  const exact = candidates.find((m) => (m.slug ?? "").toLowerCase().includes("pro"));
  return (exact ?? candidates[0]).slug;
}
