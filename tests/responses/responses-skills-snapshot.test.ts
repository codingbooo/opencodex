import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config/proxy-env";
import { handleResponses } from "../../src/server/responses/core";
import { resetSkillsSnapshotCacheForTests } from "../../src/server/responses/skills-snapshot";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;
const captured: string[] = [];

beforeEach(() => {
  releaseSpendHome = acquireOwnedSpendHome();
  resetSkillsSnapshotCacheForTests();
  captured.length = 0;
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  resetSkillsSnapshotCacheForTests();
});

function fixture(adapter: "openai-responses" | "anthropic"): OcxConfig {
  globalThis.fetch = (async (_input, init) => {
    captured.push(String(init?.body));
    return Response.json(adapter === "anthropic" ? {
      id: "msg_skills", type: "message", role: "assistant", model: "fixture-model",
      content: [{ type: "text", text: "done" }], stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 1 },
    } : {
      id: "resp_skills", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    });
  }) as typeof fetch;
  return {
    ...getDefaultConfig(),
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter, baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key" },
    },
  };
}

async function send(config: OcxConfig, catalog: string, thread?: string, surrounding = "outside", headers: Record<string, string> = {}) {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
      ...(thread ? { "thread-id": thread, "x-codex-parent-thread-id": "shared-parent" } : {}),
    },
    body: JSON.stringify({
      model: "fixture/fixture-model", stream: false,
      input: [
        { role: "developer", content: [{ type: "input_text", text: `${surrounding}<skills_instructions>${catalog}</skills_instructions>` }] },
        { role: "user", content: "Please help with <skills_instructions>user-example</skills_instructions>" },
      ],
    }),
  }), config, { model: "", provider: "" });
  const text = await response.text();
  expect({ status: response.status, ...(response.status !== 200 ? { text } : {}) }).toEqual({ status: 200 });
  return captured.at(-1)!;
}

describe("skills catalog snapshots on the Responses request path", () => {
  for (const adapter of ["openai-responses", "anthropic"] as const) {
    test(`${adapter}: keeps the catalog stable while preserving surrounding instructions and sibling isolation`, async () => {
      const config = fixture(adapter);
      await send(config, "first-catalog", "child-a");
      const second = await send(config, "edited-catalog", "child-a", "updated-outside");
      expect(second).toContain("<skills_instructions>first-catalog</skills_instructions>");
      expect(second).not.toContain("edited-catalog");
      expect(second).toContain("updated-outside");
      expect(second).toContain("<skills_instructions>user-example</skills_instructions>");
      const sibling = await send(config, "sibling-catalog", "child-b");
      expect(sibling).toContain("sibling-catalog");
      expect(sibling).not.toContain("first-catalog");
    });
  }

  test("per_turn forwards changed catalogs", async () => {
    const config = fixture("anthropic");
    config.skills = { catalog_refresh: "per_turn" };
    await send(config, "first-catalog", "turn-mode");
    expect(await send(config, "edited-catalog", "turn-mode")).toContain("edited-catalog");
  });

  test("session header aliases reuse the same snapshot", async () => {
    const config = fixture("anthropic");
    await send(config, "session-catalog", undefined, "outside", { session_id: "session-a" });
    const next = await send(config, "edited-catalog", undefined, "outside", { "session-id": "session-a" });
    expect(next).toContain("session-catalog");
    expect(next).not.toContain("edited-catalog");
    expect(await send(config, "new-session-catalog", undefined, "outside", { session_id: "session-b" }))
      .toContain("new-session-catalog");
  });

  test("requests without a conversation identity never share catalogs", async () => {
    const config = fixture("anthropic");
    await send(config, "first-catalog");
    expect(await send(config, "edited-catalog")).toContain("edited-catalog");
  });

  test("a parent-only routing identity cannot share sibling catalogs", async () => {
    const config = fixture("anthropic");
    const headers = { "x-codex-parent-thread-id": "parent-without-child" };
    await send(config, "first-child-catalog", undefined, "outside", headers);
    expect(await send(config, "second-child-catalog", undefined, "outside", headers))
      .toContain("second-child-catalog");
  });
});
