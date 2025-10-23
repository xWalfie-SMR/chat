const { expect } = require('chai');
const WebSocket = require('ws');
const { spawn } = require('child_process');

describe('Server Logout Integration Tests', function() {
  this.timeout(15000);
  
  let serverProcess;
  let serverPort = 8081;
  let serverReady = false;
  
  before(function(done) {
    // Start the actual server
    serverProcess = spawn('node', ['server.js'], {
      cwd: '/home/engine/project',
      env: { ...process.env, PORT: serverPort }
    });
    
    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('Server:', output.trim());
      
      if (output.includes('listening on port') || output.includes('Server running')) {
        serverReady = true;
        // Give it a moment to fully initialize
        setTimeout(done, 500);
      }
    });
    
    serverProcess.stderr.on('data', (data) => {
      console.error('Server Error:', data.toString());
    });
    
    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
      done(err);
    });
    
    // Fallback timeout to mark as ready
    setTimeout(() => {
      if (!serverReady) {
        serverReady = true;
        done();
      }
    }, 3000);
  });
  
  after(function(done) {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      setTimeout(() => {
        if (serverProcess.killed) {
          done();
        } else {
          serverProcess.kill('SIGKILL');
          done();
        }
      }, 1000);
    } else {
      done();
    }
  });
  
  it('should connect, authenticate, logout, and re-authenticate successfully', function(done) {
    const deviceId = 'integration-test-device-123';
    const username = 'integrationuser';
    
    const ws1 = new WebSocket(`ws://localhost:${serverPort}`);
    
    let authenticated1 = false;
    let loggedOut1 = false;
    
    ws1.on('open', () => {
      // Send auth
      ws1.send(JSON.stringify({
        type: 'auth',
        username: username,
        deviceId: deviceId,
        isReconnect: false
      }));
    });
    
    ws1.on('message', (data) => {
      const messageStr = data.toString();
      
      // Skip non-JSON messages (terminal mode greetings)
      if (!messageStr.startsWith('{')) {
        return;
      }
      
      const msg = JSON.parse(messageStr);
      
      if (msg.type === 'authenticated' && !authenticated1) {
        authenticated1 = true;
        expect(msg.username).to.equal(username);
        
        // Send logout
        setTimeout(() => {
          ws1.send(JSON.stringify({ type: 'logout' }));
        }, 100);
      } else if (msg.type === 'loggedOut') {
        loggedOut1 = true;
      }
    });
    
    ws1.on('close', () => {
      expect(authenticated1).to.be.true;
      expect(loggedOut1).to.be.true;
      
      // Now reconnect with a new connection
      setTimeout(() => {
        const ws2 = new WebSocket(`ws://localhost:${serverPort}`);
        
        let authenticated2 = false;
        
        ws2.on('open', () => {
          ws2.send(JSON.stringify({
            type: 'auth',
            username: username,
            deviceId: deviceId + '-new',
            isReconnect: false
          }));
        });
        
        ws2.on('message', (data) => {
          const messageStr = data.toString();
          
          if (!messageStr.startsWith('{')) {
            return;
          }
          
          const msg = JSON.parse(messageStr);
          
          if (msg.type === 'authenticated' && !authenticated2) {
            authenticated2 = true;
            // Should get same username since previous session logged out
            expect(msg.username).to.equal(username);
            
            // Logout and close
            ws2.send(JSON.stringify({ type: 'logout' }));
            setTimeout(() => ws2.close(), 100);
          }
        });
        
        ws2.on('close', () => {
          expect(authenticated2).to.be.true;
          done();
        });
        
        ws2.on('error', (err) => {
          done(err);
        });
      }, 500);
    });
    
    ws1.on('error', (err) => {
      done(err);
    });
  });
  
  it('should broadcast user departure after explicit logout', function(done) {
    const user1 = { deviceId: 'test-dev-1', username: 'departinguser' };
    const user2 = { deviceId: 'test-dev-2', username: 'observeruser' };
    
    const ws1 = new WebSocket(`ws://localhost:${serverPort}`);
    const ws2 = new WebSocket(`ws://localhost:${serverPort}`);
    
    let user1Authenticated = false;
    let user2Authenticated = false;
    let user2SawDeparture = false;
    
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
      const messageStr = data.toString();
      if (!messageStr.startsWith('{')) return;
      
      const msg = JSON.parse(messageStr);
      
      if (msg.type === 'authenticated' && !user1Authenticated) {
        user1Authenticated = true;
        
        // Wait for user2 to be ready, then logout
        setTimeout(() => {
          if (user2Authenticated) {
            ws1.send(JSON.stringify({ type: 'logout' }));
          }
        }, 500);
      }
    });
    
    ws2.on('message', (data) => {
      const messageStr = data.toString();
      if (!messageStr.startsWith('{')) return;
      
      const msg = JSON.parse(messageStr);
      
      if (msg.type === 'authenticated' && !user2Authenticated) {
        user2Authenticated = true;
        
        // Wait for user1 to be ready, then user1 will logout
        setTimeout(() => {
          if (user1Authenticated) {
            ws1.send(JSON.stringify({ type: 'logout' }));
          }
        }, 500);
      } else if (msg.type === 'chat' && msg.msg.includes('ha salido')) {
        // User2 should see the departure message
        if (msg.msg.includes(user1.username)) {
          user2SawDeparture = true;
          ws2.close();
        }
      }
    });
    
    ws2.on('close', () => {
      expect(user1Authenticated).to.be.true;
      expect(user2Authenticated).to.be.true;
      expect(user2SawDeparture).to.be.true;
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
