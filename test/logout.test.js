const { expect } = require('chai');
const WebSocket = require('ws');
const http = require('http');

describe('Logout E2E Tests', function() {
  this.timeout(10000);
  
  let server;
  let wss;
  let serverPort;
  
  before(function(done) {
    // Start a test server
    const express = require('express');
    const app = express();
    server = http.createServer(app);
    
    // Use dynamic port
    server.listen(0, () => {
      serverPort = server.address().port;
      console.log(`Test server started on port ${serverPort}`);
      
      // Load and start the WebSocket server logic
      wss = new WebSocket.Server({ server });
      
      // Copy the essential server logic for testing
      const clients = new Map();
      const activeUsernames = new Set();
      const deviceToUsername = new Map();
      const messageHistory = [];
      const SERVER_START_TIME = Date.now();
      
      function sanitizeUsername(username) {
        const sanitized = username.replace(/[^a-zA-Z0-9_]/g, '');
        if (sanitized.length === 0) return 'anon';
        if (sanitized.length > 20) return sanitized.substring(0, 20);
        return sanitized;
      }
      
      function isUsernameAvailable(username) {
        return !activeUsernames.has(username);
      }
      
      function generateUniqueUsername(requestedName) {
        const baseName = sanitizeUsername(requestedName || 'anon');
        if (isUsernameAvailable(baseName)) return baseName;
        
        let counter = 1;
        let candidateName = `${baseName}${counter}`;
        while (!isUsernameAvailable(candidateName)) {
          counter++;
          candidateName = `${baseName}${counter}`;
        }
        return candidateName;
      }
      
      function sendToClient(ws, type, data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type, ...data }));
        }
      }
      
      function immediateCleanup(ws) {
        const clientData = clients.get(ws);
        if (!clientData) return null;
        
        const { username, deviceId } = clientData;
        clients.delete(ws);
        
        if (deviceId) {
          deviceToUsername.delete(deviceId);
        }
        
        if (username) {
          activeUsernames.delete(username);
        }
        
        return { username, deviceId };
      }
      
      wss.on('connection', (ws) => {
        clients.set(ws, {
          username: null,
          deviceId: null,
          authenticated: false,
          terminalMode: false
        });
        
        sendToClient(ws, 'serverInfo', { startTime: SERVER_START_TIME });
        
        ws.on('message', (message) => {
          const clientData = clients.get(ws);
          if (!clientData) {
            ws.close();
            return;
          }
          
          const data = JSON.parse(message.toString());
          
          if (data.type === 'auth') {
            const { username: requestedName, deviceId } = data;
            const finalUsername = generateUniqueUsername(requestedName);
            
            activeUsernames.add(finalUsername);
            deviceToUsername.set(deviceId, finalUsername);
            
            clientData.username = finalUsername;
            clientData.deviceId = deviceId;
            clientData.authenticated = true;
            
            sendToClient(ws, 'authenticated', {
              username: finalUsername,
              serverStartTime: SERVER_START_TIME
            });
            
            sendToClient(ws, 'history', { messages: messageHistory });
          } else if (data.type === 'logout') {
            if (!clientData.authenticated) {
              sendToClient(ws, 'error', { msg: 'Not authenticated' });
              return;
            }
            
            const cleanupData = immediateCleanup(ws);
            sendToClient(ws, 'loggedOut', {});
            
            // Close connection
            setTimeout(() => ws.close(), 10);
          } else if (data.type === 'chat') {
            if (!clientData.authenticated) {
              sendToClient(ws, 'error', { msg: 'Not authenticated' });
              return;
            }
            
            const username = clientData.username;
            const msg = `[${username}] ${data.msg}`;
            
            // Broadcast to all
            for (const [otherWs, otherData] of clients.entries()) {
              if (otherData.authenticated && otherWs.readyState === WebSocket.OPEN) {
                sendToClient(otherWs, 'chat', { msg, timestamp: Date.now() });
              }
            }
          }
        });
        
        ws.on('close', () => {
          immediateCleanup(ws);
        });
      });
      
      done();
    });
  });
  
  after(function(done) {
    if (wss) {
      wss.close(() => {
        if (server) {
          server.close(done);
        } else {
          done();
        }
      });
    } else if (server) {
      server.close(done);
    } else {
      done();
    }
  });
  
  it('should properly logout and clean up user state', function(done) {
    const deviceId = 'test-device-123';
    const username = 'testuser';
    
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    
    let authenticated = false;
    let loggedOut = false;
    
    ws.on('open', () => {
      // Send auth message
      ws.send(JSON.stringify({
        type: 'auth',
        username: username,
        deviceId: deviceId
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'authenticated') {
        authenticated = true;
        expect(msg.username).to.equal(username);
        
        // Now send logout
        ws.send(JSON.stringify({ type: 'logout' }));
      } else if (msg.type === 'loggedOut') {
        loggedOut = true;
      }
    });
    
    ws.on('close', () => {
      expect(authenticated).to.be.true;
      expect(loggedOut).to.be.true;
      done();
    });
    
    ws.on('error', (err) => {
      done(err);
    });
  });
  
  it('should allow re-login after logout with same username', function(done) {
    const deviceId = 'test-device-456';
    const username = 'reloginuser';
    
    const ws1 = new WebSocket(`ws://localhost:${serverPort}`);
    
    let firstLoginComplete = false;
    let logoutComplete = false;
    
    ws1.on('open', () => {
      ws1.send(JSON.stringify({
        type: 'auth',
        username: username,
        deviceId: deviceId
      }));
    });
    
    ws1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'authenticated' && !firstLoginComplete) {
        firstLoginComplete = true;
        expect(msg.username).to.equal(username);
        
        // Logout
        ws1.send(JSON.stringify({ type: 'logout' }));
      } else if (msg.type === 'loggedOut') {
        logoutComplete = true;
      }
    });
    
    ws1.on('close', () => {
      expect(firstLoginComplete).to.be.true;
      expect(logoutComplete).to.be.true;
      
      // Now try to reconnect with same username
      setTimeout(() => {
        const ws2 = new WebSocket(`ws://localhost:${serverPort}`);
        
        ws2.on('open', () => {
          ws2.send(JSON.stringify({
            type: 'auth',
            username: username,
            deviceId: deviceId + '-new'
          }));
        });
        
        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'authenticated') {
            // Should be able to use same username since first session is logged out
            expect(msg.username).to.equal(username);
            ws2.close();
            done();
          }
        });
        
        ws2.on('error', (err) => {
          done(err);
        });
      }, 100);
    });
    
    ws1.on('error', (err) => {
      done(err);
    });
  });
  
  it('should not allow logout without authentication', function(done) {
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    
    let receivedError = false;
    
    ws.on('open', () => {
      // Try to logout without authenticating first
      ws.send(JSON.stringify({ type: 'logout' }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'error') {
        receivedError = true;
        expect(msg.msg).to.equal('Not authenticated');
        ws.close();
      }
    });
    
    ws.on('close', () => {
      expect(receivedError).to.be.true;
      done();
    });
    
    ws.on('error', (err) => {
      done(err);
    });
  });
  
  it('should handle multiple users logging out independently', function(done) {
    const user1 = { deviceId: 'device-1', username: 'user1' };
    const user2 = { deviceId: 'device-2', username: 'user2' };
    
    const ws1 = new WebSocket(`ws://localhost:${serverPort}`);
    const ws2 = new WebSocket(`ws://localhost:${serverPort}`);
    
    let user1Authenticated = false;
    let user2Authenticated = false;
    let user1LoggedOut = false;
    let user2LoggedOut = false;
    
    ws1.on('open', () => {
      ws1.send(JSON.stringify({
        type: 'auth',
        username: user1.username,
        deviceId: user1.deviceId
      }));
    });
    
    ws2.on('open', () => {
      ws2.send(JSON.stringify({
        type: 'auth',
        username: user2.username,
        deviceId: user2.deviceId
      }));
    });
    
    ws1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'authenticated' && !user1Authenticated) {
        user1Authenticated = true;
        
        // Logout user1 after both are authenticated
        setTimeout(() => {
          if (user2Authenticated) {
            ws1.send(JSON.stringify({ type: 'logout' }));
          }
        }, 100);
      } else if (msg.type === 'loggedOut') {
        user1LoggedOut = true;
      }
    });
    
    ws2.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'authenticated' && !user2Authenticated) {
        user2Authenticated = true;
        
        // Logout user1 after both are authenticated
        setTimeout(() => {
          if (user1Authenticated) {
            ws1.send(JSON.stringify({ type: 'logout' }));
          }
        }, 100);
      } else if (msg.type === 'chat') {
        // User2 should still be able to send messages after user1 logs out
        if (user1LoggedOut && msg.msg.includes('[user2]')) {
          ws2.close();
        }
      }
    });
    
    ws1.on('close', () => {
      expect(user1Authenticated).to.be.true;
      expect(user1LoggedOut).to.be.true;
      
      // User2 should still be connected, send a message
      ws2.send(JSON.stringify({
        type: 'chat',
        msg: 'Still here!'
      }));
    });
    
    ws2.on('close', () => {
      expect(user2Authenticated).to.be.true;
      done();
    });
    
    ws1.on('error', (err) => {
      done(err);
    });
    
    ws2.on('error', (err) => {
      done(err);
    });
  });
});
