const API_URL = "https://chat-cp1p.onrender.com";
let authToken = null;
let statsInterval = null;

// Check if already authenticated
window.addEventListener('DOMContentLoaded', () => {
  authToken = sessionStorage.getItem('adminToken');
  if (authToken) {
    verifyAuth();
  }

  // Handle Enter key on login
  document.getElementById('login-pwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      login();
    }
  });

  // Handle Enter key on broadcast
  document.getElementById('broadcast-msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      broadcastMessage();
    }
  });
});

async function login() {
  const pwd = document.getElementById('login-pwd').value;
  const errorDiv = document.getElementById('login-error');

  if (!pwd) {
    errorDiv.textContent = 'Please enter password';
    errorDiv.classList.add('show');
    return;
  }

  try {
    const res = await fetch(API_URL + '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();

    if (data.success) {
      authToken = data.token;
      sessionStorage.setItem('adminToken', authToken);
      showAdminPanel();
    } else {
      errorDiv.textContent = 'Invalid password';
      errorDiv.classList.add('show');
      document.getElementById('login-pwd').value = '';
    }
  } catch (err) {
    let errorMsg = 'Connection error';
    if (err && err.message) {
      errorMsg += ': ' + err.message;
    }
    if (err && err.name) {
      errorMsg += ' (' + err.name + ')';
    }
    errorDiv.textContent = errorMsg;
    errorDiv.classList.add('show');
    console.error('Login error:', err);
  }
// Fin de funciones kick modal

async function verifyAuth() {
  try {
    const res = await fetch(API_URL + '/api/admin/verify', {
      headers: { 'Authorization': `Bearer ${authToken}` }
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
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('admin-panel').classList.remove('hidden');
  fetchStats();
  statsInterval = setInterval(fetchStats, 3000);
}

function logout() {
  authToken = null;
  sessionStorage.removeItem('adminToken');
  if (statsInterval) {
    clearInterval(statsInterval);
  }
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('admin-panel').classList.add('hidden');
  document.getElementById('login-pwd').value = '';
}

function showResult(msg, isError = false) {
  const resultDiv = document.getElementById('action-result');
  resultDiv.textContent = msg;
  resultDiv.className = isError ? 'error show' : 'success show';
  setTimeout(() => {
    resultDiv.classList.remove('show');
  }, 3000);
}

async function fetchStats() {
  try {
    const res = await fetch(API_URL + '/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();
    
    document.getElementById('user-count').textContent = data.userCount;
    document.getElementById('message-count').textContent = data.messageCount;
    
    const uptimeMinutes = Math.floor(data.uptime / 60000);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    if (uptimeHours > 0) {
      document.getElementById('uptime').textContent = uptimeHours + 'h ' + (uptimeMinutes % 60) + 'm';
    } else {
      document.getElementById('uptime').textContent = uptimeMinutes + 'm';
    }

    // Render users
    const userList = document.getElementById('user-list');
    if (data.users.length === 0) {
      userList.innerHTML = '<p style="color: #888;">No active users</p>';
    } else {
      userList.innerHTML = data.users.map(user => `
        <div class="user-item">
          <div class="user-info">
            <span class="username">${escapeHtml(user.username)}</span>
            <span class="device-id">${escapeHtml(user.deviceId)}</span>
            <span class="status">${user.terminalMode ? 'Terminal' : 'Web'}</span>
          </div>
          <button onclick="kickUserPrompt('${escapeHtml(user.username)}')">Kick</button>
        </div>
      `).join('');
    }

    // Render banned users
    const bannedList = document.getElementById('banned-list');
    if (!data.bannedUsers || data.bannedUsers.length === 0) {
      bannedList.innerHTML = '<p style="color: #888;">No banned users</p>';
    } else {
      bannedList.innerHTML = data.bannedUsers.map(banned => {
        const minutes = Math.floor(banned.remainingSeconds / 60);
        const seconds = banned.remainingSeconds % 60;
        const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        return `
        <div class="user-item">
          <div class="user-info">
            <span class="username">${escapeHtml(banned.username)}</span>
            <span class="device-id">${escapeHtml(banned.deviceId)}</span>
            <span class="status" style="color: #e74c3c;">Banned (${timeStr})</span>
          </div>
          <button onclick="unbanUser('${escapeHtml(banned.username)}')" style="background: #27ae60;">Unban</button>
        </div>
      `;
      }).join('');
    }

    // Render messages
    const msgList = document.getElementById('message-list');
    if (data.messages.length === 0) {
      msgList.innerHTML = '<p style="color: #888;">No messages yet</p>';
    } else {
      msgList.innerHTML = data.messages.slice(-20).reverse().map(msg => {
        const time = new Date(msg.timestamp).toLocaleTimeString();
        return `<div style="padding: 8px; border-bottom: 1px solid #3a3a3a;">${time} - ${escapeHtml(msg.msg)}</div>`;
      }).join('');
    }

  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function kickUserPrompt(username) {
  // Mostrar modal visual, no prompt nativo
  document.getElementById('kick-modal').classList.remove('hidden');
  document.getElementById('kick-username').textContent = username;
  window._kickTarget = username;
}

window.kickUserWithTime = function(seconds) {
  const username = window._kickTarget;
  if (!username) return;
  kickUser(username, seconds);
  closeKickModal();
}

window.kickUserCustomTime = function() {
  const username = window._kickTarget;
  if (!username) return;
  const customSeconds = parseInt(document.getElementById('kick-custom-seconds').value, 10);
  if (isNaN(customSeconds) || customSeconds < 0) {
    showResult('Tiempo inválido', true);
    return;
  }
  kickUser(username, customSeconds);
  closeKickModal();
}

window.closeKickModal = function() {
  document.getElementById('kick-modal').classList.add('hidden');
  window._kickTarget = null;
  document.getElementById('kick-custom-seconds').value = '';
}
}

async function kickUser(username, seconds = 0) {
  try {
    const res = await fetch(API_URL + '/api/admin/kick', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ username, seconds })
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();
    
    if (data.success) {
      if (seconds > 0) {
        showResult(`Kicked ${username} for ${seconds} seconds`);
      } else {
        showResult(`Kicked ${username}`);
      }
      fetchStats();
    } else {
      showResult(data.error || 'Failed to kick user', true);
    }
  } catch (err) {
    showResult('Request failed', true);
  }
}

async function clearAllUsers() {
  if (!confirm('Are you sure you want to kick ALL users?')) return;

  try {
    const res = await fetch(API_URL + '/api/admin/kick-all', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();
    
    if (data.success) {
      showResult(`Kicked ${data.count} users`);
      fetchStats();
    } else {
      showResult(data.error || 'Failed', true);
    }
  } catch (err) {
    showResult('Request failed', true);
  }
}

async function clearHistory() {
  if (!confirm('Are you sure you want to clear chat history?')) return;

  try {
    const res = await fetch(API_URL + '/api/admin/clear-history', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();
    
    if (data.success) {
      showResult('Chat history cleared');
      fetchStats();
    } else {
      showResult(data.error || 'Failed', true);
    }
  } catch (err) {
    showResult('Request failed', true);
  }
}

async function broadcastMessage() {
  const msg = document.getElementById('broadcast-msg').value.trim();
  
  if (!msg) {
    showResult('Enter a message', true);
    return;
  }

  try {
    const res = await fetch(API_URL + '/api/admin/broadcast', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ message: msg })
    });

    if (res.status === 401) {
      logout();
      return;
    }

    const data = await res.json();
    
    if (data.success) {
      showResult('Broadcast sent');
      document.getElementById('broadcast-msg').value = '';
      fetchStats();
    } else {
      showResult(data.error || 'Failed', true);
    }
  } catch (err) {
    showResult('Request failed', true);
  }
}

async function unbanUser(username) {
  if (!confirm(`Are you sure you want to unban ${username}?`)) return;

  try {
    const res = await fetch(API_URL + '/api/admin/unban', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ username })
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
      showResult(data.error || 'Failed to unban user', true);
    }
  } catch (err) {
    showResult('Request failed', true);
  }
}