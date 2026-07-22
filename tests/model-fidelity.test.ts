/**
 * Tests for the folded model-fidelity bridge
 * Guards /power + /eco + /model intent parsing and per-lane model switching
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";

import activateFoldedModelFidelity from "../folded/model-fidelity/index.ts";

// node --test runs each test file in its own process, so setting lane env once at
// module scope is safe and avoids races between concurrent top-level tests.
const LANE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mf-lane-")); // no telegram.json -> sendTelegram no-ops
process.env.PI_CODING_AGENT_DIR = LANE_DIR;
process.env.PI_TELEGRAM_MODEL_POWER = "azure-anthropic-messages/opus-power";
process.env.PI_TELEGRAM_MODEL_ECO = "azure-openai-responses/mini-eco";

type InputHandler = (
  event: { text?: string; source?: string },
  ctx: unknown,
) => Promise<{ action: string } | undefined>;

function makePi() {
  let inputHandler: InputHandler | undefined;
  const entries: Array<{ type: string; data: unknown }> = [];
  const setModelCalls: unknown[] = [];
  const pi = {
    on(event: string, handler: InputHandler) {
      if (event === "input") inputHandler = handler;
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    async setModel(model: unknown) {
      setModelCalls.push(model);
      return true;
    },
  };
  activateFoldedModelFidelity(pi as never);
  return { get handler() { return inputHandler!; }, entries, setModelCalls };
}

function makeCtx() {
  return {
    cwd: "/tmp/lane",
    model: { id: "azure-openai-responses/current-model" },
    modelRegistry: {
      find(provider: string, modelId: string) {
        return { id: `${provider}/${modelId}`, name: modelId, provider };
      },
    },
  };
}

test("switches to power via slash command", async () => {
  const pi = makePi();
  const res = await pi.handler({ text: "[telegram] /power", source: "extension" }, makeCtx());
  assert.equal(res?.action, "transform");
  assert.equal(pi.setModelCalls.length, 1);
  assert.deepEqual(pi.setModelCalls[0], {
    id: "azure-anthropic-messages/opus-power",
    name: "opus-power",
    provider: "azure-anthropic-messages",
  });
});

test("switches to eco via voice phrase", async () => {
  const pi = makePi();
  const res = await pi.handler({ text: "[telegram] eco mode", source: "extension" }, makeCtx());
  assert.equal(res?.action, "transform");
  assert.equal((pi.setModelCalls[0] as { name: string }).name, "mini-eco");
});

test("high fidelity / low fidelity map to power / eco", async () => {
  const p1 = makePi();
  await p1.handler({ text: "high fidelity", source: "extension" }, makeCtx());
  assert.equal((p1.setModelCalls[0] as { name: string }).name, "opus-power");

  const p2 = makePi();
  await p2.handler({ text: "low fidelity", source: "extension" }, makeCtx());
  assert.equal((p2.setModelCalls[0] as { name: string }).name, "mini-eco");
});

test("/model status does not switch", async () => {
  const pi = makePi();
  const res = await pi.handler({ text: "[telegram] /model", source: "extension" }, makeCtx());
  assert.equal(res?.action, "transform");
  assert.equal(pi.setModelCalls.length, 0);
});

test("does not switch mid-sentence (substring guard)", async () => {
  const pi = makePi();
  const res = await pi.handler(
    { text: "[telegram] we need a lot more power on this project", source: "extension" },
    makeCtx(),
  );
  assert.equal(res?.action, "continue");
  assert.equal(pi.setModelCalls.length, 0);
});

test("ignores non-telegram console input", async () => {
  const pi = makePi();
  const res = await pi.handler({ text: "/power", source: "console" }, makeCtx());
  assert.equal(res?.action, "continue");
  assert.equal(pi.setModelCalls.length, 0);
});
