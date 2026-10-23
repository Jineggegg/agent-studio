# Windows companion

This optional companion connects outbound to your own Cloud Harness **HTTPS origin**. No listener, port forwarding, administrator access, scheduled task or Windows service is installed. Closing the PowerShell window stops polling.

Requirements: an interactive Windows 10/11 desktop, Windows PowerShell 5.1, trusted server TLS certificate. It controls the primary monitor only. Run without elevation; Windows may refuse input to elevated applications. The companion never disables that protection.

1. In Cloud Harness, open **Settings → Devices → Create pairing code**.
2. Copy this folder to the Windows computer. Review the two source files.
3. In Windows PowerShell, run `powershell.exe -STA -File .\Start-CloudHarness.ps1`. Follow your organization's normal policy for running reviewed scripts; do not disable machine-wide execution policy.
4. Enter the HTTPS origin, one-use code and device name when prompted. The code expires in five minutes. Pairing secrets are not command-line arguments.
5. Propose an action in Devices or ask an agent to propose one. Review the exact action in Devices and approve it. A local Windows dialog then asks again, including the exact text and current window title. **No** is the default. Approval expires; a stale or cancelled action is refused before execution.

Supported actions are a primary-screen screenshot, a single left click at a primary-screen pixel coordinate, and literal Unicode text entry into the previously active window. Text is sent with `SendInput` Unicode events, never parsed as SendKeys syntax or a command. Modifier keys must be released. Window focus must still match for text entry. There is no shell, arbitrary script, URL-opening, file-transfer, clipboard, key-chord or unattended control endpoint.

The device token is stored in `%LOCALAPPDATA%\CloudHarness\companion.xml` as a Windows DPAPI-protected credential. Only the same Windows user on that machine can decrypt it. Server storage contains only its SHA-256 hash. Do not copy this file to another computer. Use `-Pair` to pair again; disconnect the previous device first. Use `-Forget` to remove the local credential, and disconnect the device in Cloud Harness to revoke it server-side.

A screenshot is JPEG, capped at 2 MiB and scaled to at most 1600 pixels on its longest side. Coordinates remain in original primary-screen pixels. The server holds at most one screenshot per device in memory, deletes it after a single browser read or five minutes, and never returns it through agent tools. The browser clears its displayed copy after five minutes or when you select Clear. Screenshots can include sensitive windows: inspect your screen before allowing capture.

Connection failures never replay an action. A timed-out dispatched action is reported as outcome unknown. A successful response means the companion reported completion; it is not proof that the target application accepted the intended edit. Disconnect prevents new authorizations, but an action already executing cannot be recalled.

Public API references: [Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [Windows credential export with DPAPI](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/export-clixml?view=powershell-5.1).
