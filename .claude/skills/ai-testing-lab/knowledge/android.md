# ANDROID TESTING

The Android layer must remain independent from AI agents.

Capabilities:

- device discovery
- connection
- installation
- launch
- stop
- uninstall
- screenshot
- recording
- touch
- typing
- UI inspection
- logs
- device information
- network state

Device states:

ONLINE
OFFLINE
BUSY
ERROR
CONNECTING
MAINTENANCE

Failures must be recoverable.

Device disconnection must not crash the platform.

## Device sources and discovery

Sources: PHYSICAL, EMULATOR, REMOTE, MOCK. AdbDevice infers it from the serial
(emulator-* → EMULATOR, host:port → REMOTE, else PHYSICAL).
Discovery goes through the DeviceDiscovery interface (AdbDiscovery parses `adb devices -l`).
Readiness is checked with DeviceManager.checkHealth() before a lease is taken.
