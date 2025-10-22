const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PWD = process.env.ADMIN_PWD;

const clients = new Map(); // ws -> username
const rateLimits = new Map(); // username -> spam info
const devices = new Map(); // deviceId -> ws
const anonymousCounts = {}; // baseName -> count
const messageHistory = []; // Store last 100 messages with timestamps
const MAX_HISTORY = 100;
const SERVER_START_TIME = Date.now(); // Track when server started

// --- Static files + disable caching ---
app.use(express.static("public"));
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --- WebSocket handling ---
wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "prompt", msg: "Escribe tu nombre de usuario:" }));
    // Send server start time to help detect restarts
    ws.send(JSON.stringify({ type: "serverInfo", startTime: SERVER_START_TIME }));

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            // --- Handle username setup ---
            if (data.type === "username") {
                let { msg: requestedName, deviceId } = data;
                requestedName = (requestedName || "anon").trim();

                // Check for device reuse
                if (!deviceId) {
                    ws.send(JSON.stringify({ type: "chat", msg: "Error: dispositivo no identificado." }));
                    ws.close();
                    return;
                }

                // If device already has a connection, close the old one and allow reconnection
                if (devices.has(deviceId)) {
                    const oldWs = devices.get(deviceId);
                    const oldName = clients.get(oldWs);
                    
                    // Clean up old connection
                    clients.delete(oldWs);
                    devices.delete(deviceId);
                    rateLimits.delete(oldName);
                    
                    try {
                        oldWs.close();
                    } catch (e) {
                        console.error("Error closing old connection:", e);
                    }
                    
                    // Notify other users about the disconnection
                    if (oldName) {
                        broadcast(`[${oldName}] ha salido del chat.`, Date.now());
                    }
                }

                // Ensure unique username
                let finalName = requestedName;

                if (!requestedName || requestedName.toLowerCase().startsWith("anon")) {
                    // Handle anonymous numbering
                    const base = "anon";
                    const count = anonymousCounts[base] || 0;
                    finalName = count === 0 ? base : `${base}-${count}`;
                    anonymousCounts[base] = count + 1;
                } else {
                    // Prevent duplicate custom names
                    let suffix = 1;
                    while ([...clients.values()].includes(finalName)) {
                        finalName = `${requestedName}-${suffix}`;
                        suffix++;
                    }
                }

                clients.set(ws, finalName);
                devices.set(deviceId, ws);
                
                // Send chat history to the new client
                if (messageHistory.length > 0) {
                    ws.send(JSON.stringify({ 
                        type: "history", 
                        messages: messageHistory 
                    }));
                }
                
                broadcast(`[${finalName}] se ha unido al chat.`, Date.now());
                return;
            }

            // --- Handle ping (version check) ---
            if (data.type === "ping") {
                ws.send(JSON.stringify({ type: "serverInfo", startTime: SERVER_START_TIME }));
                return;
            }

            // --- Handle chat messages ---
            if (data.type === "chat") {
                const username = clients.get(ws) || "anónimo";

                // --- Spam Prevention ---
                if (isSpamming(username)) {
                    ws.send(JSON.stringify({
                        type: "chat",
                        msg: "Estás enviando mensajes demasiado rápido. Espera un momento.",
                    }));
                    return;
                }

                const msg = (data.msg || "").trim();
                if (!msg) return;

                // --- Handle /kick command ---
                if (msg.trim().startsWith("/kick")) {
                    const kickContent = msg.slice(5).trim(); // remove "/kick"
                    if (!kickContent) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Uso: /kick <nombre de usuario> <contraseña>",
                        }));
                        return;
                    }

                    const lastSpaceIndex = kickContent.lastIndexOf(" ");
                    if (lastSpaceIndex === -1) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Uso: /kick <nombre de usuario> <contraseña>",
                        }));
                        return;
                    }

                    const targetName = kickContent.slice(0, lastSpaceIndex).trim();
                    const pwd = kickContent.slice(lastSpaceIndex + 1).trim();

                    if (!targetName || !pwd) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Uso: /kick <nombre de usuario> <contraseña>",
                        }));
                        return;
                    }

                    if (pwd !== ADMIN_PWD) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: "Contraseña de administrador incorrecta.",
                        }));
                        return;
                    }

                    let targetClient = null;
                    for (const [client, name] of clients.entries()) {
                        if (name === targetName) {
                            targetClient = client;
                            break;
                        }
                    }

                    if (!targetClient) {
                        ws.send(JSON.stringify({
                            type: "chat",
                            msg: `Usuario [${targetName}] no encontrado.`,
                        }));
                        return;
                    }

                    try { targetClient.terminate(); } catch (e) { console.error(e); }
                    clients.delete(targetClient);
                    broadcast(`El administrador [${username}] expulsó a [${targetName}] del chat.`, Date.now());
                    return;
                }

                // --- Normal Message ---
                if (!msg.startsWith("/")) {
                    broadcast(`[${username}]: ${msg}`, Date.now());
                }
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on("close", () => {
        const name = clients.get(ws);
        // Remove device mapping
        for (const [deviceId, clientWs] of devices.entries()) {
            if (clientWs === ws) devices.delete(deviceId);
        }
        if (name) broadcast(`[${name}] ha salido del chat.`, Date.now());
        clients.delete(ws);
        rateLimits.delete(name);
    });
});

// ----- Broadcast Helper -----
function broadcast(msg, timestamp) {
    // Add message to history with timestamp
    messageHistory.push({ msg, timestamp });
    
    // Keep only last MAX_HISTORY messages
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
        rateLimits.set(username, userData);
        return false;
    }

    userData.count++;
    if (userData.count > MAX_MESSAGES) {
        userData.mutedUntil = now + MUTE_DURATION;
        rateLimits.set(username, userData);
        return true;
    }

    rateLimits.set(username, userData);
    return false;
}

// ----- Broadcast Reload Helper -----
function broadcastReload() {
    for (const client of clients.keys()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "reload" }));
        }
    }
}

// Note: Reload detection now works via client-side version checking
// Clients detect server restarts by comparing SERVER_START_TIME

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
