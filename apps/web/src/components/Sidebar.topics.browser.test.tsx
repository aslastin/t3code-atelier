import { createMemoryHistory } from "@tanstack/react-router";
import { ThreadTopicId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  answerThreadTopics,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  PROJECT_ID,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("drags a folder thread out of its topic onto the folder", async () => {
  await page.viewport(1400, 900);
  const [member, loose] = [threadWithHistory("member", 1), threadWithHistory("loose", 1)];
  using _environment = installFakeEnvironment([member, loose], {
    capabilities: { threadTopics: true },
  });
  using topics = answerThreadTopics();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${loose.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const folder = page.getByRole("button", { name: /^render/ });
  await expect.element(folder).toHaveAttribute("aria-expanded", "true");
  const memberRow = page.getByTestId("sidebar-row-folder").filter({ hasText: member.title });
  await expect.element(memberRow).toBeInTheDocument();

  // The user's own key makes the topic's arrival their move, so the shift guard keeps the press.
  await userEvent.keyboard("{Shift}");
  await topics.emit({
    topics: [
      {
        id: ThreadTopicId.make("topic-auth"),
        projectId: PROJECT_ID,
        title: "Auth",
        orderKey: "n",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    memberships: [{ threadId: member.id, topicId: ThreadTopicId.make("topic-auth") }],
  });
  const topic = page.getByRole("button", { name: "Auth", exact: true });
  await expect.element(topic).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(memberRow.element().closest<HTMLElement>("[data-sidebar-row]")!)
    .toHaveAttribute("data-sidebar-parent", `topic:${ENVIRONMENT_ID}:topic-auth`);

  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  // Focusing the composer can scroll the page; hit testing needs the rows on screen.
  folder.element().scrollIntoView({ block: "start" });
  const from = memberRow.element().getBoundingClientRect();
  const to = folder.element().getBoundingClientRect();
  await act(() => {
    memberRow.element().dispatchEvent(pointer("pointerdown", from.x + 20, from.y + 10));
    document.dispatchEvent(pointer("pointermove", from.x + 20, from.y + 30));
    document.dispatchEvent(pointer("pointermove", to.x + 40, to.y + to.height / 2));
  });
  await vi.waitFor(() => {
    expect(folder.element().hasAttribute("data-topic-drop-target")).toBe(true);
  });
  await act(() => document.dispatchEvent(pointer("pointerup", to.x + 40, to.y + to.height / 2)));
  await vi.waitFor(() => {
    expect(topics.mutations).toEqual([
      { type: "topic.assign", threadIds: [member.id], topicId: null },
    ]);
  });
  expect(folder.element().hasAttribute("data-topic-drop-target")).toBe(false);
});
