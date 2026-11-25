// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test runs a loopback OTLP receiver.
import * as NodeHttp from "node:http";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "The corrected traces endpoint can be tested while the previous URL is still checking",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const firstProbe = Promise.withResolvers<void>();
    let slowProbeClosed = false;
    const collector = NodeHttp.createServer((request, response) => {
      request.resume();
      if (request.url === "/slow/v1/traces") {
        response.once("close", () => {
          slowProbeClosed = true;
        });
        firstProbe.resolve();
        return;
      }
      response.writeHead(200).end();
    });
    try {
      await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
      const address = collector.address();
      if (address === null || typeof address === "string") throw new Error("No collector port");
      const origin = `http://127.0.0.1:${address.port}`;

      await t3.project("demo");
      await t3.open("/settings/general");
      const diagnostics = screen.getByRole("button", "Diagnostics", { exact: true });
      await screen.getByRole("button", "General", { exact: true }).waitFor();
      expect(await diagnostics.isVisible(), "Diagnostics is in the settings sidebar").toBe(true);
      await diagnostics.tap();

      const traces = browser.locator("#otlpTracesUrl");
      const exportSection = browser.locator("#telemetry-export");
      const diagnosticsScope = screen.getByRole("button", /^Diagnostics environment:/);
      await diagnosticsScope.tap();
      await screen.getByRole("menuitemradio", /Scenario/).tap();
      await expect(exportSection.getByText("Applies to Scenario", { exact: true })).toBeVisible();
      await diagnosticsScope.tap();
      await screen.getByRole("menuitemradio", "All environments").tap();
      await expect(
        exportSection.getByText("Applies to All environments", { exact: true }),
      ).toBeVisible();
      await exportSection.getByText("What to send", { exact: true }).tap();
      const environmentChoice = exportSection.getByRole("button", /Scenario/);
      expect(
        await environmentChoice.isVisible(),
        "Choose the receiver's environment in place",
      ).toBe(true);
      await environmentChoice.tap();
      await traces.waitFor();
      const analyticsLabel = "T3 product analytics (PostHog)";
      const analyticsRow = browser
        .locator("#telemetry-export label")
        .filter({ hasText: analyticsLabel });
      const analytics = analyticsRow.getByRole("switch", analyticsLabel);
      const selectable = await analyticsRow.getByText("Off", { exact: true }).isVisible();
      expect(
        await analytics.isEnabled(),
        "Analytics respects the environment's telemetry settings",
      ).toBe(selectable);
      await browser.locator("#otlpMetricsUrl").fill(`${origin}/v1/metrics`);
      await exportSection.getByRole("button", "Save").tap();
      await exportSection.getByText("Saved", { exact: true }).waitFor();
      await exportSection.getByRole("switch", "My OpenTelemetry receiver").tap();
      await exportSection.getByText("Selected · sending paused", { exact: true }).waitFor();
      expect(await exportSection.getByRole("button", "Test").count()).toBe(0);
      await exportSection.getByRole("switch", "Send telemetry").tap();
      const tracesGroup = exportSection.getByRole("group", "Traces endpoint");
      const testTraces = tracesGroup.getByRole("button", "Test");
      await traces.fill(`${origin}/slow/v1/traces`);
      await testTraces.tap();
      await firstProbe.promise;
      await traces.fill(`${origin}/v1/traces`);
      await tracesGroup.getByText("Not checked", { exact: true }).waitFor();

      // Sample the screen before the old request reaches its server timeout.
      const canTestCorrectedUrl = await testTraces.isEnabled();
      if (slowProbeClosed)
        throw new Error("The slow telemetry probe closed before the button check");
      await app.screenshot("corrected-traces-url");
      expect(canTestCorrectedUrl, "The corrected traces URL can be tested immediately").toBe(true);
    } finally {
      collector.close();
      collector.closeAllConnections();
    }
  },
);
