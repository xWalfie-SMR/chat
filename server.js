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
const deviceConnections = new Map(); // deviceId -> { ws, username, color }
const usernames = new Set(); // Track all active usernames
const messageHistory = []; // Store last 100 messages with timestamps
const rateLimits = new Map(); // username -> { count, lastReset, mutedUntil }
const disconnectTimeouts = new Map(); // deviceId -> timeoutId
const bannedDevices = new Set(); // deviceIds that are banned

const MAX_HISTORY = 100;
const SERVER_START_TIME = Date.now();
const DISCONNECT_GRACE_PERIOD = 5000; // 5 seconds

// Color assignment
const COLORS = ['color0', 'color1', 'color2', 'color3', 'color4', 'color5'];
let colorIndex = 0;

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

function validateUsername(name) {
  // Remove spaces and validate
  const cleaned = name.trim();
  
  // Check for spaces
  if (cleaned.includes(' ')) {
    return null;
  }
  
  // Check length
  if (cleaned.length === 0 || cleaned.length > 20) {
    return null;
  }
  
  return cleaned;
}

function getColorForDevice(deviceId) {
  const device = deviceConnections.get(deviceId);
  if (device && device.color) {
    return device.color;
  }
  // Assign new color
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return color;
}

function generateUniqueUsername(requestedName) {
  let baseName = validateUsername(requestedName || "anon");
  
  if (!baseName) {
    baseName = "anon";
  }

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

function broadcast(msg, timestamp = Date.now(), excludeWs = null, includeColors = false) {
  // Add to history
  const historyEntry = { msg, timestamp };
  if (includeColors) historyEntry.colors = includeColors;
  messageHistory.push(historyEntry);
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
        const payload = { type: "chat", msg, timestamp };
        if (includeColors) payload.colors = includeColors;
        ws.send(JSON.stringify(payload));
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

// Admin command handlers
function kickUser(targetUsername, adminWs) {
  let found = false;
  
  for (const [ws, clientData] of clients.entries()) {
    if (clientData.username === targetUsername) {
      found = true;
      sendToClient(ws, "kicked", { reason: "Expulsado por un administrador" });
      
      // Clean up immediately
      const deviceId = clientData.deviceId;
      if (deviceId) {
        bannedDevices.add(deviceId);
        // Remove ban after 5 minutes
        setTimeout(() => bannedDevices.delete(deviceId), 5 * 60 * 1000);
      }
      
      cleanupClient(ws, true);
      ws.close();
      
      broadcast(`[ADMIN] ${targetUsername} ha sido expulsado del chat.`);
      console.log(`Admin kicked user: ${targetUsername}`);
      break;
    }
  }
  
  if (!found) {
    sendToClient(adminWs, "chat", {
      msg: `Usuario "${targetUsername}" no encontrado.`,
      timestamp: Date.now()
    });
  }
}

function removeMessages(targetUsername, adminWs) {
  if (targetUsername.toLowerCase() === "all") {
    // Clear all messages
    messageHistory.length = 0;
    broadcast("[ADMIN] Todos los mensajes han sido eliminados.");
    console.log("Admin cleared all messages");
  } else {
    // Remove messages from specific user
    const originalCount = messageHistory.length;
    const pattern = new RegExp(`^\\[${targetUsername}\\]`);
    
    for (let i = messageHistory.length - 1; i >= 0; i--) {
      if (pattern.test(messageHistory[i].msg)) {
        messageHistory.splice(i, 1);
      }
    }
    
    const removed = originalCount - messageHistory.length;
    if (removed > 0) {
      broadcast(`[ADMIN] ${removed} mensajes de ${targetUsername} han sido eliminados.`);
      console.log(`Admin removed ${removed} messages from ${targetUsername}`);
    } else {
      sendToClient(adminWs, "chat", {
        msg: `No se encontraron mensajes de "${targetUsername}".`,
        timestamp: Date.now()
      });
    }
  }
}

function processAdminCommand(msg, ws) {
  const clientData = clients.get(ws);
  if (!clientData) return false;

  // Check for /kick command
  const kickMatch = msg.match(/^\/kick\s+(\S+)\s+(.+)$/);
  if (kickMatch) {
    const [, targetUser, password] = kickMatch;
    
    if (password !== ADMIN_PWD) {
      sendToClient(ws, "chat", {
        msg: "Contraseña de administrador incorrecta.",
        timestamp: Date.now()
      });
      return true;
    }
    
    kickUser(targetUser, ws);
    return true;
  }

  // Check for /removeuser command
  const removeMatch = msg.match(/^\/removeuser\s+(\S+)\s+(.+)$/);
  if (removeMatch) {
    const [, targetUser, password] = removeMatch;
    
    if (password !== ADMIN_PWD) {
      sendToClient(ws, "chat", {
        msg: "Contraseña de administrador incorrecta.",
        timestamp: Date.now()
      });
      return true;
    }
    
    removeMessages(targetUser, ws);
    return true;
  }

  return false;
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

// Cleanup client connection with grace period
function cleanupClient(ws, immediate = false) {
  const clientData = clients.get(ws);
  if (!clientData) return null;

  const { username, deviceId } = clientData;

  // Remove from active clients
  clients.delete(ws);

  if (!deviceId) {
    return { username, announced: false };
  }

  // Cancel any existing disconnect timeout
  if (disconnectTimeouts.has(deviceId)) {
    clearTimeout(disconnectTimeouts.get(deviceId));
    disconnectTimeouts.delete(deviceId);
  }

  if (immediate) {
    // Immediate cleanup (logout button pressed or kicked)
    if (deviceConnections.get(deviceId)?.ws === ws) {
      deviceConnections.delete(deviceId);
      if (username) {
        usernames.delete(username);
        rateLimits.delete(username);
      }
    }
    return { username, announced: true };
  } else {
    // Grace period cleanup
    const timeoutId = setTimeout(() => {
      disconnectTimeouts.delete(deviceId);
      
      // Check if still disconnected
      const device = deviceConnections.get(deviceId);
      if (!device || device.ws === ws || device.ws.readyState !== WebSocket.OPEN) {
        // User didn't reconnect, announce departure
        deviceConnections.delete(deviceId);
        if (username) {
          usernames.delete(username);
          rateLimits.delete(username);
          broadcast(`[${username}] ha salido del chat.`);
        }
      }
    }, DISCONNECT_GRACE_PERIOD);

    disconnectTimeouts.set(deviceId, timeoutId);
    return { username, announced: false };
  }
}

// Get color mapping for all active users
function getActiveColors() {
  const colors = {};
  for (const [deviceId, device] of deviceConnections.entries()) {
    if (device.username && device.color) {
      colors[device.username] = device.color;
    }
  }
  return colors;
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

        // Check if device is banned
        if (bannedDevices.has(deviceId)) {
          sendToClient(ws, "kicked", { reason: "Estás temporalmente baneado." });
          ws.close();
          return;
        }

        // Cancel any pending disconnect timeout
        if (disconnectTimeouts.has(deviceId)) {
          clearTimeout(disconnectTimeouts.get(deviceId));
          disconnectTimeouts.delete(deviceId);
          console.log(`Cancelled disconnect timeout for device ${deviceId}`);
        }

        // Check for existing connection from this device
        const existingDevice = deviceConnections.get(deviceId);
        let finalName;
        let isNewUser = true;
        let color;

        if (existingDevice) {
          // Device exists
          if (existingDevice.ws !== ws && existingDevice.ws.readyState === WebSocket.OPEN) {
            // Close old connection
            try {
              sendToClient(existingDevice.ws, "replaced", {});
              existingDevice.ws.close();
            } catch (e) {
              console.error("Error closing old connection:", e);
            }
          }
          
          // Reuse username and color for reconnection
          if (isReconnect && existingDevice.username) {
            finalName = existingDevice.username;
            color = existingDevice.color;
            isNewUser = false;
            console.log(`User ${finalName} reconnected within grace period`);
          } else {
            color = existingDevice.color || getColorForDevice(deviceId);
          }
        } else {
          // New device
          color = getColorForDevice(deviceId);
        }

        // Generate new username if needed
        if (!finalName) {
          // If changing username, free up the old one first
          if (clientData.username) {
            usernames.delete(clientData.username);
          }
          
          // Validate and generate username
          const validatedName = validateUsername(requestedName || "anon");
          if (!validatedName) {
            sendToClient(ws, "error", { 
              msg: "Nombre de usuario inválido. No se permiten espacios." 
            });
            sendToClient(ws, "invalidUsername", {});
            return;
          }
          
          finalName = generateUniqueUsername(validatedName);
        }

        // Update all tracking
        usernames.add(finalName);
        clientData.username = finalName;
        clientData.deviceId = deviceId;
        clientData.authenticated = true;
        deviceConnections.set(deviceId, { ws, username: finalName, color });

        // Send authentication success with color info
        sendToClient(ws, "authenticated", { 
          username: finalName,
          color: color,
          serverStartTime: SERVER_START_TIME 
        });

        // Send chat history with color mappings
        const activeColors = getActiveColors();
        sendToClient(ws, "history", { 
          messages: messageHistory,
          colors: activeColors 
        });

        // Broadcast join message only for truly new users
        if (isNewUser && !isReconnect) {
          broadcast(`[${finalName}] se ha unido al chat.`, Date.now(), null, getActiveColors());
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
        const deviceId = clientData.deviceId;

        // Validate new username
        const validatedName = validateUsername(newUsername);
        if (!validatedName) {
          sendToClient(ws, "error", { 
            msg: "Nombre de usuario inválido. No se permiten espacios." 
          });
          return;
        }

        // Free old username
        if (oldUsername) {
          usernames.delete(oldUsername);
        }

        // Generate unique username
        const finalName = generateUniqueUsername(validatedName);
        
        // Update tracking (keep same color!)
        usernames.add(finalName);
        clientData.username = finalName;
        
        // Update device connection with same color
        if (deviceId) {
          const device = deviceConnections.get(deviceId);
          if (device) {
            device.username = finalName;
            // Keep the same color!
          }
        }

        // Notify client with their color
        sendToClient(ws, "usernameChanged", { 
          username: finalName,
          oldUsername: oldUsername,
          color: deviceConnections.get(deviceId)?.color
        });

        // Broadcast the change with updated colors
        broadcast(`[${oldUsername}] ahora es [${finalName}]`, Date.now(), null, getActiveColors());
        
        return;
      }

      // --- Handle logout ---
      if (data.type === "logout") {
        const username = clientData.username;
        cleanupClient(ws, true); // Immediate cleanup
        if (username) {
          broadcast(`[${username}] ha salido del chat.`);
        }
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

        // Check for admin commands
        if (msg.startsWith("/")) {
          if (processAdminCommand(msg, ws)) {
            return;
          }
        }

        // Check spam
        if (isSpamming(username)) {
          sendToClient(ws, "chat", {
            msg: "Estás enviando mensajes demasiado rápido. Espera un momento.",
            timestamp: Date.now(),
          });
          return;
        }

        broadcast(`[${username}]: ${msg}`, Date.now(), null, getActiveColors());
      }
    } catch (err) {
      console.error("Error processing message:", err);
      sendToClient(ws, "error", { msg: "Error procesando mensaje." });
    }
  });

  ws.on("close", () => {
    const result = cleanupClient(ws, false); // Use grace period
    console.log(`WebSocket closed. Username: ${result?.username}, Announced: ${result?.announced}`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    cleanupClient(ws, false); // Use grace period
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Server start time: ${new Date(SERVER_START_TIME).toISOString()}`
  );
  console.log("Admin commands enabled:", ADMIN_PWD ? "YES" : "NO");
});