# Telemetry in T3 Code Atelier

Open **Settings > Diagnostics** and select an environment. **What to send** shows the available channels and whether each can send. Select the channels you want, then turn on **Send telemetry**. Switching it off takes effect immediately and remembers your choices and receiver addresses.

A fresh installation starts with every channel off. When you upgrade, a receiver you previously configured in settings or through the environment continues receiving its configured signals. Product analytics and T3 Connect tracing each require an explicit choice.

The settings apply to the selected server. The Atelier browser and desktop renderer follow their authenticated primary server's permissions. Desktop main follows its embedded environment. **All environments** reports which servers confirmed the change, which are unavailable and which need an update. A disconnected server keeps its previous settings.

## Product usage data

With product analytics enabled, the server sends product usage events to T3 Code's own endpoint at `ingest.t3.codes`,
associated with a hashed account or installation identifier. To count installations, the server can report hashed identifiers for signed-in T3 Connect, OpenAI and
Claude accounts. Official clients can also supply a hashed device identifier when they connect. Atelier
clients omit analytics identifiers from the connection handshake. The endpoint keeps a copy of each
event and forwards events to PostHog. Events include the provider, model, reasoning effort,
permission mode, turn and request results, duration, release channel, and token counts when
available. Child-agent token counts are reported separately from the main agent's. Model names
are sent only when they appear in a provider's public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Relay connection diagnostics

Builds configured for T3 Connect tracing can send relay connection traces to Axiom. Depending on the client version, traces can include connection timings, environment identifiers and the connected machine's name. Failed spans can include error messages and stack traces. Error text can quote a value the app was handling.

Setting `T3CODE_TELEMETRY_ENABLED=false` or disabling telemetry through [managed policy](./managed-policy.md#other-capabilities) blocks product events and T3 Connect tracing. Your own OpenTelemetry receiver remains available. The effective `T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` setting disables OpenTelemetry exports, including Connect traces. The T3-specific variable takes precedence.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile on macOS and Linux. On Windows, set it as a user environment variable. Restart the app after changing its startup environment.

## Mobile app diagnostics

Official clients use their own controls. When the official iOS or Android app crashes or hits an error, it sends a report to T3 Code: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay to Axiom. They do not include your threads, prompts, or connection details,
but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About T3 Code > Diagnostics**.

The mobile app also sends relay connection traces when its build has tracing configured. These
carry an identifier for the current app session. **Send crash reports** does not control these
traces, and the mobile app has no separate relay tracing toggle. Server environment variables and
managed policy do not disable mobile tracing.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

For receiver-only export, open **What to send**, select **My OpenTelemetry receiver**, and leave both T3 channels off. In a single environment, enter and save the OTLP HTTP endpoint for each signal you want (for example `http://localhost:4318/v1/traces`). Turn on **Send telemetry**. Changes take effect immediately.

The receiver must be reachable from that server. When the channel is active, opening the endpoint settings checks the saved addresses. **Test** sends an empty export from the server. Checks send authentication headers only to the currently configured endpoint for that signal and do not follow redirects. Save a new address before testing it with authentication.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
