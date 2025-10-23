const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const ADMIN_PWD = process.env.ADMIN_PWD;

// --- DATA STRUCTURES (SIMPLIFIED) ---
const clients = new Map(); // ws -> { username, deviceId, authenticated, terminalMode }
const deviceToUsername = new Map(); // deviceId -> username (for reconnection)
const activeUsernames = new Set(); // Currently active usernames
const messageHistory = [];
const rateLimits = new Map();

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
  next();
});

app.use(express.static("docs"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// --- HELPER FUNCTIONS ---

function isUsernameAvailable(username) {
  return !activeUsernames.has(username);
}

function generateUniqueUsername(requestedName) {
  const baseName = (requestedName || "anon").trim();

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
          ws.send(msg);
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
          ws.send(data.msg);
        } else if (type === "history") {
          if (data.messages.length > 0) {
            ws.send("\n--- Chat History ---");
            data.messages.forEach(msg => ws.send(msg.msg));
            ws.send("--- End of History ---\n");
          } else {
            ws.send("No chat history yet. Start chatting!\n");
          }
        } else if (type === "error") {
          ws.send(`Error: ${data.msg}`);
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
const MAX_MESSAGES = 5;
const TIME_WINDOW = 10000;
const MUTE_DURATION = 15000;

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

// --- CLEANUP ---
function cleanupClient(ws, silent = false) {
  const clientData = clients.get(ws);
  if (!clientData) return;

  const { username, deviceId } = clientData;

  // Remove from clients
  clients.delete(ws);

  // Free up the username
  if (username) {
    activeUsernames.delete(username);

    // Don't announce if silent or if device is reconnecting
    if (!silent && username) {
      broadcast(`[${username}] ha salido del chat.`);
    }
  }

  console.log(`Cleaned up: ${username} (${deviceId})`);
}

// --- WEBSOCKET HANDLING ---
wss.on("connection", (ws) => {
  console.log("New connection");

  clients.set(ws, {
    username: null,
    deviceId: null,
    authenticated: false,
    terminalMode: true // Default to terminal mode
  });

  // Send welcome message for terminal clients
  ws.send("Connected to chat server!");
  ws.send("Enter your username: ");

  ws.on("message", (message) => {
    try {
      const clientData = clients.get(ws);
      if (!clientData) {
        ws.close();
        return;
      }

      const messageStr = message.toString().trim();

      // If JSON is received, switch to JSON mode
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

          let finalUsername;
          let announceJoin = true;

          if (isReconnect && deviceToUsername.has(deviceId)) {
            const previousUsername = deviceToUsername.get(deviceId);

            if (isUsernameAvailable(previousUsername)) {
              finalUsername = previousUsername;
              announceJoin = false;
              console.log(`Reconnecting ${deviceId} as ${finalUsername}`);
            }
          }

          if (!finalUsername) {
            finalUsername = generateUniqueUsername(requestedName);
            console.log(`New user: ${finalUsername} (${deviceId})`);
          }

          activeUsernames.add(finalUsername);
          deviceToUsername.set(deviceId, finalUsername);

          clientData.username = finalUsername;
          clientData.deviceId = deviceId;
          clientData.authenticated = true;

          sendToClient(ws, "authenticated", {
            username: finalUsername,
            serverStartTime: SERVER_START_TIME,
          });

          sendToClient(ws, "history", { messages: messageHistory });

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

          if (isSpamming(username)) {
            sendToClient(ws, "chat", {
              msg: "Estás enviando mensajes demasiado rápido. Espera un momento.",
              timestamp: Date.now(),
            });
            return;
          }

          if (msg.startsWith("/kick ")) {
            const parts = msg.split(" ");
            if (parts.length < 3) {
              sendToClient(ws, "chat", {
                msg: "Uso: /kick <usuario> <ADMIN_PWD>",
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

            let kicked = false;
            for (const [client, data] of clients.entries()) {
              if (data.username === targetUser && data.authenticated) {
                cleanupClient(client, true);
                client.close();
                kicked = true;
                break;
              }
            }

            if (kicked) {
              broadcast(`[${targetUser}] ha sido expulsado por [${username}].`);
            } else {
              sendToClient(ws, "chat", {
                msg: `Usuario [${targetUser}] no encontrado.`,
                timestamp: Date.now(),
              });
            }
            return;
          }

          broadcast(`[${username}] ${msg}`);
          return;
        }
      } else {
        // Handle plain text messages (for terminal clients)
        
        // Handle username entry
        if (!clientData.authenticated && !clientData.username && messageStr) {
          const finalUsername = generateUniqueUsername(messageStr);
          
          activeUsernames.add(finalUsername);
          clientData.username = finalUsername;
          clientData.authenticated = true;
          
          ws.send(`Welcome ${finalUsername}!`);
          sendToClient(ws, "history", { messages: messageHistory });
          broadcast(`[${finalUsername}] se ha unido al chat.`);
          return;
        }

        // Handle chat messages
        if (clientData.authenticated && messageStr) {
          if (isSpamming(clientData.username)) {
            ws.send("Estás enviando mensajes demasiado rápido. Espera un momento.");
            return;
          }

          // Handle admin commands
          if (messageStr.startsWith("/kick ")) {
            const parts = messageStr.split(" ");
            if (parts.length < 3) {
              ws.send("Uso: /kick <usuario> <ADMIN_PWD>");
              return;
            }
            
            const targetUser = parts[1];
            const pwd = parts[2];
            
            if (pwd !== ADMIN_PWD) {
              ws.send("Contraseña incorrecta.");
              return;
            }

            let kicked = false;
            for (const [client, data] of clients.entries()) {
              if (data.username === targetUser && data.authenticated) {
                cleanupClient(client, true);
                client.close();
                kicked = true;
                break;
              }
            }

            if (kicked) {
              broadcast(`[${targetUser}] ha sido expulsado por [${clientData.username}].`);
            } else {
              ws.send(`Usuario [${targetUser}] no encontrado.`);
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
    cleanupClient(ws, false);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
    cleanupClient(ws, true);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Start time: ${new Date(SERVER_START_TIME).toISOString()}`);
});