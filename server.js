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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
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

function broadcast(msg, timestamp = Date.now()) {
  // Add to history
  messageHistory.push({ msg, timestamp });
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }

  // Send to all authenticated clients
  for (const [ws, clientData] of clients.entries()) {
    if (clientData.authenticated && ws.readyState === WebSocket.OPEN) {
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

function cleanupClient(ws) {
  const clientData = clients.get(ws);
  if (!clientData) return null;

  const { username } = clientData;
  
  // Remove from tracking
  clients.delete(ws);
  if (username) {
    usernames.delete(username);
    rateLimits.delete(username);
  }
  
  return username;
}

// --- WebSocket handling ---
wss.on("connection", (ws) => {
  // Initialize client data
  clients.set(ws, {
    username: null,
    deviceId: null,
    authenticated: false
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
        const oldUsername = data.oldUsername;

        // Validate deviceId
        if (!deviceId) {
          sendToClient(ws, "error", { msg: "Dispositivo no identificado." });
          ws.close();
          return;
        }

        // Check if changing username
        if (oldUsername && clientData.authenticated) {
          usernames.delete(oldUsername);
        }

        // Generate unique username
        const finalName = generateUniqueUsername(requestedName);

        // Update client data
        clientData.username = finalName;
        clientData.deviceId = deviceId;
        clientData.authenticated = true;
        usernames.add(finalName);

        // Send authentication confirmation
        sendToClient(ws, "authenticated", { username: finalName });

        // Send history
        sendToClient(ws, "history", { messages: messageHistory });

        // Broadcast join/change message
        if (oldUsername) {
          broadcast(`[${oldUsername}] ahora es conocido como [${finalName}].`);
        } else {
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
            timestamp: Date.now()
          });
          return;
        }

        // Handle /kick command
        if (msg.startsWith("/kick ")) {
          const kickContent = msg.slice(6).trim();
          const lastSpaceIndex = kickContent.lastIndexOf(" ");

          if (lastSpaceIndex === -1) {
            sendToClient(ws, "chat", {
              msg: "Uso: /kick <nombre de usuario> <contraseña>",
              timestamp: Date.now()
            });
            return;
          }

          const targetName = kickContent.slice(0, lastSpaceIndex).trim();
          const pwd = kickContent.slice(lastSpaceIndex + 1).trim();

          if (!targetName || !pwd) {
            sendToClient(ws, "chat", {
              msg: "Uso: /kick <nombre de usuario> <contraseña>",
              timestamp: Date.now()
            });
            return;
          }

          if (pwd !== ADMIN_PWD) {
            sendToClient(ws, "chat", {
              msg: "Contraseña de administrador incorrecta.",
              timestamp: Date.now()
            });
            return;
          }

          // Find target client
          let targetWs = null;
          for (const [client, data] of clients.entries()) {
            if (data.username === targetName && data.authenticated) {
              targetWs = client;
              break;
            }
          }

          if (!targetWs) {
            sendToClient(ws, "chat", {
              msg: `Usuario [${targetName}] no encontrado.`,
              timestamp: Date.now()
            });
            return;
          }

          // Kick the user
          cleanupClient(targetWs);
          targetWs.close();
          broadcast(`El administrador [${username}] expulsó a [${targetName}] del chat.`);
          return;
        }

        // Send normal message
        broadcast(`[${username}]: ${msg}`);
      }
    } catch (err) {
      console.error("Error processing message:", err);
      sendToClient(ws, "error", { msg: "Error procesando mensaje." });
    }
  });

  ws.on("close", () => {
    const username = cleanupClient(ws);
    if (username) {
      broadcast(`[${username}] ha salido del chat.`);
    }
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    cleanupClient(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Server start time: ${new Date(SERVER_START_TIME).toISOString()}`);
});