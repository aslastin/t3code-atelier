import {
  MessageId,
  ThreadId,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2CreationSource,
  type OrchestrationV2PlanArtifact,
} from "@t3tools/contracts";
import { buildPlanImplementationPrompt, proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import type { EnvironmentThreadShell, ThreadStructure } from "../state/models.ts";
import type { StartThreadTurnInput } from "./commands.ts";

export type ProposedPlan = Extract<OrchestrationV2PlanArtifact, { kind: "proposed_plan" }>;

export function latestActiveProposedPlan(
  projection: Pick<ThreadStructure, "plans" | "runs" | "turnItems"> | null,
): ProposedPlan | undefined {
  if (!projection?.plans.length) return;
  const rolledBack = new Set(
    projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
  );
  const plans = projection.plans.filter(
    (plan): plan is ProposedPlan =>
      plan.kind === "proposed_plan" &&
      plan.status === "active" &&
      (!plan.runId || !rolledBack.has(plan.runId)),
  );
  if (plans.length < 2) return plans[0];
  const runs = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  const items = new Map(
    projection.turnItems
      .filter((item) => item.type === "proposed_plan")
      .map((item) => [item.planId, item.ordinal]),
  );
  return plans.reduce((latest, plan) => {
    const run = plan.runId && runs.get(plan.runId);
    const previous = latest.runId && runs.get(latest.runId);
    return (run ?? -1) > (previous ?? -1) ||
      (run === previous && (items.get(plan.id) ?? -1) > (items.get(latest.id) ?? -1))
      ? plan
      : latest;
  });
}

export function planImplementationTurn(input: {
  source: Pick<
    EnvironmentThreadShell,
    "id" | "projectId" | "branch" | "worktreePath" | "title" | "runtimeMode"
  >;
  plan: ProposedPlan;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  newThread: boolean;
  creationSource: OrchestrationV2CreationSource;
}): StartThreadTurnInput {
  const { source, plan, modelSelection, runtimeMode, newThread, creationSource } = input;
  // Revert keeps the old message in audit history. Retries of the new attempt share a fresh key.
  const key = plan.lastRevertedImplementationRunId
    ? `reimplement-${plan.lastRevertedImplementationRunId}`
    : `implement-${plan.id}`;
  const threadId = newThread ? ThreadId.make(key) : source.id;
  return {
    threadId,
    creationSource,
    message: {
      messageId: MessageId.make(key),
      role: "user",
      text: buildPlanImplementationPrompt(plan.markdown),
      attachments: [],
    },
    sourceProposedPlan: {
      threadId: source.id,
      planId: plan.id,
      implementationRuntimeMode: runtimeMode,
      expectedSource: {
        projectId: source.projectId,
        branch: source.branch,
        worktreePath: source.worktreePath,
        runtimeMode: source.runtimeMode,
      },
    },
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    dispatchMode: "start",
    ...(newThread
      ? {
          bootstrap: {
            createThread: {
              projectId: source.projectId,
              title: proposedPlanTitle(plan.markdown)?.slice(0, 120) || source.title,
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: source.branch,
              worktreePath: source.worktreePath,
            },
          },
        }
      : {}),
  };
}
