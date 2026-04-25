import type { Page } from "playwright";
import { CHATGPT_HOME } from "../browser/chatgpt.js";

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
 */
export async function fetchModels(page: Page, accessToken?: string): Promise<ChatgptModel[]> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "OAI-Language": "en-US",
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const resp = await page.context().request.get(
    `${CHATGPT_HOME}backend-api/models?history_and_training_disabled=false`,
    { headers, timeout: 10_000 },
  );
  if (!resp.ok()) return [];
  const json = (await resp.json()) as ModelsResponse;
  return json.models ?? [];
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
