import type { Page } from "playwright";
import { CHATGPT_HOME } from "../browser/chatgpt.js";

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
 * Fetches the current account info via /backend-api/me. Cookies + Bearer
 * are auto-attached by the page's request context.
 */
export async function fetchMe(page: Page, accessToken?: string): Promise<MeResponse | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "OAI-Language": "en-US",
    };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
    const resp = await page.context().request.get(`${CHATGPT_HOME}backend-api/me`, {
      headers,
      timeout: 10_000,
    });
    if (!resp.ok()) return null;
    return (await resp.json()) as MeResponse;
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
