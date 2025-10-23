const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PWD = process.env.ADMIN_PWD;

// Data structures
const clients = new Map(); // ws -> { username, deviceId, authenticated }
const deviceConnections = new Map(); // deviceId -> ws (only one connection per device)
const usernames = new Set(); // Track all active usernames
const messageHistory = []; // Store last 100 messages with timestamps
const rateLimits = new Map(); // username -> { count, lastReset, mutedUntil }

const MAX_HISTORY = 100;
const SERVER_START_TIME = Date.now();

// --- CORS ---
app.use((req, res, next) => {
  const allowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://xwalfie-smr.github.io",
    "https://chat-cp1p.onrender.com",
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  next();
});

// --- Disable caching ---
app.use((req, res, next) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  next();
});

// --- Static files ---
app.use(express.static("docs"));

// --- Health check endpoint ---
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --- Helper Functions ---

function generateUniqueUsername(requestedName) {
  let baseName = requestedName.trim() || "anon";

  // If name is available, use it
  if (!usernames.has(baseName)) {
    return baseName;
  }

  // Otherwise append number
  let counter = 1;
  let uniqueName = `${baseName}-${counter}`;
  while (usernames.has(uniqueName)) {
    counter++;
    uniqueName = `${baseName}-${counter}`;
  }

  return uniqueName;
}

function broadcast(msg, timestamp = Date.now(), excludeWs = null) {
  // Add to history
  messageHistory.push({ msg, timestamp });
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }

  // Send to all authenticated clients
  for (const [ws, clientData] of clients.entries()) {
    if (
      ws !== excludeWs &&
      clientData.authenticated &&
      ws.readyState === WebSocket.OPEN
    ) {
      try {
        ws.send(JSON.stringify({ type: "chat", msg, timestamp }));
      } catch (err) {
        console.error("Error broadcasting to client:", err);
      }
    }
  }
}

function sendToClient(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type, ...data }));
    } catch (err) {
      console.error("Error sending to client:", err);
    }
  }
}

// ----- Spam Prevention -----
const MAX_MESSAGES = 5;
const TIME_WINDOW = 10 * 1000; // 10 seconds
const MUTE_DURATION = 15 * 1000; // 15 seconds

function isSpamming(username) {
  const now = Date.now();

  if (!rateLimits.has(username)) {
    rateLimits.set(username, { count: 1, lastReset: now, mutedUntil: 0 });
    return false;
  }

  const userData = rateLimits.get(username);

  // Check if still muted
  if (now < userData.mutedUntil) {
    return true;
  }

  // Reset count if time window passed
  if (now - userData.lastReset > TIME_WINDOW) {
    userData.count = 1;
    userData.lastReset = now;
    userData.mutedUntil = 0;
    return false;
  }

  // Increment count
  userData.count++;

  // Check if exceeded limit
  if (userData.count > MAX_MESSAGES) {
    userData.mutedUntil = now + MUTE_DURATION;
    return true;
  }

  return false;
}

// Fix: Ensure proper cleanup and reconnection handling
function cleanupClient(ws, silent = false) {
  const clientData = clients.get(ws);
  if (!clientData) return null;

  const { username, deviceId } = clientData;

  // Remove from tracking
  clients.delete(ws);
  if (deviceId && deviceConnections.get(deviceId) === ws) {
    deviceConnections.delete(deviceId);
  }
  if (username) {
    usernames.delete(username);
    rateLimits.delete(username);
  }

  return { username, silent };
}

// --- WebSocket handling ---
wss.on("connection", (ws) => {
  // Initialize client data
  clients.set(ws, {
    username: null,
    deviceId: null,
    authenticated: false,
  });

  // Send initial prompts
  sendToClient(ws, "prompt", {});
  sendToClient(ws, "serverInfo", { startTime: SERVER_START_TIME });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      const clientData = clients.get(ws);

      if (!clientData) {
        ws.close();
        return;
      }

      // --- Handle username setup ---
      if (data.type === "username") {
        const requestedName = data.msg;
        const deviceId = data.deviceId;
        const isReady = data.ready;

        if (!deviceId) {
          sendToClient(ws, "error", { msg: "Dispositivo no identificado." });
          ws.close();
          return;
        }

        // Check if this device already has a connection
        const existingWs = deviceConnections.get(deviceId);
        if (
          existingWs &&
          existingWs !== ws &&
          existingWs.readyState === WebSocket.OPEN
        ) {
          const oldData = clients.get(existingWs);
          if (oldData) {
            // Remove old username from usernames set
            if (oldData.username) {
              usernames.delete(oldData.username);
            }
            cleanupClient(existingWs, true);
          }
          try {
            existingWs.close();
          } catch (e) {
            console.error("Error closing old connection:", e);
          }
        }

        // If deviceId already exists, reuse username and suppress join broadcast
        let finalName;
        if (existingWs && clients.get(existingWs)?.username) {
          finalName = clients.get(existingWs).username;
        } else {
          finalName = generateUniqueUsername(requestedName);
        }

        // Update client data
        clientData.username = finalName;
        clientData.deviceId = deviceId;
        clientData.authenticated = true;
        usernames.add(finalName);
        deviceConnections.set(deviceId, ws);

        sendToClient(ws, "authenticated", { username: finalName });
        sendToClient(ws, "history", { messages: messageHistory });

        // Only broadcast join if this is a new username
        if (!existingWs && isReady !== false) {
          broadcast(`[${finalName}] se ha unido al chat.`);
        }

        return;
      }

      // --- Handle ping ---
      if (data.type === "ping") {
        sendToClient(ws, "serverInfo", { startTime: SERVER_START_TIME });
        return;
      }

      // --- Require authentication for other actions ---
      if (!clientData.authenticated) {
        sendToClient(ws, "error", { msg: "No autenticado." });
        return;
      }

      // --- Handle chat messages ---
      if (data.type === "chat") {
        const username = clientData.username;
        const msg = (data.msg || "").trim();

        if (!msg) return;

        // Check spam
        if (isSpamming(username)) {
          sendToClient(ws, "chat", {
            msg: "Estás enviando mensajes demasiado rápido. Espera un momento.",
            timestamp: Date.now(),
          });
          return;
        }

        broadcast(`[${username}]: ${msg}`);
      }
    } catch (err) {
      console.error("Error processing message:", err);
      sendToClient(ws, "error", { msg: "Error procesando mensaje." });
    }
  });

  ws.on("close", () => {
    const result = cleanupClient(ws);
    if (result && result.username && !result.silent) {
      broadcast(`[${result.username}] ha salido del chat.`);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    cleanupClient(ws, true);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Server start time: ${new Date(SERVER_START_TIME).toISOString()}`
  );
});
