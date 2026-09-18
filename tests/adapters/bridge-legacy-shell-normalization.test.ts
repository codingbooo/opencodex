import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

async function* toolTurn(name: string, argumentsText = '{"cmd":"ls"}'): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call-1", name } as AdapterEvent;
  yield { type: "tool_call_delta", id: "call-1", arguments: argumentsText } as AdapterEvent;
  yield { type: "tool_call_end", id: "call-1" } as AdapterEvent;
  yield { type: "done" } as AdapterEvent;
}

// #2493: Codex 0.149 declares the shell tool as `exec`, whose own description names the
// nested `tools.exec_command(...)` helper. Routed models echo the helper name back, and the
// undeclared-tool guard turned that into a 502 mid-turn. These pin the SSE path the guard
// actually runs on, which the review flagged as untested.
describe("bridge normalizes code-mode helper names against the declared catalog", () => {
  test("exec_command is delivered as the declared exec instead of failing the turn", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("exec_command"), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.exec_command({\\"cmd\\":\\"ls\\"})');
    expect(sse).not.toContain('"input":"{\\"cmd\\":\\"ls\\"}"');
  });

  test("shell_command normalizes the same way", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("shell_command"), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.exec_command({\\"cmd\\":\\"ls\\"})');
  });

  test("write_stdin is wrapped through the declared exec tool", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("write_stdin", '{"session_id":17,"yield_time_ms":1000}'),
      "fixture-model",
      undefined,
      new Set(["exec"]),
      undefined,
      undefined,
      50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.write_stdin({\\"session_id\\":17,\\"yield_time_ms\\":1000})');
  });

  test("a genuinely undeclared tool still fails the turn", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("other_tool"), "deepseek-x", undefined, undefined, undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).toContain("undeclared client tool");
  });

  test("apply_patch is wrapped through the declared exec tool", async () => {
    async function* patchTurn(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call-patch", name: "apply_patch" } as AdapterEvent;
      yield { type: "tool_call_delta", id: "call-patch", arguments: "*** Begin Patch\n*** Add File: note.txt\n+ok\n*** End Patch" } as AdapterEvent;
      yield { type: "tool_call_end", id: "call-patch" } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    }
    const sse = await drain(bridgeToResponsesSSE(
      patchTurn(), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain("await tools.apply_patch");
  });

  test("default.view_image echoes are normalized back to declared bare view_image (#4176)", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("default.view_image", "{\"path\":\"image.png\"}"), "deepseek-x", undefined, undefined, undefined, undefined, 50_000,
      { declaredToolNames: new Set(["view_image"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain("\"name\":\"view_image\"");
    expect(sse).toContain("image.png");
  });

  test("view_image is compiled through code-mode exec and surfaces the image", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("view_image", '{"file_path":"/tmp/image.png","detail":"high"}'),
      "fixture-model",
      undefined,
      new Set(["exec"]),
      undefined,
      undefined,
      50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain('await tools.view_image({\\"detail\\":\\"high\\",\\"path\\":\\"/tmp/image.png\\"})');
    expect(sse).toContain("image(result.image_url)");
    expect(sse).not.toContain("tools.exec_command");
  });

  test("default.view_image is compiled through code-mode exec", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("default.view_image", '{"path":"/tmp/image.png"}'),
      "fixture-model",
      undefined,
      new Set(["exec"]),
      undefined,
      undefined,
      50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec"');
    expect(sse).toContain("await tools.view_image");
    expect(sse).not.toContain("tools.exec_command");
  });

  test("a catalog that declares exec_command itself is never rewritten", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("exec_command"), "deepseek-x", undefined, undefined, undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec", "exec_command"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    expect(sse).toContain('"name":"exec_command"');
    expect(sse).toContain('"arguments":"{\\"cmd\\":\\"ls\\"}"');
  });

  // #4171 review: the flat-bridge shape declares `exec` next to a bare `exec_command`, where
  // `exec` may be an ordinary caller tool and nested `tools.*` helpers are not what it runs.
  // A `view_image` call there must not be compiled into code-mode JavaScript.
  test("a flat-bridge catalog never compiles view_image into code-mode exec", async () => {
    const sse = await drain(bridgeToResponsesSSE(
      toolTurn("view_image", '{"path":"/tmp/image.png"}'),
      "deepseek-x",
      undefined,
      undefined,
      undefined,
      undefined,
      50_000,
      { declaredToolNames: new Set(["exec", "exec_command", "view_image"]) },
    ));
    expect(sse).toContain('"name":"view_image"');
    expect(sse).not.toContain("tools.view_image");
    expect(sse).not.toContain('"name":"exec"');
  });
});

// #5046: `resolveCodeModeHelperName` accepted these wrapper shapes (#4983) but the bridge still
// compiled from the ORIGINAL body, so the generated JavaScript handed `tools.apply_patch` the
// wrapper JSON or the outer Markdown fence as the patch. These drive the real bridge and then
// RUN the delivered body, because a recognizer-level assertion cannot see that gap.
describe("bridge compiles a recognized apply_patch wrapper from the body it validated", () => {
  const PATCH = "*** Begin Patch\n*** Add File: note.txt\n+ok\n*** End Patch";
  const DECORATED = "*** Begin Patch ***\n*** Add File: note.txt\n+ok\n*** End Patch ***";

  /** The compiled `exec` body one turn delivers, read back out of the bridged SSE. */
  async function deliveredExecInput(argumentText: string): Promise<string> {
    async function* turn(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call-patch", name: "exec" } as AdapterEvent;
      yield { type: "tool_call_delta", id: "call-patch", arguments: argumentText } as AdapterEvent;
      yield { type: "tool_call_end", id: "call-patch" } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    }
    const sse = await drain(bridgeToResponsesSSE(
      turn(), "deepseek-x", undefined, new Set(["exec"]), undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec"]) },
    ));
    expect(sse).not.toContain("undeclared client tool");
    const delivered = sse
      .split("\n")
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice("data: ".length)) as {
        type?: string;
        item?: { type?: string; input?: unknown };
      })
      .find(payload => payload.type === "response.output_item.done" && payload.item?.type === "custom_tool_call");
    expect(typeof delivered?.item?.input).toBe("string");
    return delivered!.item!.input as string;
  }

  /** Run one delivered body the way the client does, and report what apply_patch received. */
  async function appliedPatch(argumentText: string): Promise<unknown> {
    const received: unknown[] = [];
    const run = new AsyncFunction("tools", "text", await deliveredExecInput(argumentText));
    await run({
      apply_patch: (patch: unknown) => {
        received.push(patch);
        return "ok";
      },
    }, () => {});
    expect(received).toHaveLength(1);
    return received[0];
  }

  test("a fallback-field body reaches apply_patch as the patch, not as its wrapper", async () => {
    for (const key of ["code", "script", "js", "javascript", "command", "cmd", "content"]) {
      expect(await appliedPatch(JSON.stringify({ [key]: PATCH })), key).toBe(PATCH);
    }
  });

  test("the {input} wrapper and the bare body reach apply_patch as the same patch", async () => {
    expect(await appliedPatch(JSON.stringify({ input: PATCH }))).toBe(PATCH);
    expect(await appliedPatch(PATCH)).toBe(PATCH);
  });

  test("a fenced body reaches apply_patch as the patch, with no fence", async () => {
    expect(await appliedPatch("```diff\n" + PATCH + "\n```")).toBe(PATCH);
    expect(await appliedPatch(JSON.stringify({ code: "```diff\n" + PATCH + "\n```" }))).toBe(PATCH);
  });

  test("decorated delimiters are normalized before apply_patch sees them", async () => {
    expect(await appliedPatch(DECORATED)).toBe(PATCH);
    expect(await appliedPatch(JSON.stringify({ code: DECORATED }))).toBe(PATCH);
  });

  test("a caller-defined non-code-mode exec body stays byte-exact", async () => {
    // Flat catalog: `exec` is an ordinary caller tool that may legitimately take patch text.
    async function* turn(): AsyncGenerator<AdapterEvent> {
      yield { type: "tool_call_start", id: "call-plain", name: "exec" } as AdapterEvent;
      yield { type: "tool_call_delta", id: "call-plain", arguments: JSON.stringify({ code: PATCH }) } as AdapterEvent;
      yield { type: "tool_call_end", id: "call-plain" } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    }
    const sse = await drain(bridgeToResponsesSSE(
      turn(), "deepseek-x", undefined, undefined, undefined, undefined, 50_000,
      { declaredToolNames: new Set(["exec", "exec_command"]) },
    ));
    expect(sse).not.toContain("tools.apply_patch");
    expect(sse).toContain('"name":"exec"');
  });
});
