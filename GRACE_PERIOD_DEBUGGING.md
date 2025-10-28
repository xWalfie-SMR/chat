# Grace Period Debugging Documentation

## Overview
Comprehensive debugging has been added to all grace period related code to help diagnose and troubleshoot reconnection issues.

## Grace Period Functionality
The grace period (`RECONNECT_GRACE_PERIOD = 10 seconds`) allows users to reconnect seamlessly without triggering leave/join announcements. This prevents spam from temporary disconnections due to network hiccups.

## Debug Log Prefixes

### [GRACE START]
**When:** User disconnects and grace period begins
**Information Logged:**
- Username
- Device ID
- Grace period duration
- Start timestamp (ISO format)
- Expiry timestamp (ISO format)
- Active usernames before grace period

**Example:**
```
[GRACE START] User disconnected - starting grace period
  Username: testuser
  DeviceId: abc123xyz
  Grace period: 10s
  Started at: 2025-10-28T10:30:00.000Z
  Expires at: 2025-10-28T10:30:10.000Z
  Active usernames before: testuser, alice, bob
```

### [GRACE CANCELLED]
**When:** User reconnects within grace period (before timeout expires)
**Information Logged:**
- Username
- Device ID
- Grace start timestamp
- Reconnection timestamp
- Time spent in grace period
- Remaining grace time
- Success rate (% of grace period used)

**Example:**
```
[GRACE CANCELLED] User reconnected within grace period
  Username: testuser
  DeviceId: abc123xyz
  Grace started: 2025-10-28T10:30:00.000Z
  Reconnected at: 2025-10-28T10:30:03.500Z
  Time in grace period: 3.50s
  Remaining grace time: 6.50s
  Total grace period: 10s
  Success rate: 35.0% of grace period used
```

### [GRACE EXPIRED]
**When:** Grace period timeout expires and user is cleaned up
**Information Logged:**
- Username
- Device ID
- Actual grace duration
- Expected grace duration
- Expiry timestamp
- State verification (still in timeout map, active usernames, device mapping)
- Active usernames after cleanup
- Departure broadcast confirmation

**Example:**
```
[GRACE EXPIRED] Grace period ended - cleaning up user
  Username: testuser
  DeviceId: abc123xyz
  Grace duration: 10.01s
  Expected duration: 10s
  Expired at: 2025-10-28T10:30:10.010Z
  Still in timeout map: true
  Still in active usernames: true
  Still mapped to device: true
  Cleanup completed
  Active usernames after: alice, bob
  Broadcasted departure message
```

### [QUICK RECONNECT SUCCESS]
**When:** User successfully reconnects within grace period during authentication
**Information Logged:**
- Username restored
- Device ID
- Join announcement skipped (seamless reconnect)

**Example:**
```
[QUICK RECONNECT SUCCESS] testuser (abc123xyz) reconnected within grace period
  Will NOT announce join (seamless reconnect)
```

### [RECONNECT AFTER GRACE]
**When:** User reconnects after grace period expired but device ID is still stored
**Information Logged:**
- Username restored
- Device ID
- Join announcement will be made

**Example:**
```
[RECONNECT AFTER GRACE] testuser (abc123xyz) reconnected after grace period expired
  Will announce join (user was gone)
```

### [IMMEDIATE CLEANUP]
**When:** Forced cleanup bypassing grace period (admin kicks, bans)
**Information Logged:**
- Username
- Device ID
- Reason for immediate cleanup
- Whether user had pending grace period
- Grace start time and duration if applicable
- Active usernames after cleanup

**Example:**
```
[IMMEDIATE CLEANUP] Starting immediate cleanup (bypassing grace period)
  Username: spammer
  DeviceId: xyz789abc
  Reason: Admin kick or forced disconnect
  Had pending grace period:
    Grace started: 2025-10-28T10:30:00.000Z
    Time in grace: 5.20s
    Cancelling grace period...
[IMMEDIATE CLEANUP] Completed: spammer (xyz789abc)
  Active usernames after: alice, bob
```

### [AUTH] / [AUTH CHECK 1-3]
**When:** User authenticates and server checks reconnection status
**Information Logged:**
- Requested username
- Device ID
- Reconnection flag
- Grace period status
- Stored username status
- Current active usernames
- Decision path through authentication checks
- Final username assignment
- Join announcement decision

**Example:**
```
[AUTH] Processing authentication request
  Requested username: testuser
  DeviceId: abc123xyz
  isReconnect flag: true
  Has grace period: true
  Has stored username: true
  Current active usernames: alice, bob, testuser
[AUTH CHECK 1] Checking for quick reconnect (within grace period)...
[GRACE CANCELLED] User reconnected within grace period
  ...
[QUICK RECONNECT SUCCESS] testuser (abc123xyz) reconnected within grace period
  Will NOT announce join (seamless reconnect)
[AUTH] Registering user...
  Registered testuser (abc123xyz)
  Active usernames now: alice, bob, testuser
  Sent authentication success (isQuickReconnect: true)
  Sent chat history (15 messages)
  Skipped join announcement (quick reconnect)
[AUTH COMPLETE] testuser authenticated successfully
```

### [DISCONNECT] / [DISCONNECT ERROR]
**When:** WebSocket closes or encounters an error
**Information Logged:**
- Username (or not authenticated)
- Device ID
- Authentication status
- Error details (if error disconnect)

**Example:**
```
[DISCONNECT] WebSocket closed
  Username: testuser
  DeviceId: abc123xyz
  Was authenticated: true
```

### [ADMIN STATS]
**When:** Admin panel requests user statistics
**Information Logged:**
- Active clients count
- Active usernames count
- Grace period timeouts count
- Online authenticated users count
- Details for each grace period user (username, device ID, elapsed time, remaining time)
- Total users (online + grace)

**Example:**
```
[ADMIN STATS] Collecting stats for admin panel
  Active clients: 3
  Active usernames: 3
  Grace period timeouts: 1
  Online authenticated users: 2
[ADMIN STATS] Adding grace period users...
  Grace user: testuser (abc123xyz)
    Started: 2025-10-28T10:30:00.000Z
    Elapsed: 5s
    Remaining: 5s
  Total users (online + grace): 3
```

### [GRACE DEBUG]
**When:** Various internal checks and validations
**Information Logged:**
- Function entry/exit points
- Missing data conditions
- State verification

## Monitoring Grace Period Behavior

### Success Metrics
Monitor these logs to understand reconnection success:
1. **Quick reconnects:** Look for `[GRACE CANCELLED]` followed by `[QUICK RECONNECT SUCCESS]`
2. **Grace expiry:** Look for `[GRACE EXPIRED]` to see users who didn't reconnect
3. **Success rate:** Check the "Success rate: X% of grace period used" in `[GRACE CANCELLED]` logs

### Troubleshooting
1. **Users not reconnecting successfully:**
   - Check if `[GRACE START]` is logged but no `[GRACE CANCELLED]`
   - Verify grace period duration is sufficient
   - Check network logs for connection timing

2. **Duplicate join/leave announcements:**
   - Verify `[GRACE CANCELLED]` is logging properly
   - Check if `[AUTH CHECK 1]` is detecting grace period
   - Ensure `announceJoin` is set correctly

3. **Users getting cleaned up too early:**
   - Compare "Grace duration" vs "Expected duration" in `[GRACE EXPIRED]`
   - Check for `[IMMEDIATE CLEANUP]` logs (forced removals)

4. **Admin panel not showing grace period users:**
   - Check `[ADMIN STATS]` logs
   - Verify `disconnectionTimeouts` map is populated

## Testing Recommendations

### Test Scenario 1: Quick Reconnect
1. Connect user
2. Disconnect user (network drop)
3. Reconnect within 10 seconds
4. Expected logs:
   - `[GRACE START]`
   - `[GRACE DEBUG] cancelScheduledCleanup called`
   - `[GRACE CANCELLED]`
   - `[QUICK RECONNECT SUCCESS]`

### Test Scenario 2: Grace Expiry
1. Connect user
2. Disconnect user
3. Wait 10+ seconds
4. Expected logs:
   - `[GRACE START]`
   - `[GRACE EXPIRED]` (after 10 seconds)

### Test Scenario 3: Admin Kick During Grace
1. Connect user
2. Disconnect user
3. Admin kicks user while in grace period
4. Expected logs:
   - `[GRACE START]`
   - `[IMMEDIATE CLEANUP]` (with grace cancellation details)

## Performance Considerations
- All debug logs are synchronous console.log/error calls
- Logs include timestamp serialization (toISOString())
- Array.from(activeUsernames).join() operations on every log
- Consider log level controls for production if performance becomes an issue
