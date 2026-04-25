/**
 * Wraps the chatgpt.com Projects (Gizmos) API for cgpro.
 *
 * Projects are internally called "gizmos" with a `g-p-` id prefix
 * (Custom GPTs use the bare `g-` prefix). Endpoints discovered via
 * scripts/probe-projects.ts on 2026-04-25:
 *
 *   GET  /backend-api/gizmos/snorlax/sidebar         → list all gizmos
 *   POST /backend-api/gizmos                         → create (needs files/instructions/display)
 *   GET  /backend-api/gizmos/{id}/conversations      → list convs in a project
 *
 * Update/delete endpoints accept neither PATCH nor PUT (both 405) — we
 * keep memory local instead of pushing instructions back to the server.
 */

import type { Page } from "patchright";
import { backendApiFetch } from "../browser/chatgpt.js";

export interface Project {
  /** `g-p-...` UUID-like id */
  id: string;
  /** Stable URL slug used in /g/{shortUrl}/... */
  shortUrl?: string;
  /** Display name shown in the sidebar */
  name: string;
  /** User-supplied description */
  description?: string;
  /** Custom instructions (often empty for fresh projects) */
  instructions?: string;
  /** Owning organization id */
  organizationId?: string;
}

export async function listProjects(page: Page): Promise<Project[]> {
  const r = await backendApiFetch(
    page,
    "/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0",
  );
  if (!r.ok) return [];
  return extractProjects(r.body);
}

function extractProjects(body: unknown): Project[] {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown[] }).items ?? [];
  const out: Project[] = [];
  for (const item of items) {
    const g = pickGizmo(item);
    if (!g || !g.id || !g.id.startsWith("g-p-")) continue; // projects only
    const display = (g.display ?? {}) as { name?: string; description?: string };
    out.push({
      id: g.id,
      shortUrl: g.short_url,
      name: display.name ?? "(untitled project)",
      description: display.description ?? "",
      instructions: g.instructions ?? "",
      organizationId: g.organization_id,
    });
  }
  return out;
}

interface RawGizmo {
  id?: string;
  short_url?: string;
  organization_id?: string;
  instructions?: string;
  display?: { name?: string; description?: string };
}

function pickGizmo(item: unknown): RawGizmo | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  // Two shapes seen in the sidebar response:
  //   { gizmo: {...} }
  //   { gizmo: { gizmo: {...} } }
  const inner = (obj.gizmo as Record<string, unknown> | undefined) ?? null;
  if (!inner) return null;
  const nested = (inner.gizmo as Record<string, unknown> | undefined) ?? null;
  return (nested as RawGizmo) ?? (inner as RawGizmo);
}

/**
 * List the conversations attached to a specific project.
 * Cursor-based; returns first page (50 rows by default).
 */
export interface ProjectConversation {
  id: string;
  title: string;
  updatedAt?: string;
}

export async function listProjectConversations(
  page: Page,
  projectId: string,
  cursor = "0",
  limit = 50,
): Promise<ProjectConversation[]> {
  const r = await backendApiFetch(
    page,
    `/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
  );
  if (!r.ok) return [];
  const items = (r.body as { items?: Array<Record<string, unknown>> }).items ?? [];
  const out: ProjectConversation[] = [];
  for (const it of items) {
    const id = typeof it.id === "string" ? it.id : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    const title = typeof it.title === "string" && it.title.trim().length > 0 ? it.title.trim() : "(untitled)";
    const updateTime = it.update_time ?? it.updated_at;
    const updatedAt =
      typeof updateTime === "string"
        ? updateTime
        : typeof updateTime === "number"
          ? new Date(updateTime * 1000).toISOString()
          : undefined;
    out.push({ id, title, updatedAt });
  }
  return out;
}

/**
 * Create a new project (gizmo with g-p- prefix).
 *
 * Probed body shape via `POST /backend-api/gizmos` 422 schema-leak:
 *   { files, instructions, display }
 * `display` must include `name`. Files can be empty. Instructions can be empty.
 *
 * Returns the new project on success, null on failure (logs the error).
 */
export async function createProject(
  page: Page,
  opts: { name: string; description?: string; instructions?: string },
): Promise<Project | null> {
  const body = {
    files: [],
    instructions: opts.instructions ?? "",
    display: {
      name: opts.name,
      description: opts.description ?? "",
      prompt_starters: [],
      profile_pic_id: null,
    },
    // The UI also sends these — including them avoids 422s when the
    // backend tightens schema validation.
    settings: { hide_in_chat_history: false },
    workspace_id: null,
    kind: "project",
  };
  const r = await backendApiFetch(page, "/backend-api/gizmos", {
    method: "POST",
    body,
  });
  if (!r.ok) {
    if (process.env.CGPRO_DEBUG === "1") {
      console.error("[cgpro:projects] create failed", r.status, JSON.stringify(r.body).slice(0, 500));
    }
    return null;
  }
  const g = pickGizmo({ gizmo: r.body });
  if (!g?.id) return null;
  const display = (g.display ?? {}) as { name?: string; description?: string };
  return {
    id: g.id,
    shortUrl: g.short_url,
    name: display.name ?? opts.name,
    description: display.description ?? "",
    instructions: g.instructions ?? "",
    organizationId: g.organization_id,
  };
}

/**
 * Returns the chatgpt.com URL for a project (used to navigate the
 * page so subsequent sendPrompt creates a conversation inside it).
 */
export function projectUrl(p: { id: string; shortUrl?: string }): string {
  return `https://chatgpt.com/g/${encodeURIComponent(p.shortUrl ?? p.id)}/project`;
}
