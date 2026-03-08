/**
 * Tests for scope detection — config.json-based scope resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectScope, detectObsidianScope, resetScopeConfigCache } from "./scope.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function makeTmpHome(): string {
  const dir = path.join(
    os.tmpdir(),
    `um-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("scope detection", () => {
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = makeTmpHome();
    process.env.HOME = tmpHome;
    resetScopeConfigCache();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    resetScopeConfigCache();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("no config.json → detectScope returns 'global'", () => {
    expect(detectScope("/some/random/path")).toBe("global");
  });

  it("no config.json → detectObsidianScope returns 'global'", () => {
    expect(detectObsidianScope("Project/foo.md")).toBe("global");
  });

  it("config.json with scopeMap → returns correct scope", () => {
    const engramDir = path.join(tmpHome, ".engram");
    fs.mkdirSync(engramDir, { recursive: true });
    fs.writeFileSync(
      path.join(engramDir, "config.json"),
      JSON.stringify({
        scopeMap: {
          myproject: "/workspace/myproject",
        },
      })
    );

    expect(detectScope("/workspace/myproject/src/index.ts")).toBe("myproject");
    expect(detectScope("/other/path")).toBe("global");
  });

  it("config.json with obsidianScopeMap → returns correct scope", () => {
    const engramDir = path.join(tmpHome, ".engram");
    fs.mkdirSync(engramDir, { recursive: true });
    fs.writeFileSync(
      path.join(engramDir, "config.json"),
      JSON.stringify({
        obsidianScopeMap: {
          "Blog/": "blog",
          "Study/": "study",
        },
      })
    );

    expect(detectObsidianScope("Blog/my-post.md")).toBe("blog");
    expect(detectObsidianScope("Study/notes.md")).toBe("study");
    expect(detectObsidianScope("Random/file.md")).toBe("global");
  });

  it("invalid JSON in config.json → graceful fallback to 'global'", () => {
    const engramDir = path.join(tmpHome, ".engram");
    fs.mkdirSync(engramDir, { recursive: true });
    fs.writeFileSync(path.join(engramDir, "config.json"), "{ invalid json!!!");

    expect(detectScope("/any/path")).toBe("global");
    expect(detectObsidianScope("Blog/post.md")).toBe("global");
  });

  it("config.json with only scopeMap → obsidianScope returns 'global'", () => {
    const engramDir = path.join(tmpHome, ".engram");
    fs.mkdirSync(engramDir, { recursive: true });
    fs.writeFileSync(
      path.join(engramDir, "config.json"),
      JSON.stringify({
        scopeMap: { myproject: "/workspace/myproject" },
      })
    );

    expect(detectObsidianScope("Blog/post.md")).toBe("global");
  });

  it("resetScopeConfigCache → picks up new config", () => {
    const engramDir = path.join(tmpHome, ".engram");
    fs.mkdirSync(engramDir, { recursive: true });

    // No config initially
    expect(detectScope("/workspace/myproject/src")).toBe("global");

    // Create config
    resetScopeConfigCache();
    fs.writeFileSync(
      path.join(engramDir, "config.json"),
      JSON.stringify({
        scopeMap: { myproject: "/workspace/myproject" },
      })
    );

    expect(detectScope("/workspace/myproject/src")).toBe("myproject");
  });
});
