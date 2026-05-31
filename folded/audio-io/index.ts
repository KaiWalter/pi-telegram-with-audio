import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type TextBlock = {
	type?: string;
	text?: string;
	[key: string]: unknown;
};

type TranscriptSource = "outputs" | "local";

type AudioDetection = {
	isTelegram: boolean;
	hasAudioAttachment: boolean;
	hasTranscript: boolean;
	transcript?: string;
	transcriptSource?: TranscriptSource;
	audioFilePath?: string;
	replyContext?: string;
	transcriptionError?: string;
};

const execFileAsync = promisify(execFile);
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const TRANSCRIBE_HELPER = resolve(EXTENSION_DIR, "bin/transcribe-whisper");
const AUDIO_FILE_RE = /\.(ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)\b/i;
const AUDIO_TOKEN_RE = /(?:^|[\s"'`(])((?:\.{1,2}\/|\/|~\/)?[^\s"'`)<>{}\[\]]+\.(?:ogg|oga|opus|mp3|m4a|wav|webm|aac|flac))(?:$|[\s"'`)>])/gim;
const MARKDOWN_LINK_AUDIO_RE = /\[[^\]]*\]\(([^)]+\.(?:ogg|oga|opus|mp3|m4a|wav|webm|aac|flac)[^)]*)\)/gim;
const BASE_DIR_RE = /^\s*base_dir\s*[:=]\s*(.+)$/im;
const TELEGRAM_RE = /^\[telegram(?:\|[^\]]+)?\]/im;
const AUDIO_HINT_RE = /\b(voice note|voice message|audio note|audio message)\b/i;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const WHITESPACE_RE = /[ \t]+/g;
const TELEGRAM_VOICE_COMMENT_RE = /^<!--\s*telegram_voice\b/m;
const TELEGRAM_VOICE_COMMENT_BLOCK_RE = /\n*<!--\s*telegram_voice\b[\s\S]*?-->\n*/gim;
const INLINE_MARKER_RE = /([^\n])(\[(?:telegram(?:\|[^\]]+)?|attachments|outputs|reply(?:\|[^\]]+)?|voice|time)\])/gi;

function normalizeEnvelopeText(text: string): string {
	return text.replace(INLINE_MARKER_RE, "$1\n$2");
}

function parseSections(text: string): Map<string, string[]> {
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

function extractSection(text: string, name: string): string | undefined {
	const key = name.trim().toLowerCase();
	if (!key) return undefined;
	const lines = parseSections(text).get(key) ?? [];
	const section = lines.join("\n").trim();
	return section ? section : undefined;
}

function cleanupTranscript(text: string): string {
	return text
		.replace(/^```[\s\S]*?```$/gm, "")
		.replace(/^[-*]\s?/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/\r/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(WHITESPACE_RE, " ")
		.trim();
}

function normalizePathToken(value: string): string | undefined {
	let normalized = value.trim();
	if (!normalized) {
		return undefined;
	}

	normalized = normalized.replace(/^file:\/\//i, "");
	normalized = normalized.replace(/^[<(\[]+/, "");
	normalized = normalized.replace(/[>),;\]]+$/, "");
	normalized = normalized.replace(/^['"`]+/, "");
	normalized = normalized.replace(/['"`]+$/, "");

	return normalized || undefined;
}

function expandHomePath(value: string): string {
	if (!value.startsWith("~/")) {
		return value;
	}

	const homeDir = process.env.HOME;
	return homeDir ? resolve(homeDir, value.slice(2)) : value;
}

function extractBaseDir(attachments: string): string | undefined {
	const match = attachments.match(BASE_DIR_RE);
	const rawBaseDir = normalizePathToken(match?.[1] ?? "");
	return rawBaseDir ? expandHomePath(rawBaseDir) : undefined;
}

function collectAudioAttachmentCandidates(attachments: string): string[] {
	const candidates = new Set<string>();
	const addCandidate = (value: string | undefined) => {
		const normalized = value ? normalizePathToken(value) : undefined;
		if (!normalized || !AUDIO_FILE_RE.test(normalized) || URL_SCHEME_RE.test(normalized)) {
			return;
		}
		candidates.add(normalized);
	};

	for (const line of attachments.split(/\r?\n/)) {
		const fieldMatch = line.match(/\b(?:path|file|filename|relative_path|source|src)\s*[:=]\s*(.+)$/i);
		if (fieldMatch) {
			addCandidate(fieldMatch[1]);
		}
	}

	for (const match of attachments.matchAll(MARKDOWN_LINK_AUDIO_RE)) {
		addCandidate(match[1]);
	}

	for (const match of attachments.matchAll(AUDIO_TOKEN_RE)) {
		addCandidate(match[1]);
	}

	return Array.from(candidates);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveAudioAttachment(attachments: string): Promise<string | undefined> {
	const baseDir = extractBaseDir(attachments);
	const candidates = collectAudioAttachmentCandidates(attachments);

	for (const candidate of candidates) {
		const candidatePaths = new Set<string>();
		const expandedCandidate = expandHomePath(candidate);

		if (isAbsolute(expandedCandidate)) {
			candidatePaths.add(expandedCandidate);
		}
		if (baseDir && !isAbsolute(expandedCandidate)) {
			candidatePaths.add(resolve(baseDir, expandedCandidate));
		}

		for (const candidatePath of candidatePaths) {
			if (await fileExists(candidatePath)) {
				return candidatePath;
			}
		}
	}

	return undefined;
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function transcribeAudioAttachment(audioFilePath: string): Promise<string | undefined> {
	const { stdout } = await execFileAsync("bash", [TRANSCRIBE_HELPER, audioFilePath], {
		env: process.env,
		maxBuffer: 8 * 1024 * 1024,
	});
	const transcript = cleanupTranscript(stdout);
	return transcript || undefined;
}

async function detectTelegramAudio(text: string): Promise<AudioDetection> {
	const isTelegram = TELEGRAM_RE.test(text);
	const attachments = extractSection(text, "attachments") ?? "";
	const outputs = extractSection(text, "outputs");
	const replyContext = extractSection(text, "reply");
	const combined = `${attachments}\n${outputs ?? ""}`;
	const hasAudioAttachment = AUDIO_FILE_RE.test(combined) || AUDIO_HINT_RE.test(combined);
	const outputTranscript = outputs ? cleanupTranscript(outputs) : undefined;
	const detection: AudioDetection = {
		isTelegram,
		hasAudioAttachment,
		hasTranscript: Boolean(outputTranscript),
		transcript: outputTranscript,
		transcriptSource: outputTranscript ? "outputs" : undefined,
		replyContext,
	};

	if (outputTranscript || !hasAudioAttachment) {
		return detection;
	}

	const audioFilePath = await resolveAudioAttachment(attachments);
	if (!audioFilePath) {
		return detection;
	}

	detection.audioFilePath = audioFilePath;

	try {
		const transcript = await transcribeAudioAttachment(audioFilePath);
		if (transcript) {
			detection.transcript = transcript;
			detection.transcriptSource = "local";
			detection.hasTranscript = true;
		}
	} catch (error) {
		detection.transcriptionError = describeError(error);
	}

	return detection;
}

function buildTelegramAudioPrompt(rawText: string, detection: AudioDetection): string {
	const sections: string[] = [
		"[telegram]",
		"[telegram-audio-in]",
		"The user sent a Telegram audio or voice message.",
	];

	if (detection.transcript) {
		sections.push(
			detection.transcriptSource === "local"
				? "Use the locally generated transcription below as the user's request."
				: "Use the transcription below as the user's request.",
			`<transcript>\n${detection.transcript}\n</transcript>`,
		);
	} else {
		sections.push("An audio attachment was detected, but no transcription text was supplied.");
		if (detection.transcriptionError) {
			sections.push(
				"A local transcription fallback was attempted but did not succeed.",
				"If the request is unclear, ask the user to resend the voice note or type the request.",
			);
		} else if (detection.audioFilePath) {
			sections.push(
				"A local transcription fallback could not produce usable transcript text.",
				"If the request is unclear, ask the user to resend the voice note or type the request.",
			);
		} else {
			sections.push("If the request is unclear, ask the user to resend the voice note or type the request.");
		}
	}

	if (detection.replyContext) {
		sections.push(`Reply context from Telegram:\n<reply>\n${detection.replyContext}\n</reply>`);
	}

	sections.push(
		"Respond naturally to the spoken request.",
		"Keep the answer concise and easy to speak aloud.",
		"If the transcript appears noisy or incomplete, mention that briefly and answer as best you can.",
		`<transport_envelope_omitted>\n${rawText}\n</transport_envelope_omitted>`,
	);

	return sections.join("\n\n");
}

function extractAssistantText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}
		const block = part as TextBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}

	return textParts.join("\n\n").trim();
}

function hasTelegramVoiceComment(content: unknown): boolean {
	if (typeof content === "string") {
		return TELEGRAM_VOICE_COMMENT_RE.test(content);
	}

	if (!Array.isArray(content)) {
		return false;
	}

	return content.some((part) => {
		if (!part || typeof part !== "object") {
			return false;
		}
		const block = part as TextBlock;
		return block.type === "text" && typeof block.text === "string"
			? TELEGRAM_VOICE_COMMENT_RE.test(block.text)
			: false;
	});
}

function stripTelegramVoiceComment(text: string): string {
	return text.replace(TELEGRAM_VOICE_COMMENT_BLOCK_RE, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function removeTelegramVoiceComment(content: unknown): unknown {
	if (typeof content === "string") {
		return stripTelegramVoiceComment(content);
	}

	if (!Array.isArray(content)) {
		return content;
	}

	const updated = content.flatMap((part) => {
		if (!part || typeof part !== "object") {
			return [part];
		}
		const block = part as TextBlock;
		if (block.type !== "text" || typeof block.text !== "string") {
			return [part];
		}

		const text = stripTelegramVoiceComment(block.text);
		return text ? [{ ...block, text }] : [];
	});

	return updated.length > 0 ? updated : "";
}

function makeTtsFriendly(text: string): string {
	const cleaned = text
		.replace(/<!--([\s\S]*?)-->/g, "")
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
		.replace(/^#{1,6}\s*/gm, "")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/^\d+\.\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/\|/g, " ")
		.replace(/\r/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(WHITESPACE_RE, " ")
		.trim();

	if (!cleaned) {
		return "";
	}

	const maxLength = 2500;
	if (cleaned.length <= maxLength) {
		return cleaned;
	}

	return `${cleaned.slice(0, maxLength).trimEnd()}...`;
}

function sanitizeVoiceText(text: string): string {
	return text
		.replace(/<!--/g, "")
		.replace(/-->/g, "—>")
		.replace(/\r/g, " ")
		.replace(/\n+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function appendTelegramVoiceComment(content: unknown, voiceText: string): unknown {
	const comment = `<!-- telegram_voice: ${sanitizeVoiceText(voiceText)} -->`;

	if (typeof content === "string") {
		return `${content.trimEnd()}\n\n${comment}`;
	}

	if (!Array.isArray(content)) {
		return content;
	}

	return [
		...content,
		{
			type: "text",
			text: `\n\n${comment}`,
		},
	];
}

function envFlagEnabled(name: string, fallback: boolean): boolean {
	const rawValue = process.env[name];
	if (rawValue == null || rawValue.trim() === "") {
		return fallback;
	}

	return !/^(0|false|no|off)$/i.test(rawValue.trim());
}

export default function telegramAudioIoExtension(pi: ExtensionAPI) {
	let currentTurnIsTelegram = false;

	pi.on("input", async (event) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const detection = await detectTelegramAudio(event.text ?? "");
		currentTurnIsTelegram = currentTurnIsTelegram || detection.isTelegram;
		if (!detection.isTelegram || (!detection.hasAudioAttachment && !detection.hasTranscript)) {
			return { action: "continue" };
		}

		console.error(
			"[telegram-audio-io] input detected",
			JSON.stringify({
				isTelegram: detection.isTelegram,
				hasAudioAttachment: detection.hasAudioAttachment,
				hasTranscript: detection.hasTranscript,
				transcriptSource: detection.transcriptSource,
				audioFilePath: detection.audioFilePath,
				transcriptionError: detection.transcriptionError,
			}),
		);

		return {
			action: "transform",
			text: buildTelegramAudioPrompt(event.text, detection),
		};
	});

	pi.on("before_agent_start", async (event) => {
		currentTurnIsTelegram = currentTurnIsTelegram || TELEGRAM_RE.test(event.prompt);
		if (!currentTurnIsTelegram) {
			console.error("[telegram-audio-io] before_agent_start: non-telegram turn");
			return;
		}

		console.error("[telegram-audio-io] before_agent_start: telegram turn active");
		return {
			systemPrompt:
				event.systemPrompt +
				"\n\nTelegram reply mode:\n" +
				"- The user is reading on Telegram, often on a phone.\n" +
				"- Keep replies concise, conversational, and easy to scan.\n" +
				"- Avoid wide tables, raw HTML, code fences, and dense long lists unless the user explicitly asks for them.\n" +
				"- If you must mention commands, paths, or code, summarize them in plain language unless literal code is required.\n" +
				"- Do not mention transport markers like [telegram], [attachments], or [outputs].\n",
		};
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") {
			return;
		}

		const voiceReplyEnabled = envFlagEnabled("PI_TELEGRAM_AUDIO_VOICE_REPLY", true);
		console.error(
			"[telegram-audio-io] message_end",
			JSON.stringify({
				currentTurnIsTelegram,
				voiceReplyEnabled,
				hasVoiceComment: hasTelegramVoiceComment(event.message.content),
			}),
		);
		if (!currentTurnIsTelegram) {
			return;
		}
		if (!voiceReplyEnabled) {
			if (!hasTelegramVoiceComment(event.message.content)) {
				return;
			}

			return {
				message: {
					...event.message,
					content: removeTelegramVoiceComment(event.message.content),
				},
			};
		}

		if (hasTelegramVoiceComment(event.message.content)) {
			return;
		}

		const assistantText = extractAssistantText(event.message.content);
		const pendingVoiceText = makeTtsFriendly(assistantText);
		console.error(
			"[telegram-audio-io] pending voice",
			JSON.stringify({
				assistantTextLength: assistantText.length,
				pendingVoiceTextLength: pendingVoiceText.length,
			}),
		);
		if (!pendingVoiceText) {
			return;
		}

		console.error("[telegram-audio-io] appending telegram_voice comment");
		return {
			message: {
				...event.message,
				content: appendTelegramVoiceComment(event.message.content, pendingVoiceText),
			},
		};
	});

	pi.on("agent_end", async () => {
		currentTurnIsTelegram = false;
	});

	pi.on("session_start", async () => {
		currentTurnIsTelegram = false;
	});
}
