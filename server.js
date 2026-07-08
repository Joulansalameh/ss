const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();
const MAX_HISTORY = 120;
const MAX_TEXT_LENGTH = 1000;
const MAX_AUDIO_DATA_LENGTH = 1_600_000;

const contentTypes = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".mp3": "audio/mpeg",
};

const rooms = new Map();

function sanitizeRoom(raw) {
	const room = String(raw || "shadow").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
	return room || "shadow";
}

function getRoomState(room) {
	if (!rooms.has(room)) {
		rooms.set(room, { clients: new Set(), history: [] });
	}
	return rooms.get(room);
}

function sendJson(ws, payload) {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(payload));
	}
}

function broadcastToRoom(room, payload) {
	const state = rooms.get(room);
	if (!state) {
		return;
	}
	const data = JSON.stringify(payload);
	for (const client of state.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	}
}

function validateMessage(msg) {
	if (!msg || typeof msg !== "object") {
		return false;
	}
	if (typeof msg.id !== "string" || msg.id.length > 120) {
		return false;
	}
	if (typeof msg.sender !== "string" || msg.sender.length > 120) {
		return false;
	}
	if (typeof msg.ts !== "number") {
		return false;
	}
	if (msg.type === "text") {
		return typeof msg.text === "string" && msg.text.length > 0 && msg.text.length <= MAX_TEXT_LENGTH;
	}
	if (msg.type === "voice") {
		return typeof msg.audioData === "string" && msg.audioData.length > 0 && msg.audioData.length <= MAX_AUDIO_DATA_LENGTH;
	}
	return false;
}

const server = http.createServer((req, res) => {
	const cleanUrl = (req.url || "/").split("?")[0];
	const target = cleanUrl === "/" ? "/message.html" : cleanUrl;
	const safePath = path.normalize(target).replace(/^([.][.][/\\])+/, "");
	const filePath = path.join(ROOT, safePath);

	if (!filePath.startsWith(ROOT)) {
		res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Forbidden");
		return;
	}

	fs.readFile(filePath, (err, data) => {
		if (err) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}

		const ext = path.extname(filePath).toLowerCase();
		res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
		res.end(data);
	});
});

const wss = new WebSocket.Server({ server, path: "/ws", maxPayload: 2 * 1024 * 1024 });

wss.on("connection", (ws) => {
	ws.room = null;

	ws.on("message", (raw) => {
		let packet;
		try {
			packet = JSON.parse(String(raw));
		} catch {
			sendJson(ws, { type: "error", message: "Invalid JSON" });
			return;
		}

		if (packet.type === "join") {
			const room = sanitizeRoom(packet.room);

			if (ws.room && rooms.has(ws.room)) {
				rooms.get(ws.room).clients.delete(ws);
			}

			ws.room = room;
			const state = getRoomState(room);
			state.clients.add(ws);
			sendJson(ws, { type: "history", items: state.history.slice(-MAX_HISTORY) });
			return;
		}

		if (!ws.room || !rooms.has(ws.room)) {
			sendJson(ws, { type: "error", message: "Join a room first" });
			return;
		}

		if (packet.type === "message") {
			if (!validateMessage(packet.msg)) {
				sendJson(ws, { type: "error", message: "Invalid message payload" });
				return;
			}

			const state = rooms.get(ws.room);
			const already = state.history.findIndex((item) => item.id === packet.msg.id);
			if (already >= 0) {
				state.history[already] = packet.msg;
			} else {
				state.history.push(packet.msg);
			}
			state.history = state.history.slice(-MAX_HISTORY);
			broadcastToRoom(ws.room, { type: "message", item: packet.msg });
			return;
		}

		if (packet.type === "delete") {
			const id = String(packet.id || "");
			if (!id) {
				return;
			}

			const state = rooms.get(ws.room);
			state.history = state.history.filter((item) => item.id !== id);
			broadcastToRoom(ws.room, { type: "delete", id });
		}
	});

	ws.on("close", () => {
		if (!ws.room || !rooms.has(ws.room)) {
			return;
		}
		const state = rooms.get(ws.room);
		state.clients.delete(ws);
		if (state.clients.size === 0 && state.history.length === 0) {
			rooms.delete(ws.room);
		}
	});
});

server.listen(PORT, () => {
	console.log(`Shady relay server running on http://localhost:${PORT}`);
	console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
