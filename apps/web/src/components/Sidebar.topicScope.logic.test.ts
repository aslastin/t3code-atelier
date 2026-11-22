import { indexThreadTopics } from "@t3tools/client-runtime/state/thread-topics";
import { EnvironmentId, ProjectId, ThreadId, ThreadTopicId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarScopeMenuItems,
  createSidebarTopicScopeMatcher,
  noTopicScopeKey,
  pickSidebarScopeItem,
  resolveSidebarTopicScope,
  type SidebarScopeSelection,
  toggleSidebarScopeItem,
  topicScopeKey,
} from "./Sidebar.topicScope.logic";

const env = EnvironmentId.make("env-1");
const plainEnv = EnvironmentId.make("env-2");
const app = ProjectId.make("app");
const web = ProjectId.make("web");
const legacy = ProjectId.make("legacy");

const topic = (id: string, projectId: ProjectId, orderKey: string) => ({
  id: ThreadTopicId.make(id),
  projectId,
  title: id,
  orderKey,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

// env-2 serves no topics, so it has no index.
const indexes = new Map([
  [
    env,
    indexThreadTopics({
      topics: [topic("payments", app, "b"), topic("auth", app, "a"), topic("styles", web, "a")],
      memberships: [
        { threadId: ThreadId.make("pay-1"), topicId: ThreadTopicId.make("payments") },
        { threadId: ThreadId.make("auth-1"), topicId: ThreadTopicId.make("auth") },
        { threadId: ThreadId.make("css-1"), topicId: ThreadTopicId.make("styles") },
      ],
    }),
  ],
]);

const groups = [
  { projectKey: "app", memberProjectRefs: [{ environmentId: env, projectId: app }] },
  { projectKey: "web", memberProjectRefs: [{ environmentId: env, projectId: web }] },
  { projectKey: "legacy", memberProjectRefs: [{ environmentId: plainEnv, projectId: legacy }] },
];

const payments = topicScopeKey(env, ThreadTopicId.make("payments"));
const auth = topicScopeKey(env, ThreadTopicId.make("auth"));
const styles = topicScopeKey(env, ThreadTopicId.make("styles"));

const resolve = (selection: SidebarScopeSelection) =>
  resolveSidebarTopicScope({ groups, indexes, ...selection });

const thread = (id: string, projectId: ProjectId, environmentId = env) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId,
});

const allThreads = [
  thread("pay-1", app),
  thread("auth-1", app),
  thread("loose-app", app),
  thread("css-1", web),
  thread("loose-web", web),
  thread("old", legacy, plainEnv),
];

/** What the sidebar lists for a selection: the project filter, then topics. */
const visible = (selection: SidebarScopeSelection) => {
  const scope = resolve(selection);
  const refs = new Set(
    groups
      .filter((group) => scope.projectKeys.includes(group.projectKey))
      .flatMap((group) => group.memberProjectRefs)
      .map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const matcher = createSidebarTopicScopeMatcher({ scope, groups, indexes });
  return allThreads
    .filter((value) => refs.size === 0 || refs.has(`${value.environmentId}:${value.projectId}`))
    .filter((value) => matcher?.matchesThread(value) ?? true)
    .map((value) => value.id);
};

describe("sidebar topic scope", () => {
  it("shows a picked project whole, and only the picked topics of a narrowed project", () => {
    expect(visible({ projectKeys: ["app"], topicKeys: [] })).toEqual([
      "pay-1",
      "auth-1",
      "loose-app",
    ]);
    expect(visible({ projectKeys: [], topicKeys: [payments] })).toEqual(["pay-1"]);
    expect(visible({ projectKeys: [], topicKeys: [noTopicScopeKey("app")] })).toEqual([
      "loose-app",
    ]);
    // Picked topics win over the same project picked whole.
    expect(
      visible({ projectKeys: ["app"], topicKeys: [payments, noTopicScopeKey("app")] }),
    ).toEqual(["pay-1", "loose-app"]);
  });

  it("unites projects, whole or narrowed", () => {
    expect(visible({ projectKeys: ["legacy"], topicKeys: [payments, styles] })).toEqual([
      "pay-1",
      "css-1",
      "old",
    ]);
    expect(resolve({ projectKeys: ["legacy"], topicKeys: [payments, styles] }).projectKeys).toEqual(
      ["app", "web", "legacy"],
    );
  });

  it("ignores keys of disbanded topics and of environments without topics", () => {
    const gone = topicScopeKey(env, ThreadTopicId.make("disbanded"));
    const scope = resolve({ projectKeys: [], topicKeys: [gone, noTopicScopeKey("legacy")] });
    expect(scope.topicKeys).toEqual([]);
    expect(scope.projectKeys).toEqual([]);
    expect(visible({ projectKeys: ["web"], topicKeys: [gone] })).toEqual(["css-1", "loose-web"]);
  });

  it("matches a topic draft by its slot's topic, and a draft without one by No topic", () => {
    const scope = resolve({ projectKeys: [], topicKeys: [payments] });
    const matcher = createSidebarTopicScopeMatcher({ scope, groups, indexes })!;
    const draft = (topicId: string | null, projectId = app) => ({
      environmentId: env,
      projectId,
      topicId: topicId === null ? null : ThreadTopicId.make(topicId),
    });
    expect(matcher.matchesDraft(draft("payments"))).toBe(true);
    expect(matcher.matchesDraft(draft("auth"))).toBe(false);
    expect(matcher.matchesDraft(draft(null))).toBe(false);
    // A topic of another project does not file the draft.
    expect(matcher.matchesDraft(draft("styles"))).toBe(false);
  });

  it("keeps a thread sent from a topic's draft in the topic until it joins one", () => {
    const scope = resolve({ projectKeys: [], topicKeys: [payments] });
    const matcher = createSidebarTopicScopeMatcher({
      scope,
      groups,
      indexes,
      draftTopicIdByThread: new Map([
        [`${env}:just-sent`, ThreadTopicId.make("payments")],
        [`${env}:auth-1`, ThreadTopicId.make("payments")],
      ]),
    })!;
    expect(matcher.matchesThread(thread("just-sent", app))).toBe(true);
    // Membership, once it lands, decides.
    expect(matcher.matchesThread(thread("auth-1", app))).toBe(false);
    expect(matcher.narrowedRefKeys).toEqual(new Set([`${env}:${app}`]));
  });
});

describe("sidebar scope picks", () => {
  const pickApp = { kind: "project", projectKey: "app" } as const;
  const pickPayments = { kind: "topic", projectKey: "app", key: payments } as const;
  const pickAuth = { kind: "topic", projectKey: "app", key: auth } as const;

  it("keeps only the clicked item on a plain click", () => {
    expect(pickSidebarScopeItem(pickPayments)).toEqual({ projectKeys: [], topicKeys: [payments] });
    expect(pickSidebarScopeItem(pickApp)).toEqual({ projectKeys: ["app"], topicKeys: [] });
  });

  it("narrows a whole project to an added topic and widens it again when the project is added", () => {
    const narrowed = toggleSidebarScopeItem(
      resolve({ projectKeys: ["app", "web"], topicKeys: [] }),
      pickPayments,
    );
    expect(narrowed).toEqual({ projectKeys: ["web"], topicKeys: [payments] });
    const both = toggleSidebarScopeItem(resolve(narrowed), pickAuth);
    expect(both).toEqual({ projectKeys: ["web"], topicKeys: [payments, auth] });
    expect(toggleSidebarScopeItem(resolve(both), pickApp)).toEqual({
      projectKeys: ["web", "app"],
      topicKeys: [],
    });
  });

  it("drops a project from the filter with its last topic", () => {
    const selection = { projectKeys: ["web"], topicKeys: [payments] };
    expect(toggleSidebarScopeItem(resolve(selection), pickPayments)).toEqual({
      projectKeys: ["web"],
      topicKeys: [],
    });
    expect(
      toggleSidebarScopeItem(resolve({ projectKeys: ["app"], topicKeys: [] }), pickApp),
    ).toEqual({ projectKeys: [], topicKeys: [] });
  });

  it("keeps ignored keys through Shift picks, so a returning topic is picked again", () => {
    const gone = topicScopeKey(env, ThreadTopicId.make("disbanded"));
    const scope = resolve({ projectKeys: [], topicKeys: [gone] });
    expect(toggleSidebarScopeItem(scope, pickPayments)).toEqual({
      projectKeys: [],
      topicKeys: [gone, payments],
    });
    expect(toggleSidebarScopeItem(scope, pickApp)).toEqual({
      projectKeys: ["app"],
      topicKeys: [gone],
    });
  });
});

describe("buildSidebarScopeMenuItems", () => {
  const projectItems = [
    { value: "all", label: "All projects" },
    { value: "app", label: "app" },
    { value: "web", label: "web" },
    { value: "legacy", label: "legacy" },
  ];
  const matches = (label: string, value: string) =>
    label.toLowerCase().includes(value.toLowerCase());
  const build = (selection: SidebarScopeSelection, query = "") =>
    buildSidebarScopeMenuItems({
      projectItems,
      // As filterSidebarProjectScopeItems keeps them.
      shownValues: new Set(
        projectItems
          .filter((item) => query === "" || (item.value !== "all" && matches(item.label, query)))
          .map((item) => item.value),
      ),
      groupByKey: new Map(groups.map((group) => [group.projectKey, group])),
      scope: resolve(selection),
      indexes,
      listedTopicKeys: new Set([payments, styles]),
      query,
      matches,
      noTopicLabel: "No topic",
    }).map((item) => (item.kind === "topic" ? `  ${item.label}` : item.label));

  it("lists the topics of projects in the filter: listed ones, picked ones, and No topic", () => {
    expect(build({ projectKeys: [], topicKeys: [] })).toEqual([
      "All projects",
      "app",
      "web",
      "legacy",
    ]);
    // auth has no active thread, so it shows only once picked.
    expect(build({ projectKeys: ["app"], topicKeys: [] })).toEqual([
      "All projects",
      "app",
      "  payments",
      "  No topic",
      "web",
      "legacy",
    ]);
    expect(build({ projectKeys: [], topicKeys: [auth] })).toEqual([
      "All projects",
      "app",
      "  auth",
      "  payments",
      "  No topic",
      "web",
      "legacy",
    ]);
    // No topic stays while the project has topics, though none has an active thread.
    expect(
      buildSidebarScopeMenuItems({
        projectItems,
        shownValues: new Set(projectItems.map((item) => item.value)),
        groupByKey: new Map(groups.map((group) => [group.projectKey, group])),
        scope: resolve({ projectKeys: ["app"], topicKeys: [] }),
        indexes,
        listedTopicKeys: new Set(),
        query: "",
        matches,
        noTopicLabel: "No topic",
      }).map((item) => item.label),
    ).toEqual(["All projects", "app", "No topic", "web", "legacy"]);
    // A project in an environment without topics never lists any.
    expect(build({ projectKeys: ["legacy"], topicKeys: [] })).toEqual([
      "All projects",
      "app",
      "web",
      "legacy",
    ]);
  });

  it("finds topics by name in every project while searching", () => {
    expect(build({ projectKeys: [], topicKeys: [] }, "sty")).toEqual(["  styles"]);
    expect(build({ projectKeys: [], topicKeys: [] }, "a")).toEqual(["app", "  payments", "legacy"]);
  });
});
