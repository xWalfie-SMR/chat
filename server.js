const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

const clients = new Map();
const ADMIN_PWD = process.env.ADMIN_PWD || "NOOB";

app.use(express.static("public"));
app.get("/healthz", (req, res) => {
    res.status(200).send("OK");
});

wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "prompt", msg: "Enter username:" }));

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === "username") {
                clients.set(ws, data.msg || "anon");
                broadcast(`[${clients.get(ws)}] joined the chat.`);
            } else if (data.type === "chat") {
                const username = clients.get(ws) || "anon";

                if (typeof data.msg === "string" && data.msg.startsWith("/admin ")) {
                    const parts = data.msg.split(/\s+/);
                    const targetName = parts[1];
                    const pwd = parts[2];

                    if (!targetName || !pwd) {
                        ws.send(
                            JSON.stringify({
                                type: "chat",
                                msg: "Usage: /admin <username> <password>",
                            })
                        );
                        return;
                    }

                    if (pwd !== ADMIN_PWD) {
                        ws.send(
                            JSON.stringify({ type: "chat", msg: "Invalid admin password." })
                        );
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
                        ws.send(
                            JSON.stringify({
                                type: "chat",
                                msg: `User [${targetName}] not found.`,
                            })
                        );
                        return;
                    }

                    try {
                        targetClient.terminate();
                    } catch (e) {
                        console.error(`Failed to remove user [${targetName}].`, e);
                    }

                    clients.delete(targetClient);
                    broadcast(
                        `Admin [${username}] removed user [${targetName}] from the chat.`
                    );
                    return;
                }

                broadcast(`[${username}]: ${data.msg}`);
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    });

    ws.on("close", () => {
        const name = clients.get(ws);
        if (name) broadcast(`[${name}] left the chat.`);
        clients.delete(ws);
    });
});

function broadcast(msg) {
    for (const client of clients.keys()) {
        client.send(JSON.stringify({ type: "chat", msg }));
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
