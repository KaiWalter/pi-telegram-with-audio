# telegram-new-session-bridge

Shared Pi extension that hooks the `pi-telegram` external update registry and consumes Telegram `/new` and `/reload` commands.

Execution strategy:
- Primary: intercept Telegram `/new` and `/reload` on pi input flow and consume them before normal prompt processing.
- Preferred native path: send `/new` or `/reload` keystrokes into the current tmux pane (`$TMUX_PANE`) so Pi executes real native command handling.
- Secondary path: external-handler registry interception (`__piTelegramExternalHandlerRegistry__`) when available.
- Fallback: `pi.sendUserMessage("/new")` only if tmux injection is unavailable.

This keeps behavior in our own shared extension surface instead of patching upstream `pi-telegram` source checkouts.
