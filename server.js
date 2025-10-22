const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PWD = process.env.ADMIN_PWD;

const clients = new Map(); // ws -> { username, deviceId }
const rateLimits = new Map(); // username -> spam info
const devices = new Map(); // deviceId -> ws
const anonymousCounts = {}; // baseName -> count
const messageHistory = []; // Store last 100 messages with timestamps
const MAX_HISTORY = 100;
const SERVER_START_TIME = Date.now();

// --- CORS ---
app.use((req, res, next) => {
  const allowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://xwalfie-smr.github.io",
    "https://chat-cp1p.onrender.com",
    // Add other allowed origins as needed
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  next();
});

// --- Static files + disable caching ---
app.use(express.static("public"));
app.use((res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// --- Health check endpoint ---

app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --- WebSocket handling ---
wss.on("connection", (ws) => {
    // Send initial prompt
    ws.send(JSON.stringify({ type: "prompt", msg: "Escribe tu nombre de usuario:" }));
    ws.send(JSON.stringify({ type: "serverInfo", startTime: SERVER_START_TIME }));

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            // --- Handle username setup ---
            if (data.type === "username") {
                let { msg: requestedName, deviceId, oldUsername } = data;
                requestedName = (requestedName || "anon").trim();

                // Validate deviceId
                if (!deviceId) {
                    ws.send(JSON.stringify({ type: "error", msg: "Error: dispositivo no identificado." }));
                    ws.close();
                    return;
                }

                // Handle existing device connection
                if (devices.has(deviceId)) {
                    const oldWs = devices.get(deviceId);
                    const oldClient = clients.get(oldWs);

                    if (oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
                        const oldName = oldClient?.username;
                        
                        // Clean up old connection
                        clients.delete(oldWs);
                        devices.delete(deviceId);
                        if (oldName) rateLimits.delete(oldName);

                        try {
                            oldWs.close();
                        } catch (e) {
                            console.error("Error closing old connection:", e);
                        }

                        // Only notify if not a username change
                        if (oldName && !oldUsername) {
                            broadcast(`[${oldName}] ha salido del chat.`, Date.now());
                        }
                    }
                }

                // Generate unique username
                let finalName = requestedName;

                if (!requestedName || requestedName.toLowerCase().startsWith("anon")) {
                    const base = "anon";
                    const count = anonymousCounts[base] || 0;
                    finalName = count === 0 ? base : `${base}-${count}`;
                    anonymousCounts[base] = count + 1;
                } else {
                    // Prevent duplicate names
                    let suffix = 1;
                    const existingNames = Array.from(clients.values()).map(c => c.username);
                    while (existingNames.includes(finalName)) {
                        finalName = `${requestedName}-${suffix}`;
                        suffix++;
                    }
                }

                // Store client info
                clients.set(ws, { username: finalName, deviceId });
                devices.set(deviceId, ws);

                // Send history immediately
                ws.send(JSON.stringify({
                    type: "history",
                    messages: messageHistory
                }));

                // Send authentication success
                ws.send(JSON.stringify({
                    type: "authenticated",
                    username: finalName
                }));

                // Broadcast join/change message
                if (oldUsername) {
                    broadcast(`[${oldUsername}] ahora es conocido como [${finalName}].`, Date.now());
                } else {
                    broadcast(`[${finalName}] se ha unido al chat.`, Date.now());
                }
                return;
            }

            // --- Handle ping ---
            if (data.type === "ping") {
                ws.send(JSON.stringify({ type: "serverInfo", startTime: SERVER_START_TIME }));
                return;
            }

            // --- Handle chat messages ---
            if (data.type === "chat") {
                const clientData = clients.get(ws);
                if (!clientData) {
                    ws.send(JSON.stringify({ type: "error", msg: "No autenticado." }));
                    return;
                }

                const username = clientData.username;

                // Spam prevention
                if (isSpamming(username)) {
                    ws.send(JSON.stringify({
                        type: "chat",
                        msg: "Estás enviando mensajes demasiado rápido. Espera un momento.",
                        timestamp: Date.now()
                    }));
                    return;
                }

                const msg = (data.msg || "").trim();
                if (!msg) return;

                // Handle /kick command
                if (msg.trim().startsWith("/kick")) {
                    const kickContent = msg.slice(5).trim();
                    if (!kickContent) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Uso: /kick <nombre de usuario> <contraseña>",
                            timestamp: Date.now()
                        }));
                        return;
                    }

                    const lastSpaceIndex = kickContent.lastIndexOf(" ");
                    if (lastSpaceIndex === -1) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Uso: /kick <nombre de usuario> <contraseña>",
                            timestamp: Date.now()
                        }));
                        return;
                    }

                    const targetName = kickContent.slice(0, lastSpaceIndex).trim();
                    const pwd = kickContent.slice(lastSpaceIndex + 1).trim();

                    if (!targetName || !pwd) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Uso: /kick <nombre de usuario> <contraseña>",
                            timestamp: Date.now()
                        }));
                        return;
                    }

                    if (pwd !== ADMIN_PWD) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Contraseña de administrador incorrecta.",
                            timestamp: Date.now()
                        }));
                        return;
                    }

                    let targetClient = null;
                    for (const [client, data] of clients.entries()) {
                        if (data.username === targetName) {
                            targetClient = client;
                            break;
                        }
                    }

                    if (!targetClient) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: `Usuario [${targetName}] no encontrado.`,
                            timestamp: Date.now()
                        }));
                        return;
                    }

                    try { targetClient.terminate(); } catch (e) { console.error(e); }
                    const kickedDeviceId = clients.get(targetClient)?.deviceId;
                    if (kickedDeviceId) devices.delete(kickedDeviceId);
                    clients.delete(targetClient);
                    broadcast(`El administrador [${username}] expulsó a [${targetName}] del chat.`, Date.now());
                    return;
                }

                // Normal message
                if (!msg.startsWith("/")) {
                    broadcast(`[${username}]: ${msg}`, Date.now());
                }
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on("close", () => {
        const clientData = clients.get(ws);
        if (!clientData) return;

        const { username, deviceId } = clientData;
        
        // Clean up
        devices.delete(deviceId);
        clients.delete(ws);
        rateLimits.delete(username);
        
        // Broadcast leave message
        if (username) {
            broadcast(`[${username}] ha salido del chat.`, Date.now());
        }
    });
});

// ----- Broadcast Helper -----
function broadcast(msg, timestamp) {
    messageHistory.push({ msg, timestamp });
    if (messageHistory.length > MAX_HISTORY) {
        messageHistory.shift();
    }

    for (const client of clients.keys()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "chat", msg, timestamp }));
        }
    }
}

// ----- Spam Prevention -----
const MAX_MESSAGES = 5;
const TIME_WINDOW = 10 * 1000;
const MUTE_DURATION = 15 * 1000;

function isSpamming(username) {
    const now = Date.now();
    if (!rateLimits.has(username)) {
        rateLimits.set(username, { count: 1, last: now, mutedUntil: 0 });
        return false;
    }

    const userData = rateLimits.get(username);
    if (now < userData.mutedUntil) return true;
    if (now - userData.last > TIME_WINDOW) {
        userData.count = 1;
        userData.last = now;
        return false;
    }

    userData.count++;
    if (userData.count > MAX_MESSAGES) {
        userData.mutedUntil = now + MUTE_DURATION;
        return true;
    }

    return false;
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));