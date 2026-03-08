/**
 * Tests for file watcher.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase, type DatabaseInstance } from "./database.js";
import { startWatcher } from "./watcher.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock embedder
vi.mock("./embedder.js", () => {
  function fakeEmbed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(768);
    for (let i = 0; i < Math.min(text.length, 768); i++) {
      vec[i] = text.charCodeAt(i) / 256;
    }
    let norm = 0;
    for (let i = 0; i < 768; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < 768; i++) vec[i] /= norm;
    return Promise.resolve(vec);
  }
  return { embed: fakeEmbed, EMBEDDING_DIM: 768 };
});

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `um-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `um-watch-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("watcher", () => {
  let inst: DatabaseInstance;

  beforeEach(() => {
    inst = openDatabase(tmpDbPath());
  });

  afterEach(() => {
    inst.close();
  });

  it("detects new file and indexes it", async () => {
    const dir = tmpDir();
    const indexed: string[] = [];

    const w = startWatcher(inst.db, {
      vaultPath: dir,
      debounceMs: 300,
      onIndexed: (file) => indexed.push(file),
    });

    await new Promise<void>((resolve) => w.watcher.on("ready", resolve));

    fs.writeFileSync(path.join(dir, "new-note.md"), "# New Note\n\nSome content here.");

    await waitFor(() => indexed.includes("new-note.md"));

    const rows = inst.db.prepare("SELECT * FROM memories WHERE source_path = ? AND deleted = 0").all("new-note.md");
    expect(rows.length).toBeGreaterThanOrEqual(1);

    await w.close();
  }, 15000);

  it("detects file change and re-indexes", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "existing.md"), "# Existing\n\nOriginal content.");

    const indexed: string[] = [];

    const w = startWatcher(inst.db, {
      vaultPath: dir,
      debounceMs: 300,
      onIndexed: (file) => indexed.push(file),
    });

    await new Promise<void>((resolve) => w.watcher.on("ready", resolve));

    fs.writeFileSync(path.join(dir, "existing.md"), "# Existing\n\nUpdated content with new info.");

    await waitFor(() => indexed.includes("existing.md"));

    await w.close();
  }, 15000);

  it("soft-deletes on file removal", async () => {
    const dir = tmpDir();
    const now = new Date().toISOString();
    inst.db.prepare(
      "INSERT INTO memories (id, content, source, source_path, source_hash, scope, tags, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("del-test-1", "content", "obsidian", "to-delete.md", "hash1", "global", "[]", 0.5, now, now);

    fs.writeFileSync(path.join(dir, "to-delete.md"), "# Delete Me");

    const deleted: string[] = [];

    const w = startWatcher(inst.db, {
      vaultPath: dir,
      debounceMs: 300,
      onDeleted: (file) => deleted.push(file),
    });

    await new Promise<void>((resolve) => w.watcher.on("ready", resolve));

    fs.unlinkSync(path.join(dir, "to-delete.md"));

    await waitFor(() => deleted.includes("to-delete.md"));

    const row = inst.db.prepare("SELECT deleted FROM memories WHERE id = ?").get("del-test-1") as { deleted: number };
    expect(row.deleted).toBe(1);

    await w.close();
  }, 15000);

  it("ignores .obsidian directory", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });

    const indexed: string[] = [];

    const w = startWatcher(inst.db, {
      vaultPath: dir,
      debounceMs: 300,
      onIndexed: (file) => indexed.push(file),
    });

    await new Promise<void>((resolve) => w.watcher.on("ready", resolve));

    fs.writeFileSync(path.join(dir, ".obsidian", "config.md"), "config stuff");

    // Wait a bit to confirm nothing happens
    await new Promise((r) => setTimeout(r, 1500));

    expect(indexed).not.toContain(".obsidian/config.md");

    await w.close();
  }, 10000);
});
