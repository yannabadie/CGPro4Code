/**
 * Pull the user's chatgpt.com conversation history.
 *
 * Two paths, tried in order. Both run inside the page so the React
 * app's Authorization Bearer is attached:
 *
 *   1. /backend-api/conversations — the canonical paginated endpoint.
 *      Schema can drift; we accept several URL variants and a few
 *      response shapes.
 *   2. DOM sidebar scrape — last-resort fallback that reads `<a href="/c/...">`
 *      links out of the conversation history nav. Works even when the
 *      API endpoint changes name, but only returns what's currently
 *      mounted in the DOM (typically the most recent ~50).
 */

import type { Page } from "patchright";
import { SELECTORS } from "../browser/selectors.js";

export interface RemoteConversation {
  id: string;
  title: string;
  /** ISO timestamp if the API gave us one. */
  updatedAt?: string;
  isArchived?: boolean;
  /** Tells the caller which path produced this row (for debugging). */
  source: "api" | "dom";
}

export interface FetchOptions {
  /** Cap the number of rows returned. Default 100. */
  limit?: number;
  /** Verbose logging to stderr. */
  debug?: boolean;
}

export async function fetchRemoteConversations(
  page: Page,
  opts: FetchOptions = {},
): Promise<RemoteConversation[]> {
  const limit = opts.limit ?? 100;
  const debug = opts.debug ?? process.env.CGPRO_DEBUG === "1";
  const log = (m: string): void => {
    if (debug) console.error("[cgpro:conversations]", m);
  };

  const fromApi = await fetchViaApi(page, limit, log);
  if (fromApi && fromApi.length > 0) return fromApi;

  log("API path returned no rows — falling back to DOM sidebar scrape.");
  return await fetchViaDom(page, limit, log);
}

async function fetchViaApi(
  page: Page,
  limit: number,
  log: (m: string) => void,
): Promise<RemoteConversation[] | null> {
  const urls = [
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated`,
    `/backend-api/conversations?offset=0&limit=${limit}&order=updated&is_archived=false`,
    `/backend-api/me/conversations?offset=0&limit=${limit}`,
  ];

  for (const url of urls) {
    const result = await page
      .evaluate(async (u) => {
        try {
          const r = await fetch(u, {
            headers: { Accept: "application/json", "OAI-Language": "en-US" },
            credentials: "include",
          });
          return {
            ok: r.ok,
            status: r.status,
            body: r.ok ? await r.json() : null,
          };
        } catch (e) {
          return { ok: false, status: 0, body: null, error: (e as Error).message };
        }
      }, url)
      .catch((e) => ({ ok: false as const, status: 0, body: null, error: (e as Error).message }));

    log(
      `${url} → ok=${result.ok} status=${result.status} bodyKeys=${
        result.body && typeof result.body === "object"
          ? Object.keys(result.body as object).join(",")
          : "(none)"
      }`,
    );

    if (!result.ok) continue;
    const rows = extractItems(result.body);
    if (rows.length > 0) {
      log(`${url} → matched ${rows.length} rows`);
      return rows.slice(0, limit);
    }
  }
  return null;
}

function extractItems(body: unknown): RemoteConversation[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const rawList = (Array.isArray(obj.items) ? obj.items : Array.isArray(obj.conversations) ? obj.conversations : []) as Array<Record<string, unknown>>;
  const out: RemoteConversation[] = [];
  for (const it of rawList) {
    const id = typeof it.id === "string" ? it.id : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    const title = typeof it.title === "string" && it.title.trim().length > 0 ? it.title.trim() : "(untitled)";
    const updateTime = it.update_time ?? it.updated_at;
    const updatedAt = typeof updateTime === "string" ? updateTime : typeof updateTime === "number" ? new Date(updateTime * 1000).toISOString() : undefined;
    const isArchived = typeof it.is_archived === "boolean" ? it.is_archived : undefined;
    out.push({ id, title, updatedAt, isArchived, source: "api" });
  }
  return out;
}

async function fetchViaDom(
  page: Page,
  limit: number,
  log: (m: string) => void,
): Promise<RemoteConversation[]> {
  const links = await page
    .evaluate((sels) => {
      const tried: { sel: string; count: number }[] = [];
      for (const sel of sels) {
        const items = document.querySelectorAll(sel);
        tried.push({ sel, count: items.length });
        if (items.length === 0) continue;
        const out: { id: string; title: string }[] = [];
        items.forEach((el) => {
          const a = (el.tagName === "A" ? el : el.querySelector("a")) as HTMLAnchorElement | null;
          if (!a) return;
          const m = a.href.match(/\/c\/([0-9a-f-]{36})/i);
          if (!m) return;
          const text = (a.textContent ?? "").trim();
          out.push({ id: m[1], title: text.length > 0 ? text : "(untitled)" });
        });
        if (out.length > 0) return { tried, out };
      }
      return { tried, out: [] };
    }, SELECTORS.conversationItem)
    .catch((e) => {
      log(`DOM evaluate threw: ${(e as Error).message}`);
      return { tried: [] as { sel: string; count: number }[], out: [] as { id: string; title: string }[] };
    });

  for (const t of links.tried) {
    log(`dom selector "${t.sel}": ${t.count} matches`);
  }
  return links.out.slice(0, limit).map((l) => ({
    id: l.id,
    title: l.title,
    source: "dom" as const,
  }));
}
