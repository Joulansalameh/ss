const refs = {
	form: document.getElementById("messageForm"),
	input: document.getElementById("messageInput"),
	history: document.getElementById("history"),
	status: document.getElementById("statusText"),
	recordBtn: document.getElementById("recordBtn"),
	serverInput: document.getElementById("serverInput"),
	roomInput: document.getElementById("roomInput"),
	connectBtn: document.getElementById("connectBtn"),
};

const ROOM_KEY = "shady_room_v1";
const SERVER_KEY = "shady_server_v1";
const MAX_RECORDING_MS = 12000;
const MAX_MESSAGES = 120;

const clientId = sessionStorage.getItem("shady_client_id") || `c-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
sessionStorage.setItem("shady_client_id", clientId);

const audioCtx = window.AudioContext || window.webkitAudioContext ? new (window.AudioContext || window.webkitAudioContext)() : null;

let ws = null;
let connected = false;
let memoryHistory = [];
let recorder = null;
let recording = false;
let recordChunks = [];
let recordStartAt = 0;
let recordStopTimer = null;

function setStatus(text) {
	refs.status.textContent = text;
}

function normalizeRoom(value) {
	const cleaned = String(value || "shadow").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
	return cleaned || "shadow";
}

function defaultServerUrl() {
	if (location.protocol.startsWith("http")) {
		const protocol = location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${location.host}/ws`;
	}
	return "ws://localhost:8080/ws";
}

function currentRoom() {
	return normalizeRoom(refs.roomInput.value);
}

function saveConnectionPrefs() {
	localStorage.setItem(ROOM_KEY, currentRoom());
	localStorage.setItem(SERVER_KEY, refs.serverInput.value.trim());
}

function msToLabel(ms) {
	const totalSec = Math.max(1, Math.round(ms / 1000));
	const mm = Math.floor(totalSec / 60);
	const ss = String(totalSec % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

function stampTime(ts) {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}

function sendPacket(packet) {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		setStatus("Not connected. Tap Connect first.");
		return false;
	}

	try {
		ws.send(JSON.stringify(packet));
		return true;
	} catch {
		setStatus("Failed to send packet");
		return false;
	}
}

function buildActions(messageId) {
	const wrap = document.createElement("div");
	wrap.className = "msg-actions";

	const delBtn = document.createElement("button");
	delBtn.type = "button";
	delBtn.className = "delete-msg-btn";
	delBtn.textContent = "Delete";
	delBtn.addEventListener("click", () => {
		sendPacket({ type: "delete", room: currentRoom(), id: messageId });
	});

	wrap.append(delBtn);
	return wrap;
}

function buildDeepButton(item) {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "play-deep-btn";
	btn.textContent = "Play Voice";

	btn.addEventListener("click", async () => {
		btn.disabled = true;
		btn.textContent = "Playing";
		try {
			await playDeepVoice(item.audioData);
		} catch {
			setStatus("Deep playback failed");
		}
		btn.disabled = false;
		btn.textContent = "Play Voice";
	});

	return btn;
}

function buildTextNode(item, self) {
	const node = document.createElement("article");
	node.className = `msg${self ? " self" : ""}`;

	const meta = document.createElement("span");
	meta.className = "meta";
	meta.textContent = `${self ? "you" : "other"} | ${stampTime(item.ts)}`;

	const body = document.createElement("span");
	body.textContent = item.text;

	node.append(meta, body, buildActions(item.id));
	return node;
}

function buildVoiceNode(item, self) {
	const node = document.createElement("article");
	node.className = `msg${self ? " self" : ""}`;

	const meta = document.createElement("span");
	meta.className = "meta";
	meta.textContent = `${self ? "you" : "other"} | ${stampTime(item.ts)} | voice ${msToLabel(item.durationMs || 0)}`;

	const row = document.createElement("div");
	row.className = "voice-row";
	row.append(buildDeepButton(item));

	node.append(meta, row, buildActions(item.id));
	return node;
}

function renderHistory() {
	refs.history.textContent = "";
	if (memoryHistory.length === 0) {
		const empty = document.createElement("p");
		empty.className = "empty";
		empty.textContent = "No messages yet.";
		refs.history.appendChild(empty);
		return;
	}

	for (const item of memoryHistory) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const self = item.sender === clientId;
		const node = item.type === "voice" ? buildVoiceNode(item, self) : buildTextNode(item, self);
		refs.history.appendChild(node);
	}

	refs.history.scrollTop = refs.history.scrollHeight;
}

function applyIncomingMessage(item) {
	if (!item || !item.id) {
		return;
	}

	const index = memoryHistory.findIndex((m) => m.id === item.id);
	if (index >= 0) {
		memoryHistory[index] = item;
	} else {
		memoryHistory.push(item);
	}

	memoryHistory = memoryHistory.slice(-MAX_MESSAGES);
	renderHistory();
}

function applyDelete(id) {
	if (!id) {
		return;
	}
	memoryHistory = memoryHistory.filter((item) => item && item.id !== id);
	renderHistory();
}

function handlePacket(packet) {
	if (!packet || typeof packet !== "object") {
		return;
	}

	if (packet.type === "history" && Array.isArray(packet.items)) {
		memoryHistory = packet.items.slice(-MAX_MESSAGES);
		renderHistory();
		setStatus(`Connected to room ${currentRoom()}`);
		return;
	}

	if (packet.type === "message" && packet.item) {
		applyIncomingMessage(packet.item);
		return;
	}

	if (packet.type === "delete" && packet.id) {
		applyDelete(packet.id);
		return;
	}

	if (packet.type === "error") {
		setStatus(packet.message || "Server error");
	}
}

function connectSocket() {
	const url = refs.serverInput.value.trim() || defaultServerUrl();
	const room = currentRoom();
	refs.roomInput.value = room;
	refs.serverInput.value = url;
	saveConnectionPrefs();

	if (ws) {
		try {
			ws.close();
		} catch {
			// Ignore close errors.
		}
	}

	memoryHistory = [];
	renderHistory();
	setStatus("Connecting...");

	try {
		ws = new WebSocket(url);
 	} catch {
		setStatus("Invalid server URL");
 		return;
 	}

	ws.onopen = () => {
		connected = true;
		refs.connectBtn.textContent = "Reconnect";
		sendPacket({ type: "join", room, clientId });
	};

	ws.onmessage = (event) => {
		try {
			const packet = JSON.parse(event.data);
			handlePacket(packet);
		} catch {
			setStatus("Bad server packet");
		}
	};

	ws.onclose = () => {
		connected = false;
		setStatus("Disconnected");
	};

	ws.onerror = () => {
		connected = false;
		setStatus("Connection error");
	};
}

async function playDeepVoice(audioDataUrl) {
	if (!audioDataUrl || typeof audioDataUrl !== "string") {
		return;
	}

	if (!audioCtx) {
		const audio = new Audio(audioDataUrl);
		audio.playbackRate = 0.9;
		await audio.play();
		return;
	}

	if (audioCtx.state === "suspended") {
		await audioCtx.resume();
	}

	const response = await fetch(audioDataUrl);
	const blob = await response.blob();
	const arrayBuffer = await blob.arrayBuffer();
	const buffer = await audioCtx.decodeAudioData(arrayBuffer);

	const source = audioCtx.createBufferSource();
	source.buffer = buffer;
	source.playbackRate.value = 0.9;
	source.detune.value = -320;

	const filter = audioCtx.createBiquadFilter();
	filter.type = "lowpass";
	filter.frequency.value = 1800;
	filter.Q.value = 0.8;

	const gain = audioCtx.createGain();
	gain.gain.value = 1.08;

	source.connect(filter);
	filter.connect(gain);
	gain.connect(audioCtx.destination);
	source.start();

	await new Promise((resolve) => {
		source.onended = resolve;
	});
}

function chooseMimeType() {
	const candidates = [
		"audio/webm;codecs=opus",
		"audio/webm",
		"audio/mp4",
		"audio/ogg;codecs=opus",
	];

	for (const type of candidates) {
		if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
			return type;
		}
	}

	return "";
}

function clearRecordTimer() {
	if (recordStopTimer) {
		window.clearTimeout(recordStopTimer);
		recordStopTimer = null;
	}
}

async function stopRecording() {
	if (!recorder || recorder.state !== "recording") {
		return;
	}
	clearRecordTimer();
	recorder.stop();
}

async function startRecording() {
	if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
		setStatus("Connect before sending voice");
		return;
	}

	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
		setStatus("Voice recording unsupported in this browser");
		return;
	}

	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		recordChunks = [];
		recordStartAt = Date.now();
		const mimeType = chooseMimeType();
		recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

		recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) {
				recordChunks.push(event.data);
			}
		};

		recorder.onstop = async () => {
			const durationMs = Date.now() - recordStartAt;
			stream.getTracks().forEach((track) => track.stop());
			recording = false;
			refs.recordBtn.classList.remove("active");
			refs.recordBtn.textContent = "Voice";

			if (recordChunks.length === 0 || durationMs < 300) {
				setStatus("Voice message too short");
				return;
			}

			try {
				const blob = new Blob(recordChunks, { type: recorder.mimeType || "audio/webm" });
				const audioData = await toDataUrl(blob);
				const msg = {
					id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
					type: "voice",
					sender: clientId,
					ts: Date.now(),
					audioData,
					durationMs,
				};
				sendPacket({ type: "message", room: currentRoom(), msg });
				setStatus("Voice message sent");
			} catch {
				setStatus("Voice message failed");
			}
		};

		recorder.start(250);
		recording = true;
		refs.recordBtn.classList.add("active");
		refs.recordBtn.textContent = "Stop";
		setStatus("Recording voice...");

		recordStopTimer = window.setTimeout(() => {
			stopRecording();
		}, MAX_RECORDING_MS);
 	} catch {
		setStatus("Microphone access blocked or unavailable");
 	}
 }

 refs.connectBtn.addEventListener("click", () => {
 	connectSocket();
 });

 refs.recordBtn.addEventListener("click", async () => {
 	if (recording) {
 		await stopRecording();
 		return;
 	}
 	await startRecording();
 });

 refs.form.addEventListener("submit", (event) => {
 	event.preventDefault();
 	const text = refs.input.value.trim();
 	if (!text) {
 		return;
 	}

 	if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
 		setStatus("Connect before sending messages");
 		return;
 	}

 	const msg = {
 		id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
 		type: "text",
 		sender: clientId,
 		ts: Date.now(),
 		text,
 	};

 	sendPacket({ type: "message", room: currentRoom(), msg });
 	refs.input.value = "";
 	refs.input.focus();
 });

 function bootstrap() {
 	const savedRoom = normalizeRoom(localStorage.getItem(ROOM_KEY) || "shadow");
 	const savedUrl = localStorage.getItem(SERVER_KEY) || defaultServerUrl();
 	refs.roomInput.value = savedRoom;
 	refs.serverInput.value = savedUrl;
 	setStatus("Disconnected");
 	renderHistory();
 	connectSocket();
 }

 bootstrap();
