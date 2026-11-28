import { assert, it } from "@effect/vitest";

import { filterPatch, patchToNumstat } from "./pluginCheckpoints.ts";

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
  // U+2028 is part of a name, not a line break, even as its first character.
  const leading = [
    "diff --git a/\u2028foo b/bar b/new",
    "similarity index 100%",
    "rename from \u2028foo b/bar",
    "rename to new",
    "",
  ].join("\n");
  const separated = [
    "diff --git a/one.txt b/part\u2028two",
    "similarity index 100%",
    "rename from one.txt",
    "rename to part\u2028two",
    "",
  ].join("\n");
  const patch = rename + quoted + separated + leading;
  assert.strictEqual(filterPatch(patch, new Set(["dir b/old.txt"])), rename);
  assert.strictEqual(filterPatch(patch, new Set(["dst.txt"])), rename);
  assert.strictEqual(filterPatch(patch, new Set(["dir"])), "");
  assert.strictEqual(filterPatch(patch, new Set(["café.txt"])), quoted);
  assert.strictEqual(filterPatch(patch, new Set(["part\u2028two"])), separated);
  assert.strictEqual(filterPatch(patch, new Set(["part"])), "");
  assert.strictEqual(filterPatch(patch, new Set(["\u2028foo b/bar"])), leading);
  assert.strictEqual(filterPatch(patch, new Set(["bar b/new"])), "");
});

it("counts a text line that mentions a binary patch as text", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -0,0 +1 @@",
    "+prefix\u2028GIT binary patch\u2028suffix",
    "",
  ].join("\n");
  assert.strictEqual(patchToNumstat(patch), "1\t0\ta.txt\0");
});
