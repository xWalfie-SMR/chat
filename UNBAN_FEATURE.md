# Unban Feature Documentation

## Overview
Added functionality to unban users who were kicked with a ban duration. This allows admins to pardon users who may have been banned for excessively long periods (e.g., 1909209 seconds).

## Features Added

### 1. Server-Side Functions (server.js)

#### New Functions:
- **`unbanDevice(deviceId)`** - Removes a device from the banned list
  - Returns `{ success: true, username }` if unbanned successfully
  - Returns `{ success: false }` if device is not banned

- **`findDeviceByUsername(username)`** - Finds a device ID by username
  - Searches active connections, deviceToUsername map, and banned devices
  - Returns deviceId or null if not found

#### Updated Functions:
- **`cleanExpiredBans()`** - Now called by the stats endpoint to clean up expired bans before reporting
- **Admin Stats API** - Now includes `bannedUsers` array with:
  - deviceId
  - username
  - remainingSeconds (time left on ban)

### 2. API Endpoints

#### POST `/api/admin/unban` (Protected)
Unbans a user by username or deviceId.

**Request Body:**
```json
{
  "username": "targetUser",  // Optional if deviceId provided
  "deviceId": "device-123"    // Optional if username provided
}
```

**Response:**
```json
{
  "success": true,
  "username": "unbannedUser"
}
```

**Broadcasts:** `[username] ha sido desbaneado por el administrador.`

### 3. Chat Commands

#### `/unban <usuario> <ADMIN_PWD>`
Allows admins to unban users from within the chat (works for both web and terminal clients).

**Usage:**
```
/unban john password123
```

**Response:**
- Success: Broadcasts unban message to all users
- Failure: Shows error message to command issuer

### 4. Admin Panel UI

#### New Section: "Banned Users"
Located between "Active Users" and "Recent Messages" sections.

**Display for each banned user:**
- Username
- Device ID
- Ban status with remaining time (e.g., "Banned (5m 30s)")
- Green "Unban" button

**Features:**
- Auto-refreshes every 3 seconds (same as stats)
- Shows countdown timer for ban duration
- Confirmation dialog before unbanning
- Success/error feedback messages

### 5. How It Works

1. **Admin Panel Unban:**
   - Admin clicks "Unban" button next to a banned user
   - Confirmation dialog appears
   - If confirmed, sends POST request to `/api/admin/unban`
   - Server removes device from bannedDevices map
   - Broadcasts unban message to all users
   - Admin panel refreshes to show updated banned list

2. **Chat Command Unban:**
   - Admin types `/unban username password`
   - Server validates admin password
   - Finds device ID associated with username
   - Removes device from bannedDevices map
   - Broadcasts unban message to all users

3. **Effect:**
   - User can immediately reconnect (no longer blocked)
   - Ban countdown timer stops
   - User appears in "Active Users" if they reconnect

## Example Scenarios

### Scenario 1: User accidentally banned for 1 million seconds
```
Admin: /kick troublemaker 1000000 password123
[troublemaker] ha sido expulsado por [Admin] durante 1000000 segundos.

Admin: /unban troublemaker password123
[troublemaker] ha sido desbaneado por [Admin].
```

### Scenario 2: Admin panel unban
1. Admin logs into admin panel
2. Sees "troublemaker" in Banned Users list with "Banned (277h 46m 40s)"
3. Clicks "Unban" button
4. Confirms the action
5. User is immediately unbanned and can reconnect

## Technical Notes

- Banned users are stored in the `bannedDevices` Map with deviceId as key
- Ban information includes: `{ expiresAt: timestamp, username: string }`
- The `findDeviceByUsername()` function searches multiple sources to find the device ID
- Expired bans are automatically cleaned up when the stats endpoint is called
- Unbanning broadcasts a system message to all connected users
