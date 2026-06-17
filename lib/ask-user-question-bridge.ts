/**
 * Telegram ask-user-question bridge runtime
 * Zones: telegram runtime, tool interop, update interception
 * Owns the global ask bridge registration used by ask-user-question.ts during Telegram turns
 */

import type * as TelegramApi from "./telegram-api.ts";

export type TelegramAskBridge = {
  version: 1;
  isTelegramTurnActive: () => boolean;
  ask: (payload: {
    question: string;
    details?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
    signal?: AbortSignal;
  }) => Promise<{ status: "answered" | "cancelled"; answer?: string }>;
};

export const TELEGRAM_ASK_BRIDGE_KEY = "__piTelegramAskUserQuestionBridge__";

type RegisterTelegramUpdateHandler = (
  handler: (update: unknown) => "pass" | "consume" | void,
) => () => void;

function buildTelegramAskPromptText(payload: {
  question: string;
  details?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}): string {
  const lines: string[] = [payload.question.trim()];
  if (payload.details?.trim()) {
    lines.push("", payload.details.trim());
  }
  const options = (payload.options || []).filter(
    (option) => option.label?.trim().length,
  );
  if (options.length > 0) {
    lines.push("", "Options:");
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      lines.push(`${i + 1}. ${option.label.trim()}`);
      if (option.description?.trim()) {
        lines.push(`   ${option.description.trim()}`);
      }
    }
    lines.push("");
    lines.push(
      payload.multiSelect
        ? "Reply with one or more numbers (e.g. 1 3), or type custom text. Send /cancel to cancel."
        : "Reply with a number (e.g. 1), or type custom text. Send /cancel to cancel.",
    );
  } else {
    lines.push("", "Reply with your answer. Send /cancel to cancel.");
  }
  return lines.filter((line) => line !== "").join("\n");
}

export function bindTelegramAskUserQuestionBridge(deps: {
  hasActiveTelegramTurn: () => boolean;
  getActiveTurnChatId: () => number | undefined;
  registerTelegramUpdateHandler: RegisterTelegramUpdateHandler;
  sendMessage: (body: TelegramApi.TelegramSendMessageBody) => Promise<unknown>;
  recordRuntimeEvent: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}): () => void {
  let pending:
    | {
        chatId: number;
        resolve: (result: {
          status: "answered" | "cancelled";
          answer?: string;
        }) => void;
        off: () => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const clearPending = (result: {
    status: "answered" | "cancelled";
    answer?: string;
  }) => {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timeout);
    try {
      current.off();
    } catch {
      // no-op
    }
    current.resolve(result);
  };

  const bridge: TelegramAskBridge = {
    version: 1,
    isTelegramTurnActive: deps.hasActiveTelegramTurn,
    ask: async (payload) => {
      if (pending) {
        clearPending({ status: "cancelled" });
      }
      const chatId = deps.getActiveTurnChatId();
      if (typeof chatId !== "number") {
        return { status: "cancelled" };
      }

      try {
        await deps.sendMessage({
          chat_id: chatId,
          text: buildTelegramAskPromptText(payload),
        });
      } catch (error) {
        deps.recordRuntimeEvent("ask_user_question", error, {
          stage: "send_prompt",
        });
        return { status: "cancelled" };
      }

      return await new Promise<{
        status: "answered" | "cancelled";
        answer?: string;
      }>((resolve) => {
        const off = deps.registerTelegramUpdateHandler((update) => {
          if (!pending) return "pass";
          const message = (
            update as {
              message?: {
                text?: string;
                caption?: string;
                chat?: { id?: number; type?: string };
                from?: { is_bot?: boolean };
              };
            }
          ).message;
          if (!message) return "pass";
          if (message.chat?.type !== "private") return "pass";
          if (message.from?.is_bot) return "pass";
          if (message.chat?.id !== pending.chatId) return "pass";
          const text = String(message.text ?? message.caption ?? "").trim();
          if (!text) return "pass";
          if (text === "/cancel") {
            clearPending({ status: "cancelled" });
            return "consume";
          }
          clearPending({ status: "answered", answer: text });
          return "consume";
        });

        const timeout = setTimeout(() => {
          clearPending({ status: "cancelled" });
        }, 10 * 60 * 1000);
        (timeout as unknown as { unref?: () => void }).unref?.();

        pending = { chatId, resolve, off, timeout };

        payload.signal?.addEventListener(
          "abort",
          () => {
            clearPending({ status: "cancelled" });
          },
          { once: true },
        );
      });
    },
  };

  (globalThis as Record<string, unknown>)[TELEGRAM_ASK_BRIDGE_KEY] = bridge;

  return () => {
    clearPending({ status: "cancelled" });
    const g = globalThis as Record<string, unknown>;
    if (g[TELEGRAM_ASK_BRIDGE_KEY] === bridge) {
      delete g[TELEGRAM_ASK_BRIDGE_KEY];
    }
  };
}
