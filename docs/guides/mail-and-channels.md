# Mail and notification channels

Open **Mailbox → Add account** to configure your own Gmail or Outlook delegated
OAuth credentials. The setup screen lists the required scopes. This version
does not ship an OAuth application or a hosted sign-in callback: bring your own
access token and, optionally, refresh credentials. Saving only stores encrypted
credentials; it does not contact the provider. Credentials are never returned
to the browser after saving. Each account and local draft belongs to one user.

Choose an account and folder, search, then open a message in the safe text view.
Remote images and active content are not loaded. Attachments up to 5 MB are
downloaded as files rather than rendered inline. Folder browsing currently shows
the provider's first folder page; All mail searches across the mailbox.

Compose and save a local draft, then choose **Review and send**. The confirmation
names the sending account, recipients and subject and binds to the saved draft
revision. Sending requires a recently authenticated browser session. If delivery
becomes uncertain, check the provider's Sent folder before composing again; the
application never automatically retries a possibly sent message.

**Summarize locally** requires a separate confirmation. The instance owner must
configure an enabled, keyless OpenAI-compatible provider at literal loopback
`127.0.0.1` or `::1`. The selected message's subject, sender and up to 40,000
characters go to that service without agent tools or conversation persistence.
Reading mail does not require a model. No cloud summary endpoint is selected
automatically.

In notification settings, optionally add SMTP over implicit TLS or a Bark
endpoint with a separately stored device key. Values start empty and credentials
are encrypted. Test delivery happens only after an explicit test action. Channel
destinations use guarded public-network access. Existing in-app notifications
and Web Push remain available independently.

Agents can propose structured reminders through their normal tool approval
flow. Review the text, destination and time zone before accepting. Inspect,
pause or resume saved reminders in Automations; proposing a reminder is not
permission to perform arbitrary agent work in the background.
