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
const deviceToUsername = new Map(); // deviceId -> username
const activeUsernames = new Set(); // Currently active usernames
const disconnectionTimeouts = new Map(); // deviceId -> { timeout, username, timestamp }
const messageHistory = []; // { msg, timestamp }[]
const rateLimits = new Map(); // username -> { count, lastReset, mutedUntil }
const bannedDevices = new Map(); // deviceId -> { expiresAt, username }

const MAX_HISTORY = 100;
const SERVER_START_TIME = Date.now();
const MAX_USERNAME_LENGTH = 20;
const RECONNECT_GRACE_PERIOD = 10 * 1000;

// --- CORS ---
app.use((req, res, next) => {
  const allowedOrigins = [
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "https://xwalfie-smr.github.io",
  ];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
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

  // Reserved words not allowed as usernames
  const reservedUsernames = [
    "admin",
    "manager",
    "administrator",
    "mod",
    "moderator",
    "root",
    "system",
    "owner",
  ];
  if (reservedUsernames.includes(sanitized.toLowerCase())) {
    return "anon";
  }

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
  // Make [ADMIN] always white
  if (username.toUpperCase() === "ADMIN") {
    return colors.white;
  }
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
  const expiresAt = Date.now() + durationSeconds * 1000;
  bannedDevices.set(deviceId, { expiresAt, username });
  console.log(
    `[BANNED] ${deviceId} (${username}) for ${durationSeconds} seconds`
  );
}

function unbanDevice(deviceId) {
  if (bannedDevices.has(deviceId)) {
    const banInfo = bannedDevices.get(deviceId);
    bannedDevices.delete(deviceId);
    console.log(`[UNBANNED] ${deviceId} (${banInfo.username})`);
    return { success: true, username: banInfo.username };
  }
  return { success: false };
}

function findDeviceByUsername(username) {
  // Try to find device ID from active connections
  for (const [ws, clientData] of clients.entries()) {
    if (clientData.username === username) {
      return clientData.deviceId;
    }
  }

  // Try to find from deviceToUsername map
  for (const [deviceId, storedUsername] of deviceToUsername.entries()) {
    if (storedUsername === username) {
      return deviceId;
    }
  }

  // Try to find from banned devices
  for (const [deviceId, banInfo] of bannedDevices.entries()) {
    if (banInfo.username === username) {
      return deviceId;
    }
  }

  return null;
}

// --- CLEANUP WITH GRACE PERIOD ---
function scheduleCleanup(ws) {
  const clientData = clients.get(ws);
  if (!clientData) {
    console.log(`[GRACE DEBUG] scheduleCleanup called but no clientData found`);
    return;
  }

  const { username, deviceId } = clientData;

  // Remove from clients map immediately
  clients.delete(ws);

  if (!deviceId || !username) {
    console.log(
      `[GRACE DEBUG] scheduleCleanup skipped - missing data: deviceId=${deviceId}, username=${username}`
    );
    return;
  }

  const graceStartTime = Date.now();
  const graceExpiresAt = graceStartTime + RECONNECT_GRACE_PERIOD;

  console.log(
    `[GRACE START] User disconnected - starting grace period`
  );
  console.log(`  Username: ${username}`);
  console.log(`  DeviceId: ${deviceId}`);
  console.log(`  Grace period: ${RECONNECT_GRACE_PERIOD / 1000}s`);
  console.log(`  Started at: ${new Date(graceStartTime).toISOString()}`);
  console.log(`  Expires at: ${new Date(graceExpiresAt).toISOString()}`);
  console.log(`  Active usernames before: ${Array.from(activeUsernames).join(", ")}`);

  // Cancel any existing timeout for this device
  if (disconnectionTimeouts.has(deviceId)) {
    const existing = disconnectionTimeouts.get(deviceId);
    clearTimeout(existing.timeout);
    console.log(
      `[GRACE DEBUG] Cleared existing grace period timeout for ${username} (${deviceId})`
    );
    console.log(`  Previous grace started: ${new Date(existing.timestamp).toISOString()}`);
  }

  // Schedule cleanup after grace period
  const timeoutId = setTimeout(() => {
    const now = Date.now();
    const graceDuration = (now - graceStartTime) / 1000;
    
    console.log(`[GRACE EXPIRED] Grace period ended - cleaning up user`);
    console.log(`  Username: ${username}`);
    console.log(`  DeviceId: ${deviceId}`);
    console.log(`  Grace duration: ${graceDuration.toFixed(2)}s`);
    console.log(`  Expected duration: ${RECONNECT_GRACE_PERIOD / 1000}s`);
    console.log(`  Expired at: ${new Date(now).toISOString()}`);

    // Check if user is still in expected state
    const stillInTimeout = disconnectionTimeouts.has(deviceId);
    const stillHasUsername = activeUsernames.has(username);
    const stillMappedDevice = deviceToUsername.get(deviceId) === username;

    console.log(`  Still in timeout map: ${stillInTimeout}`);
    console.log(`  Still in active usernames: ${stillHasUsername}`);
    console.log(`  Still mapped to device: ${stillMappedDevice}`);

    // Clean up
    activeUsernames.delete(username);
    deviceToUsername.delete(deviceId);
    rateLimits.delete(username);
    disconnectionTimeouts.delete(deviceId);

    console.log(`  Cleanup completed`);
    console.log(`  Active usernames after: ${Array.from(activeUsernames).join(", ") || "(none)"}`);

    // NOW broadcast departure (after grace period)
    broadcast(`[${username}] ha salido del chat.`);
    console.log(`  Broadcasted departure message`);
  }, RECONNECT_GRACE_PERIOD);

  // Store timeout info
  disconnectionTimeouts.set(deviceId, {
    timeout: timeoutId,
    username: username,
    timestamp: graceStartTime,
  });

  console.log(
    `[GRACE DEBUG] Grace period scheduled successfully, timeout stored in map`
  );
}

function cancelScheduledCleanup(deviceId) {
  console.log(`[GRACE DEBUG] cancelScheduledCleanup called for deviceId: ${deviceId}`);
  
  if (disconnectionTimeouts.has(deviceId)) {
    const { timeout, username, timestamp } = disconnectionTimeouts.get(deviceId);
    const now = Date.now();
    const timeInGrace = (now - timestamp) / 1000;
    const remainingGrace = (RECONNECT_GRACE_PERIOD - (now - timestamp)) / 1000;
    
    clearTimeout(timeout);
    disconnectionTimeouts.delete(deviceId);
    
    console.log(`[GRACE CANCELLED] User reconnected within grace period`);
    console.log(`  Username: ${username}`);
    console.log(`  DeviceId: ${deviceId}`);
    console.log(`  Grace started: ${new Date(timestamp).toISOString()}`);
    console.log(`  Reconnected at: ${new Date(now).toISOString()}`);
    console.log(`  Time in grace period: ${timeInGrace.toFixed(2)}s`);
    console.log(`  Remaining grace time: ${remainingGrace.toFixed(2)}s`);
    console.log(`  Total grace period: ${RECONNECT_GRACE_PERIOD / 1000}s`);
    console.log(`  Success rate: ${((timeInGrace / (RECONNECT_GRACE_PERIOD / 1000)) * 100).toFixed(1)}% of grace period used`);
    
    return true;
  }
  
  console.log(`[GRACE DEBUG] No grace period found for deviceId: ${deviceId}`);
  return false;
}

function immediateCleanup(ws) {
  const clientData = clients.get(ws);
  if (!clientData) {
    console.log(`[GRACE DEBUG] immediateCleanup called but no clientData found`);
    return null;
  }

  const { username, deviceId } = clientData;

  console.log(`[IMMEDIATE CLEANUP] Starting immediate cleanup (bypassing grace period)`);
  console.log(`  Username: ${username}`);
  console.log(`  DeviceId: ${deviceId}`);
  console.log(`  Reason: Admin kick or forced disconnect`);

  // Remove from all tracking immediately
  clients.delete(ws);

  if (deviceId) {
    // Cancel any pending cleanup
    if (disconnectionTimeouts.has(deviceId)) {
      const { timestamp } = disconnectionTimeouts.get(deviceId);
      const timeInGrace = (Date.now() - timestamp) / 1000;
      
      console.log(`  Had pending grace period:`);
      console.log(`    Grace started: ${new Date(timestamp).toISOString()}`);
      console.log(`    Time in grace: ${timeInGrace.toFixed(2)}s`);
      console.log(`    Cancelling grace period...`);
      
      clearTimeout(disconnectionTimeouts.get(deviceId).timeout);
      disconnectionTimeouts.delete(deviceId);
    } else {
      console.log(`  No pending grace period found`);
    }
    deviceToUsername.delete(deviceId);
  }

  if (username) {
    activeUsernames.delete(username);
    rateLimits.delete(username);
  }

  console.log(`[IMMEDIATE CLEANUP] Completed: ${username} (${deviceId})`);
  console.log(`  Active usernames after: ${Array.from(activeUsernames).join(", ") || "(none)"}`);
  
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
              msg: `Tu dispositivo ha sido expulsado. Podrás volver a entrar en ${banStatus.remainingTime} segundos.`,
            });
            ws.close();
            return;
          }

          let finalUsername;
          let announceJoin = true;
          let isQuickReconnect = false;

          console.log(`[AUTH] Processing authentication request`);
          console.log(`  Requested username: ${requestedName}`);
          console.log(`  DeviceId: ${deviceId}`);
          console.log(`  isReconnect flag: ${isReconnect}`);
          console.log(`  Has grace period: ${disconnectionTimeouts.has(deviceId)}`);
          console.log(`  Has stored username: ${deviceToUsername.has(deviceId)}`);
          console.log(`  Current active usernames: ${Array.from(activeUsernames).join(", ") || "(none)"}`);

          // CHECK 1: Is there a pending disconnection for this device? (Quick reconnect)
          console.log(`[AUTH CHECK 1] Checking for quick reconnect (within grace period)...`);
          if (cancelScheduledCleanup(deviceId)) {
            // User reconnected before grace period ended
            const previousUsername = deviceToUsername.get(deviceId);
            console.log(`  Found previous username: ${previousUsername}`);
            console.log(`  Previous username still active: ${activeUsernames.has(previousUsername)}`);
            
            if (previousUsername && activeUsernames.has(previousUsername)) {
              finalUsername = previousUsername;
              announceJoin = false; // DON'T announce - they never really left
              isQuickReconnect = true;
              console.log(
                `[QUICK RECONNECT SUCCESS] ${finalUsername} (${deviceId}) reconnected within grace period`
              );
              console.log(`  Will NOT announce join (seamless reconnect)`);
            } else {
              console.log(`[AUTH DEBUG] Grace cancelled but username not available: ${previousUsername}`);
            }
          } else {
            console.log(`  No grace period found - not a quick reconnect`);
          }

          // CHECK 2: Does this device have a stored username? (Reconnect after grace period)
          console.log(`[AUTH CHECK 2] Checking for reconnect after grace period...`);
          if (!finalUsername && isReconnect && deviceToUsername.has(deviceId)) {
            const previousUsername = deviceToUsername.get(deviceId);
            console.log(`  Found stored username: ${previousUsername}`);
            console.log(`  Username available: ${isUsernameAvailable(previousUsername)}`);

            // Reuse previous username if it's available
            if (isUsernameAvailable(previousUsername)) {
              finalUsername = previousUsername;
              announceJoin = true; // DO announce - they were gone long enough
              console.log(
                `[RECONNECT AFTER GRACE] ${finalUsername} (${deviceId}) reconnected after grace period expired`
              );
              console.log(`  Will announce join (user was gone)`);
            } else {
              console.log(`[AUTH DEBUG] Previous username taken, will generate new one`);
            }
          } else {
            if (!finalUsername) {
              console.log(`  Conditions not met:`);
              console.log(`    finalUsername set: ${!!finalUsername}`);
              console.log(`    isReconnect: ${isReconnect}`);
              console.log(`    has stored username: ${deviceToUsername.has(deviceId)}`);
            }
          }

          // CHECK 3: Generate new username for first-time users
          console.log(`[AUTH CHECK 3] Checking if new username needed...`);
          if (!finalUsername) {
            finalUsername = generateUniqueUsername(requestedName);
            announceJoin = true; // DO announce - brand new user
            console.log(`[NEW USER] Generated username: ${finalUsername} for deviceId: ${deviceId}`);
            console.log(`  Will announce join (new user)`);
          } else {
            console.log(`  Username already determined: ${finalUsername}`);
          }

          // Register username
          console.log(`[AUTH] Registering user...`);
          activeUsernames.add(finalUsername);
          deviceToUsername.set(deviceId, finalUsername);
          console.log(`  Registered ${finalUsername} (${deviceId})`);
          console.log(`  Active usernames now: ${Array.from(activeUsernames).join(", ")}`);

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
          console.log(`  Sent authentication success (isQuickReconnect: ${isQuickReconnect})`);

          // Send chat history
          sendToClient(ws, "history", { messages: messageHistory });
          console.log(`  Sent chat history (${messageHistory.length} messages)`);

          // Announce join ONLY if appropriate
          if (announceJoin) {
            broadcast(`[${finalUsername}] se ha unido al chat.`);
            console.log(`  Broadcasted join announcement`);
          } else {
            console.log(`  Skipped join announcement (quick reconnect)`);
          }

          console.log(`[AUTH COMPLETE] ${finalUsername} authenticated successfully`);
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

        if (data.type === "logout") {
          if (!clientData.authenticated) {
            sendToClient(ws, "error", { msg: "Not authenticated" });
            return;
          }

          console.log(
            `[LOGOUT] ${clientData.username} (${clientData.deviceId}) - explicit logout`
          );

          // Do immediate cleanup (no grace period for explicit logout)
          const cleanupData = immediateCleanup(ws);

          // Send confirmation
          sendToClient(ws, "loggedOut", {});

          // Announce departure
          if (cleanupData && cleanupData.username) {
            broadcast(`[${cleanupData.username}] ha salido del chat.`);
          }

          // Close the connection
          ws.close();
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

            if (msg.startsWith("/unban ")) {
              const parts = msg.split(" ");
              if (parts.length < 3) {
                sendToClient(ws, "chat", {
                  msg: "Uso: /unban <usuario> <ADMIN_PWD>",
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

              const targetDeviceId = findDeviceByUsername(targetUser);
              if (!targetDeviceId) {
                sendToClient(ws, "chat", {
                  msg: `Usuario [${targetUser}] no encontrado.`,
                  timestamp: Date.now(),
                });
                return;
              }

              const result = unbanDevice(targetDeviceId);
              if (result.success) {
                broadcast(
                  `[${result.username}] ha sido desbaneado por [${username}].`
                );
              } else {
                sendToClient(ws, "chat", {
                  msg: `Usuario [${targetUser}] no está baneado.`,
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

          // Handle unban command
          if (messageStr.startsWith("/unban")) {
            const parts = messageStr.split(" ");
            if (parts.length < 3) {
              ws.send(
                `${colors.yellow}Uso: /unban <usuario> <ADMIN_PWD>${colors.reset}`
              );
              return;
            }

            const targetUser = parts[1];
            const pwd = parts[2];

            if (pwd !== ADMIN_PWD) {
              ws.send(`${colors.red}Contraseña incorrecta.${colors.reset}`);
              return;
            }

            const targetDeviceId = findDeviceByUsername(targetUser);
            if (!targetDeviceId) {
              ws.send(
                `${colors.red}Usuario [${targetUser}] no encontrado.${colors.reset}`
              );
              return;
            }

            const result = unbanDevice(targetDeviceId);
            if (result.success) {
              broadcast(
                `[${result.username}] ha sido desbaneado por [${clientData.username}].`
              );
            } else {
              ws.send(
                `${colors.red}Usuario [${targetUser}] no está baneado.${colors.reset}`
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
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`[DISCONNECT] WebSocket closed`);
      console.log(`  Username: ${clientData.username || "(not authenticated)"}`);
      console.log(`  DeviceId: ${clientData.deviceId || "(none)"}`);
      console.log(`  Was authenticated: ${clientData.authenticated}`);
    }
    // Use grace period for normal disconnections
    scheduleCleanup(ws);
  });

  ws.on("error", (err) => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.error(`[DISCONNECT ERROR] WebSocket error for ${clientData.username || "(not authenticated)"}`);
      console.error(`  DeviceId: ${clientData.deviceId || "(none)"}`);
      console.error(`  Error:`, err);
    } else {
      console.error("WebSocket error:", err);
    }
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
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.substring(7);
  if (!adminTokens.has(token)) {
    return res.status(401).json({ error: "Invalid token" });
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
  cleanExpiredBans(); // Clean up expired bans before reporting

  console.log(`[ADMIN STATS] Collecting stats for admin panel`);
  console.log(`  Active clients: ${clients.size}`);
  console.log(`  Active usernames: ${activeUsernames.size}`);
  console.log(`  Grace period timeouts: ${disconnectionTimeouts.size}`);

  // Collect online users
  const users = [];
  for (const [ws, data] of clients.entries()) {
    if (data.authenticated) {
      users.push({
        username: data.username,
        deviceId: data.deviceId,
        terminalMode: data.terminalMode,
        status: "online",
      });
    }
  }
  console.log(`  Online authenticated users: ${users.length}`);

  // Add users in grace period (disconnectionTimeouts)
  console.log(`[ADMIN STATS] Adding grace period users...`);
  for (const [deviceId, info] of disconnectionTimeouts.entries()) {
    const graceSeconds = Math.ceil((Date.now() - info.timestamp) / 1000);
    const graceRemaining = Math.ceil(
      RECONNECT_GRACE_PERIOD / 1000 - (Date.now() - info.timestamp) / 1000
    );
    
    console.log(`  Grace user: ${info.username} (${deviceId})`);
    console.log(`    Started: ${new Date(info.timestamp).toISOString()}`);
    console.log(`    Elapsed: ${graceSeconds}s`);
    console.log(`    Remaining: ${graceRemaining}s`);
    
    users.push({
      username: info.username,
      deviceId: deviceId,
      terminalMode: null,
      status: "grace",
      graceStarted: info.timestamp,
      graceSeconds: graceSeconds,
      graceRemaining: graceRemaining,
    });
  }
  console.log(`  Total users (online + grace): ${users.length}`)

  const bannedUsers = [];
  for (const [deviceId, banInfo] of bannedDevices.entries()) {
    const remainingTime = Math.ceil((banInfo.expiresAt - Date.now()) / 1000);
    bannedUsers.push({
      deviceId: deviceId,
      username: banInfo.username,
      remainingSeconds: remainingTime,
    });
  }

  res.json({
    userCount: activeUsernames.size,
    messageCount: messageHistory.length,
    uptime: Date.now() - SERVER_START_TIME,
    users: users,
    messages: messageHistory,
    bannedUsers: bannedUsers,
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
    const banDuration =
      seconds && parseInt(seconds, 10) > 0 ? parseInt(seconds, 10) : 0;

    if (kickedDeviceId && banDuration > 0) {
      banDevice(kickedDeviceId, username, banDuration);
      broadcast(
        `[${username}] ha sido expulsado por el administrador durante ${banDuration} segundos.`
      );
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
          ws.send(
            `${colors.white}[SISTEMA] El historial del chat ha sido limpiado.${colors.reset}`
          );
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

// Unban user (protected)
app.post("/api/admin/unban", verifyAdminToken, (req, res) => {
  const { username, deviceId } = req.body;

  let targetDeviceId = deviceId;

  // If only username provided, try to find device ID
  if (!targetDeviceId && username) {
    targetDeviceId = findDeviceByUsername(username);
  }

  if (!targetDeviceId) {
    return res.json({ success: false, error: "User or device not found" });
  }

  const result = unbanDevice(targetDeviceId);

  if (result.success) {
    broadcast(`[${result.username}] ha sido desbaneado por el administrador.`);
    res.json({ success: true, username: result.username });
  } else {
    res.json({ success: false, error: "User is not banned" });
  }
});

// --- START SERVER ---
server.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Chat Server Started`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Server running on port ${PORT}`);
  console.log(`Start time: ${new Date(SERVER_START_TIME).toISOString()}`);
  console.log(`\nGrace Period Configuration:`);
  console.log(`  Duration: ${RECONNECT_GRACE_PERIOD / 1000} seconds`);
  console.log(`  Purpose: Allow seamless reconnections without announcing leave/join`);
  console.log(`\nDebugging Features:`);
  console.log(`  [GRACE START] - When a user disconnects and grace period begins`);
  console.log(`  [GRACE CANCELLED] - When user reconnects within grace period`);
  console.log(`  [GRACE EXPIRED] - When grace period ends and user is removed`);
  console.log(`  [QUICK RECONNECT SUCCESS] - Successful reconnection within grace`);
  console.log(`  [RECONNECT AFTER GRACE] - Reconnection after grace expired`);
  console.log(`  [IMMEDIATE CLEANUP] - Forced cleanup (kicks, etc)`);
  console.log(`  [ADMIN STATS] - Stats requests showing grace period users`);
  console.log(`${"=".repeat(60)}\n`);
});
