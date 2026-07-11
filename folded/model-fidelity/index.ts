/**
 * Folded model-fidelity bridge.
 *
 * Adds a simple two-tier model switch to the Telegram lane:
 *   /power  (voice: "power mode" / "high fidelity")  -> the lane's Power model
 *   /eco    (voice: "eco mode"   / "low fidelity")    -> the lane's Eco model
 *   /model  (voice: "which model")                    -> report current + tiers
 *
 * Per-lane tier mapping is resolved (in order):
 *   1. env PI_TELEGRAM_MODEL_POWER / PI_TELEGRAM_MODEL_ECO
 *   2. ~/.pi/shared/data/model-fidelity/tiers.json keyed by PI_CODING_AGENT_DIR basename
 * Values are "provider/modelId" resolved via ctx.modelRegistry.
 *
 * The switch happens in the "input" event (which receives ctx.modelRegistry and
 * runs before the turn), and a plain confirmation is sent back over the Telegram
 * Bot API. No pi-telegram core files are modified beyond bot-command menu copy.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- minimal structural typing for the bits of ctx we use ---
interface ModelLike {
  id?: string;
  name?: string;
  provider?: string;
}
interface ModelRegistryLike {
  find?: (provider: string, modelId: string) => ModelLike | undefined;
  getAvailable?: () => ModelLike[];
}
interface CtxLike {
  cwd?: string;
  model?: ModelLike;
  modelRegistry?: ModelRegistryLike;
}

type Tier = "power" | "eco";

const TELEGRAM_RE = /^\[telegram(?:\|[^\]]+)?\]/im;
const TRANSCRIPT_RE = /<transcript>\s*([\s\S]*?)\s*<\/transcript>/i;
const TRANSPORT_RE = /<transport_envelope_omitted>\s*([\s\S]*?)\s*<\/transport_envelope_omitted>/i;
const SLASH_COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/;
const BULLET_RE = /^\s*[-*]\s*/;
const INLINE_MARKER_RE = /([^\n])(\[(?:telegram(?:\|[^\]]+)?|attachments|outputs|reply(?:\|[^\]]+)?|voice|time)\])/gi;

// Whole-message trigger phrases (case/punctuation-insensitive, exact match only —
// deliberately not substring, to avoid switching mid-conversation).
const POWER_PHRASES = new Set([
  "power",
  "power mode",
  "power model",
  "high fidelity",
  "high fidelity mode",
  "hifi",
  "hi fi",
  "switch to power",
  "switch to power mode",
  "go power",
]);
const ECO_PHRASES = new Set([
  "eco",
  "eco mode",
  "eco model",
  "economy",
  "economy mode",
  "low fidelity",
  "low fidelity mode",
  "lofi",
  "lo fi",
  "switch to eco",
  "switch to eco mode",
  "go eco",
]);
const STATUS_PHRASES = new Set([
  "model",
  "which model",
  "what model",
  "current model",
  "model status",
  "which model am i using",
  "what model are you using",
]);

function normalizeEnvelopeText(text: string): string {
  return text.replace(INLINE_MARKER_RE, "$1\n$2");
}

function extractSections(text: string): Map<string, string[]> {
  const normalized = normalizeEnvelopeText(text);
  const sections = new Map<string, string[]>();
  let current = "body";
  sections.set(current, []);
  for (const line of normalized.split(/\r?\n/)) {
    const marker = line.match(/^\[([^\]\n]+)\](?:\s+(.*))?$/);
    if (marker) {
      const keyRaw = marker[1]?.trim().toLowerCase() ?? "";
      const key = keyRaw.split("|")[0]?.trim() || "body";
      const remainder = marker[2]?.trim();
      current = key === "telegram" ? "body" : key;
      if (!sections.has(current)) sections.set(current, []);
      if (remainder) sections.get(current)?.push(remainder);
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)?.push(line);
  }
  return sections;
}

function collapseText(lines: string[]): string {
  return lines.join("\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeListText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET_RE, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractUserText(raw: string): string {
  const transcript = raw.match(TRANSCRIPT_RE)?.[1]?.trim();
  if (transcript) return transcript;
  const transport = raw.match(TRANSPORT_RE)?.[1]?.trim();
  const source = transport || raw;
  const sections = extractSections(source);
  const body = collapseText(sections.get("body") ?? []);
  if (body) return body;
  const outputs = normalizeListText(collapseText(sections.get("outputs") ?? []));
  if (outputs) return outputs;
  return "";
}

function cleanPhrase(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSlashCommand(text: string): string | undefined {
  const match = text.trim().match(SLASH_COMMAND_RE);
  return match?.[1]?.toLowerCase();
}

type Intent = { kind: "set"; tier: Tier } | { kind: "status" } | undefined;

function detectIntent(userText: string): Intent {
  const cleaned = cleanPhrase(userText);
  if (!cleaned) return undefined;

  // Slash commands (leading, possibly after envelope strip already done).
  const slash = parseSlashCommand(userText.trim()) ?? parseSlashCommand(cleaned);
  if (slash === "power") return { kind: "set", tier: "power" };
  if (slash === "eco") return { kind: "set", tier: "eco" };
  if (slash === "model") return { kind: "status" };

  // Whole-message phrase match only.
  if (POWER_PHRASES.has(cleaned)) return { kind: "set", tier: "power" };
  if (ECO_PHRASES.has(cleaned)) return { kind: "set", tier: "eco" };
  if (STATUS_PHRASES.has(cleaned)) return { kind: "status" };
  return undefined;
}

function laneName(ctx: CtxLike): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  const base = fromEnv || ctx.cwd || "";
  return path.basename(base.replace(/\/+$/, "")) || "unknown";
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || process.cwd();
}

function loadTierConfig(lane: string): { power?: string; eco?: string } {
  const envPower = process.env.PI_TELEGRAM_MODEL_POWER;
  const envEco = process.env.PI_TELEGRAM_MODEL_ECO;
  let filePower: string | undefined;
  let fileEco: string | undefined;
  try {
    const cfgPath = path.join(os.homedir(), ".pi", "shared", "data", "model-fidelity", "tiers.json");
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    const laneCfg = raw[lane];
    if (laneCfg && typeof laneCfg === "object") {
      const l = laneCfg as Record<string, unknown>;
      if (typeof l.power === "string") filePower = l.power;
      if (typeof l.eco === "string") fileEco = l.eco;
    }
  } catch {
    // ignore; env may still provide values
  }
  return { power: envPower || filePower, eco: envEco || fileEco };
}

function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx >= ref.length - 1) return undefined;
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}


export default function telegramModelFidelityBridgeExtension(pi: ExtensionAPI) {
  pi.on("input", async (event: { text?: string; source?: string }, ctx: CtxLike) => {
    const raw = event.text ?? "";
    const telegramEnvelope = TELEGRAM_RE.test(raw) || raw.includes("<transport_envelope_omitted>");
    const telegramLikeSource = telegramEnvelope || event.source === "extension";
    if (!telegramLikeSource) return { action: "continue" as const };

    const userText = extractUserText(raw) || raw;
    const intent = detectIntent(userText);
    if (!intent) return { action: "continue" as const };

    const lane = laneName(ctx);
    const tiers = loadTierConfig(lane);

    // IMPORTANT: do not short-circuit with action=handled + out-of-band Bot API replies.
    // We still switch via pi.setModel, but we return action=transform with a normal text
    // response so Telegram bridge lifecycle (agent_end / inflight clear) stays consistent.
    if (intent.kind === "status") {
      const current = ctx.model?.id ?? ctx.model?.name ?? "unknown";
      const parts = [
        `Current model: ${current}`,
        tiers.power ? `Power (/power): ${tiers.power}` : "Power: not configured",
        tiers.eco ? `Eco (/eco): ${tiers.eco}` : "Eco: not configured",
      ];
      pi.appendEntry("telegram_model_fidelity", { status: "reported", lane, current });
      return { action: "transform" as const, text: parts.join("\n") };
    }

    const tier = intent.tier;
    const ref = tier === "power" ? tiers.power : tiers.eco;
    if (!ref) {
      pi.appendEntry("telegram_model_fidelity", { status: "tier_not_configured", lane, tier });
      return { action: "transform" as const, text: `No ${tier} model configured for this lane (${lane}).` };
    }

    const parsed = parseModelRef(ref);
    const model = parsed && ctx.modelRegistry?.find
      ? ctx.modelRegistry.find(parsed.provider, parsed.modelId)
      : undefined;
    if (!model) {
      pi.appendEntry("telegram_model_fidelity", { status: "model_not_found", lane, tier, ref });
      return { action: "transform" as const, text: `Could not find ${tier} model "${ref}" in the model registry.` };
    }

    try {
      const ok = await pi.setModel(model as never);
      const label = model.name ?? model.id ?? ref;
      if (ok === false) {
        pi.appendEntry("telegram_model_fidelity", { status: "no_api_key", lane, tier, ref });
        return { action: "transform" as const, text: `Could not switch to ${tier} model ${label} (no API key available).` };
      }
      pi.appendEntry("telegram_model_fidelity", { status: "switched", lane, tier, ref, label });
      const tierName = tier === "power" ? "Power" : "Eco";
      return { action: "transform" as const, text: `${tierName} mode on. Model: ${label}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      pi.appendEntry("telegram_model_fidelity", { status: "switch_failed", lane, tier, ref, error: msg });
      return { action: "transform" as const, text: `Failed to switch to ${tier} model: ${msg}` };
    }
  });
}
