# telegram-new-session-bridge

Shared Pi extension that hooks the `pi-telegram` external update registry and consumes Telegram `/new` commands.

Execution strategy:
- Primary: intercept Telegram `/new` on pi input flow (`event.source === "extension"`) and consume it before normal prompt processing.
- Preferred reset path: send native `/new` keystrokes into the current tmux pane (`$TMUX_PANE`) so Pi executes a real session reset.
- Secondary path: external-handler registry interception (`__piTelegramExternalHandlerRegistry__`) when available.
- Fallback: `pi.sendUserMessage("/new")` only if tmux injection is unavailable.

This keeps behavior in our own shared extension surface instead of patching upstream `pi-telegram` source checkouts.
