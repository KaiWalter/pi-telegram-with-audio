import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TELEGRAM_RE = /^\[telegram(?:\|[^\]]+)?\]/im;
const TRANSCRIPT_RE = /<transcript>\s*([\s\S]*?)\s*<\/transcript>/i;
const TRANSPORT_RE = /<transport_envelope_omitted>\s*([\s\S]*?)\s*<\/transport_envelope_omitted>/i;
const SLASH_COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/;
const BULLET_RE = /^\s*[-*]\s*/;
const INLINE_MARKER_RE = /([^\n])(\[(?:telegram(?:\|[^\]]+)?|attachments|outputs|reply(?:\|[^\]]+)?|voice|time)\])/gi;

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
	return lines
		.join("\n")
		.replace(/\r/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
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

function parseSlashCommand(text: string): string | undefined {
	const match = text.trim().match(SLASH_COMMAND_RE);
	return match?.[1]?.toLowerCase();
}

function hasRebootIntent(text: string): boolean {
	const normalized = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
	if (!normalized) return false;

	const slash = parseSlashCommand(normalized);
	if (slash === "reboot" || slash === "restart") {
		return true;
	}

	const hasAction = /\b(reboot|restart|rebooten|neu ?start)\b/.test(normalized);
	if (!hasAction) return false;
	const hasTarget = /\b(host|system|machine|computer|server|pc|hyperdrive|now|immediately)\b/.test(normalized);
	return hasTarget || normalized.split(" ").length <= 4;
}

function rebootScriptPath(): string {
	return path.join(os.homedir(), ".pi", "chief-engineer", "skills", "reboot-system", "reboot-system.sh");
}

export default function telegramRebootBridgeExtension(pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		const raw = event.text ?? "";
		const telegramEnvelope = TELEGRAM_RE.test(raw) || raw.includes("<transport_envelope_omitted>");
		const telegramLikeSource = telegramEnvelope || event.source === "extension";
		if (!telegramLikeSource) {
			return { action: "continue" };
		}

		const userText = extractUserText(raw);
		if (!hasRebootIntent(userText)) {
			return { action: "continue" };
		}

		const scriptPath = rebootScriptPath();
		pi.appendEntry("telegram_reboot_bridge", {
			status: "triggered",
			scriptPath,
			userText,
			timestamp: new Date().toISOString(),
		});

		try {
			await pi.exec("bash", [scriptPath]);
			return { action: "handled" };
		} catch (error) {
			pi.appendEntry("telegram_reboot_bridge", {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				timestamp: new Date().toISOString(),
			});
			return { action: "continue" };
		}
	});
}
