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
const NATIVE_PI_COMMANDS = new Set(["new", "reload"] as const);
type NativePiCommand = "new" | "reload";

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

function stripLeadingEnvelopeTags(text: string): string {
  // Handles transport prefixes like: [telegram] /new  or  [telegram]\n\n/new
  return text.trim().replace(/^(?:\[[^\]\n]+\]\s*)+/, "").trim();
}

function parseLeadingSlashCommand(text: string): string | undefined {
  const trimmed = text.trim();

  // Fast path: plain /command
  const direct = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  if (direct?.[1]) return direct[1].toLowerCase();

  // Envelope path: [telegram] /command or [telegram]\n\n/command
  const withoutEnvelope = stripLeadingEnvelopeTags(trimmed);
  const envelopeDirect = withoutEnvelope.match(
    /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/,
  );
  if (envelopeDirect?.[1]) return envelopeDirect[1].toLowerCase();

  // Conservative line scan for slash-commands at line start after optional envelope tags.
  const lineStart = withoutEnvelope.match(
    /(?:^|\n)\s*\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/,
  );
  return lineStart?.[1]?.toLowerCase() || undefined;
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

async function triggerNativePiCommand(
  pi: ExtensionAPI,
  command: NativePiCommand,
): Promise<boolean> {
  const pane = process.env.TMUX_PANE;
  const slashCommand = `/${command}`;
  if (pane) {
    try {
      const script = `sleep 0.35; tmux send-keys -t ${shellQuote(pane)} ${slashCommand} Enter`;
      await pi.exec("tmux", ["run-shell", "-b", script]);
      pi.appendEntry("telegram_new_bridge_debug", {
        path: "tmux-run-shell",
        pane,
        command,
      });
      return true;
    } catch (error) {
      pi.appendEntry("telegram_new_bridge_debug", {
        path: "tmux-run-shell-error",
        pane,
        command,
        error: error instanceof Error ? error.message : String(error),
      });
      // fall through to fallback
    }
  }

  try {
    pi.sendUserMessage(slashCommand);
    pi.appendEntry("telegram_new_bridge_debug", {
      path: "sendUserMessage-fallback",
      command,
    });
    return true;
  } catch (error) {
    pi.appendEntry("telegram_new_bridge_debug", {
      path: "sendUserMessage-error",
      command,
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
      const command = getMessageCommand(message) as NativePiCommand | undefined;
      if (!command || !NATIVE_PI_COMMANDS.has(command)) return "pass";

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

      await triggerNativePiCommand(pi, command);
      return "consume";
    });

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  pi.on("input", async (event) => {
    const command = parseLeadingSlashCommand(
      event.text ?? "",
    ) as NativePiCommand | undefined;
    if (!command || !NATIVE_PI_COMMANDS.has(command)) {
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
      await triggerNativePiCommand(pi, command);
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
