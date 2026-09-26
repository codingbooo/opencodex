/**
 * Detect Cursor desktop installs and tell the two builds apart.
 *
 * Cursor ships a second desktop distribution, "Cursor Private Inference", whose agent loop
 * runs locally and calls an OpenAI-compatible gateway the user configures. That build can
 * reach opencodex on loopback. Regular Cursor cannot: its backend calls the custom base URL
 * and rejects private addresses. The two share a bundle id, data folder and URL scheme, so
 * the only reliable discriminator is `nameLong` in the app's `product.json`.
 *
 * Detection is read-only and injectable: the proxy never writes anything into a Cursor
 * install, its state database, or its keychain entries (the T20 exclusion in
 * devlog/_plan/260822_senpi_cursor_transfer/090), and the tests run against a temp tree.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type CursorBuild = "private-inference" | "regular";

export interface CursorInstall {
  build: CursorBuild;
  /** The install root (the .app bundle, install directory, or AppImage extraction root). */
  path: string;
  version: string | null;
}

export interface CursorDetectDeps {
  platform: string;
  homedir: string;
  env: Record<string, string | undefined>;
  readText(path: string): string | null;
  listDir(path: string): string[];
}

export function realCursorDetectDeps(): CursorDetectDeps {
  return {
    platform: process.platform,
    homedir: homedir(),
    env: process.env,
    readText: path => {
      try {
        return existsSync(path) ? readFileSync(path, "utf-8") : null;
      } catch {
        return null;
      }
    },
    listDir: path => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
}

const PRIVATE_INFERENCE_NAME = "Cursor Private Inference";
const REGULAR_NAME = "Cursor";

/**
 * Candidate `product.json` paths per platform, each paired with the install root it
 * belongs to. Only well-known locations; a custom install path is the user's to name.
 */
export function cursorProductJsonCandidates(deps: CursorDetectDeps): Array<{ root: string; productJson: string }> {
  const out: Array<{ root: string; productJson: string }> = [];
  // Join with the target platform's separator so the candidate list is stable in tests
  // that describe another OS from this one.
  const { join } = deps.platform === "win32" ? win32 : posix;
  if (deps.platform === "darwin") {
    for (const dir of ["/Applications", join(deps.homedir, "Applications")]) {
      for (const entry of deps.listDir(dir)) {
        if (!/^Cursor.*\.app$/i.test(entry)) continue;
        const root = join(dir, entry);
        out.push({ root, productJson: join(root, "Contents", "Resources", "app", "product.json") });
      }
    }
    return out;
  }
  if (deps.platform === "win32") {
    const bases = [
      deps.env.LOCALAPPDATA ? join(deps.env.LOCALAPPDATA, "Programs") : null,
      deps.env.ProgramFiles ?? null,
    ].filter((value): value is string => value !== null);
    for (const dir of bases) {
      for (const entry of deps.listDir(dir)) {
        if (!/^cursor/i.test(entry)) continue;
        const root = join(dir, entry);
        out.push({ root, productJson: join(root, "resources", "app", "product.json") });
      }
    }
    return out;
  }
  // Linux: AppImages carry product.json only once extracted, so this covers the tarball /
  // package layouts and stays best-effort.
  for (const dir of ["/opt", join(deps.homedir, ".local", "share")]) {
    for (const entry of deps.listDir(dir)) {
      if (!/^cursor/i.test(entry)) continue;
      const root = join(dir, entry);
      out.push({ root, productJson: join(root, "resources", "app", "product.json") });
    }
  }
  return out;
}

function classify(productJson: string): { build: CursorBuild; version: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(productJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { nameLong?: unknown; version?: unknown };
  const version = typeof record.version === "string" ? record.version : null;
  if (record.nameLong === PRIVATE_INFERENCE_NAME) return { build: "private-inference", version };
  if (record.nameLong === REGULAR_NAME) return { build: "regular", version };
  return null;
}

export function detectCursorInstalls(deps: CursorDetectDeps = realCursorDetectDeps()): CursorInstall[] {
  const found: CursorInstall[] = [];
  const seen = new Set<string>();
  for (const candidate of cursorProductJsonCandidates(deps)) {
    if (seen.has(candidate.root)) continue;
    const text = deps.readText(candidate.productJson);
    if (text === null) continue;
    const classified = classify(text);
    if (!classified) continue;
    seen.add(candidate.root);
    found.push({ build: classified.build, path: candidate.root, version: classified.version ?? packageVersion(deps.readText(candidate.productJson.replace(/product\.json$/, "package.json"))) });
  }
  return found;
}

// Recent Cursor products keep their application version in package.json.
function packageVersion(text: string | null): string | null {
  try {
    const value = JSON.parse(text ?? "null")?.version;
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

export interface CursorInstaller { version: string; url: string }

const installerCache = new Map<string, { expires: number; result: Promise<CursorInstaller | null> }>();

/** Metadata only: never fetch the installer or mutate the installed app. */
export async function cursorLocalModeInstaller(
  installs: CursorInstall[],
  options: { platform?: string; arch?: string; fetch?: typeof fetch } = {},
): Promise<CursorInstaller | null> {
  if (installs.some(install => install.build === "private-inference")) return null;
  const regular = installs.find(install => install.build === "regular");
  if (!regular?.version || !/^\d+\.\d+\.\d+$/.test(regular.version)) return null;
  const installedVersion = regular.version;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!["x64", "arm64"].includes(arch)) return null;
  const target = platform === "win32"
    ? `win32-${arch}${/[\\/]Programs[\\/]/i.test(regular.path) ? "-user" : ""}`
    : platform === "darwin" ? `darwin${arch === "arm64" ? "-arm64" : ""}`
    : platform === "linux" ? `linux-${arch}` : null;
  if (!target) return null;
  const key = `${target}:${regular.version}`;
  const cached = options.fetch ? undefined : installerCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = (async (): Promise<CursorInstaller | null> => {
    try {
      const response = await (options.fetch ?? fetch)(
        `https://api2.cursor.sh/updates/api/update/${target}/cursor-local/0.0.0/manual-check/stable`,
        { signal: AbortSignal.timeout(3000), redirect: "error" },
      );
      if (!response.ok) { await response.body?.cancel(); return null; }
      const body = await readBoundedResponseBody(response, { maxBytes: 65_536, totalTimeoutMs: 3000 });
      if (body.truncated || body.oversized) return null;
      const manifest = JSON.parse(body.text) as { version?: unknown; productVersion?: unknown; url?: unknown };
      const version = manifest.productVersion ?? manifest.version;
      if (version !== regular.version || typeof manifest.url !== "string") return null;
      const url = new URL(manifest.url);
      if (url.origin !== "https://downloads.cursor.com" || !url.pathname.startsWith("/local-mode/")
        || url.username || url.password) return null;
      return { version: installedVersion, url: url.href };
    } catch { return null; }
  })();
  if (!options.fetch) installerCache.set(key, { expires: Date.now() + 10 * 60_000, result });
  return result;
}
