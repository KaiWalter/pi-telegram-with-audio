import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type TelegramUpdate = {
  message?: TelegramMessage;
};

type TelegramMessage = {
  text?: string;
  caption?: string;
  chat?: { type?: string };
  from?: { is_bot?: boolean };
};

type ExternalHandlerVerdict = "consume" | "pass" | void;

type ExternalHandlerRegistry = {
  version: 1;
  add: (handler: (update: unknown) => ExternalHandlerVerdict | Promise<ExternalHandlerVerdict>) => () => void;
  dispatch: (update: unknown) => Promise<"consume" | "pass">;
};

const EXTERNAL_REGISTRY_KEY = "__piTelegramExternalHandlerRegistry__";
const NEW_SESSION_COMMANDS = new Set(["new"]);

function getExternalRegistry(): ExternalHandlerRegistry | undefined {
  const raw = (globalThis as Record<string, unknown>)[EXTERNAL_REGISTRY_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<ExternalHandlerRegistry>;
  if (
    candidate.version !== 1 ||
    typeof candidate.add !== "function" ||
    typeof candidate.dispatch !== "function"
  ) {
    return undefined;
  }
  return candidate as ExternalHandlerRegistry;
}

function parseLeadingSlashCommand(text: string): string | undefined {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  const command = match?.[1]?.toLowerCase();
  return command || undefined;
}

function getMessageCommand(message: TelegramMessage | undefined): string | undefined {
  if (!message) return undefined;
  const text = message.text ?? message.caption ?? "";
  if (!text) return undefined;
  return parseLeadingSlashCommand(text);
}

function isLikelyBotMessage(message: TelegramMessage | undefined): boolean {
  return message?.from?.is_bot === true;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function triggerNativeNewSession(pi: ExtensionAPI): Promise<boolean> {
  const pane = process.env.TMUX_PANE;
  if (pane) {
    try {
      const script = `sleep 0.35; tmux send-keys -t ${shellQuote(pane)} /new Enter`;
      await pi.exec("tmux", ["run-shell", "-b", script]);
      pi.appendEntry("telegram_new_bridge_debug", {
        path: "tmux-run-shell",
        pane,
      });
      return true;
    } catch (error) {
      pi.appendEntry("telegram_new_bridge_debug", {
        path: "tmux-run-shell-error",
        pane,
        error: error instanceof Error ? error.message : String(error),
      });
      // fall through to fallback
    }
  }

  try {
    pi.sendUserMessage("/new");
    pi.appendEntry("telegram_new_bridge_debug", {
      path: "sendUserMessage-fallback",
    });
    return true;
  } catch (error) {
    pi.appendEntry("telegram_new_bridge_debug", {
      path: "sendUserMessage-error",
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export default function telegramNewSessionBridgeExtension(pi: ExtensionAPI) {
  let off: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inputBridgeInFlight = false;

  const registerIfReady = () => {
    if (off) return;
    const registry = getExternalRegistry();
    if (!registry) return;

    off = registry.add(async (update) => {
      const message = (update as TelegramUpdate).message;
      const command = getMessageCommand(message);
      if (!command || !NEW_SESSION_COMMANDS.has(command)) return "pass";

      pi.appendEntry("telegram_new_bridge_debug", {
        path: "intercept",
        command,
        chatType: message?.chat?.type,
        fromBot: message?.from?.is_bot,
      });

      if (isLikelyBotMessage(message)) {
        pi.appendEntry("telegram_new_bridge_debug", {
          path: "skip-bot-message",
          command,
        });
        return "pass";
      }

      await triggerNativeNewSession(pi);
      return "consume";
    });

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  pi.on("input", async (event) => {
    if (event.source !== "extension") return { action: "continue" };
    const command = parseLeadingSlashCommand(event.text ?? "");
    if (!command || !NEW_SESSION_COMMANDS.has(command)) {
      return { action: "continue" };
    }

    if (inputBridgeInFlight) {
      return { action: "handled" };
    }

    inputBridgeInFlight = true;
    try {
      pi.appendEntry("telegram_new_bridge_debug", {
        path: "input-intercept",
        command,
        source: event.source,
      });
      await triggerNativeNewSession(pi);
      return { action: "handled" };
    } finally {
      const releaseTimer = setTimeout(() => {
        inputBridgeInFlight = false;
      }, 1000);
      (releaseTimer as unknown as { unref?: () => void }).unref?.();
    }
  });

  registerIfReady();
  timer = setInterval(registerIfReady, 1000);
  // Do not keep Node test processes alive solely because of this retry timer.
  (timer as unknown as { unref?: () => void }).unref?.();

  pi.on("session_start", () => {
    registerIfReady();
  });

  pi.on("shutdown", () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    off?.();
    off = undefined;
  });
}
