# Logout E2E Tests

This directory contains end-to-end tests for the logout functionality in the chat application.

## Test Structure

### `logout.test.js`
Unit-style E2E tests that spin up a minimal WebSocket server to test the logout flow in isolation:

- **Test 1: Basic Logout** - Verifies that a user can properly logout and their state is cleaned up
- **Test 2: Re-login After Logout** - Ensures that after logging out, the same username can be used again immediately
- **Test 3: Unauthorized Logout** - Confirms that logout requires authentication
- **Test 4: Multiple Users** - Tests that multiple users can logout independently without affecting each other

### `server-logout.test.js`
Integration tests that run against the actual server:

- **Test 1: Full Logout Cycle** - Tests authentication, logout, and re-authentication against the real server
- **Test 2: Departure Broadcast** - Verifies that other users see a departure message when someone logs out

## Running Tests

```bash
# Run all tests
npm test

# Run only logout tests
npm run test:logout

# Run with verbose output
npm test -- --reporter spec
```

## Logout Flow

### Client-Side (docs/index.html)
1. User clicks "Cerrar sesión" button
2. Confirmation modal appears
3. User confirms logout
4. Client sends `{ type: "logout" }` message to server
5. Client waits 100ms for server to process
6. Client closes WebSocket connection
7. Client clears all state (username, localStorage, chat history)
8. Username prompt is shown for re-login

### Server-Side (server.js)
1. Server receives `{ type: "logout" }` message
2. Server performs immediate cleanup (no grace period):
   - Removes client from clients map
   - Removes deviceId mapping
   - Removes username from active usernames
   - Clears rate limit data
3. Server sends `{ type: "loggedOut" }` confirmation
4. Server broadcasts departure message to other users
5. Server closes the connection

## Key Improvements

The logout overhaul addresses several issues:

1. **Immediate Cleanup** - Explicit logouts now do immediate cleanup instead of waiting for the 10-second grace period
2. **Proper State Reset** - All client state is properly cleared on logout
3. **Server Confirmation** - Server sends confirmation before closing connection
4. **Username Availability** - Logged out usernames are immediately available for reuse
5. **No Race Conditions** - Client waits for server to process logout before closing connection
6. **Broadcast Departure** - Other users are notified when someone logs out

## Testing Notes

- Tests use dynamic ports to avoid conflicts
- Integration tests spawn the actual server process
- Tests clean up all connections and processes properly
- All tests include proper timeouts and error handling
