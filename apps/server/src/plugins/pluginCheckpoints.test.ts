import { assert, it } from "@effect/vitest";

import { filterPatch } from "./pluginCheckpoints.ts";

it("filters a pure rename whose header splits two ways by its rename lines", () => {
  const rename = [
    "diff --git a/dir b/old.txt b/dst.txt",
    "similarity index 100%",
    "rename from dir b/old.txt",
    "rename to dst.txt",
    "",
  ].join("\n");
  const quoted = [
    'diff --git "a/caf\\303\\251.txt" b/x.txt',
    "similarity index 100%",
    'rename from "caf\\303\\251.txt"',
    "rename to x.txt",
    "",
  ].join("\n");
  // U+2028 is part of a name, not a line break.
  const separated = [
    "diff --git a/one.txt b/part\u2028two",
    "similarity index 100%",
    "rename from one.txt",
    "rename to part\u2028two",
    "",
  ].join("\n");
  const patch = rename + quoted + separated;
  assert.strictEqual(filterPatch(patch, new Set(["dir b/old.txt"])), rename);
  assert.strictEqual(filterPatch(patch, new Set(["dst.txt"])), rename);
  assert.strictEqual(filterPatch(patch, new Set(["dir"])), "");
  assert.strictEqual(filterPatch(patch, new Set(["café.txt"])), quoted);
  assert.strictEqual(filterPatch(patch, new Set(["part\u2028two"])), separated);
  assert.strictEqual(filterPatch(patch, new Set(["part"])), "");
});
