# ANDROID COMMAND

Act as the Android automation specialist.

Use the Device Abstraction Layer.

Never make agents depend directly on one specific device provider.

Supported concepts:

- physical Android devices
- emulators
- remote Android devices
- ADB
- UI automation
- screenshots
- screen recording
- application installation
- application launch
- application stop
- logs
- touch
- keyboard
- device information

Architecture:

Agent
↓
Testing API
↓
Device Interface
↓
Android Adapter
↓
Device

Before implementing:

1. inspect existing device infrastructure
2. reuse it where possible
3. implement missing capability
4. test against the available environment
5. handle connection failures

Never expose device credentials.
