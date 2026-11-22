import { indexThreadTopics } from "@t3tools/client-runtime/state/thread-topics";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadTopicId,
  type ThreadTopicsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeFolderTopics,
  draftTopicId,
  planTopicReorder,
  planTopicThreadDrop,
  sharedTopicProject,
  sidebarFolderTopicsLayoutKey,
  sidebarTopicKey,
  sidebarTopicRowId,
  topicDraftSlot,
} from "./Sidebar.topics.logic";

import { draftSlotKey } from "../lib/draftSlots";

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

const arrange = (threads: readonly Thread[], options: { collapsed?: ReadonlySet<string> } = {}) =>
  arrangeFolderTopics({
    threads,
    indexes: new Map([[env, indexThreadTopics(snapshot)]]),
    isCollapsed: (key) => options.collapsed?.has(key) ?? false,
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

  it("hides every thread of a closed topic", () => {
    const arranged = arrange([thread("t1"), thread("t2"), thread("t3")], {
      collapsed: new Set([sidebarTopicKey(env, "later")]),
    });
    const [later] = arranged.topics;
    expect(later!.collapsed).toBe(true);
    expect(ids(later!.threads)).toEqual([]);
    expect(ids(later!.hiddenThreads)).toEqual(["t1", "t3"]);
    expect(ids(arranged.threads)).toEqual(["t2"]);
  });

  it("keys the drawn layout by topic order and membership, not just the thread count", () => {
    const threads = [thread("t1"), thread("t2"), thread("t4")];
    const key = (value: ThreadTopicsSnapshot) => {
      const topics = arrangeFolderTopics({
        threads,
        indexes: new Map([[env, indexThreadTopics(value)]]),
        isCollapsed: () => false,
      });
      return sidebarFolderTopicsLayoutKey({ threads: topics.threads, topics });
    };
    const reordered: ThreadTopicsSnapshot = {
      ...snapshot,
      topics: [topic("later", "a"), topic("first", "c")],
    };
    expect(key(reordered)).not.toBe(key(snapshot));
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

describe("planTopicThreadDrop", () => {
  const indexes = new Map([[env, indexThreadTopics(snapshot)]]);
  const folderRow = "folder:repo";
  const folderProjects = (rowId: string) =>
    rowId === folderRow ? [{ environmentId: env, projectId: project }] : null;
  const laterRow = sidebarTopicRowId(sidebarTopicKey(env, "later"));
  const plan = (threads: readonly Thread[], row: { rowId: string; parentId?: string } | null) =>
    planTopicThreadDrop({
      threads,
      row: row && { rowId: row.rowId, parentId: row.parentId },
      indexes,
      folderProjects,
    });

  it("joins the topic under a header or a row inside the topic", () => {
    expect(plan([thread("t2")], { rowId: laterRow, parentId: folderRow })).toEqual({
      environmentId: env,
      threadIds: ["t2"],
      topicId: "later",
      targetRowId: laterRow,
    });
    expect(plan([thread("t2"), thread("t4")], { rowId: "env-1:t1", parentId: laterRow })).toEqual(
      expect.objectContaining({ topicId: "later", threadIds: ["t2", "t4"] }),
    );
    // Already there: nothing to do.
    expect(plan([thread("t1")], { rowId: laterRow, parentId: folderRow })).toBeNull();
  });

  it("leaves the topic on the folder header or a row without a topic", () => {
    expect(plan([thread("t1")], { rowId: folderRow })).toEqual(
      expect.objectContaining({ topicId: null, targetRowId: folderRow }),
    );
    expect(plan([thread("t1")], { rowId: "env-1:t2", parentId: folderRow })).toEqual(
      expect.objectContaining({ topicId: null }),
    );
    expect(plan([thread("t2")], { rowId: folderRow })).toBeNull();
  });

  it("never crosses projects or environments", () => {
    expect(plan([thread("x", otherProject)], { rowId: laterRow })).toBeNull();
    expect(plan([thread("x", project, otherEnv)], { rowId: laterRow })).toBeNull();
    expect(plan([thread("t2"), thread("x", otherProject)], { rowId: laterRow })).toBeNull();
    expect(plan([thread("t1", project)], { rowId: "folder:other" })).toBeNull();
    expect(plan([thread("t1")], null)).toBeNull();
    // A dragged row stays put; releasing over it, even with the folder as its parent, is no drop.
    expect(plan([thread("t1")], { rowId: "env-1:t1", parentId: folderRow })).toBeNull();
  });
});

describe("planTopicReorder", () => {
  const order = ["a", "b", "c", "d"].map((id) => ThreadTopicId.make(id));
  const plan = (movedId: string, targetId: string, placeAfter: boolean) =>
    planTopicReorder({
      order,
      movedId: ThreadTopicId.make(movedId),
      targetId: ThreadTopicId.make(targetId),
      placeAfter,
    });

  it("places the topic before or after its drop target", () => {
    expect(plan("d", "a", false)).toEqual({ afterTopicId: null });
    expect(plan("a", "c", true)).toEqual({ afterTopicId: "c" });
    expect(plan("a", "c", false)).toEqual({ afterTopicId: "b" });
    expect(plan("d", "b", true)).toEqual({ afterTopicId: "b" });
  });

  it("ignores drops that keep the order", () => {
    expect(plan("b", "b", true)).toBeNull();
    expect(plan("b", "a", true)).toBeNull();
    expect(plan("b", "c", false)).toBeNull();
    expect(plan("z", "a", false)).toBeNull();
  });
});

describe("draftTopicId", () => {
  it("reads the topic back from a topic draft's slot key, and nothing from a project's", () => {
    const projectKey = "/work/app";
    const topicSlot = topicDraftSlot(ThreadTopicId.make("t-1"));
    expect(draftTopicId(draftSlotKey(projectKey, topicSlot))).toBe("t-1");
    expect(draftTopicId(projectKey)).toBeNull();
    // A project whose path reads like a topic slot keeps a plain draft of its own.
    expect(draftTopicId(`${projectKey}#${topicSlot}`)).toBeNull();
    expect(draftSlotKey(projectKey, topicSlot)).not.toBe(`${projectKey}#${topicSlot}`);
  });
});
