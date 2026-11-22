import { threadTopicOf, type ThreadTopicIndex } from "@t3tools/client-runtime/state/thread-topics";
import type {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ThreadTopic,
  ThreadTopicId,
} from "@t3tools/contracts";

// Atelier fork: topics in the sidebar's project filter. Picked topics are stored beside the
// picked projects; a project with picked topics, or "No topic", shows only those.

export function topicScopeKey(environmentId: EnvironmentId, topicId: ThreadTopicId): string {
  return `topic:${environmentId}:${topicId}`;
}

export function noTopicScopeKey(projectKey: string): string {
  return `no-topic:${projectKey}`;
}

interface ScopeGroup {
  readonly projectKey: string;
  readonly memberProjectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
}

export interface SidebarScopeTopic {
  readonly key: string;
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly topic: ThreadTopic;
}

/**
 * The topics a project can narrow to, across its members in environments that serve topics, in
 * display order; null when none of its environments serves topics.
 */
function sidebarScopeTopicsOf(
  group: ScopeGroup,
  indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>,
): readonly SidebarScopeTopic[] | null {
  let served = false;
  const topics: SidebarScopeTopic[] = [];
  for (const ref of group.memberProjectRefs) {
    const index = indexes.get(ref.environmentId);
    if (index === undefined) continue;
    served = true;
    for (const topic of index.topicsByProjectId.get(ref.projectId) ?? []) {
      topics.push({
        key: topicScopeKey(ref.environmentId, topic.id),
        projectKey: group.projectKey,
        environmentId: ref.environmentId,
        topic,
      });
    }
  }
  return served ? topics : null;
}

export interface SidebarTopicScope {
  /** Projects picked whole: all their threads show. */
  readonly wholeProjectKeys: readonly string[];
  /** Picked topic and "No topic" keys that still exist, in stored order. */
  readonly topicKeys: readonly string[];
  /** The picked keys of each project they narrow. */
  readonly topicKeysByProject: ReadonlyMap<string, readonly string[]>;
  /** Every project the filter shows threads of, whole or narrowed. */
  readonly projectKeys: readonly string[];
  /** Picked topics by key; "No topic" keys are not here. */
  readonly topicByKey: ReadonlyMap<string, SidebarScopeTopic>;
  /** Stored keys that match no current topic; picks keep them for when it returns. */
  readonly unresolvedTopicKeys: readonly string[];
}

export const EMPTY_SIDEBAR_TOPIC_SCOPE: SidebarTopicScope = {
  wholeProjectKeys: [],
  topicKeys: [],
  topicKeysByProject: new Map(),
  projectKeys: [],
  topicByKey: new Map(),
  unresolvedTopicKeys: [],
};

/**
 * Reads the stored picks against the current projects and topics. Keys of disbanded topics,
 * of projects that are not choices, or of environments without topics are ignored but kept in
 * storage, like project keys, so they apply again if their topic returns.
 */
export function resolveSidebarTopicScope(input: {
  /** Projects the filter can pick, in menu order. */
  readonly groups: readonly ScopeGroup[];
  /** Picked projects, already resolved against `groups`. */
  readonly projectKeys: readonly string[];
  readonly topicKeys: readonly string[];
  readonly indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>;
}): SidebarTopicScope {
  const { groups, indexes } = input;
  if (input.projectKeys.length === 0 && input.topicKeys.length === 0) {
    return EMPTY_SIDEBAR_TOPIC_SCOPE;
  }
  const projectOfKey = new Map<string, string>();
  const topicByKey = new Map<string, SidebarScopeTopic>();
  if (input.topicKeys.length > 0) {
    for (const group of groups) {
      const topics = sidebarScopeTopicsOf(group, indexes);
      if (topics === null) continue;
      projectOfKey.set(noTopicScopeKey(group.projectKey), group.projectKey);
      for (const topic of topics) projectOfKey.set(topic.key, group.projectKey);
      for (const topic of topics) topicByKey.set(topic.key, topic);
    }
  }
  const storedTopicKeys = [...new Set(input.topicKeys)];
  const topicKeys = storedTopicKeys.filter((key) => projectOfKey.has(key));
  const topicKeysByProject = new Map<string, string[]>();
  for (const key of topicKeys) {
    const projectKey = projectOfKey.get(key)!;
    const keys = topicKeysByProject.get(projectKey);
    if (keys) keys.push(key);
    else topicKeysByProject.set(projectKey, [key]);
  }
  const wholeProjectKeys = input.projectKeys.filter((key) => !topicKeysByProject.has(key));
  const scoped = new Set([...wholeProjectKeys, ...topicKeysByProject.keys()]);
  return {
    wholeProjectKeys,
    topicKeys,
    topicKeysByProject,
    projectKeys: groups.flatMap((group) => (scoped.has(group.projectKey) ? group.projectKey : [])),
    topicByKey: new Map(
      topicKeys.flatMap((key) => {
        const topic = topicByKey.get(key);
        return topic ? [[key, topic] as const] : [];
      }),
    ),
    unresolvedTopicKeys: storedTopicKeys.filter((key) => !projectOfKey.has(key)),
  };
}

export interface SidebarTopicScopeMatcher {
  /** `environmentId:projectId` of every project the scope narrows. */
  readonly narrowedRefKeys: ReadonlySet<string>;
  readonly matchesThread: (thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
  }) => boolean;
  /** Drafts name their topic by draft slot rather than membership. */
  readonly matchesDraft: (draft: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly topicId: ThreadTopicId | null;
  }) => boolean;
}

/**
 * Tests rows of the projects the scope narrows; rows of other projects pass, so the project
 * filter still decides those. Null when no project is narrowed.
 */
export function createSidebarTopicScopeMatcher(input: {
  readonly scope: SidebarTopicScope;
  readonly groups: readonly ScopeGroup[];
  readonly indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>;
  /**
   * Topics of threads sent from a topic's draft, by `environmentId:threadId`. The thread can
   * reach the list before it joins the topic, and must not leave the filter meanwhile.
   */
  readonly draftTopicIdByThread?: ReadonlyMap<string, ThreadTopicId>;
}): SidebarTopicScopeMatcher | null {
  const { scope, indexes } = input;
  if (scope.topicKeysByProject.size === 0) return null;
  const narrowedByRef = new Map<string, { projectKey: string; keys: ReadonlySet<string> }>();
  for (const group of input.groups) {
    const keys = scope.topicKeysByProject.get(group.projectKey);
    if (keys === undefined) continue;
    const narrowed = { projectKey: group.projectKey, keys: new Set(keys) };
    for (const ref of group.memberProjectRefs) {
      narrowedByRef.set(`${ref.environmentId}:${ref.projectId}`, narrowed);
    }
  }
  const matches = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    topicId: ThreadTopicId | null,
  ) => {
    const narrowed = narrowedByRef.get(`${environmentId}:${projectId}`);
    if (narrowed === undefined) return true;
    return narrowed.keys.has(
      topicId === null
        ? noTopicScopeKey(narrowed.projectKey)
        : topicScopeKey(environmentId, topicId),
    );
  };
  // A draft whose topic is gone, or belongs elsewhere, files its thread without one.
  const draftTopicOf = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    topicId: ThreadTopicId | null | undefined,
  ) => {
    const topic = topicId == null ? undefined : indexes.get(environmentId)?.topicById.get(topicId);
    return topic !== undefined && topic.projectId === projectId ? topic.id : null;
  };
  return {
    narrowedRefKeys: new Set(narrowedByRef.keys()),
    matchesThread: (thread) => {
      const index = indexes.get(thread.environmentId);
      const topicId =
        (index ? threadTopicOf(index, thread)?.id : undefined) ??
        draftTopicOf(
          thread.environmentId,
          thread.projectId,
          input.draftTopicIdByThread?.get(`${thread.environmentId}:${thread.id}`),
        );
      return matches(thread.environmentId, thread.projectId, topicId);
    },
    matchesDraft: (draft) =>
      matches(
        draft.environmentId,
        draft.projectId,
        draftTopicOf(draft.environmentId, draft.projectId, draft.topicId),
      ),
  };
}

export type SidebarScopePick =
  | { readonly kind: "project"; readonly projectKey: string }
  | { readonly kind: "topic"; readonly projectKey: string; readonly key: string };

export interface SidebarScopeSelection {
  readonly projectKeys: readonly string[];
  readonly topicKeys: readonly string[];
}

/** A plain click keeps only the clicked item. */
export function pickSidebarScopeItem(pick: SidebarScopePick): SidebarScopeSelection {
  return pick.kind === "project"
    ? { projectKeys: [pick.projectKey], topicKeys: [] }
    : { projectKeys: [], topicKeys: [pick.key] };
}

/**
 * Shift adds or removes an item. Adding a project shows all of it again; adding a topic to a
 * project shown whole narrows it to that topic. A project whose last topic is removed leaves
 * the filter.
 */
export function toggleSidebarScopeItem(
  scope: SidebarTopicScope,
  pick: SidebarScopePick,
): SidebarScopeSelection {
  const { projectKeys, topicKeys } = toggleResolvedSidebarScopeItem(scope, pick);
  return { projectKeys, topicKeys: [...scope.unresolvedTopicKeys, ...topicKeys] };
}

function toggleResolvedSidebarScopeItem(
  scope: SidebarTopicScope,
  pick: SidebarScopePick,
): SidebarScopeSelection {
  if (pick.kind === "project") {
    if (scope.wholeProjectKeys.includes(pick.projectKey)) {
      return {
        projectKeys: scope.wholeProjectKeys.filter((key) => key !== pick.projectKey),
        topicKeys: scope.topicKeys,
      };
    }
    const own = new Set(scope.topicKeysByProject.get(pick.projectKey) ?? []);
    return {
      projectKeys: [...scope.wholeProjectKeys, pick.projectKey],
      topicKeys: scope.topicKeys.filter((key) => !own.has(key)),
    };
  }
  if (scope.topicKeys.includes(pick.key)) {
    return {
      projectKeys: scope.wholeProjectKeys,
      topicKeys: scope.topicKeys.filter((key) => key !== pick.key),
    };
  }
  return {
    projectKeys: scope.wholeProjectKeys.filter((key) => key !== pick.projectKey),
    topicKeys: [...scope.topicKeys, pick.key],
  };
}

export type SidebarScopeMenuItem =
  | { readonly kind: "all"; readonly value: "all"; readonly label: string }
  | {
      readonly kind: "project";
      readonly value: string;
      readonly label: string;
      readonly projectKey: string;
    }
  | {
      readonly kind: "topic";
      readonly value: string;
      readonly label: string;
      readonly projectKey: string;
      /** The project's name, shown while searching, when rows leave their project. */
      readonly projectLabel: string | null;
      readonly noTopic: boolean;
    };

/**
 * The filter menu's rows: the shown project rows, each followed by its topic rows. Without a
 * query, a project in the filter lists its topics with active threads, the picked ones, and
 * "No topic". A query lists the topics it matches in every project.
 */
export function buildSidebarScopeMenuItems(input: {
  /** "All projects" first, then projects, in menu order. */
  readonly projectItems: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  /** The project rows the query keeps. */
  readonly shownValues: ReadonlySet<string>;
  readonly groupByKey: ReadonlyMap<string, ScopeGroup>;
  readonly scope: SidebarTopicScope;
  readonly indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>;
  /** Topic keys with an active thread. */
  readonly listedTopicKeys: ReadonlySet<string>;
  readonly query: string;
  readonly matches: (label: string, query: string) => boolean;
  readonly noTopicLabel: string;
}): readonly SidebarScopeMenuItem[] {
  const query = input.query.trim();
  const picked = new Set(input.scope.topicKeys);
  const items: SidebarScopeMenuItem[] = [];
  for (const item of input.projectItems) {
    const shown = input.shownValues.has(item.value);
    const group = input.groupByKey.get(item.value);
    if (group === undefined) {
      if (shown) items.push({ kind: "all", value: "all", label: item.label });
      continue;
    }
    if (shown) {
      items.push({ kind: "project", value: item.value, label: item.label, projectKey: item.value });
    }
    if (query.length === 0 && !input.scope.projectKeys.includes(group.projectKey)) continue;
    const projectTopics = sidebarScopeTopicsOf(group, input.indexes) ?? [];
    const topics = projectTopics.filter(
      (topic) =>
        (input.listedTopicKeys.has(topic.key) || picked.has(topic.key)) &&
        (query.length === 0 || input.matches(topic.topic.title, query)),
    );
    const projectLabel = query.length === 0 ? null : item.label;
    for (const topic of topics) {
      items.push({
        kind: "topic",
        value: topic.key,
        label: topic.topic.title,
        projectKey: group.projectKey,
        projectLabel,
        noTopic: false,
      });
    }
    const noTopicKey = noTopicScopeKey(group.projectKey);
    // Shown while the project has topics, even ones without active threads to list.
    if (query.length === 0 && (projectTopics.length > 0 || picked.has(noTopicKey))) {
      items.push({
        kind: "topic",
        value: noTopicKey,
        label: input.noTopicLabel,
        projectKey: group.projectKey,
        projectLabel,
        noTopic: true,
      });
    }
  }
  return items;
}

/** Topic keys of the threads, for the filter menu's topic rows. */
export function collectSidebarTopicKeys(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
  }>,
  indexes: ReadonlyMap<EnvironmentId, ThreadTopicIndex>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const thread of threads) {
    const index = indexes.get(thread.environmentId);
    const topic = index ? threadTopicOf(index, thread) : null;
    if (topic !== null) keys.add(topicScopeKey(thread.environmentId, topic.id));
  }
  return keys;
}

/** The filter's picks for its button's label: whole projects by name, topics under theirs. */
export function describeSidebarScope(input: {
  readonly scope: SidebarTopicScope;
  readonly projectLabel: (projectKey: string) => string;
  readonly noTopicLabel: string;
}): readonly string[] {
  const { scope } = input;
  return scope.projectKeys.flatMap((projectKey) => {
    const label = input.projectLabel(projectKey);
    const keys = scope.topicKeysByProject.get(projectKey);
    if (keys === undefined) return [label];
    return keys.map(
      (key) => `${label} / ${scope.topicByKey.get(key)?.topic.title ?? input.noTopicLabel}`,
    );
  });
}

/**
 * Whether a stored key that matches no topic may still be loading: its environment is connected
 * but its config or first topic snapshot has not arrived. Keys of disconnected or removed
 * environments, and of environments without topics, are simply stale.
 */
export function sidebarTopicScopePending(input: {
  readonly unresolvedTopicKeys: readonly string[];
  readonly groups: readonly ScopeGroup[];
  readonly connected: ReadonlySet<EnvironmentId>;
  readonly configured: ReadonlySet<EnvironmentId>;
  /** Environments that serve topics, configured ones only. */
  readonly served: ReadonlySet<EnvironmentId>;
  /** Served environments whose topic subscription has answered. */
  readonly answered: ReadonlySet<EnvironmentId>;
}): boolean {
  const loading = (environmentId: EnvironmentId) =>
    input.connected.has(environmentId) &&
    (!input.configured.has(environmentId) ||
      (input.served.has(environmentId) && !input.answered.has(environmentId)));
  return input.unresolvedTopicKeys.some((key) => {
    if (key.startsWith("no-topic:")) {
      const group = input.groups.find((candidate) => noTopicScopeKey(candidate.projectKey) === key);
      return group?.memberProjectRefs.some((ref) => loading(ref.environmentId)) ?? false;
    }
    return [...input.connected].some(
      (environmentId) => key.startsWith(`topic:${environmentId}:`) && loading(environmentId),
    );
  });
}
