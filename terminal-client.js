const WebSocket = require("ws");
const readline = require("readline");
const crypto = require("crypto");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ws = new WebSocket("wss://chat-cp1p.onrender.com");

let username = "";
const deviceId = crypto.randomBytes(16).toString("hex");

ws.on("open", () => {});
ws.on("message", (message) => {
  const data = JSON.parse(message);
  if (data.type === "prompt") {
    rl.question(data.msg + " ", (name) => {
      username = name || "anon";
      ws.send(JSON.stringify({ type: "username", msg: username, deviceId: deviceId }));
    });
  } else if (data.type === "history") {
    console.log("--- Chat History ---");
    data.messages.forEach((msg) => {
      console.log(msg);
    });
    console.log("--- End of History ---");
    rl.prompt(true);
  } else if (data.type === "chat") {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    console.log(data.msg);
    rl.prompt(true);
  }
});

rl.on("line", (line) => {
  ws.send(JSON.stringify({ type: "chat", msg: line }));
  rl.prompt();
});