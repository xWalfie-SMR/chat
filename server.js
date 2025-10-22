const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

const clients = new Map();

app.use(express.static("public"));

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "prompt", msg: "Enter username:" }));

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === "username") {
        clients.set(ws, data.msg || "anon");
        broadcast(`*** ${clients.get(ws)} joined the chat ***`);
      } else if (data.type === "chat") {
        const username = clients.get(ws) || "anon";
        broadcast(`[${username}] ${data.msg}`);
      }
    } catch (e) {
      console.error("Invalid message", e);
    }
  });

  ws.on("close", () => {
    const name = clients.get(ws);
    if (name) broadcast(`*** ${name} left the chat ***`);
    clients.delete(ws);
  });
});

function broadcast(msg) {
  for (const client of clients.keys()) {
    client.send(JSON.stringify({ type: "chat", msg }));
  }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));