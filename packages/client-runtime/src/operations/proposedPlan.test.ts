import { NodeId, PlanId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { latestActiveProposedPlan, type ProposedPlan } from "./proposedPlan.ts";

it("keeps the current proposal actionable when older implementation links outlive their turns", () => {
  const current: ProposedPlan = {
    id: PlanId.make("revision"),
    threadId: ThreadId.make("source"),
    runId: RunId.make("newer"),
    nodeId: NodeId.make("plan"),
    kind: "proposed_plan",
    status: "active",
    markdown: "# Revised",
  };
  const historical: ProposedPlan = {
    ...current,
    id: PlanId.make("earlier"),
    runId: RunId.make("older"),
    implementationThreadId: ThreadId.make("destination"),
    status: "completed",
    detailInTurnItem: true,
    markdown: "",
  };
  expect(latestActiveProposedPlan({ plans: [historical, current], runs: [], turnItems: [] })).toBe(
    current,
  );
});
