/**
 * One-off probe: enumerate the chatgpt.com Projects (Gizmos) API
 * surface using the local cgpro authenticated session. Output is
 * JSON dumped to stdout so we can grep/jq it.
 *
 *   tsx scripts/probe-projects.ts
 */

import { openSession } from "../src/browser/session.js";
import { goHome, isLoggedIn, getAccessToken } from "../src/browser/chatgpt.js";

interface ProbeResult {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  bodyPreview: string;
  bodyKeys?: string[];
  error?: string;
}

interface FetchResult {
  ok: boolean;
  status: number;
  bodyText: string;
  bodyJson: unknown;
  error?: string;
}

const endpoints: { method: string; url: string; body?: unknown }[] = [
  // Known-good baseline
  { method: "GET", url: "/backend-api/me" },

  // ---- LIST gizmos (all confirmed by exporters) ----
  { method: "GET", url: "/backend-api/gizmos/snorlax/sidebar" },
  { method: "GET", url: "/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0" },
  { method: "GET", url: "/backend-api/gizmos/discovery" },

  // ---- CREATE project candidates (probe to find the right path) ----
  // POST /backend-api/gizmos creates a GPT not a Project — need a
  // project-specific endpoint. Probe the obvious ones with empty body
  // so the 422 schema-error reveals the expected fields.
  { method: "GET", url: "/backend-api/gizmos/projects" },
  { method: "PUT", url: "/backend-api/gizmos/projects", body: {} },
  { method: "POST", url: "/backend-api/projects/create", body: {} },
  { method: "POST", url: "/backend-api/gizmos/g-p-create", body: {} },
  { method: "POST", url: "/backend-api/gizmos/snorlax/create", body: {} },
  // Try GIZMO with "kind" hint variations
  { method: "POST", url: "/backend-api/gizmos", body: { kind: "project", display: { name: "x" }, files: [], instructions: "" } },
  { method: "POST", url: "/backend-api/gizmos", body: { type: "project", display: { name: "x" }, files: [], instructions: "" } },

  // ---- UPDATE / instructions (advisor's discriminating test) ----
  // 422 here = path exists; 404 = path doesn't.
  // Replace REPLACE_WITH_REAL_GIZMO_ID once we have one in hand.
  { method: "PATCH", url: "/backend-api/gizmos/REPLACE_WITH_REAL_GIZMO_ID", body: {} },
  { method: "PUT", url: "/backend-api/gizmos/REPLACE_WITH_REAL_GIZMO_ID", body: {} },

  // ---- CONVERSATION membership (sanity check) ----
  // Triggers a 422 with the expected schema so we see the gizmo_id field path.
  {
    method: "POST",
    url: "/backend-api/conversation",
    body: { __probe_only: true },
  },
];

async function probe(
  page: import("patchright").Page,
  ep: { method: string; url: string; body?: unknown },
  accessToken: string | null,
): Promise<ProbeResult> {
  const fetched = await page
    .evaluate(
      async (
        { method, url, body, token }: { method: string; url: string; body?: unknown; token: string | null },
      ): Promise<FetchResult> => {
        try {
          const init: RequestInit = {
            method,
            credentials: "include",
            headers: {
              Accept: "application/json",
              "OAI-Language": "en-US",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          };
          const r = await fetch(url, init);
          const text = await r.text();
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          return { ok: r.ok, status: r.status, bodyText: text, bodyJson: json };
        } catch (e) {
          return {
            ok: false,
            status: 0,
            bodyText: "",
            bodyJson: null,
            error: (e as Error).message,
          };
        }
      },
      { method: ep.method, url: ep.url, body: ep.body, token: accessToken },
    )
    .catch((e: Error) => ({
      ok: false,
      status: 0,
      bodyText: "",
      bodyJson: null,
      error: e.message,
    }));

  const result: ProbeResult = {
    method: ep.method,
    url: ep.url,
    status: fetched.status,
    ok: fetched.ok,
    bodyPreview: fetched.bodyText.slice(0, 600),
  };
  if (fetched.bodyJson && typeof fetched.bodyJson === "object") {
    result.bodyKeys = Object.keys(fetched.bodyJson as object).slice(0, 12);
  }
  if (fetched.error) result.error = fetched.error;
  return result;
}

async function main(): Promise<void> {
  const session = await openSession({ headed: true, background: true });
  try {
    await goHome(session.page);

    // Wait for the React app to bootstrap (it injects the Authorization
    // Bearer into its fetch interceptor only after first hydration).
    // networkidle is best-effort; fall through after 8s to keep moving.
    await session.page
      .waitForLoadState("networkidle", { timeout: 8_000 })
      .catch(() => console.error("(networkidle timeout — continuing)"));
    // Also wait for either the composer or the login button — proves
    // React mounted SOMETHING that's not a placeholder.
    await session.page
      .waitForSelector(
        '#prompt-textarea, [data-testid="prompt-textarea"], a[href*="login"]',
        { timeout: 8_000 },
      )
      .catch(() => console.error("(no composer/login selector — continuing)"));

    // Pull the Bearer once; reuse for every backend-api call.
    const accessToken = await getAccessToken(session.page);
    if (!accessToken) {
      console.error("NO ACCESS TOKEN from /api/auth/session — run `cgpro login` first.");
      process.exit(2);
    }
    console.error(`accessToken first20=${accessToken.slice(0, 20)}…`);
    void isLoggedIn;

    const results: ProbeResult[] = [];
    for (const ep of endpoints) {
      const r = await probe(session.page, ep, accessToken);
      results.push(r);
      // Compact one-liner to stderr so we can watch progress
      console.error(`${r.status.toString().padStart(3, " ")} ${ep.method.padEnd(4)} ${ep.url}`);
    }
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } finally {
    await session.close();
  }
}

void main();
