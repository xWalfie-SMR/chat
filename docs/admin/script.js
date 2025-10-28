const API_URL = "https://chat-cp1p.onrender.com";
let authToken = null;
let statsInterval = null;
let selectedDuration = 0;
let currentKickUsername = null;

window.addEventListener("DOMContentLoaded", () => {
  authToken = sessionStorage.getItem("adminToken");
  if (authToken) {
    verifyAuth();
  }

  document.getElementById("login-pwd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      login();
    }
  });

  document.getElementById("broadcast-msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      broadcastMessage();
    }
  });

  // Listen for custom seconds input
  const customSecondsInput = document.getElementById("custom-seconds");
  if (customSecondsInput) {
    customSecondsInput.addEventListener("input", (e) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value) && value >= 0) {
        selectedDuration = value;
        document.querySelectorAll(".duration-btn").forEach((btn) => {
          btn.classList.remove("active");
        });
      }
    });
    customSecondsInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        confirmKick();
      }
    });
  }

  document.getElementById("kick-modal").addEventListener("click", (e) => {
    if (e.target.id === "kick-modal") {
      closeKickModal();
    }
  });
});

async function login() {
  const pwd = document.getElementById("login-pwd").value;
  const errorDiv = document.getElementById("login-error");

  if (!pwd) {
    errorDiv.textContent = "Please enter password";
    errorDiv.classList.add("show");
    return;
  }

  try {
    const res = await fetch(API_URL + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwd }),
    });
    const data = await res.json();

    if (data.success) {
      authToken = data.token;
      sessionStorage.setItem("adminToken", authToken);
      showAdminPanel();
    } else {
      errorDiv.textContent = "Invalid password";
      errorDiv.classList.add("show");
      document.getElementById("login-pwd").value = "";
    }
  } catch (err) {
    let errorMsg = "Connection error";
    if (err && err.message) {
      errorMsg += ": " + err.message;
    }
    if (err && err.name) {
      errorMsg += " (" + err.name + ")";
    }
    errorDiv.textContent = errorMsg;
    errorDiv.classList.add("show");
    console.error("Login error:", err);
  }
}

async function verifyAuth() {
  try {
    const res = await fetch(API_URL + "/api/admin/verify", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const data = await res.json();

    if (data.valid) {
      showAdminPanel();
    } else {
      logout();
    }
  } catch (err) {
    logout();
  }
}

function showAdminPanel() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("admin-panel").classList.remove("hidden");
  fetchStats();
  statsInterval = setInterval(fetchStats, 3000);
}

function logout() {
  authToken = null;
  sessionStorage.removeItem("adminToken");
  if (statsInterval) {
    clearInterval(statsInterval);
  }
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("admin-panel").classList.add("hidden");
  document.getElementById("login-pwd").value = "";
}

function showResult(msg, isError = false) {
  const resultDiv = document.getElementById("action-result");
  resultDiv.textContent = msg;
  resultDiv.className = isError ? "error show" : "success show";
  setTimeout(() => {
    resultDiv.classList.remove("show");
  }, 3000);
}

async function fetchStats() {
  try {
    const res = await fetch(API_URL + "/api/admin/stats", {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();

    document.getElementById("user-count").textContent = data.userCount;
    document.getElementById("message-count").textContent = data.messageCount;

    const uptimeMinutes = Math.floor(data.uptime / 60000);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    if (uptimeHours > 0) {
      document.getElementById("uptime").textContent =
        uptimeHours + "h " + (uptimeMinutes % 60) + "m";
    } else {
      document.getElementById("uptime").textContent = uptimeMinutes + "m";
    }

    const userList = document.getElementById("user-list");
    if (data.users.length === 0) {
      userList.innerHTML = '<div class="loading">No active users</div>';
    } else {
      userList.innerHTML = "";
      data.users.forEach((user) => {
        const userItem = document.createElement("div");
        userItem.className = "user-item";
        const userInfo = document.createElement("div");
        userInfo.className = "user-info";
        let statusLabel = "";
        let statusClass = "";
        if (user.status === "grace") {
          statusLabel = `In Grace Period${
            typeof user.graceRemaining === "number" && user.graceRemaining >= 0
              ? ` (${user.graceRemaining}s left)`
              : ""
          }`;
          statusClass = "status-grace";
        } else {
          statusLabel = user.terminalMode ? "Terminal" : "Web";
          statusClass = "";
        }
        userInfo.innerHTML = `
          <span class="username">${escapeHtml(user.username)}</span>
          <span class="device-id">${escapeHtml(user.deviceId)}</span>
          <span class="status ${statusClass}">${statusLabel}</span>
        `;
        const kickBtn = document.createElement("button");
        kickBtn.innerHTML = '<i class="fas fa-user-times"></i> Kick';
        if (user.status === "grace") {
          kickBtn.disabled = true;
          kickBtn.title = "Cannot kick user in grace period";
        } else {
          kickBtn.onclick = () => openKickModal(user.username);
        }
        userItem.appendChild(userInfo);
        userItem.appendChild(kickBtn);
        userList.appendChild(userItem);
      });
    }

    const bannedList = document.getElementById("banned-list");
    if (!data.bannedUsers || data.bannedUsers.length === 0) {
      bannedList.innerHTML = '<p style="color: #888;">No banned users</p>';
    } else {
      bannedList.innerHTML = data.bannedUsers
        .map((banned) => {
          const minutes = Math.floor(banned.remainingSeconds / 60);
          const seconds = banned.remainingSeconds % 60;
          const timeStr =
            minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
          return `
      <div class="user-item">
        <div class="user-info">
          <span class="username">${escapeHtml(banned.username)}</span>
          <span class="device-id">${escapeHtml(banned.deviceId)}</span>
          <span class="status" style="color: #e74c3c;">Banned (${timeStr})</span>
        </div>
        <button onclick="unbanUser('${escapeHtml(
          banned.username
        )}')" style="background: #27ae60;">Unban</button>
      </div>
    `;
        })
        .join("");
    }

    const msgList = document.getElementById("message-list");
    if (data.messages.length === 0) {
      msgList.innerHTML = '<div class="loading">No messages yet</div>';
    } else {
      msgList.innerHTML = data.messages
        .slice(-20)
        .reverse()
        .map((msg) => {
          const time = new Date(msg.timestamp).toLocaleTimeString();
          return `<div>${time} - ${escapeHtml(msg.msg)}</div>`;
        })
        .join("");
    }
  } catch (err) {
    console.error("Failed to fetch stats:", err);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function openKickModal(username) {
  currentKickUsername = username;
  selectedDuration = 0;
  document.getElementById("kick-username").textContent = username;
  document.getElementById("custom-seconds").value = "";
  document.querySelectorAll(".duration-btn").forEach((btn) => {
    btn.classList.remove("active");
    if (parseInt(btn.dataset.seconds) === 0) {
      btn.classList.add("active");
    }
  });
  const modal = document.getElementById("kick-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("show");
  }
}

function closeKickModal() {
  const modal = document.getElementById("kick-modal");
  if (modal) {
    modal.classList.remove("show");
    modal.classList.add("hidden");
  }
  currentKickUsername = null;
  selectedDuration = 0;
}

function selectDuration(seconds) {
  selectedDuration = seconds;
  document.getElementById("custom-seconds").value = "";

  document.querySelectorAll(".duration-btn").forEach((btn) => {
    btn.classList.remove("active");
    if (parseInt(btn.dataset.seconds) === seconds) {
      btn.classList.add("active");
    }
  });
}

async function confirmKick() {
  if (!currentKickUsername) return;

  const customSecondsInput = document.getElementById("custom-seconds");
  let banDuration = selectedDuration;
  if (customSecondsInput && customSecondsInput.value) {
    const customSeconds = parseInt(customSecondsInput.value, 10);
    if (!isNaN(customSeconds) && customSeconds >= 0) {
      banDuration = customSeconds;
    }
  }
  if (isNaN(banDuration) || banDuration < 0) {
    showResult("Invalid duration", true);
    return;
  }
  closeKickModal();
  await kickUser(currentKickUsername, banDuration);
}

async function kickUser(username, seconds = 0) {
  try {
    const res = await fetch(API_URL + "/api/admin/kick", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ username, seconds }),
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();

    if (data.success) {
      if (seconds > 0) {
        const minutes = Math.floor(seconds / 60);
        const timeStr =
          minutes > 0
            ? `${minutes} minute${minutes > 1 ? "s" : ""}`
            : `${seconds} second${seconds > 1 ? "s" : ""}`;
        showResult(`Kicked ${username} for ${timeStr}`);
      } else {
        showResult(`Kicked ${username}`);
      }
      fetchStats();
    } else {
      showResult(data.error || "Failed to kick user", true);
    }
  } catch (err) {
    showResult("Request failed", true);
  }
}

async function clearAllUsers() {
  if (!confirm("Are you sure you want to kick ALL users?")) return;

  try {
    const res = await fetch(API_URL + "/api/admin/kick-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();

    if (data.success) {
      showResult(`Kicked ${data.count} user${data.count > 1 ? "s" : ""}`);
      fetchStats();
    } else {
      showResult(data.error || "Failed", true);
    }
  } catch (err) {
    showResult("Request failed", true);
  }
}

async function clearHistory() {
  showCustomPrompt({
    message: "Are you sure you want to clear chat history?",
    confirmText: "Clear History",
    cancelText: "Cancel",
    onConfirm: async () => {
      try {
        const res = await fetch(API_URL + "/api/admin/clear-history", {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.status === 401) {
          logout();
          return;
        }
        const data = await res.json();
        if (data.success) {
          showResult("Chat history cleared");
          fetchStats();
        } else {
          showResult(data.error || "Failed", true);
        }
      } catch (err) {
        showResult("Request failed", true);
      }
    },
  });
  // Custom modal prompt for admin actions
  function showCustomPrompt({ message, confirmText, cancelText, onConfirm }) {
    // Remove any existing prompt
    let existing = document.getElementById("custom-prompt-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "custom-prompt-modal";
    modal.className = "hide";

    const box = document.createElement("div");
    box.className = "custom-prompt-box";

    const msg = document.createElement("div");
    msg.className = "custom-prompt-message";
    msg.textContent = message;

    const btnRow = document.createElement("div");
    btnRow.className = "custom-prompt-btn-row";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "custom-prompt-confirm";
    confirmBtn.textContent = confirmText || "Confirm";
    confirmBtn.onclick = () => {
      modal.classList.remove("show");
      modal.classList.add("hide");
      setTimeout(() => {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (onConfirm) onConfirm();
      }, 250);
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "custom-prompt-cancel";
    cancelBtn.textContent = cancelText || "Cancel";
    cancelBtn.onclick = () => {
      modal.classList.remove("show");
      modal.classList.add("hide");
      setTimeout(() => {
        if (modal.parentNode) modal.parentNode.removeChild(modal);
      }, 250);
    };

    btnRow.appendChild(confirmBtn);
    btnRow.appendChild(cancelBtn);
    box.appendChild(msg);
    box.appendChild(btnRow);
    modal.appendChild(box);
    document.body.appendChild(modal);
    // Trigger fade-in
    setTimeout(() => {
      modal.classList.remove("hide");
      modal.classList.add("show");
    }, 10);
  }
}

async function broadcastMessage() {
  const msg = document.getElementById("broadcast-msg").value.trim();

  if (!msg) {
    showResult("Enter a message", true);
    return;
  }

  try {
    const res = await fetch(API_URL + "/api/admin/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ message: msg }),
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();

    if (data.success) {
      showResult("Broadcast sent");
      document.getElementById("broadcast-msg").value = "";
      fetchStats();
    } else {
      showResult(data.error || "Failed", true);
    }
  } catch (err) {
    showResult("Request failed", true);
  }
}

async function unbanUser(username) {
  if (!confirm(`Are you sure you want to unban ${username}?`)) return;

  try {
    const res = await fetch(API_URL + "/api/admin/unban", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ username }),
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();

    if (data.success) {
      showResult(`Unbanned ${username}`);
      fetchStats();
    } else {
      showResult(data.error || "Failed to unban user", true);
    }
  } catch (err) {
    showResult("Request failed", true);
  }
}
