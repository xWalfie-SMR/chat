const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PWD = process.env.ADMIN_PWD;

// --- COLOR CONSTANTS ---
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

// --- DATA STRUCTURES ---
const clients = new Map(); // ws -> { username, deviceId, authenticated, terminalMode }
const deviceToUsername = new Map(); // deviceId -> username (for reconnection)
const activeUsernames = new Set(); // Currently active usernames
const disconnectionTimeouts = new Map(); // deviceId -> { timeout, username, timestamp }
const messageHistory = [];
const rateLimits = new Map();
const bannedDevices = new Map(); // deviceId -> { expiresAt, username }

const MAX_HISTORY = 100;
const SERVER_START_TIME = Date.now();
const MAX_USERNAME_LENGTH = 20;
const RECONNECT_GRACE_PERIOD = 10 * 1000; // 10 seconds

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
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
  next();
});

// --- JSON parsing ---
app.use(express.json());

// --- STATIC FILES ---
app.use(express.static("docs"));

// --- HEALTH CHECK ---
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --- HELPER FUNCTIONS ---

function sanitizeUsername(username) {
  // Remove spaces, special characters, keep only alphanumeric and underscores
  const sanitized = username.replace(/[^a-zA-Z0-9_]/g, "");

  // Ensure it's not empty and has reasonable length
  if (sanitized.length === 0) {
    return "anon";
  }

  if (sanitized.length > MAX_USERNAME_LENGTH) {
    return sanitized.substring(0, MAX_USERNAME_LENGTH);
  }

  return sanitized;
}

function getUserColor(username) {
  // Simple hash to assign consistent colors to usernames
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }

  const userColors = [
    colors.red,
    colors.green,
    colors.yellow,
    colors.blue,
    colors.magenta,
    colors.cyan,
  ];
  return userColors[Math.abs(hash) % userColors.length];
}

function formatMessageForTerminal(msg) {
  // Parse [username] message format and add colors
  const match = msg.match(/^\[(.+?)\] (.*)$/);
  if (match) {
    const username = match[1];
    const message = match[2];
    const userColor = getUserColor(username);
    return `${userColor}[${username}]${colors.reset} ${message}`;
  }

  // System messages (join/leave/kick) - use gray
  if (
    msg.includes("se ha unido") ||
    msg.includes("ha salido") ||
    msg.includes("expulsado") ||
    msg.includes("ahora es")
  ) {
    return `${colors.gray}${msg}${colors.reset}`;
  }

  return msg;
}

function isUsernameAvailable(username) {
  return !activeUsernames.has(username);
}

function generateUniqueUsername(requestedName) {
  const baseName = sanitizeUsername(requestedName || "anon");

  // If exact name is available, use it
  if (isUsernameAvailable(baseName)) {
    return baseName;
  }

  // Otherwise, append incrementing number
  let counter = 1;
  let candidateName = `${baseName}${counter}`;
  while (!isUsernameAvailable(candidateName)) {
    counter++;
    candidateName = `${baseName}${counter}`;
  }

  return candidateName;
}

function broadcast(msg, timestamp = Date.now(), excludeWs = null) {
  messageHistory.push({ msg, timestamp });
  if (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }

  for (const [ws, clientData] of clients.entries()) {
    if (
      ws !== excludeWs &&
      clientData.authenticated &&
      ws.readyState === WebSocket.OPEN
    ) {
      try {
        if (clientData.terminalMode) {
          ws.send(formatMessageForTerminal(msg));
        } else {
          ws.send(JSON.stringify({ type: "chat", msg, timestamp }));
        }
      } catch (err) {
        console.error("Broadcast error:", err);
      }
    }
  }
}

function sendToClient(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      const clientData = clients.get(ws);

      if (clientData && clientData.terminalMode) {
        // Send formatted text for terminal clients
        if (type === "chat") {
          ws.send(formatMessageForTerminal(data.msg));
        } else if (type === "history") {
          if (data.messages.length > 0) {
            ws.send(`\n${colors.cyan}--- Chat History ---${colors.reset}`);
            data.messages.forEach((msg) =>
              ws.send(formatMessageForTerminal(msg.msg))
            );
            ws.send(`${colors.cyan}--- End of History ---${colors.reset}\n`);
          } else {
            ws.send(
              `${colors.cyan}No chat history yet. Start chatting!${colors.reset}\n`
            );
          }
        } else if (type === "error") {
          ws.send(`${colors.red}Error: ${data.msg}${colors.reset}`);
        }
        // Don't send serverInfo, prompt, etc. to terminal clients
      } else {
        // Send JSON for web clients
        ws.send(JSON.stringify({ type, ...data }));
      }
    } catch (err) {
      console.error("Send error:", err);
    }
  }
}

// --- SPAM PREVENTION ---
const MAX_MESSAGES = 15;
const TIME_WINDOW = 10000;
const MUTE_DURATION = 5000;

function isSpamming(username) {
  const now = Date.now();

  if (!rateLimits.has(username)) {
    rateLimits.set(username, { count: 1, lastReset: now, mutedUntil: 0 });
    return false;
  }

  const userData = rateLimits.get(username);

  if (now < userData.mutedUntil) return true;

  if (now - userData.lastReset > TIME_WINDOW) {
    userData.count = 1;
    userData.lastReset = now;
    userData.mutedUntil = 0;
    return false;
  }

  userData.count++;

  if (userData.count > MAX_MESSAGES) {
    userData.mutedUntil = now + MUTE_DURATION;
    return true;
  }

  return false;
}

// --- DEVICE BAN MANAGEMENT ---
function cleanExpiredBans() {
  const now = Date.now();
  for (const [deviceId, banInfo] of bannedDevices.entries()) {
    if (now >= banInfo.expiresAt) {
      bannedDevices.delete(deviceId);
      console.log(`[BAN EXPIRED] ${deviceId} (${banInfo.username})`);
    }
  }
}

function isDeviceBanned(deviceId) {
  if (!deviceId) return false;
  
  cleanExpiredBans();
  
  if (bannedDevices.has(deviceId)) {
    const banInfo = bannedDevices.get(deviceId);
    const remainingTime = Math.ceil((banInfo.expiresAt - Date.now()) / 1000);
    return { banned: true, remainingTime, username: banInfo.username };
  }
  
  return { banned: false };
}

function banDevice(deviceId, username, durationSeconds) {
  const expiresAt = Date.now() + (durationSeconds * 1000);
  bannedDevices.set(deviceId, { expiresAt, username });
  console.log(`[BANNED] ${deviceId} (${username}) for ${durationSeconds} seconds`);
}

// --- CLEANUP WITH GRACE PERIOD ---
function scheduleCleanup(ws) {
  const clientData = clients.get(ws);
  if (!clientData) return;

  const { username, deviceId } = clientData;

  // Remove from clients map immediately
  clients.delete(ws);

  if (!deviceId || !username) return;

  console.log(
    `[GRACE] Scheduling cleanup for ${username} (${deviceId}) - ${RECONNECT_GRACE_PERIOD / 1000}s grace period`
  );

  // Cancel any existing timeout for this device
  if (disconnectionTimeouts.has(deviceId)) {
    clearTimeout(disconnectionTimeouts.get(deviceId).timeout);
  }

  // Schedule cleanup after grace period
  const timeoutId = setTimeout(() => {
    console.log(`[CLEANUP] Grace period expired for ${username} (${deviceId})`);

    // Clean up
    activeUsernames.delete(username);
    deviceToUsername.delete(deviceId);
    rateLimits.delete(username);
    disconnectionTimeouts.delete(deviceId);

    // NOW broadcast departure (after grace period)
    broadcast(`[${username}] ha salido del chat.`);
  }, RECONNECT_GRACE_PERIOD);

  // Store timeout info
  disconnectionTimeouts.set(deviceId, {
    timeout: timeoutId,
    username: username,
    timestamp: Date.now(),
  });
}

function cancelScheduledCleanup(deviceId) {
  if (disconnectionTimeouts.has(deviceId)) {
    const { timeout, username } = disconnectionTimeouts.get(deviceId);
    clearTimeout(timeout);
    disconnectionTimeouts.delete(deviceId);
    console.log(
      `[RECONNECT] Cancelled cleanup for ${username} (${deviceId}) - reconnected in time`
    );
    return true;
  }
  return false;
}

function immediateCleanup(ws) {
  const clientData = clients.get(ws);
  if (!clientData) return null;

  const { username, deviceId } = clientData;

  // Remove from all tracking immediately
  clients.delete(ws);

  if (deviceId) {
    // Cancel any pending cleanup
    if (disconnectionTimeouts.has(deviceId)) {
      clearTimeout(disconnectionTimeouts.get(deviceId).timeout);
      disconnectionTimeouts.delete(deviceId);
    }
    deviceToUsername.delete(deviceId);
  }

  if (username) {
    activeUsernames.delete(username);
    rateLimits.delete(username);
  }

  console.log(`[IMMEDIATE] Cleaned up: ${username} (${deviceId})`);
  return { username, deviceId };
}

// --- WEBSOCKET HANDLING ---
wss.on("connection", (ws) => {
  console.log("New connection");

  clients.set(ws, {
    username: null,
    deviceId: null,
    authenticated: false,
    terminalMode: null, // Will be determined by first message
  });

  // Don't send initial messages yet - wait to determine if terminal or web client
  // Web clients will send JSON auth message first
  // Terminal clients will send plain text username

  ws.on("message", (message) => {
    try {
      const clientData = clients.get(ws);
      if (!clientData) {
        ws.close();
        return;
      }

      const messageStr = message.toString().trim();

      // Determine client mode on first message
      if (clientData.terminalMode === null) {
        if (messageStr.startsWith("{")) {
          // Web client detected
          clientData.terminalMode = false;
          // Send serverInfo to web clients
          sendToClient(ws, "serverInfo", { startTime: SERVER_START_TIME });
        } else {
          // Terminal client detected
          clientData.terminalMode = true;
          // Send welcome messages to terminal clients
          ws.send(`${colors.green}Connected to chat server!${colors.reset}`);
          ws.send(`${colors.cyan}Enter your username: ${colors.reset}`);
        }
      }

      // If JSON is received, process as web client
      if (messageStr.startsWith("{")) {
        clientData.terminalMode = false;

        const data = JSON.parse(messageStr);

        // Handle JSON messages (for web clients)
        if (data.type === "username") {
          const { msg: requestedName, deviceId } = data;

          const finalUsername = generateUniqueUsername(requestedName);

          activeUsernames.add(finalUsername);
          if (deviceId) {
            deviceToUsername.set(deviceId, finalUsername);
          }

          clientData.username = finalUsername;
          clientData.deviceId = deviceId;
          clientData.authenticated = true;

          sendToClient(ws, "history", { messages: messageHistory });
          broadcast(`[${finalUsername}] se ha unido al chat.`);
          return;
        }

        if (data.type === "auth") {
          const { username: requestedName, deviceId, isReconnect } = data;

          if (!deviceId) {
            sendToClient(ws, "error", { msg: "Device ID missing" });
            ws.close();
            return;
          }

          // Check if device is banned
          const banStatus = isDeviceBanned(deviceId);
          if (banStatus.banned) {
            sendToClient(ws, "error", { 
              msg: `Tu dispositivo ha sido expulsado. Podrás volver a entrar en ${banStatus.remainingTime} segundos.` 
            });
            ws.close();
            return;
          }

          let finalUsername;
          let announceJoin = true;
          let isQuickReconnect = false;

          // CHECK 1: Is there a pending disconnection for this device? (Quick reconnect)
          if (cancelScheduledCleanup(deviceId)) {
            // User reconnected before grace period ended
            const previousUsername = deviceToUsername.get(deviceId);
            if (previousUsername && activeUsernames.has(previousUsername)) {
              finalUsername = previousUsername;
              announceJoin = false; // DON'T announce - they never really left
              isQuickReconnect = true;
              console.log(
                `[QUICK RECONNECT] ${finalUsername} (${deviceId}) within grace period`
              );
            }
          }

          // CHECK 2: Does this device have a stored username? (Reconnect after grace period)
          if (!finalUsername && isReconnect && deviceToUsername.has(deviceId)) {
            const previousUsername = deviceToUsername.get(deviceId);

            // Reuse previous username if it's available
            if (isUsernameAvailable(previousUsername)) {
              finalUsername = previousUsername;
              announceJoin = true; // DO announce - they were gone long enough
              console.log(
                `[RECONNECT] ${finalUsername} (${deviceId}) after grace period`
              );
            }
          }

          // CHECK 3: Generate new username for first-time users
          if (!finalUsername) {
            finalUsername = generateUniqueUsername(requestedName);
            announceJoin = true; // DO announce - brand new user
            console.log(`[NEW USER] ${finalUsername} (${deviceId})`);
          }

          // Register username
          activeUsernames.add(finalUsername);
          deviceToUsername.set(deviceId, finalUsername);

          // Update client data
          clientData.username = finalUsername;
          clientData.deviceId = deviceId;
          clientData.authenticated = true;

          // Send authentication success
          sendToClient(ws, "authenticated", {
            username: finalUsername,
            serverStartTime: SERVER_START_TIME,
            isQuickReconnect: isQuickReconnect,
          });

          // Send chat history
          sendToClient(ws, "history", { messages: messageHistory });

          // Announce join ONLY if appropriate
          if (announceJoin) {
            broadcast(`[${finalUsername}] se ha unido al chat.`);
          }

          return;
        }

        if (data.type === "changeUsername") {
          if (!clientData.authenticated) {
            sendToClient(ws, "error", { msg: "Not authenticated" });
            return;
          }

          const { newUsername } = data;
          const oldUsername = clientData.username;

          activeUsernames.delete(oldUsername);
          const finalUsername = generateUniqueUsername(newUsername);
          activeUsernames.add(finalUsername);
          clientData.username = finalUsername;

          if (clientData.deviceId) {
            deviceToUsername.set(clientData.deviceId, finalUsername);
          }

          sendToClient(ws, "usernameChanged", {
            username: finalUsername,
            oldUsername: oldUsername,
          });

          broadcast(`[${oldUsername}] ahora es [${finalUsername}]`);
          console.log(`Username changed: ${oldUsername} -> ${finalUsername}`);
          return;
        }

        if (data.type === "ping") {
          sendToClient(ws, "pong", { serverStartTime: SERVER_START_TIME });
          return;
        }

        if (!clientData.authenticated) {
          sendToClient(ws, "error", { msg: "Not authenticated" });
          return;
        }

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

          // Handle commands
          if (msg.startsWith("/")) {
            if (msg.startsWith("/kick ")) {
              const parts = msg.split(" ");
              if (parts.length < 4) {
                sendToClient(ws, "chat", {
                  msg: "Uso: /kick <usuario> <segundos> <ADMIN_PWD>",
                  timestamp: Date.now(),
                });
                return;
              }

              const targetUser = parts[1];
              const seconds = parseInt(parts[2], 10);
              const pwd = parts[3];

              if (isNaN(seconds) || seconds < 0) {
                sendToClient(ws, "chat", {
                  msg: "El tiempo debe ser un número válido de segundos.",
                  timestamp: Date.now(),
                });
                return;
              }

              if (pwd !== ADMIN_PWD) {
                sendToClient(ws, "chat", {
                  msg: "Contraseña incorrecta.",
                  timestamp: Date.now(),
                });
                return;
              }

              let kicked = false;
              let kickedDeviceId = null;
              for (const [client, data] of clients.entries()) {
                if (data.username === targetUser && data.authenticated) {
                  kickedDeviceId = data.deviceId;
                  immediateCleanup(client);
                  client.close();
                  kicked = true;
                  break;
                }
              }

              if (kicked) {
                if (kickedDeviceId && seconds > 0) {
                  banDevice(kickedDeviceId, targetUser, seconds);
                  broadcast(
                    `[${targetUser}] ha sido expulsado por [${username}] durante ${seconds} segundos.`
                  );
                } else {
                  broadcast(
                    `[${targetUser}] ha sido expulsado por [${username}].`
                  );
                }
              } else {
                sendToClient(ws, "chat", {
                  msg: `Usuario [${targetUser}] no encontrado.`,
                  timestamp: Date.now(),
                });
              }
              return;
            }

            if (msg.startsWith("/removeuser ")) {
              const parts = msg.split(" ");
              if (parts.length < 3) {
                sendToClient(ws, "chat", {
                  msg: "Uso: /removeuser <usuario> <ADMIN_PWD>",
                  timestamp: Date.now(),
                });
                return;
              }

              const targetUser = parts[1];
              const pwd = parts[2];

              if (pwd !== ADMIN_PWD) {
                sendToClient(ws, "chat", {
                  msg: "Contraseña incorrecta.",
                  timestamp: Date.now(),
                });
                return;
              }

              let removed = false;
              for (const [client, data] of clients.entries()) {
                if (data.username === targetUser && data.authenticated) {
                  immediateCleanup(client);
                  client.close();
                  removed = true;
                  break;
                }
              }

              if (removed) {
                broadcast(
                  `[${targetUser}] ha sido removido por [${username}].`
                );
              } else {
                sendToClient(ws, "chat", {
                  msg: `Usuario [${targetUser}] no encontrado.`,
                  timestamp: Date.now(),
                });
              }
              return;
            }

            // Ignore unknown /commands
            return;
          }

          broadcast(`[${username}]: ${msg}`);
          return;
        }
      } else {
        // Handle plain text messages (for terminal clients)

        // Handle username entry
        if (!clientData.authenticated && !clientData.username && messageStr) {
          const sanitizedName = sanitizeUsername(messageStr);
          const finalUsername = generateUniqueUsername(sanitizedName);

          if (sanitizedName !== messageStr) {
            ws.send(
              `${colors.yellow}Username sanitized to: ${finalUsername}${colors.reset}`
            );
          }

          activeUsernames.add(finalUsername);
          clientData.username = finalUsername;
          clientData.authenticated = true;

          ws.send(`${colors.green}Welcome ${finalUsername}!${colors.reset}`);
          sendToClient(ws, "history", { messages: messageHistory });
          broadcast(`[${finalUsername}] se ha unido al chat.`);
          return;
        }

        // Handle chat messages
        if (clientData.authenticated && messageStr) {
          if (isSpamming(clientData.username)) {
            ws.send(
              `${colors.yellow}Estás enviando mensajes demasiado rápido. Espera un momento.${colors.reset}`
            );
            return;
          }

          // Handle admin commands
          if (messageStr.startsWith("/kick")) {
            const parts = messageStr.split(" ");
            if (parts.length < 4) {
              ws.send(
                `${colors.yellow}Uso: /kick <usuario> <segundos> <ADMIN_PWD>${colors.reset}`
              );
              return;
            }

            const targetUser = parts[1];
            const seconds = parseInt(parts[2], 10);
            const pwd = parts[3];

            if (isNaN(seconds) || seconds < 0) {
              ws.send(
                `${colors.red}El tiempo debe ser un número válido de segundos.${colors.reset}`
              );
              return;
            }

            if (pwd !== ADMIN_PWD) {
              ws.send(`${colors.red}Contraseña incorrecta.${colors.reset}`);
              return;
            }

            let kicked = false;
            let kickedDeviceId = null;
            for (const [client, data] of clients.entries()) {
              if (data.username === targetUser && data.authenticated) {
                kickedDeviceId = data.deviceId;
                immediateCleanup(client);
                client.close();
                kicked = true;
                break;
              }
            }

            if (kicked) {
              if (kickedDeviceId && seconds > 0) {
                banDevice(kickedDeviceId, targetUser, seconds);
                broadcast(
                  `[${targetUser}] ha sido expulsado por [${clientData.username}] durante ${seconds} segundos.`
                );
              } else {
                broadcast(
                  `[${targetUser}] ha sido expulsado por [${clientData.username}].`
                );
              }
            } else {
              ws.send(
                `${colors.red}Usuario [${targetUser}] no encontrado.${colors.reset}`
              );
            }
            return;
          }

          // Handle removeuser command
          if (messageStr.startsWith("/removeuser")) {
            const parts = messageStr.split(" ");
            if (parts.length < 3) {
              ws.send(
                `${colors.yellow}Uso: /removeuser <usuario> <ADMIN_PWD>${colors.reset}`
              );
              return;
            }

            const targetUser = parts[1];
            const pwd = parts[2];

            if (pwd !== ADMIN_PWD) {
              ws.send(`${colors.red}Contraseña incorrecta.${colors.reset}`);
              return;
            }

            let removed = false;
            for (const [client, data] of clients.entries()) {
              if (data.username === targetUser && data.authenticated) {
                immediateCleanup(client);
                client.close();
                removed = true;
                break;
              }
            }

            if (removed) {
              broadcast(
                `[${targetUser}] ha sido removido por [${clientData.username}].`
              );
            } else {
              ws.send(
                `${colors.red}Usuario [${targetUser}] no encontrado.${colors.reset}`
              );
            }
            return;
          }

          // Regular chat message
          broadcast(`[${clientData.username}] ${messageStr}`);
          return;
        }
      }
    } catch (err) {
      console.error("Message processing error:", err);
      sendToClient(ws, "error", { msg: "Server error" });
    }
  });

  ws.on("close", () => {
    // Use grace period for normal disconnections
    scheduleCleanup(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    // Use grace period even for errors
    scheduleCleanup(ws);
  });
});

// --- ADMIN AUTHENTICATION ---
const adminTokens = new Set();

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function verifyAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  if (!adminTokens.has(token)) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  next();
}

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PWD) {
    return res.json({ success: false, error: "Invalid password" });
  }

  const token = generateToken();
  adminTokens.add(token);

  res.json({ success: true, token });
});

// Verify token
app.get("/api/admin/verify", verifyAdminToken, (req, res) => {
  res.json({ valid: true });
});

// Admin stats (protected)
app.get("/api/admin/stats", verifyAdminToken, (req, res) => {
  const users = [];
  for (const [ws, data] of clients.entries()) {
    if (data.authenticated) {
      users.push({
        username: data.username,
        deviceId: data.deviceId,
        terminalMode: data.terminalMode,
      });
    }
  }

  res.json({
    userCount: activeUsernames.size,
    messageCount: messageHistory.length,
    uptime: Date.now() - SERVER_START_TIME,
    users: users,
    messages: messageHistory,
  });
});

// Kick user (protected)
app.post("/api/admin/kick", verifyAdminToken, (req, res) => {
  const { username, seconds } = req.body;

  let kicked = false;
  let kickedDeviceId = null;
  for (const [client, data] of clients.entries()) {
    if (data.username === username && data.authenticated) {
      kickedDeviceId = data.deviceId;
      immediateCleanup(client);
      client.close();
      kicked = true;
      break;
    }
  }

  if (kicked) {
    const banDuration = seconds && parseInt(seconds, 10) > 0 ? parseInt(seconds, 10) : 0;
    
    if (kickedDeviceId && banDuration > 0) {
      banDevice(kickedDeviceId, username, banDuration);
      broadcast(`[${username}] ha sido expulsado por el administrador durante ${banDuration} segundos.`);
    } else {
      broadcast(`[${username}] ha sido expulsado por el administrador.`);
    }
  }

  res.json({ success: kicked, error: kicked ? null : "User not found" });
});

// Kick all users (protected)
app.post("/api/admin/kick-all", verifyAdminToken, (req, res) => {
  let count = 0;
  for (const [client, data] of clients.entries()) {
    if (data.authenticated) {
      immediateCleanup(client);
      client.close();
      count++;
    }
  }

  broadcast(`Todos los usuarios han sido expulsados por el administrador.`);
  res.json({ success: true, count });
});

// Clear history (protected)
app.post("/api/admin/clear-history", verifyAdminToken, (req, res) => {
  messageHistory.length = 0;
  
  // Send a special clearHistory message to all clients
  for (const [ws, clientData] of clients.entries()) {
    if (clientData.authenticated && ws.readyState === WebSocket.OPEN) {
      try {
        if (clientData.terminalMode) {
          ws.send(`${colors.cyan}[SISTEMA] El historial del chat ha sido limpiado.${colors.reset}`);
        } else {
          ws.send(JSON.stringify({ type: "clearHistory" }));
        }
      } catch (err) {
        console.error("Clear history broadcast error:", err);
      }
    }
  }
  
  res.json({ success: true });
});

// Broadcast message (protected)
app.post("/api/admin/broadcast", verifyAdminToken, (req, res) => {
  const { message } = req.body;

  broadcast(`[ADMIN] ${message}`);
  res.json({ success: true });
});

// --- START SERVER ---
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Start time: ${new Date(SERVER_START_TIME).toISOString()}`);
  console.log(
    `Reconnect grace period: ${RECONNECT_GRACE_PERIOD / 1000} seconds`
  );
});