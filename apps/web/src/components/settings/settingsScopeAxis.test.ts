import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeCheckoutChoices,
  settingsScopeCheckoutLabel,
  settingsScopeEnvironmentLabels,
} from "./settingsScopeAxis";

const member = (environmentId: string, physicalProjectKey: string, workspaceRoot = "") =>
  ({
    environmentId,
    physicalProjectKey,
    workspaceRoot,
  }) as SidebarProjectSnapshot["memberProjects"][number];
const group = (...memberProjects: SidebarProjectSnapshot["memberProjects"]) =>
  ({ memberProjects }) as SidebarProjectSnapshot;

describe("settings scope axes", () => {
  it("distinguishes environments with identical names and addresses", () => {
    const first = {
      environmentId: EnvironmentId.make("first"),
      label: "Ready",
      displayUrl: "dev@gateway:22",
    };
    const second = { ...first, environmentId: EnvironmentId.make("second") };
    const environments = [first, second];
    expect(settingsScopeEnvironmentLabels(first, environments).secondary).toBe(
      "dev@gateway:22 · first",
    );
    expect(settingsScopeEnvironmentLabels(second, environments).secondary).toBe(
      "dev@gateway:22 · second",
    );
  });

  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });

  it("offers checkouts only where an environment cannot tell them apart", () => {
    const a = member("laptop", "a");
    const b = member("laptop", "b");
    const c = member("server", "c");

    expect(settingsScopeCheckoutChoices(group(a, b, c), { machine: "laptop" })).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b), {})).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), { checkout: "b" })).toEqual([a, b]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), {})).toEqual([]);
    expect(settingsScopeCheckoutChoices(group(a, b, c), { machine: "server" })).toEqual([]);
  });

  it("labels a checkout by its full path only when its folder name repeats", () => {
    const first = member("laptop", "a", "/work/one/app");
    const second = member("laptop", "b", "C:\\work\\two\\app");
    const other = member("laptop", "c", "/work/tools");

    expect(settingsScopeCheckoutLabel(second, [first, second, other])).toBe("C:\\work\\two\\app");
    expect(settingsScopeCheckoutLabel(other, [first, second, other])).toBe("tools");
  });
});
