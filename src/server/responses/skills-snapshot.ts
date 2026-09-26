/**
 * runtime skills catalog session snapshotting (#5569).
 *
 * Preserves the Anthropic/LLM prompt cache prefix across turns by freezing
 * incoming <skills_instructions> for the duration of a trustworthy session.
 * Gated by config `skills.catalog_refresh`: "per_session" (default) or "per_turn".
 *
 * Lifecycle & Bounds:
 * - 4 hours idle TTL (sliding on access)
 * - 1,000 maximum tracked sessions (LRU eviction)
 * - 512 KiB maximum per snapshotted skills block
 * - 8 MiB global retained byte bound across all sessions
 */
import type { OcxConfig, SkillsCatalogRefresh } from "../../types/config";
import { resolveContextPrincipal, type DataPlaneAdmission } from "../auth-cors";
import {
  reasoningReplayConversationIdFromResponsesRequest,
  sessionIdHeaderFromRequest,
} from "../request-log-conversation";

const SKILLS_BLOCK_GLOBAL_REGEX = /<skills_instructions>([\s\S]*?)<\/skills_instructions>/g;

/** Maximum distinct sessions tracked in the memory LRU. */
export const MAX_SNAPSHOT_SESSIONS = 1000;
/** Slide expiry after 4 hours of inactivity. */
export const SNAPSHOT_TTL_MS = 4 * 60 * 60 * 1000;
/** Bounded byte ceiling per snapshotted skills block (512 KiB). */
export const MAX_SKILLS_BLOCK_BYTES = 512 * 1024;
/** Global retained byte bound across all tracked sessions (8 MiB). */
export const MAX_TOTAL_RETAINED_BYTES = 8 * 1024 * 1024;

interface SnapshotEntry {
  skillsBlock: string; // The full <skills_instructions>...</skills_instructions> block
  byteLength: number;
  lastAccessed: number;
}

const snapshotCache = new Map<string, SnapshotEntry>();
let totalRetainedBytes = 0;

function evictOldestEntry(): boolean {
  const oldest = snapshotCache.entries().next().value;
  if (!oldest) return false;
  const [key, entry] = oldest;
  totalRetainedBytes -= entry.byteLength;
  snapshotCache.delete(key);
  return true;
}

export function resolveSkillsCatalogRefresh(config: OcxConfig | undefined): SkillsCatalogRefresh {
  const configured = config?.skills?.catalog_refresh;
  if (configured === "per_turn") return "per_turn";
  return "per_session";
}

export interface ResolveSkillsSessionScopeInput {
  req: Request;
  config: OcxConfig;
  admission?: DataPlaneAdmission;
  cursorConversationId?: string;
  promptCacheKeyIsSharedCohort?: boolean;
}

/**
 * Resolves a trustworthy cache key for skills catalog snapshotting.
 * Returns null if no specific, reliable thread/session identity is available,
 * or if the identity comes from a shared cohort fallback.
 */
export function resolveSkillsSnapshotScopeKey(input: ResolveSkillsSessionScopeInput): string | null {
  if (input.promptCacheKeyIsSharedCohort === true) {
    return null;
  }

  const parentThread = input.req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const ownThreadId = input.req.headers.get("thread-id")?.trim() || undefined;
  const cursorId = input.cursorConversationId?.trim() || undefined;

  // When a parent thread is present, subagents/children may share a root session-id header.
  // To prevent cross-thread/sibling collapse or parent-level caching, require an explicit
  // own thread-id (or cursor id). If parentThread is present without an own child thread,
  // bypass snapshotting completely.
  if (parentThread) {
    const childId = ownThreadId ?? cursorId;
    if (!childId || childId === parentThread) {
      return null;
    }
    const qualifiedId = `${parentThread}\u0000${childId}`;
    const principal = resolveContextPrincipal(input.req, input.config, input.admission) ?? null;
    return JSON.stringify(["skills_catalog_snapshot_v1", principal, qualifiedId]);
  }

  // Standalone conversation (no parent thread)
  const standaloneId = reasoningReplayConversationIdFromResponsesRequest({
    threadIdHeader: ownThreadId,
    cursorConversationId: cursorId,
    sessionIdHeader: sessionIdHeaderFromRequest(input.req.headers),
  });
  if (!standaloneId) {
    return null;
  }
  const principal = resolveContextPrincipal(input.req, input.config, input.admission) ?? null;
  return JSON.stringify(["skills_catalog_snapshot_v1", principal, standaloneId]);
}

function snapshotOrReplaceInText(
  text: string,
  scopeKey: string,
  now: number,
): string {
  if (!text.includes("<skills_instructions>")) return text;

  return text.replace(SKILLS_BLOCK_GLOBAL_REGEX, (match) => {
    const existing = snapshotCache.get(scopeKey);
    if (existing) {
      // Check TTL on cache hits
      if (now - existing.lastAccessed > SNAPSHOT_TTL_MS) {
        totalRetainedBytes -= existing.byteLength;
        snapshotCache.delete(scopeKey);
      } else {
        existing.lastAccessed = now;
        // Refresh Map order for true LRU behavior
        snapshotCache.delete(scopeKey);
        snapshotCache.set(scopeKey, existing);
        return existing.skillsBlock;
      }
    }

    // First turn or expired: snapshot incoming block if bounded
    const incomingBlock = match;
    const blockBytes = Buffer.byteLength(incomingBlock, "utf8");
    if (blockBytes <= MAX_SKILLS_BLOCK_BYTES && blockBytes <= MAX_TOTAL_RETAINED_BYTES) {
      // Evict oldest entries until under count ceiling AND under global byte ceiling
      while (
        (snapshotCache.size >= MAX_SNAPSHOT_SESSIONS || totalRetainedBytes + blockBytes > MAX_TOTAL_RETAINED_BYTES)
        && snapshotCache.size > 0
      ) {
        if (!evictOldestEntry()) break;
      }

      if (totalRetainedBytes + blockBytes <= MAX_TOTAL_RETAINED_BYTES) {
        snapshotCache.set(scopeKey, {
          skillsBlock: incomingBlock,
          byteLength: blockBytes,
          lastAccessed: now,
        });
        totalRetainedBytes += blockBytes;
      }
    }
    return match;
  });
}

/**
 * Transforms incoming developer/system prompt contents to reuse the session's
 * snapshotted <skills_instructions>, preserving prefix cache across turns.
 * User and assistant messages, as well as tool calls, are never modified.
 */
export function snapshotSkillsCatalogInBody(
  body: unknown,
  scopeKey: string | null,
  config: OcxConfig,
  now: number = Date.now(),
): void {
  if (!scopeKey) return;
  if (resolveSkillsCatalogRefresh(config) === "per_turn") return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;

  const b = body as Record<string, unknown>;

  // 1. Check top-level instructions field
  if (typeof b.instructions === "string" && b.instructions.includes("<skills_instructions>")) {
    b.instructions = snapshotOrReplaceInText(b.instructions, scopeKey, now);
  }

  // 2. Check input array for developer/system messages only
  if (Array.isArray(b.input)) {
    for (const item of b.input) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      // Restrict message item type: must be undefined or "message", so role-like tool objects are untouched
      if (it.type !== undefined && it.type !== "message") continue;
      const role = it.role;
      // Only developer and system content is inspected/transformed
      if (role !== "developer" && role !== "system") continue;

      const content = it.content;
      if (typeof content === "string") {
        if (content.includes("<skills_instructions>")) {
          it.content = snapshotOrReplaceInText(content, scopeKey, now);
        }
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          // Restrict text parts to known text / input_text
          if (p.type !== "text" && p.type !== "input_text") continue;
          if (typeof p.text === "string" && p.text.includes("<skills_instructions>")) {
            p.text = snapshotOrReplaceInText(p.text, scopeKey, now);
          }
        }
      }
    }
  }
}

/** Test helpers */
export function resetSkillsSnapshotCacheForTests(): void {
  snapshotCache.clear();
  totalRetainedBytes = 0;
}

