# telegram-audio-io

Pi extension for Telegram audio-in/audio-out.

## What it does

- detects Telegram-originated voice/audio turns
- prefers inbound `[outputs]` transcript text when it is already present
- falls back to local Whisper transcription from `[attachments]` when no `[outputs]` transcript is supplied
- keeps Telegram replies concise and TTS-friendly
- appends a hidden `telegram_voice` action comment only when `PI_TELEGRAM_AUDIO_VOICE_REPLY=true`
- strips any `telegram_voice` comment before delivery when `PI_TELEGRAM_AUDIO_VOICE_REPLY=false`

## Runtime assumptions

This extension is designed for the Telegram bridge setup already present in this environment:

- Telegram voice/audio arrives in a transport envelope that includes `[telegram]`
- `[attachments]` includes a `base_dir` plus relative or absolute audio file paths
- `[outputs]` may already contain transcript text from the bridge; if it does, that transcript stays authoritative
- when no transcript is present in `[outputs]`, the extension runs `bin/transcribe-whisper` locally against the detected audio attachment
- outbound hidden comment `telegram_voice` is converted by the bridge into playable audio for Telegram clients

## Voice reply policy

Set `PI_TELEGRAM_AUDIO_VOICE_REPLY` in Pi settings env:

- `true` or unset: allow hidden `telegram_voice` injection
- `false`: hard-block voice comment delivery for the turn

## Install

This directory is intended to be canonicalized through the Pi shared-extension symlink chain:

- `~/.pi/shared/extensions -> ~/nix-config/profiles/features/pi-agent/shared/extensions`
- `~/.pi/telegram-service/extensions -> ~/.pi/shared/extensions`

Reload Pi after updating:

```text
/reload
```

## Notes

- Sync check: minor docs touch to verify shared-extension edits are tracked in `~/nix-config`.

- Telegram audio/voice inputs are rewritten so the transcript becomes the user's request.
- If local transcription fallback fails, the assistant is prompted to ask for a resend or typed request when needed.
- The extension-internal fallback invokes the helper through `bash`, but Telegram inbound handler templates may execute it directly; keep `bin/transcribe-whisper` present and executable (`chmod +x`).
