/**
 * Regression tests for the Telegram extension entrypoint wiring
 * Covers composition-root binding of tools, commands, lifecycle hooks, and prompt injection
 */

import assert from "node:assert/strict";
import test from "node:test";

import telegramExtension from "../index.ts";
import * as telegramEntrypoint from "../index.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

type RegisteredIndexTool = {
  name?: string;
};

type RegisteredIndexCommand = {
  handler: (...args: never[]) => unknown;
};

type RegisteredIndexHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createIndexApiHarness() {
  let tool: RegisteredIndexTool | undefined;
  const commands = new Map<string, RegisteredIndexCommand>();
  const handlers = new Map<string, RegisteredIndexHandler[]>();
  const api = {
    on: (event: string, handler: RegisteredIndexHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (definition: RegisteredIndexTool) => {
      tool = definition;
    },
    registerCommand: (name: string, definition: RegisteredIndexCommand) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { tool: () => tool, commands, handlers, api };
}

function getRequiredIndexHandlers(
  handlers: Map<string, RegisteredIndexHandler[]>,
  name: string,
): RegisteredIndexHandler[] {
  const list = handlers.get(name) ?? [];
  assert.ok(list.length > 0, `Expected entrypoint handler ${name}`);
  return list;
}

function createIndexExtensionContext(): ExtensionContext {
  return {} as ExtensionContext;
}

function assertSystemPromptResult(
  value: unknown,
): asserts value is { systemPrompt: string } {
  assert.ok(typeof value === "object" && value !== null);
  assert.equal(typeof Reflect.get(value, "systemPrompt"), "string");
}

test("Extension entrypoint exposes only the default composition root", () => {
  assert.deepEqual(Object.keys(telegramEntrypoint), ["default"]);
});

test("Extension entrypoint wires domain bindings into the pi API", () => {
  const harness = createIndexApiHarness();
  telegramExtension(harness.api);
  assert.equal(harness.tool()?.name, "telegram_attach");
  assert.deepEqual(
    [...harness.commands.keys()],
    [
      "telegram-setup",
      "telegram-status",
      "telegram-connect",
      "telegram-disconnect",
    ],
  );
  const requiredEvents = [
    "session_start",
    "session_shutdown",
    "session_before_compact",
    "session_compact",
    "before_agent_start",
    "model_select",
    "agent_start",
    "tool_execution_start",
    "tool_execution_end",
    "message_start",
    "message_update",
    "agent_end",
  ];
  for (const evt of requiredEvents) {
    assert.ok(harness.handlers.has(evt), `Expected event binding: ${evt}`);
  }
});

test("Extension before-agent-start hook appends Telegram-specific guidance", async () => {
  const harness = createIndexApiHarness();
  telegramExtension(harness.api);
  const handlers = getRequiredIndexHandlers(
    harness.handlers,
    "before_agent_start",
  );

  const applyChain = async (prompt: string) => {
    let event: unknown = { systemPrompt: "System base", prompt };
    const ctx = createIndexExtensionContext();
    for (const h of handlers) {
      const next = await h(event, ctx);
      if (next !== undefined) event = next;
    }
    assertSystemPromptResult(event);
    return event;
  };

  const telegramResult = await applyChain("[telegram] hello");
  const localResult = await applyChain("hello");

  assert.match(
    telegramResult.systemPrompt,
    /current user message came from Telegram/,
  );
  assert.match(telegramResult.systemPrompt, /telegram_attach/);
  assert.equal(localResult.systemPrompt.includes("came from Telegram"), false);
});
