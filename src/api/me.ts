import type { Page } from "patchright";
import { backendApiFetch } from "../browser/chatgpt.js";

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
  orgs?: {
    data?: Array<{
      id?: string;
      title?: string;
      name?: string;
      settings?: Record<string, unknown>;
      role?: string;
      personal?: boolean;
    }>;
  };
}

export async function fetchMe(page: Page, _accessToken?: string): Promise<MeResponse | null> {
  const r = await backendApiFetch(page, "/backend-api/me");
  return r.ok ? (r.body as MeResponse) : null;
}

export function detectPlan(me: MeResponse | null): string {
  if (!me) return "unknown";
  if (me.plan) return me.plan;
  // Most accounts surface plan via the org settings or features array.
  const f = (me.features ?? []).concat(me.groups ?? []).join(",").toLowerCase();
  if (f.includes("pro")) return "pro";
  if (f.includes("business")) return "business";
  if (f.includes("enterprise")) return "enterprise";
  if (f.includes("plus")) return "plus";
  return "unknown";
}
