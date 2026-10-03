/**
 * Regression tests for Telegram outbound voice delivery helpers
 * Exercises direct voice-sender ownership after extraction from outbound.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramVoiceReplySender } from "../lib/outbound-voice.ts";
import { sanitizeTelegramVoiceText } from "../lib/voice-text.ts";
import {
  clearTelegramVoiceSynthesisProviders,
  registerTelegramVoiceSynthesisProvider,
} from "../lib/voice.ts";

test.beforeEach(() => {
  clearTelegramVoiceSynthesisProviders();
});

test("Outbound voice sender uploads provider opus result with reply markup and transcript", async () => {
  registerTelegramVoiceSynthesisProvider(
    async () => ({ audioPath: "/tmp/direct.opus", transcriptText: "spoken" }),
    { id: "direct-test" },
  );
  const uploads: unknown[] = [];
  const actions: unknown[] = [];
  const sendVoice = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendRecordVoiceAction: async (chatId) => {
      actions.push(chatId);
    },
    sendMultipart: async (...args) => {
      uploads.push(args);
    },
  });

  await sendVoice(
    { chatId: 1, replyToMessageId: 2 },
    "hello",
    { replyMarkup: { inline_keyboard: [] }, replyToPrompt: true },
  );

  assert.deepEqual(actions, [1]);
  assert.deepEqual(uploads, [
    [
      "sendVoice",
      {
        chat_id: "1",
        caption: "spoken",
        reply_parameters: JSON.stringify({
          message_id: 2,
          allow_sending_without_reply: true,
        }),
        reply_markup: JSON.stringify({ inline_keyboard: [] }),
      },
      "voice",
      "/tmp/direct.opus",
      "direct.opus",
    ],
  ]);
});

test("Voice text sanitizer removes Markdown controls and link destinations", () => {
  assert.equal(
    sanitizeTelegramVoiceText(
      "# Update\n\n- **Important**: _read_ [the guide](https://example.com/guide).\n- `Keep this` and ~~that~~.\n\n```ts\nconst hidden = true;\n```\n\n<https://example.com/raw>",
    ),
    "Update\nImportant: read the guide.\nKeep this and that.",
  );
  assert.equal(sanitizeTelegramVoiceText("**Unclosed _emphasis"), "Unclosed emphasis");
});

test("Outbound voice sender normalizes Markdown before calling providers", async () => {
  let receivedText = "";
  registerTelegramVoiceSynthesisProvider(
    async (text) => {
      receivedText = text;
      return "/tmp/normalized.opus";
    },
    { id: "normalization-test" },
  );
  const sendVoice = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async () => {},
  });

  await sendVoice(
    { chatId: 1, replyToMessageId: 2 },
    "**Bold** _italic_ [label](https://example.com) and `code`",
  );

  assert.equal(receivedText, "Bold italic label and code");
});

test("Outbound voice sender records and throws when every source fails", async () => {
  const events: Array<{ category: string; message: string; phase?: unknown }> = [];
  const sendVoice = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async () => {},
    recordRuntimeEvent: (category, error, details) => {
      events.push({
        category,
        message: (error as Error).message,
        phase: details?.phase,
      });
    },
  });

  await assert.rejects(
    sendVoice({ chatId: 1, replyToMessageId: 2 }, "hello"),
    /every voice synthesis provider and outbound voice handler failed/,
  );
  assert.deepEqual(events, [
    {
      category: "voice",
      message:
        "Failed to send voice reply: every voice synthesis provider and outbound voice handler failed.",
      phase: "send",
    },
  ]);
});
