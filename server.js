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
const deviceConnections = new Map(); // deviceId -> { ws, username }
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

// Cleanup client connection
function cleanupClient(ws, silent = false) {
  const clientData = clients.get(ws);
  if (!clientData) return null;

  const { username, deviceId } = clientData;

  // Remove from tracking
  clients.delete(ws);
  
  // Only fully clean up if this is the active connection for this device
  if (deviceId && deviceConnections.get(deviceId)?.ws === ws) {
    deviceConnections.delete(deviceId);
    if (username) {
      usernames.delete(username);
      rateLimits.delete(username);
    }
  }

  return { username, silent };
}

// --- WebSocket handling ---
wss.on("connection", (ws) => {
  console.log("New WebSocket connection");
  
  // Initialize client data
  clients.set(ws, {
    username: null,
    deviceId: null,
    authenticated: false,
  });

  // Send server info immediately
  sendToClient(ws, "serverInfo", { startTime: SERVER_START_TIME });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      const clientData = clients.get(ws);

      if (!clientData) {
        ws.close();
        return;
      }

      // --- Handle authentication/username ---
      if (data.type === "auth") {
        const { username: requestedName, deviceId, isReconnect } = data;

        if (!deviceId) {
          sendToClient(ws, "error", { msg: "Dispositivo no identificado." });
          ws.close();
          return;
        }

        // Check for existing connection from this device
        const existingDevice = deviceConnections.get(deviceId);
        let finalName;
        let isNewUser = true;

        if (existingDevice && existingDevice.ws !== ws) {
          // Close old connection
          if (existingDevice.ws.readyState === WebSocket.OPEN) {
            try {
              sendToClient(existingDevice.ws, "replaced", {});
              existingDevice.ws.close();
            } catch (e) {
              console.error("Error closing old connection:", e);
            }
          }
          
          // Reuse the same username if reconnecting
          if (isReconnect && existingDevice.username) {
            finalName = existingDevice.username;
            isNewUser = false;
          }
        }

        // Generate new username if needed
        if (!finalName) {
          // If changing username, free up the old one first
          if (clientData.username) {
            usernames.delete(clientData.username);
          }
          finalName = generateUniqueUsername(requestedName);
        }

        // Update all tracking
        usernames.add(finalName);
        clientData.username = finalName;
        clientData.deviceId = deviceId;
        clientData.authenticated = true;
        deviceConnections.set(deviceId, { ws, username: finalName });

        // Send authentication success
        sendToClient(ws, "authenticated", { 
          username: finalName,
          serverStartTime: SERVER_START_TIME 
        });

        // Send chat history
        sendToClient(ws, "history", { messages: messageHistory });

        // Broadcast join message only for new users
        if (isNewUser && !isReconnect) {
          broadcast(`[${finalName}] se ha unido al chat.`);
        }

        return;
      }

      // --- Handle username change ---
      if (data.type === "changeUsername") {
        if (!clientData.authenticated) {
          sendToClient(ws, "error", { msg: "No autenticado." });
          return;
        }

        const { newUsername } = data;
        const oldUsername = clientData.username;

        // Free old username
        if (oldUsername) {
          usernames.delete(oldUsername);
        }

        // Generate unique username
        const finalName = generateUniqueUsername(newUsername);
        
        // Update tracking
        usernames.add(finalName);
        clientData.username = finalName;
        
        // Update device connection
        if (clientData.deviceId) {
          deviceConnections.set(clientData.deviceId, { ws, username: finalName });
        }

        // Notify client
        sendToClient(ws, "usernameChanged", { 
          username: finalName,
          oldUsername: oldUsername 
        });

        // Broadcast the change
        broadcast(`[${oldUsername}] ahora es [${finalName}]`);
        
        return;
      }

      // --- Handle ping ---
      if (data.type === "ping") {
        sendToClient(ws, "pong", { serverStartTime: SERVER_START_TIME });
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
      // Only announce departure if this was the active connection
      const deviceId = clients.get(ws)?.deviceId;
      if (!deviceId || !deviceConnections.has(deviceId)) {
        broadcast(`[${result.username}] ha salido del chat.`);
      }
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