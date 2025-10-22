const WebSocket = require("ws");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ws = new WebSocket("ws://localhost:8080");

let username = "";

ws.on("open", () => {});
ws.on("message", (message) => {
  const data = JSON.parse(message);
  if (data.type === "prompt") {
    rl.question(data.msg + " ", (name) => {
      username = name || "anon";
      ws.send(JSON.stringify({ type: "username", msg: username }));
    });
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
