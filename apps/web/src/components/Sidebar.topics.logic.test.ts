import { indexThreadTopics } from "@t3tools/client-runtime/state/thread-topics";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadTopicId,
  type ThreadTopicsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { arrangeFolderTopics, sharedTopicProject, sidebarTopicKey } from "./Sidebar.topics.logic";

const env = EnvironmentId.make("env-1");
const otherEnv = EnvironmentId.make("env-2");
const project = ProjectId.make("project-1");
const otherProject = ProjectId.make("project-2");

const thread = (id: string, projectId = project, environmentId = env) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId,
});
type Thread = ReturnType<typeof thread>;

const topic = (id: string, orderKey: string, projectId = project) => ({
  id: ThreadTopicId.make(id),
  projectId,
  title: id,
  orderKey,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const snapshot: ThreadTopicsSnapshot = {
  topics: [topic("later", "n"), topic("first", "c"), topic("empty", "a")],
  memberships: [
    { threadId: ThreadId.make("t1"), topicId: ThreadTopicId.make("later") },
    { threadId: ThreadId.make("t3"), topicId: ThreadTopicId.make("later") },
    { threadId: ThreadId.make("t4"), topicId: ThreadTopicId.make("first") },
    // A thread that moved to another project keeps a stale membership.
    { threadId: ThreadId.make("moved"), topicId: ThreadTopicId.make("first") },
    { threadId: ThreadId.make("settled"), topicId: ThreadTopicId.make("empty") },
  ],
};

const threadKey = (value: Thread) => `${value.environmentId}:${value.id}`;

const arrange = (
  threads: readonly Thread[],
  options: { collapsed?: ReadonlySet<string>; routeThreadKey?: string } = {},
) =>
  arrangeFolderTopics({
    threads,
    indexes: new Map([[env, indexThreadTopics(snapshot)]]),
    isCollapsed: (key) => options.collapsed?.has(key) ?? false,
    routeThreadKey: options.routeThreadKey ?? null,
    threadKey,
  });

const ids = (threads: readonly Thread[]) => threads.map((value) => value.id);

describe("arrangeFolderTopics", () => {
  it("puts topics first in manual order, keeps thread order, and hides topics without active threads", () => {
    const arranged = arrange([
      thread("t1"),
      thread("t2"),
      thread("t3"),
      thread("t4"),
      thread("moved", otherProject),
    ]);
    expect(arranged.topics.map((block) => block.topic.id)).toEqual(["first", "later"]);
    expect(arranged.topics.map((block) => ids(block.threads))).toEqual([["t4"], ["t1", "t3"]]);
    expect(ids(arranged.looseThreads)).toEqual(["t2", "moved"]);
    expect(ids(arranged.threads)).toEqual(["t4", "t1", "t3", "t2", "moved"]);
  });

  it("keeps only the open thread of a closed topic", () => {
    const arranged = arrange([thread("t1"), thread("t2"), thread("t3")], {
      collapsed: new Set([sidebarTopicKey(env, "later")]),
      routeThreadKey: "env-1:t3",
    });
    const [later] = arranged.topics;
    expect(later!.collapsed).toBe(true);
    expect(ids(later!.threads)).toEqual(["t3"]);
    expect(ids(later!.hiddenThreads)).toEqual(["t1"]);
    expect(ids(arranged.threads)).toEqual(["t3", "t2"]);
  });

  it("leaves threads of environments without topics alone", () => {
    const arranged = arrange([thread("t1", project, otherEnv), thread("t2")]);
    expect(arranged.topics).toEqual([]);
    expect(ids(arranged.looseThreads)).toEqual(["t1", "t2"]);
  });
});

describe("sharedTopicProject", () => {
  it("needs one project in one environment", () => {
    expect(sharedTopicProject([thread("a"), thread("b")])).toEqual({
      environmentId: env,
      projectId: project,
    });
    expect(sharedTopicProject([thread("a"), thread("b", otherProject)])).toBeNull();
    expect(sharedTopicProject([thread("a"), thread("b", project, otherEnv)])).toBeNull();
    expect(sharedTopicProject([])).toBeNull();
  });
});
