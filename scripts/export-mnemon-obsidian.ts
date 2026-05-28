#!/usr/bin/env tsx
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DB_PATH =
  "/home/jai-multi0526/nanoclaw/data/v2-sessions/c7e2a6c6-81a5-4e20-ad8d-4d9ae1efeb1d/.claude-shared/mnemon/data/default/mnemon.db";
const DEFAULT_OUT_DIR = path.join(os.homedir(), "obsidian-export", "agen-Gem1");

interface Insight {
  id: string;
  content: string;
  category: string;
  importance: number;
  tags: string;
  entities: string;
  source: string;
  access_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_accessed_at: string | null;
  effective_importance: number;
}

interface Edge {
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number;
  metadata: string;
}

function slugify(s: string, max = 60): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, max)
    .replace(/-+$/, "")
    || "insight";
}

function shortId(id: string): string {
  return id.split("-")[0];
}

function filenameFor(i: Insight): string {
  return `${slugify(i.content)}-${shortId(i.id)}`;
}

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderInsight(
  i: Insight,
  edges: Edge[],
  byId: Map<string, Insight>,
  fnameById: Map<string, string>,
): string {
  let tags: string[] = [];
  let entities: string[] = [];
  try { tags = JSON.parse(i.tags || "[]"); } catch {}
  try { entities = JSON.parse(i.entities || "[]"); } catch {}

  const allTags = [
    `category/${slugify(i.category, 40)}`,
    ...tags.map((t) => slugify(t, 40)),
    ...entities.map((e) => `entity/${slugify(e, 40)}`),
  ];

  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${i.id}`);
  lines.push(`category: ${i.category}`);
  lines.push(`importance: ${i.importance}`);
  lines.push(`effective_importance: ${i.effective_importance}`);
  lines.push(`source: ${i.source}`);
  lines.push(`created_at: ${i.created_at}`);
  lines.push(`updated_at: ${i.updated_at}`);
  lines.push("tags:");
  for (const t of allTags) lines.push(`  - ${t}`);
  if (entities.length > 0) {
    lines.push("entities:");
    for (const e of entities) lines.push(`  - ${yamlString(e)}`);
  }
  lines.push("---");
  lines.push("");

  const title = i.content.split("\n")[0].slice(0, 120);
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(i.content);
  lines.push("");

  if (edges.length > 0) {
    lines.push("## Related");
    lines.push("");
    const byType = new Map<string, Edge[]>();
    for (const e of edges) {
      const arr = byType.get(e.edge_type) ?? [];
      arr.push(e);
      byType.set(e.edge_type, arr);
    }
    for (const type of Array.from(byType.keys()).sort()) {
      const arr = byType.get(type)!;
      lines.push(`### ${type}`);
      lines.push("");
      const seen = new Set<string>();
      for (const e of arr) {
        const target = byId.get(e.target_id);
        if (!target) continue;
        const tfname = fnameById.get(e.target_id);
        if (!tfname) continue;
        const display = target.content.replace(/\n/g, " ").slice(0, 80);
        const metaParts: string[] = [];
        try {
          const m = JSON.parse(e.metadata || "{}");
          if (m.direction) metaParts.push(String(m.direction));
          if (m.entity) metaParts.push(`via ${m.entity}`);
          if (m.sub_type) metaParts.push(String(m.sub_type));
        } catch {}
        const metaSuffix = metaParts.length > 0 ? ` _(${metaParts.join(", ")})_` : "";
        const line = `- [[${tfname}|${display}]]${metaSuffix}`;
        if (seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function exportOnce(): { written: number; unchanged: number; removed: number } {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const insights = db
    .prepare(
      `SELECT id, content, category, importance, tags, entities, source, access_count, created_at, updated_at, deleted_at, last_accessed_at, effective_importance FROM insights WHERE deleted_at IS NULL`,
    )
    .all() as Insight[];
  const edges = db
    .prepare(`SELECT source_id, target_id, edge_type, weight, metadata FROM edges`)
    .all() as Edge[];
  db.close();

  const byId = new Map<string, Insight>();
  for (const i of insights) byId.set(i.id, i);

  const fnameById = new Map<string, string>();
  const used = new Map<string, number>();
  for (const i of insights) {
    let base = filenameFor(i);
    let final = base;
    const n = used.get(base) ?? 0;
    if (n > 0) final = `${base}-${n}`;
    used.set(base, n + 1);
    fnameById.set(i.id, final);
  }

  const outgoing = new Map<string, Edge[]>();
  for (const e of edges) {
    if (!byId.has(e.source_id) || !byId.has(e.target_id)) continue;
    const arr = outgoing.get(e.source_id) ?? [];
    arr.push(e);
    outgoing.set(e.source_id, arr);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const expected = new Set<string>();
  let written = 0;
  let unchanged = 0;
  for (const i of insights) {
    const fname = `${fnameById.get(i.id)!}.md`;
    expected.add(fname);
    const full = path.join(OUT_DIR, fname);
    const md = renderInsight(i, outgoing.get(i.id) ?? [], byId, fnameById);
    let existing: string | null = null;
    try { existing = fs.readFileSync(full, "utf8"); } catch {}
    if (existing === md) {
      unchanged++;
    } else {
      fs.writeFileSync(full, md);
      written++;
    }
  }

  let removed = 0;
  for (const fname of fs.readdirSync(OUT_DIR)) {
    if (!fname.endsWith(".md")) continue;
    if (!expected.has(fname)) {
      fs.unlinkSync(path.join(OUT_DIR, fname));
      removed++;
    }
  }

  return { written, unchanged, removed };
}

function dbSignature(): string {
  const parts: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const st = fs.statSync(DB_PATH + suffix);
      parts.push(`${suffix}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${suffix}:none`);
    }
  }
  return parts.join("|");
}

function ts(): string {
  return new Date().toISOString();
}

function runWatch(intervalMs: number) {
  let lastSig = "";
  const tick = () => {
    try {
      const sig = dbSignature();
      if (sig === lastSig) return;
      lastSig = sig;
      const r = exportOnce();
      if (r.written > 0 || r.removed > 0) {
        console.log(`[${ts()}] written=${r.written} unchanged=${r.unchanged} removed=${r.removed}`);
      }
    } catch (e) {
      console.error(`[${ts()}] error:`, (e as Error).message);
    }
  };
  tick();
  setInterval(tick, intervalMs);
}

const args = process.argv.slice(2);

function argVal(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const DB_PATH = argVal("--db") ?? DEFAULT_DB_PATH;
const OUT_DIR = argVal("--out") ?? DEFAULT_OUT_DIR;

if (args.includes("--watch")) {
  const interval = argVal("--interval") ? Number(argVal("--interval")) : 5000;
  console.log(`[${ts()}] watching ${DB_PATH} every ${interval}ms → ${OUT_DIR}`);
  runWatch(interval);
} else {
  const r = exportOnce();
  console.log(`[${ts()}] one-shot: written=${r.written} unchanged=${r.unchanged} removed=${r.removed} → ${OUT_DIR}`);
}
