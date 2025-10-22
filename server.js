const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PWD = process.env.ADMIN_PWD;

const clients = new Map();
const rateLimits = new Map();

app.use(express.static("public"));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

app.get("/healthz", (req, res) => {
    res.status(200).send("OK");
});

wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "prompt", msg: "Escribe tu nombre de usuario:" }));

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            // --- Handle username setup ---
            if (data.type === "username") {
                const username = (data.msg || "anónimo").trim();
                clients.set(ws, username);
                broadcast(`[${username}] se ha unido al chat.`);
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

                    try {
                        targetClient.terminate();
                    } catch (e) {
                        console.error(`Failed to remove user [${targetName}].`, e);
                    }

                    clients.delete(targetClient);
                    broadcast(`El administrador [${username}] expulsó a [${targetName}] del chat.`);
                    return;
                }

                // --- Normal Message ---
                if (!msg.startsWith("/")) {
                    broadcast(`[${username}]: ${msg}`);
                }
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on("close", () => {
        const name = clients.get(ws);
        if (name) broadcast(`[${name}] ha salido del chat.`);
        clients.delete(ws);
        rateLimits.delete(name);
    });
});

// ----- Broadcast Helper -----
function broadcast(msg) {
    for (const client of clients.keys()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "chat", msg }));
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

// Send reload notice after server boots
setTimeout(() => {
    console.log("Broadcasting reload to clients...");
    broadcastReload();
}, 1000);

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));