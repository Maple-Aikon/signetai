/**
 * Signet content script
 * Handles: text selection → save panel (shadow DOM isolated)
 * Receives messages from background service worker
 */

import { getConfig } from "../shared/config.js";
import { applyTheme, resolveTheme } from "../shared/theme.js";
import type { ThemeMode } from "../shared/types.js";

// --- Extension presence marker (for dashboard detection) ---
document.documentElement.dataset.signetExtension = "true";

// --- State ---

let panelHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let askHost: HTMLElement | null = null;
let askShadowRoot: ShadowRoot | null = null;
let stopAskVoiceCapture: (() => void) | null = null;
let stopAskOverlayDrag: (() => void) | null = null;
let currentSelection = "";
let currentPageUrl = "";
let currentPageTitle = "";

// --- Shadow DOM Panel ---

const PANEL_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

  :host {
    all: initial;
    font-family: "IBM Plex Mono", monospace;
    font-size: 13px;
    line-height: 1.55;
  }

  .panel {
    position: fixed;
    z-index: 2147483647;
    width: 320px;
    background: var(--sig-bg);
    border: 1px solid var(--sig-border-strong);
    color: var(--sig-text);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    font-family: "IBM Plex Mono", monospace;
    font-size: 13px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;

    --sig-bg: #08080a;
    --sig-surface: #0e0e12;
    --sig-surface-raised: #151519;
    --sig-border: rgba(255, 255, 255, 0.06);
    --sig-border-strong: rgba(255, 255, 255, 0.12);
    --sig-text: #d4d4d8;
    --sig-text-bright: #f0f0f2;
    --sig-text-muted: #6b6b76;
    --sig-accent: #8a8a96;
    --sig-accent-hover: #c0c0c8;
    --sig-danger: #8a4a48;
    --sig-success: #4a7a5e;
    --sig-highlight: #a3e635;
    --sig-warning: #facc15;
    --sig-glow-highlight: 0 0 10px rgba(163, 230, 53, 0.24);

    --ease: cubic-bezier(0.16, 1, 0.3, 1);
    --dur: 0.2s;
  }

  .panel[data-theme="light"] {
    --sig-bg: #e4dfd8;
    --sig-surface: #dbd5cd;
    --sig-surface-raised: #d1cbc2;
    --sig-border: rgba(0, 0, 0, 0.06);
    --sig-border-strong: rgba(0, 0, 0, 0.12);
    --sig-text: #2a2a2e;
    --sig-text-bright: #0a0a0c;
    --sig-text-muted: #7a756e;
    --sig-accent: #6a6660;
    --sig-accent-hover: #3a3832;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    border-bottom: 1px solid var(--sig-border);
    background: var(--sig-surface);
  }

  .panel-title {
    font-family: "Chakra Petch", sans-serif;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--sig-text-bright);
  }

  .panel-close {
    background: none;
    border: none;
    color: var(--sig-text-muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0;
    font-family: "IBM Plex Mono", monospace;
    transition: color var(--dur) var(--ease);
  }

  .panel-close:hover {
    color: var(--sig-text-bright);
  }

  .panel-body {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .preview {
    font-size: 11px;
    color: var(--sig-text);
    background: var(--sig-surface-raised);
    border: 1px solid var(--sig-border);
    padding: 8px;
    max-height: 80px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .field-label {
    font-size: 10px;
    color: var(--sig-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 2px;
  }

  .field-input {
    width: 100%;
    padding: 4px 8px;
    background: var(--sig-surface-raised);
    border: 1px solid var(--sig-border-strong);
    color: var(--sig-text);
    font-family: "IBM Plex Mono", monospace;
    font-size: 13px;
    outline: none;
    box-sizing: border-box;
    transition: border-color var(--dur) var(--ease);
  }

  .field-input:focus {
    border-color: var(--sig-accent);
  }

  .field-input::placeholder {
    color: var(--sig-text-muted);
  }

  .slider-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .slider {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 3px;
    background: var(--sig-border-strong);
    outline: none;
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    background: var(--sig-text);
    cursor: pointer;
  }

  .slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    background: var(--sig-text);
    border: none;
    cursor: pointer;
  }

  .slider-value {
    font-size: 11px;
    color: var(--sig-text-muted);
    min-width: 32px;
    text-align: right;
  }

  .source-meta {
    font-size: 10px;
    color: var(--sig-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .panel-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 8px 16px;
    border-top: 1px solid var(--sig-border);
    background: var(--sig-surface);
  }

  .btn {
    padding: 4px 12px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    border: 1px solid var(--sig-border-strong);
    background: var(--sig-surface-raised);
    color: var(--sig-text);
    transition: all var(--dur) var(--ease);
  }

  .btn:hover {
    background: var(--sig-accent);
    color: var(--sig-bg);
  }

  .btn-primary {
    background: var(--sig-text-bright);
    color: var(--sig-bg);
    border-color: var(--sig-text-bright);
  }

  .btn-primary:hover {
    background: var(--sig-accent-hover);
  }

  .ask-panel {
    width: min(380px, calc(100vw - 28px));
    max-height: min(82vh, 780px);
    border-radius: 12px;
    overflow: hidden;
    backdrop-filter: blur(8px);
    display: flex;
    flex-direction: column;
  }

  .ask-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--sig-border);
    background: var(--sig-surface);
    cursor: grab;
    user-select: none;
  }

  .ask-header:active {
    cursor: grabbing;
  }

  .ask-header-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .ask-header-name {
    font-family: "Chakra Petch", sans-serif;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--sig-text-bright);
  }

  .ask-header-meta {
    font-size: 10px;
    color: var(--sig-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: min(440px, 56vw);
  }

  .ask-header-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .ask-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--sig-border);
    background: var(--sig-bg);
    color: var(--sig-text-muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    transition: all var(--dur) var(--ease);
  }

  .ask-icon-btn:hover {
    border-color: var(--sig-accent);
    color: var(--sig-accent-hover);
  }

  .ask-body {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 420px;
  }

  .ask-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ask-mic-select,
  .ask-model-select {
    font-size: 11px;
    min-height: 32px;
    border-radius: 8px;
    padding: 6px 8px;
    background: var(--sig-bg);
  }

  .ask-mic-select {
    flex: 0 0 42%;
    min-width: 180px;
  }

  .ask-model-select {
    flex: 1;
  }

  .ask-messages {
    flex: 1;
    min-height: 230px;
    max-height: 44vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--sig-border);
    border-radius: 10px;
    background: var(--sig-surface-raised);
  }

  .ask-empty {
    margin: auto;
    text-align: center;
    color: var(--sig-text-muted);
    font-size: 11px;
    max-width: 340px;
    line-height: 1.45;
  }

  .ask-msg {
    display: flex;
    gap: 8px;
    max-width: 88%;
  }

  .ask-msg--user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .ask-msg-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    border: 1px solid var(--sig-border);
    background: var(--sig-bg);
    color: var(--sig-text-muted);
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .ask-msg--assistant .ask-msg-icon {
    border-color: color-mix(in srgb, var(--sig-highlight) 62%, var(--sig-warning));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--sig-highlight) 30%, transparent), var(--sig-glow-highlight);
  }

  .ask-msg--user .ask-msg-icon {
    border-color: color-mix(in srgb, var(--sig-warning) 70%, var(--sig-border));
  }

  .ask-msg-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .ask-msg-actions {
    display: flex;
    justify-content: flex-end;
  }

  .ask-copy-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 6px;
    border: 1px solid var(--sig-border);
    background: var(--sig-bg);
    color: var(--sig-text-muted);
    cursor: pointer;
    transition: all var(--dur) var(--ease);
  }

  .ask-copy-btn:hover {
    border-color: var(--sig-highlight);
    color: var(--sig-highlight);
    background: color-mix(in srgb, var(--sig-highlight) 10%, var(--sig-bg));
  }

  .ask-msg-content {
    font-size: 12px;
    line-height: 1.48;
    color: var(--sig-text);
    border: 1px solid var(--sig-border);
    border-radius: 8px;
    padding: 7px 10px;
    background: var(--sig-surface);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .ask-msg--user .ask-msg-content {
    background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
  }

  .ask-thinking {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 7px 10px;
    border-radius: 8px;
    border: 1px solid var(--sig-border);
    background: var(--sig-surface);
  }

  .ask-thinking-dot {
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background: var(--sig-text-muted);
    opacity: 0.28;
    animation: askDotPulse 1.15s ease-in-out infinite;
  }

  .ask-thinking-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ask-thinking-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes askDotPulse {
    0%, 60%, 100% {
      opacity: 0.22;
      transform: scale(0.82);
    }
    30% {
      opacity: 1;
      transform: scale(1);
    }
  }

  .ask-input-bar {
    position: relative;
    width: 100%;
  }

  .ask-input-actions {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    z-index: 2;
  }

  .ask-input {
    width: 100%;
    min-height: 36px;
    max-height: 36px;
    border-radius: 6px;
    border-color: color-mix(in srgb, var(--sig-highlight) 65%, var(--sig-border-strong));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--sig-highlight) 22%, transparent);
    padding: 8px 78px 8px 10px;
    font-size: 12px;
    line-height: 1.2;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }

  .ask-input:focus {
    border-color: var(--sig-highlight);
    box-shadow: var(--sig-glow-highlight);
  }

  .ask-voice-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    min-width: 30px;
    min-height: 30px;
    border-radius: 6px;
    padding: 0;
    background: var(--sig-surface);
    color: var(--sig-text-muted);
  }

  .ask-voice-btn[data-state="active"] {
    border-color: color-mix(in srgb, var(--sig-highlight) 70%, var(--sig-warning));
    color: var(--sig-highlight);
    box-shadow: var(--sig-glow-highlight);
  }

  .ask-voice-btn:hover:not(:disabled) {
    border-color: var(--sig-highlight);
    color: var(--sig-highlight);
    background: color-mix(in srgb, var(--sig-highlight) 10%, var(--sig-surface));
  }

  .ask-voice-bars {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 12px;
  }

  .ask-voice-bars span {
    width: 2px;
    height: 100%;
    border-radius: 2px;
    background: currentColor;
    transform-origin: center bottom;
    animation: askVoiceWave 0.9s ease-in-out infinite;
  }

  .ask-voice-bars span:nth-child(2) {
    animation-delay: 0.15s;
  }

  .ask-voice-bars span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes askVoiceWave {
    0%,
    100% {
      transform: scaleY(0.35);
      opacity: 0.45;
    }
    50% {
      transform: scaleY(1);
      opacity: 1;
    }
  }

  .ask-send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    min-width: 30px;
    min-height: 30px;
    border-radius: 6px;
    padding: 0;
    background: var(--sig-surface);
    color: var(--sig-text-muted);
  }

  .ask-send-btn:hover:not(:disabled) {
    border-color: var(--sig-accent);
    color: var(--sig-accent);
    background: color-mix(in srgb, var(--sig-accent) 8%, var(--sig-surface));
  }

  .ask-send-btn:disabled,
  .ask-voice-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .ask-icon-glyph {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ask-status {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--sig-text-muted);
    min-height: 16px;
    padding: 0 2px;
  }

  .ask-status[data-tone="error"] {
    color: #cf8a86;
  }

  .ask-status[data-tone="success"] {
    color: #76b492;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    padding: 8px 16px;
    background: var(--sig-success);
    color: var(--sig-text-bright);
    font-family: "IBM Plex Mono", monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    z-index: 2147483647;
    opacity: 0;
    transition: opacity var(--dur) var(--ease);
  }

  .toast.visible {
    opacity: 1;
  }
`;

type SpeechRecognitionInstance = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	onend: (() => void) | null;
	start: (track?: MediaStreamTrack) => void;
	stop: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
	if (typeof window === "undefined") return null;
	const withSpeech = window as Window & {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return withSpeech.SpeechRecognition ?? withSpeech.webkitSpeechRecognition ?? null;
}

async function requestMicrophoneStream(deviceId?: string): Promise<MediaStream> {
	if (!navigator.mediaDevices?.getUserMedia) {
		throw new Error("Microphone capture is not supported in this browser.");
	}
	if (deviceId && deviceId !== "default") {
		try {
			return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
		} catch {
			return await navigator.mediaDevices.getUserMedia({ audio: true });
		}
	}
	return await navigator.mediaDevices.getUserMedia({ audio: true });
}

async function getAudioInputOptions(): Promise<Array<{ id: string; label: string }>> {
	if (!navigator.mediaDevices?.enumerateDevices) {
		return [{ id: "default", label: "Browser default microphone" }];
	}
	const devices = await navigator.mediaDevices.enumerateDevices();
	const discovered = devices
		.filter((device) => device.kind === "audioinput")
		.map((device, index) => ({
			id: device.deviceId,
			label: device.label?.trim() || `Microphone ${index + 1}`,
		}));
	return [
		{ id: "default", label: "Browser default microphone" },
		...discovered.filter((device) => device.id !== "default"),
	];
}

const ASK_MIC_ICON_SVG = `<svg class="ask-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"></path><path d="M19 11a7 7 0 1 1-14 0"></path><path d="M12 18v3"></path><path d="M8 21h8"></path></svg>`;
const ASK_SEND_ICON_SVG = `<svg class="ask-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>`;
const ASK_COPY_ICON_SVG = `<svg class="ask-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>`;
const ASK_CHECK_ICON_SVG = `<svg class="ask-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

function createPanel(theme: "dark" | "light"): void {
	if (panelHost) return;

	panelHost = document.createElement("div");
	panelHost.id = "signet-save-panel";
	document.body.appendChild(panelHost);

	shadowRoot = panelHost.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = PANEL_STYLES;
	shadowRoot.appendChild(style);

	const panel = document.createElement("div");
	panel.className = "panel";
	panel.setAttribute("data-theme", theme);

	// Position near mouse / center of viewport
	panel.style.top = "80px";
	panel.style.right = "20px";

	// Header
	const header = document.createElement("div");
	header.className = "panel-header";

	const title = document.createElement("span");
	title.className = "panel-title";
	title.textContent = "Remember with Signet";
	header.appendChild(title);

	const closeBtn = document.createElement("button");
	closeBtn.className = "panel-close";
	closeBtn.textContent = "\u00d7";
	closeBtn.addEventListener("click", destroyPanel);
	header.appendChild(closeBtn);

	panel.appendChild(header);

	// Body
	const body = document.createElement("div");
	body.className = "panel-body";

	// Preview
	const preview = document.createElement("div");
	preview.className = "preview";
	preview.textContent = currentSelection;
	body.appendChild(preview);

	// Tags
	const tagsLabel = document.createElement("div");
	tagsLabel.className = "field-label";
	tagsLabel.textContent = "Tags (comma-separated)";
	body.appendChild(tagsLabel);

	const tagsInput = document.createElement("input");
	tagsInput.className = "field-input";
	tagsInput.type = "text";
	tagsInput.placeholder = "web, research, notes...";
	body.appendChild(tagsInput);

	// Importance
	const impLabel = document.createElement("div");
	impLabel.className = "field-label";
	impLabel.textContent = "Importance";
	body.appendChild(impLabel);

	const sliderRow = document.createElement("div");
	sliderRow.className = "slider-row";

	const slider = document.createElement("input");
	slider.className = "slider";
	slider.type = "range";
	slider.min = "0";
	slider.max = "100";
	slider.value = "50";

	const sliderValue = document.createElement("span");
	sliderValue.className = "slider-value";
	sliderValue.textContent = "0.50";

	slider.addEventListener("input", () => {
		sliderValue.textContent = (Number(slider.value) / 100).toFixed(2);
	});

	sliderRow.appendChild(slider);
	sliderRow.appendChild(sliderValue);
	body.appendChild(sliderRow);

	// Source meta
	const sourceMeta = document.createElement("div");
	sourceMeta.className = "source-meta";
	sourceMeta.textContent = `Source: ${currentPageTitle || currentPageUrl}`;
	sourceMeta.title = currentPageUrl;
	body.appendChild(sourceMeta);

	panel.appendChild(body);

	// Footer
	const footer = document.createElement("div");
	footer.className = "panel-footer";

	const cancelBtn = document.createElement("button");
	cancelBtn.className = "btn";
	cancelBtn.textContent = "Cancel";
	cancelBtn.addEventListener("click", destroyPanel);
	footer.appendChild(cancelBtn);

	const saveBtn = document.createElement("button");
	saveBtn.className = "btn btn-primary";
	saveBtn.textContent = "Save";
	saveBtn.addEventListener("click", async () => {
		saveBtn.disabled = true;
		saveBtn.textContent = "Saving...";

		const tags = tagsInput.value.trim();
		const importance = Number(slider.value) / 100;

		// Build content with source metadata
		const sourceNote = currentPageUrl ? `\n\nSource: ${currentPageTitle} (${currentPageUrl})` : "";
		const content = currentSelection + sourceNote;

		try {
			const config = await getConfig();
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (config.authToken) {
				headers["Authorization"] = `Bearer ${config.authToken}`;
			}

			const response = await fetch(`${config.daemonUrl}/api/memory/remember`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					content,
					tags: tags || undefined,
					importance,
					source_type: "browser-extension",
					type: "fact",
				}),
			});

			if (response.ok) {
				destroyPanel();
				showToast(theme, "Saved to Signet");
			} else {
				saveBtn.textContent = "Error";
				setTimeout(() => {
					saveBtn.disabled = false;
					saveBtn.textContent = "Save";
				}, 2000);
			}
		} catch {
			saveBtn.textContent = "Offline";
			setTimeout(() => {
				saveBtn.disabled = false;
				saveBtn.textContent = "Save";
			}, 2000);
		}
	});

	footer.appendChild(saveBtn);
	panel.appendChild(footer);

	shadowRoot.appendChild(panel);

	// Focus tags input
	tagsInput.focus();

	// Close on Escape
	const handleEscape = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			destroyPanel();
			document.removeEventListener("keydown", handleEscape);
		}
	};
	document.addEventListener("keydown", handleEscape);
}

function destroyPanel(): void {
	if (panelHost) {
		panelHost.remove();
		panelHost = null;
		shadowRoot = null;
	}
}

function destroyAskOverlay(): void {
	if (stopAskVoiceCapture) {
		stopAskVoiceCapture();
		stopAskVoiceCapture = null;
	}
	if (stopAskOverlayDrag) {
		stopAskOverlayDrag();
		stopAskOverlayDrag = null;
	}
	if (askHost) {
		askHost.remove();
		askHost = null;
		askShadowRoot = null;
	}
}

async function askSignetFromOverlay(
	message: string,
	modelId: string,
): Promise<{ ok: true; response: string } | { ok: false; error: string }> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(
			{ action: "ask-signet-chat", message, modelId },
			(response?: { ok?: boolean; response?: string; error?: string }) => {
				if (chrome.runtime.lastError) {
					resolve({ ok: false, error: chrome.runtime.lastError.message || "Chat request failed." });
					return;
				}
				if (!response?.ok) {
					resolve({ ok: false, error: response?.error || "Chat request failed." });
					return;
				}
				const text = String(response.response ?? "").trim();
				if (!text) {
					resolve({ ok: false, error: "Signet returned an empty response." });
					return;
				}
				resolve({ ok: true, response: text });
			},
		);
	});
}

async function getAskSignetModels(): Promise<{
	ok: boolean;
	options?: Array<{ id: string; label: string }>;
	defaultModelId?: string;
	error?: string;
}> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(
			{ action: "ask-signet-models" },
			(
				response?: {
					ok?: boolean;
					options?: Array<{ id: string; label: string }>;
					defaultModelId?: string;
					error?: string;
				},
			) => {
				if (chrome.runtime.lastError) {
					resolve({ ok: false, error: chrome.runtime.lastError.message || "Failed to load models." });
					return;
				}
				if (!response?.ok) {
					resolve({ ok: false, error: response?.error || "Failed to load models." });
					return;
				}
				resolve({
					ok: true,
					options: Array.isArray(response.options) ? response.options : [],
					defaultModelId: response.defaultModelId,
				});
			},
		);
	});
}

async function copyTextToClipboard(text: string): Promise<boolean> {
	const value = text.trim();
	if (!value) return false;
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
			return true;
		}
		const area = document.createElement("textarea");
		area.value = value;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.focus();
		area.select();
		document.execCommand("copy");
		area.remove();
		return true;
	} catch {
		return false;
	}
}

function appendAskMessage(container: HTMLElement, role: "user" | "assistant", text: string): void {
	const row = document.createElement("div");
	row.className = `ask-msg ask-msg--${role}`;

	const icon = document.createElement("div");
	icon.className = "ask-msg-icon";
	icon.textContent = role === "user" ? "U" : "S";
	row.appendChild(icon);

	const body = document.createElement("div");
	body.className = "ask-msg-body";
	if (role === "assistant") {
		const actions = document.createElement("div");
		actions.className = "ask-msg-actions";
		const copyBtn = document.createElement("button");
		copyBtn.className = "ask-copy-btn";
		copyBtn.type = "button";
		copyBtn.title = "Copy response";
		copyBtn.innerHTML = ASK_COPY_ICON_SVG;
		copyBtn.addEventListener("click", async () => {
			const copied = await copyTextToClipboard(text);
			if (!copied) return;
			copyBtn.innerHTML = ASK_CHECK_ICON_SVG;
			window.setTimeout(() => {
				copyBtn.innerHTML = ASK_COPY_ICON_SVG;
			}, 1600);
		});
		actions.appendChild(copyBtn);
		body.appendChild(actions);
	}

	const bubble = document.createElement("div");
	bubble.className = "ask-msg-content";
	bubble.textContent = text;
	body.appendChild(bubble);
	row.appendChild(body);

	container.appendChild(row);
	container.scrollTop = container.scrollHeight;
}

function createAskOverlay(
	theme: "dark" | "light",
	initialText: string,
	pageTitle: string,
	pageUrl: string,
	options?: {
		presetAction?: "transcribe";
		autoSubmit?: boolean;
		promptText?: string;
	},
): void {
	destroyAskOverlay();

	askHost = document.createElement("div");
	askHost.id = "signet-ask-overlay";
	document.body.appendChild(askHost);
	askShadowRoot = askHost.attachShadow({ mode: "closed" });
	const askRoot = askShadowRoot;
	if (!askRoot) return;

	const style = document.createElement("style");
	style.textContent = PANEL_STYLES;
	askRoot.appendChild(style);

	const panel = document.createElement("div");
	panel.className = "panel ask-panel";
	panel.setAttribute("data-theme", theme);
	panel.style.top = "48px";
	panel.style.right = "16px";

	const header = document.createElement("div");
	header.className = "ask-header";

	const headerTitle = document.createElement("div");
	headerTitle.className = "ask-header-title";

	const title = document.createElement("span");
	title.className = "ask-header-name";
	title.textContent = "Ask Signet";
	headerTitle.appendChild(title);

	const meta = document.createElement("span");
	meta.className = "ask-header-meta";
	meta.textContent = pageTitle || pageUrl || "Current Page";
	meta.title = pageUrl || pageTitle;
	headerTitle.appendChild(meta);
	header.appendChild(headerTitle);

	const headerActions = document.createElement("div");
	headerActions.className = "ask-header-actions";

	const clearConversationBtn = document.createElement("button");
	clearConversationBtn.className = "ask-icon-btn";
	clearConversationBtn.title = "Clear conversation";
	clearConversationBtn.textContent = "↺";
	headerActions.appendChild(clearConversationBtn);

	const closeBtn = document.createElement("button");
	closeBtn.className = "ask-icon-btn";
	closeBtn.title = "Close";
	closeBtn.textContent = "×";
	closeBtn.addEventListener("click", destroyAskOverlay);
	headerActions.appendChild(closeBtn);

	header.appendChild(headerActions);
	panel.appendChild(header);

	const clampToViewport = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
	let dragging = false;
	let dragOffsetX = 0;
	let dragOffsetY = 0;

	const handleWindowMouseMove = (event: MouseEvent): void => {
		if (!dragging) return;
		const rect = panel.getBoundingClientRect();
		const maxLeft = Math.max(0, window.innerWidth - rect.width);
		const maxTop = Math.max(0, window.innerHeight - rect.height);
		const nextLeft = clampToViewport(event.clientX - dragOffsetX, 0, maxLeft);
		const nextTop = clampToViewport(event.clientY - dragOffsetY, 0, maxTop);
		panel.style.left = `${nextLeft}px`;
		panel.style.top = `${nextTop}px`;
		panel.style.right = "auto";
		panel.style.bottom = "auto";
	};

	const handleWindowMouseUp = (): void => {
		dragging = false;
		window.removeEventListener("mousemove", handleWindowMouseMove);
		window.removeEventListener("mouseup", handleWindowMouseUp);
	};

	const stopDragging = (): void => {
		handleWindowMouseUp();
	};

	const handleHeaderMouseDown = (event: MouseEvent): void => {
		if (event.button !== 0) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest(".ask-icon-btn")) return;
		event.preventDefault();
		const rect = panel.getBoundingClientRect();
		panel.style.left = `${rect.left}px`;
		panel.style.top = `${rect.top}px`;
		panel.style.right = "auto";
		panel.style.bottom = "auto";
		dragOffsetX = event.clientX - rect.left;
		dragOffsetY = event.clientY - rect.top;
		dragging = true;
		window.addEventListener("mousemove", handleWindowMouseMove);
		window.addEventListener("mouseup", handleWindowMouseUp);
	};

	header.addEventListener("mousedown", handleHeaderMouseDown);
	stopAskOverlayDrag = () => {
		stopDragging();
		header.removeEventListener("mousedown", handleHeaderMouseDown);
	};

	const body = document.createElement("div");
	body.className = "ask-body";

	const responseBox = document.createElement("div");
	responseBox.className = "ask-messages";

	const emptyHint = document.createElement("div");
	emptyHint.className = "ask-empty";
	emptyHint.textContent = "Ask about this page and Signet will respond here.";
	responseBox.appendChild(emptyHint);
	body.appendChild(responseBox);

	const overlayPresetAction = options?.presetAction;
	const shouldAutoSubmitPreset =
		overlayPresetAction === "transcribe" && options?.autoSubmit === true && Boolean(options?.promptText?.trim());
	const initialAskInput = shouldAutoSubmitPreset
		? String(options?.promptText ?? "").trim()
		: initialText;
	let autoSubmittedPreset = false;

	let selectedModelId = "";
	let selectedMicrophoneId = "default";
	let microphoneOptions: Array<{ id: string; label: string }> = [];
	const controls = document.createElement("div");
	controls.className = "ask-controls";

	const micSelect = document.createElement("select");
	micSelect.className = "field-input ask-mic-select";
	micSelect.disabled = true;
	micSelect.innerHTML = '<option value="default">Loading microphones...</option>';
	controls.appendChild(micSelect);

	const modelSelect = document.createElement("select");
	modelSelect.className = "field-input ask-model-select";
	modelSelect.disabled = true;
	modelSelect.innerHTML = '<option value="">Loading models...</option>';
	controls.appendChild(modelSelect);
	body.appendChild(controls);

	const inputBar = document.createElement("div");
	inputBar.className = "ask-input-bar";

	const input = document.createElement("input");
	input.className = "field-input ask-input";
	input.type = "text";
	input.placeholder = "Ask your agent...";
	input.value = initialAskInput;
	input.autocomplete = "off";
	inputBar.appendChild(input);

	const inputActions = document.createElement("div");
	inputActions.className = "ask-input-actions";

	const voiceBtn = document.createElement("button");
	voiceBtn.className = "btn ask-voice-btn";
	voiceBtn.type = "button";
	voiceBtn.innerHTML = ASK_MIC_ICON_SVG;
	voiceBtn.title = "Use microphone";
	inputActions.appendChild(voiceBtn);

	const sendBtn = document.createElement("button");
	sendBtn.className = "btn ask-send-btn";
	sendBtn.innerHTML = ASK_SEND_ICON_SVG;
	sendBtn.title = "Send message";
	sendBtn.disabled = true;
	inputActions.appendChild(sendBtn);

	inputBar.appendChild(inputActions);
	body.appendChild(inputBar);

	const status = document.createElement("div");
	status.className = "ask-status";
	status.textContent = "Loading providers...";
	body.appendChild(status);

	let recognition: SpeechRecognitionInstance | null = null;
	let activeMicStream: MediaStream | null = null;
	let listening = false;
	let voicePending = false;
	const speechCtor = getSpeechRecognitionCtor();
	const voiceSupported = Boolean(speechCtor);

	const updateActionState = (): void => {
		sendBtn.disabled = input.disabled || !selectedModelId || !input.value.trim();
		voiceBtn.disabled = input.disabled || !voiceSupported || voicePending;
		micSelect.disabled = input.disabled || listening || microphoneOptions.length === 0;
		voiceBtn.innerHTML = listening
			? '<span class="ask-voice-bars" aria-hidden="true"><span></span><span></span><span></span></span>'
			: ASK_MIC_ICON_SVG;
		voiceBtn.title = voiceSupported
			? listening
				? "Stop microphone"
				: "Use microphone"
			: "Voice input is not supported in this browser";
		voiceBtn.setAttribute("data-state", listening ? "active" : "idle");
	};

	let voiceInputBase = input.value.trim();

	const appendTranscriptToInput = (transcript: string): void => {
		const cleaned = transcript.trim();
		if (!cleaned) return;
		const merged = voiceInputBase ? `${voiceInputBase} ${cleaned}` : cleaned;
		input.value = merged;
		input.dispatchEvent(new Event("input"));
	};

	const releaseActiveMicStream = (): void => {
		if (!activeMicStream) return;
		for (const track of activeMicStream.getTracks()) {
			track.stop();
		}
		activeMicStream = null;
	};

	const clearRecognitionHandlers = (): void => {
		if (!recognition) return;
		recognition.onend = null;
		recognition.onerror = null;
		recognition.onresult = null;
		recognition = null;
	};

	const extractTranscriptFromVoiceEvent = (event: Event): string => {
		const speechEvent = event as Event & {
			results?: ArrayLike<{
				0?: { transcript?: string };
				item?: (index: number) => { transcript?: string } | null;
			}> & {
				item?: (index: number) => {
					0?: { transcript?: string };
					item?: (index: number) => { transcript?: string } | null;
				} | null;
			};
		};
		const results = speechEvent.results;
		if (!results) return "";

		let transcript = "";
		for (let index = 0; index < results.length; index += 1) {
			const result = results[index] ?? results.item?.(index) ?? null;
			const primaryAlt = result?.[0] ?? result?.item?.(0) ?? null;
			const chunk = typeof primaryAlt?.transcript === "string" ? primaryAlt.transcript.trim() : "";
			if (!chunk) continue;
			transcript += `${chunk} `;
		}

		if (transcript.trim()) return transcript.trim();

		const fallbackTranscript = (event as Event & { transcript?: string }).transcript;
		return typeof fallbackTranscript === "string" ? fallbackTranscript.trim() : "";
	};

	const stopVoiceCapture = (): void => {
		if (!recognition) {
			listening = false;
			voicePending = false;
			releaseActiveMicStream();
			updateActionState();
			return;
		}
		voicePending = true;
		updateActionState();
		recognition.stop();
	};
	stopAskVoiceCapture = stopVoiceCapture;

	micSelect.addEventListener("change", () => {
		selectedMicrophoneId = micSelect.value || "default";
		updateActionState();
	});

	modelSelect.addEventListener("change", () => {
		selectedModelId = modelSelect.value;
		updateActionState();
	});

	voiceBtn.addEventListener("click", async () => {
		status.removeAttribute("data-tone");
		if (listening) {
			stopVoiceCapture();
			status.textContent = "Stopping voice input...";
			return;
		}
		if (!speechCtor) {
			status.textContent = "Voice input is not supported in this browser.";
			status.setAttribute("data-tone", "error");
			return;
		}

		voicePending = true;
		updateActionState();
		try {
			releaseActiveMicStream();
			activeMicStream = await requestMicrophoneStream(selectedMicrophoneId || "default");
			await loadMicrophones();
			voiceInputBase = input.value.trim();
			recognition = new speechCtor();
			recognition.continuous = false;
			recognition.interimResults = true;
			recognition.lang = navigator.language || "en-US";
			recognition.onresult = (event: Event) => {
				const transcript = extractTranscriptFromVoiceEvent(event);
				if (!transcript) return;
				appendTranscriptToInput(transcript);
			};
			recognition.onerror = (event: Event) => {
				const reason = (event as Event & { error?: string }).error;
				if (reason === "no-speech") {
					status.textContent = "No speech detected. Try speaking immediately after the mic turns active.";
					status.removeAttribute("data-tone");
				} else if (reason && reason !== "aborted") {
					status.textContent = `Voice capture failed: ${reason}`;
					status.setAttribute("data-tone", "error");
				}
				listening = false;
				voicePending = false;
				clearRecognitionHandlers();
				releaseActiveMicStream();
				updateActionState();
			};
			recognition.onend = () => {
				listening = false;
				voicePending = false;
				if (!status.getAttribute("data-tone")) {
					status.textContent = "Ready";
				}
				clearRecognitionHandlers();
				releaseActiveMicStream();
				updateActionState();
				input.focus();
			};
			listening = true;
			voicePending = false;
			status.textContent = "Listening...";
			status.removeAttribute("data-tone");
			updateActionState();
			const selectedTrack = activeMicStream.getAudioTracks()[0] ?? undefined;
			if (selectedTrack) {
				try {
					recognition.start(selectedTrack);
				} catch {
					recognition.start();
				}
			} else {
				recognition.start();
			}
		} catch (error) {
			listening = false;
			voicePending = false;
			status.textContent = error instanceof Error ? error.message : "Unable to access microphone.";
			status.setAttribute("data-tone", "error");
			clearRecognitionHandlers();
			releaseActiveMicStream();
			updateActionState();
		}
	});

	const loadMicrophones = async (): Promise<void> => {
		try {
			microphoneOptions = await getAudioInputOptions();
			if (microphoneOptions.length === 0) {
				micSelect.innerHTML = '<option value="default">No microphones found</option>';
				micSelect.disabled = true;
				selectedMicrophoneId = "default";
				updateActionState();
				return;
			}

			micSelect.innerHTML = "";
			for (const option of microphoneOptions) {
				const optionEl = document.createElement("option");
				optionEl.value = option.id;
				optionEl.textContent = option.label;
				micSelect.appendChild(optionEl);
			}

			if (!microphoneOptions.some((option) => option.id === selectedMicrophoneId)) {
				selectedMicrophoneId = "default";
			}
			micSelect.value = selectedMicrophoneId;
			micSelect.disabled = input.disabled || listening;
			updateActionState();
		} catch {
			micSelect.innerHTML = '<option value="default">Microphone unavailable</option>';
			micSelect.disabled = true;
			selectedMicrophoneId = "default";
			updateActionState();
		}
	};

	const loadModels = async (): Promise<void> => {
		const result = await getAskSignetModels();
		if (!result.ok || !result.options || result.options.length === 0) {
			status.textContent = result.error || "No providers found.";
			status.setAttribute("data-tone", "error");
			modelSelect.innerHTML = '<option value="">No providers found</option>';
			modelSelect.disabled = true;
			updateActionState();
			return;
		}

		modelSelect.innerHTML = "";
		for (const option of result.options) {
			const optionEl = document.createElement("option");
			optionEl.value = option.id;
			optionEl.textContent = option.label;
			modelSelect.appendChild(optionEl);
		}

		selectedModelId = result.defaultModelId && result.options.some((opt) => opt.id === result.defaultModelId)
			? result.defaultModelId
			: result.options[0]?.id || "";
		modelSelect.value = selectedModelId;
		modelSelect.disabled = false;
		status.textContent = "Ready";
		status.removeAttribute("data-tone");
		updateActionState();
		if (shouldAutoSubmitPreset && !autoSubmittedPreset && selectedModelId && input.value.trim()) {
			autoSubmittedPreset = true;
			status.textContent = "Starting transcription...";
			setTimeout(() => sendBtn.click(), 0);
		}
	};

	updateActionState();
	void loadMicrophones();
	void loadModels();

	clearConversationBtn.addEventListener("click", () => {
		responseBox.innerHTML = "";
		const hint = document.createElement("div");
		hint.className = "ask-empty";
		hint.textContent = "Conversation cleared.";
		responseBox.appendChild(hint);
		status.textContent = "Cleared";
		status.removeAttribute("data-tone");
	});

	sendBtn.addEventListener("click", async () => {
		const prompt = input.value.trim();
		if (!prompt) {
			status.textContent = "Add a prompt first.";
			status.setAttribute("data-tone", "error");
			return;
		}
		if (!selectedModelId) {
			status.textContent = "Select a model first.";
			status.setAttribute("data-tone", "error");
			return;
		}

		if (responseBox.firstElementChild?.classList.contains("ask-empty")) {
			responseBox.innerHTML = "";
		}

		stopVoiceCapture();
		sendBtn.disabled = true;
		modelSelect.disabled = true;
		input.disabled = true;
		updateActionState();
		status.textContent = "Asking Signet...";
		status.removeAttribute("data-tone");
		appendAskMessage(responseBox, "user", prompt);
		input.value = "";

		const thinking = document.createElement("div");
		thinking.className = "ask-msg ask-msg--assistant";
		thinking.innerHTML =
			'<div class="ask-msg-icon">S</div><div class="ask-thinking"><span class="ask-thinking-dot"></span><span class="ask-thinking-dot"></span><span class="ask-thinking-dot"></span></div>';
		responseBox.appendChild(thinking);
		responseBox.scrollTop = responseBox.scrollHeight;

		try {
			let result = await askSignetFromOverlay(prompt, selectedModelId);
			if (!result.ok && overlayPresetAction === "transcribe") {
				const fallbackPrompt = [
					"Transcribe the content below.",
					"Return only the final transcript text.",
					"",
					prompt,
				].join("\n");
				result = await askSignetFromOverlay(fallbackPrompt, selectedModelId);
			}
			thinking.remove();
			if (!result.ok) {
				appendAskMessage(responseBox, "assistant", `Request failed: ${result.error}`);
				status.textContent = result.error;
				status.setAttribute("data-tone", "error");
				return;
			}
			appendAskMessage(responseBox, "assistant", result.response);
			status.textContent = "Response received.";
			status.setAttribute("data-tone", "success");
		} catch (error) {
			thinking.remove();
			const message = error instanceof Error ? error.message : "Signet request failed.";
			appendAskMessage(responseBox, "assistant", `Request failed: ${message}`);
			status.textContent = message;
			status.setAttribute("data-tone", "error");
		} finally {
			input.disabled = false;
			modelSelect.disabled = false;
			updateActionState();
			input.focus();
		}
	});

	input.addEventListener("input", () => {
		updateActionState();
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			sendBtn.click();
		}
	});

	panel.appendChild(body);
	askRoot.appendChild(panel);
	input.focus();
	if (initialText) {
		input.setSelectionRange(input.value.length, input.value.length);
	}
}

function showToast(theme: "dark" | "light", message: string): void {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const shadow = host.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = PANEL_STYLES;
	shadow.appendChild(style);

	const toast = document.createElement("div");
	toast.className = "toast";
	toast.setAttribute("data-theme", theme);
	toast.textContent = message;
	shadow.appendChild(toast);

	requestAnimationFrame(() => {
		toast.classList.add("visible");
	});

	setTimeout(() => {
		toast.classList.remove("visible");
		setTimeout(() => host.remove(), 300);
	}, 2000);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueLimited(values: readonly string[], limit = 24): string[] {
	const unique = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
	return unique.slice(0, limit);
}

function normalizeUrl(value: string): string | null {
	if (!value) return null;
	try {
		return new URL(value, window.location.href).href;
	} catch {
		return null;
	}
}

function collectPageContext() {
	const selectedText = window.getSelection()?.toString()?.trim() ?? "";

	const links = uniqueLimited(
		Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
			.map((anchor) => normalizeUrl(anchor.href) ?? "")
			.filter(Boolean),
	);

	const images = uniqueLimited(
		Array.from(document.querySelectorAll<HTMLImageElement>("img[src]"))
			.map((img) => normalizeUrl(img.currentSrc || img.src) ?? "")
			.filter(Boolean),
	);

	const videos = uniqueLimited(
		Array.from(document.querySelectorAll<HTMLVideoElement>("video"))
			.flatMap((video) => {
				const sourceEls = Array.from(video.querySelectorAll<HTMLSourceElement>("source[src]"));
				return [video.currentSrc, video.src, ...sourceEls.map((source) => source.src)]
					.map((src) => normalizeUrl(src || "") ?? "")
					.filter(Boolean);
			})
			.slice(0, 32),
	);

	const audio = uniqueLimited(
		Array.from(document.querySelectorAll<HTMLAudioElement>("audio"))
			.flatMap((track) => {
				const sourceEls = Array.from(track.querySelectorAll<HTMLSourceElement>("source[src]"));
				return [track.currentSrc, track.src, ...sourceEls.map((source) => source.src)]
					.map((src) => normalizeUrl(src || "") ?? "")
					.filter(Boolean);
			})
			.slice(0, 32),
	);

	const files = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
		.flatMap((input) => Array.from(input.files ?? []))
		.slice(0, 24)
		.map((file) => ({
			name: file.name,
			type: file.type,
			size: file.size,
		}));

	return {
		pageTitle: document.title,
		pageUrl: window.location.href,
		selectedText,
		links,
		images,
		videos,
		audio,
		files,
	};
}

type HarnessInput = HTMLInputElement | HTMLTextAreaElement;

function setInputValue(input: HarnessInput, value: string): void {
	if (input instanceof HTMLTextAreaElement) {
		const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
		if (descriptor?.set) {
			descriptor.set.call(input, value);
		} else {
			input.value = value;
		}
	} else {
		const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
		if (descriptor?.set) {
			descriptor.set.call(input, value);
		} else {
			input.value = value;
		}
	}

	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForElement<T extends Element>(selector: string, timeoutMs = 4000): Promise<T | null> {
	const start = Date.now();
	while (Date.now() - start <= timeoutMs) {
		const found = document.querySelector<T>(selector);
		if (found) return found;
		await delay(100);
	}
	return null;
}

async function injectHarnessPayload(payload: string, autoSend: boolean): Promise<{ ok: boolean; error?: string }> {
	if (!payload.trim()) {
		return { ok: false, error: "Empty payload" };
	}

	if (window.location.hash.slice(1) !== "os") {
		window.location.hash = "os";
		await delay(350);
	}

	const chatToggle = await waitForElement<HTMLButtonElement>(".os-chat-toggle", 2500);
	if (chatToggle && !chatToggle.classList.contains("active")) {
		chatToggle.click();
		await delay(250);
	}

	const chatInput = await waitForElement<HarnessInput>(".chat-input", 4500);
	if (!chatInput) {
		return { ok: false, error: "Harness input unavailable" };
	}

	chatInput.focus();
	setInputValue(chatInput, payload);
	await delay(80);

	if (!chatInput.value.trim()) {
		return { ok: false, error: "Harness input did not accept payload" };
	}

	if (autoSend) {
		const sendButton = await waitForElement<HTMLButtonElement>(".chat-send-btn", 2000);
		if (!sendButton) {
			return { ok: false, error: "Harness send button unavailable" };
		}

		if (sendButton.disabled) {
			chatInput.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					bubbles: true,
					cancelable: true,
				}),
			);
			await delay(120);
			if (sendButton.disabled) {
				return { ok: false, error: "Harness send action unavailable" };
			}
		}

		sendButton.click();
	}

	return { ok: true };
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.action === "show-save-panel" || message.action === "trigger-save-shortcut") {
		const selectedText = message.text ?? window.getSelection()?.toString()?.trim() ?? "";
		if (!selectedText) return false;

		currentSelection = selectedText;
		currentPageUrl = message.pageUrl ?? window.location.href;
		currentPageTitle = message.pageTitle ?? document.title;

		getConfig().then((config) => {
			const theme = resolveTheme(config.theme);
			destroyPanel();
			createPanel(theme);
		});
		return false;
	}

	if (message.action === "show-ask-signet-overlay") {
		const selectedText = String(message.text ?? window.getSelection()?.toString()?.trim() ?? "");
		const pageUrl = String(message.pageUrl ?? window.location.href ?? "");
		const pageTitle = String(message.pageTitle ?? document.title ?? "");
		const presetAction = message.presetAction === "transcribe" ? "transcribe" : undefined;
		const autoSubmit = message.autoSubmit === true;
		const promptText = typeof message.promptText === "string" ? message.promptText : undefined;

		getConfig()
			.then((config) => {
				const theme = resolveTheme(config.theme);
				createAskOverlay(theme, selectedText, pageTitle, pageUrl, {
					presetAction,
					autoSubmit,
					promptText,
				});
				sendResponse({ ok: true });
			})
			.catch((error: unknown) => {
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Failed to open Ask Signet overlay",
				});
			});
		return true;
	}

	if (message.action === "collect-page-context") {
		sendResponse(collectPageContext());
		return false;
	}

	if (message.action === "inject-harness-payload") {
		injectHarnessPayload(String(message.payload ?? ""), message.autoSend !== false)
			.then((result) => sendResponse(result))
			.catch((error: unknown) => {
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : "Injection failed",
				});
			});
		return true;
	}

	return false;
});
