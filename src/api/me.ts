import type { Page } from "patchright";

export interface MeResponse {
  id?: string;
  email?: string;
  name?: string;
  picture?: string;
  groups?: string[];
  features?: string[];
  /** Plan: "plus", "pro", "business", "enterprise", "free", "go", … */
  plan?: string;
  intercom_hash?: string;
  has_payment_method?: boolean;
}

/**
 * Fetches /backend-api/me from inside the page's JS context so the
 * React app's `Authorization: Bearer …` JWT is auto-attached.
 * `accessToken` is accepted for API parity but ignored — the page-side
 * fetch already has the right credentials.
 */
export async function fetchMe(page: Page, _accessToken?: string): Promise<MeResponse | null> {
  try {
    const result = await page.evaluate(async () => {
      const r = await fetch("/backend-api/me", {
        headers: { Accept: "application/json", "OAI-Language": "en-US" },
        credentials: "include",
      });
      if (!r.ok) return null;
      return await r.json();
    });
    return (result ?? null) as MeResponse | null;
  } catch {
    return null;
  }
}

export function detectPlan(me: MeResponse | null): string {
  if (!me) return "unknown";
  if (me.plan) return me.plan;
  // Fallback: feature/group sniffing
  const f = (me.features ?? []).concat(me.groups ?? []).join(",").toLowerCase();
  if (f.includes("pro")) return "pro";
  if (f.includes("business")) return "business";
  if (f.includes("enterprise")) return "enterprise";
  if (f.includes("plus")) return "plus";
  return "unknown";
}
