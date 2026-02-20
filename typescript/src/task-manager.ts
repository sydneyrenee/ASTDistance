import * as fs from "fs";
import * as path from "path";

export enum TaskStatus {
  PENDING = "pending",
  ASSIGNED = "assigned",
  COMPLETED = "completed",
  BLOCKED = "blocked",
}

export interface PortTask {
  source_path: string;
  source_qualified: string;
  target_path: string;
  target_qualified?: string;
  dependent_count: number;
  dependency_count: number;
  status: TaskStatus;
  assigned_to?: string;
  assigned_at?: string;
  completed_at?: string;
  similarity?: number;
  dependencies?: string[];
  dependents?: string[];
}

export interface TaskFileData {
  source_root: string;
  target_root: string;
  source_lang: string;
  target_lang: string;
  agents_md?: string;
  tasks: Array<Record<string, unknown>>;
}

function sleepMs(ms: number): void {
  // Synchronous sleep for short-lived CLI locking. This avoids adding deps.
  const sab = new SharedArrayBuffer(4);
  const a = new Int32Array(sab);
  Atomics.wait(a, 0, 0, ms);
}

function processExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means it exists but we can't signal it (treat as exists).
    if (e && typeof e === "object" && e.code === "EPERM") return true;
    return false;
  }
}

class FileLock {
  private lockPath: string;
  private held: boolean;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
    this.held = false;
  }

  acquire(wait: boolean): boolean {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      try {
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      } catch {
        // ignore
      }
      try {
        fs.writeFileSync(this.lockPath, `${process.pid}\n`, { flag: "wx" });
        this.held = true;
        return true;
      } catch (e: any) {
        if (e && typeof e === "object" && e.code === "EEXIST") {
          // Stale lock cleanup: if PID isn't alive, remove and retry.
          let holderPid = 0;
          try {
            const s = fs.readFileSync(this.lockPath, "utf8").trim();
            holderPid = Number(s);
          } catch {
            holderPid = 0;
          }
          if (holderPid > 0 && !processExists(holderPid)) {
            try {
              fs.unlinkSync(this.lockPath);
            } catch {
              // ignore
            }
            continue;
          }

          if (!wait) return false;
          sleepMs(200);
          continue;
        }
        return false;
      }
    }
    return false;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      // Only remove the lock if we still appear to own it.
      const s = fs.readFileSync(this.lockPath, "utf8").trim();
      const holderPid = Number(s);
      if (holderPid === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // ignore
    }
  }
}

function nowUtcString(): string {
  // Match Python/C++ format: YYYY-MM-DDTHH:MM:SS (UTC)
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

export class TaskManager {
  task_file_path: string;
  source_root: string = "";
  target_root: string = "";
  source_lang: string = "";
  target_lang: string = "";
  agents_md: string = "";
  tasks: PortTask[] = [];

  constructor(taskFile: string) {
    this.task_file_path = taskFile;
  }

  load(): boolean {
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(this.task_file_path, "utf8"));
    } catch {
      return false;
    }

    this.source_root = String(data?.source_root || "");
    this.target_root = String(data?.target_root || "");
    this.source_lang = String(data?.source_lang || "");
    this.target_lang = String(data?.target_lang || "");
    this.agents_md = String(data?.agents_md || "");

    this.tasks = [];
    const raw = Array.isArray(data?.tasks) ? data.tasks : [];
    for (const t of raw) {
      const statusStr = String((t as any)?.status || "pending");
      const status: TaskStatus =
        statusStr === TaskStatus.ASSIGNED
          ? TaskStatus.ASSIGNED
          : statusStr === TaskStatus.COMPLETED
            ? TaskStatus.COMPLETED
            : statusStr === TaskStatus.BLOCKED
              ? TaskStatus.BLOCKED
              : TaskStatus.PENDING;

      const task: PortTask = {
        source_path: String((t as any)?.source_path || ""),
        source_qualified: String((t as any)?.source_qualified || ""),
        target_path: String((t as any)?.target_path || ""),
        target_qualified: (t as any)?.target_qualified
          ? String((t as any)?.target_qualified)
          : undefined,
        dependent_count: Number((t as any)?.dependent_count || 0),
        dependency_count: Number((t as any)?.dependency_count || 0),
        status,
        assigned_to: (t as any)?.assigned_to ? String((t as any)?.assigned_to) : undefined,
        assigned_at: (t as any)?.assigned_at ? String((t as any)?.assigned_at) : undefined,
        completed_at: (t as any)?.completed_at ? String((t as any)?.completed_at) : undefined,
        similarity: typeof (t as any)?.similarity === "number" ? (t as any).similarity : undefined,
        dependencies: Array.isArray((t as any)?.dependencies)
          ? ((t as any).dependencies as any[]).map(String)
          : undefined,
        dependents: Array.isArray((t as any)?.dependents)
          ? ((t as any).dependents as any[]).map(String)
          : undefined,
      };

      if (task.source_path) {
        this.tasks.push(task);
      }
    }
    return true;
  }

  save(): boolean {
    const data: any = {
      source_root: this.source_root,
      target_root: this.target_root,
      source_lang: this.source_lang,
      target_lang: this.target_lang,
      agents_md: this.agents_md,
      tasks: [],
    };

    for (const t of this.tasks) {
      const td: any = {
        source_path: t.source_path,
        source_qualified: t.source_qualified,
        target_path: t.target_path,
        dependent_count: t.dependent_count,
        dependency_count: t.dependency_count,
        status: t.status,
      };
      if (t.assigned_to) td.assigned_to = t.assigned_to;
      if (t.assigned_at) td.assigned_at = t.assigned_at;
      if (t.completed_at) td.completed_at = t.completed_at;
      if (typeof t.similarity === "number") td.similarity = t.similarity;
      if (t.dependencies) td.dependencies = t.dependencies;
      if (t.dependents) td.dependents = t.dependents;
      data.tasks.push(td);
    }

    try {
      fs.writeFileSync(this.task_file_path, JSON.stringify(data, null, 2) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  private withLock<T>(fn: () => T): T | null {
    const lock = new FileLock(`${this.task_file_path}.lock`);
    if (!lock.acquire(true)) {
      return null;
    }
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  assign_next(agent_id: string): PortTask | null {
    const res = this.withLock(() => {
      if (!this.load()) return null;
      const pending = this.tasks.filter((t) => t.status === TaskStatus.PENDING);
      if (pending.length === 0) return null;
      pending.sort((a, b) => b.dependent_count - a.dependent_count);
      const task = pending[0]!;
      task.status = TaskStatus.ASSIGNED;
      task.assigned_to = agent_id;
      task.assigned_at = nowUtcString();
      if (!this.save()) {
        task.status = TaskStatus.PENDING;
        task.assigned_to = undefined;
        task.assigned_at = undefined;
        return null;
      }
      return task;
    });
    return res ?? null;
  }

  complete_task(source_qualified: string): boolean {
    const ok = this.withLock(() => {
      if (!this.load()) return false;
      for (const t of this.tasks) {
        if (t.source_qualified === source_qualified) {
          t.status = TaskStatus.COMPLETED;
          t.completed_at = nowUtcString();
          return this.save();
        }
      }
      return false;
    });
    return Boolean(ok);
  }

  release_task(source_qualified: string): boolean {
    const ok = this.withLock(() => {
      if (!this.load()) return false;
      for (const t of this.tasks) {
        if (t.source_qualified === source_qualified && t.status === TaskStatus.ASSIGNED) {
          t.status = TaskStatus.PENDING;
          t.assigned_to = undefined;
          t.assigned_at = undefined;
          return this.save();
        }
      }
      return false;
    });
    return Boolean(ok);
  }

  get_stats(): Record<string, number> {
    const counts: Record<string, number> = {
      pending: 0,
      assigned: 0,
      completed: 0,
      blocked: 0,
    };
    for (const t of this.tasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
    return counts;
  }

  read_agents_md(): string {
    if (!this.agents_md) return "";
    try {
      return fs.readFileSync(this.agents_md, "utf8");
    } catch {
      return "";
    }
  }

  format_assignment(task: PortTask, agent_number: number): string {
    const prefix = this.target_lang === "python" ? "##" : "//";
    const lines: string[] = [];

    lines.push("=== TASK ASSIGNMENT ===\n");
    lines.push(`You are agent #${agent_number}`);
    lines.push(`Reminder: all ast_distance commands require: --agent ${agent_number}\n`);

    lines.push("Source File:");
    lines.push(`  Path:      ${this.source_root}/${task.source_path}`);
    lines.push(`  Qualified: ${task.source_qualified}`);
    lines.push(`  Dependents: ${task.dependent_count} files depend on this\n`);

    lines.push("Target File:");
    lines.push(`  Path:      ${this.target_root}/${task.target_path}`);
    lines.push(`  Add header: ${prefix} port-lint: source ${task.source_path}\n`);

    lines.push(`Priority: ${task.dependent_count} (higher = more critical)\n`);

    const agentsContent = this.read_agents_md();
    if (agentsContent) {
      lines.push("=== PORTING GUIDELINES (from AGENTS.md) ===\n");
      lines.push(agentsContent);
      lines.push("");
    }

    lines.push("=== INSTRUCTIONS ===\n");
    lines.push("1. Read the source file thoroughly");
    lines.push("2. Create the target file at the target path");
    lines.push("3. Add the port-lint header as the first line");
    lines.push("4. Transliterate the source code to idiomatic target language");
    lines.push("5. Match documentation comments from the source");
    lines.push(
      `6. Run: ast_distance --agent ${agent_number} <source> ${this.source_lang} <target> ${this.target_lang}`,
    );
    lines.push("   to verify similarity (aim for >0.85)");
    lines.push(
      `7. When complete, run: ast_distance --agent ${agent_number} --complete ${this.task_file_path} ${task.source_qualified}`,
    );

    return lines.join("\n") + "\n";
  }
}

