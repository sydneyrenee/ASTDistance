import * as fs from "fs";
import * as path from "path";
import { TaskManager, TaskStatus } from "./task-manager.js";

export interface AgentState {
  last_used_epoch: number;
  last_score_epoch: number;
  last_score: number; // -1 = unknown
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function sleepMs(ms: number): void {
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
    if (e && typeof e === "object" && e.code === "EPERM") return true;
    return false;
  }
}

function activityScoreFromIdleMinutes(idleMinutes: number): number {
  if (idleMinutes <= 15) return 100.0;
  if (idleMinutes >= 60) return 0.0;
  const t = (idleMinutes - 15) / 45.0;
  return 100.0 * (1.0 - t);
}

function formatIdleMinutes(idleMinutes: number): string {
  const mins = Math.max(0, Math.trunc(idleMinutes));
  const h = Math.trunc(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function agentsDir(taskFile: string): string {
  const base = path.dirname(taskFile) || process.cwd();
  return path.join(base, ".cache", "ast_distance", "agents");
}

function agentLockPath(taskFile: string, agent: number): string {
  return path.join(agentsDir(taskFile), `agent_${agent}.lock`);
}

function agentNoticePath(taskFile: string, agent: number): string {
  return path.join(agentsDir(taskFile), `agent_${agent}.notice`);
}

function agentStatePath(taskFile: string, agent: number): string {
  return path.join(agentsDir(taskFile), `agent_${agent}.state`);
}

function loadAgentState(filePath: string): AgentState {
  const st: AgentState = { last_used_epoch: 0, last_score_epoch: 0, last_score: -1.0 };
  try {
    const s = fs.readFileSync(filePath, "utf8");
    for (const line of s.split("\n")) {
      const i = line.indexOf("=");
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k === "last_used_epoch") st.last_used_epoch = Number(v) || 0;
      else if (k === "last_score_epoch") st.last_score_epoch = Number(v) || 0;
      else if (k === "last_score") st.last_score = Number(v);
    }
  } catch {
    // ignore
  }
  return st;
}

function saveAgentState(filePath: string, st: AgentState): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `last_used_epoch=${st.last_used_epoch}\n` +
        `last_score_epoch=${st.last_score_epoch}\n` +
        `last_score=${st.last_score}\n`,
    );
  } catch {
    // ignore
  }
}

export function touchAgentLastUsed(taskFile: string, agent: number): void {
  const p = agentStatePath(taskFile, agent);
  const st = loadAgentState(p);
  st.last_used_epoch = nowEpochSeconds();
  saveAgentState(p, st);
}

export function writeAgentNotice(taskFile: string, agent: number, msg: string): void {
  const p = agentNoticePath(taskFile, agent);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, msg.endsWith("\n") ? msg : msg + "\n");
  } catch {
    // ignore
  }
}

export function printAndClearAgentNotice(taskFile: string, agent: number): void {
  const p = agentNoticePath(taskFile, agent);
  let s = "";
  try {
    s = fs.readFileSync(p, "utf8");
  } catch {
    s = "";
  }
  if (s.trim().length > 0) {
    process.stderr.write(`\n=== NOTICE (Agent #${agent}) ===\n\n${s}\n`);
  }
  try {
    fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

export class AgentLock {
  private lockPath: string;
  private locked_: boolean;
  private holderPid_: number;

  constructor(taskFile: string, agent: number, overrideWait: boolean) {
    this.lockPath = agentLockPath(taskFile, agent);
    this.locked_ = false;
    this.holderPid_ = 0;

    for (let attempt = 0; attempt < 10_000; attempt++) {
      try {
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
      } catch {
        // ignore
      }
      try {
        fs.writeFileSync(this.lockPath, `${process.pid}\n`, { flag: "wx" });
        this.locked_ = true;
        this.holderPid_ = 0;
        break;
      } catch (e: any) {
        if (e && typeof e === "object" && e.code === "EEXIST") {
          let holder = 0;
          try {
            const s = fs.readFileSync(this.lockPath, "utf8").trim();
            holder = Number(s) || 0;
          } catch {
            holder = 0;
          }

          if (holder > 0 && !processExists(holder)) {
            try {
              fs.unlinkSync(this.lockPath);
            } catch {
              // ignore
            }
            continue;
          }

          this.holderPid_ = holder;
          this.locked_ = false;
          if (!overrideWait) break;
          sleepMs(200);
          continue;
        }
        this.locked_ = false;
        break;
      }
    }
  }

  locked(): boolean {
    return this.locked_;
  }

  holderPid(): number {
    return this.holderPid_;
  }

  release(): void {
    if (!this.locked_) return;
    this.locked_ = false;
    try {
      const s = fs.readFileSync(this.lockPath, "utf8").trim();
      const holder = Number(s) || 0;
      if (holder === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // ignore
    }
  }
}

export function printAgentActivitySection(
  tm: TaskManager,
  taskFile: string,
  currentAgent: number,
): void {
  process.stdout.write("\n=== Agent Activity ===\n\n");
  process.stdout.write(`You are agent #${currentAgent}\n\n`);

  type Row = {
    agent: number;
    task: string;
    since: string;
    idleMin: number;
    score: number;
    trend: number;
    hasTrend: boolean;
  };

  const rows: Row[] = [];
  const now = nowEpochSeconds();

  for (const t of tm.tasks) {
    if (t.status !== TaskStatus.ASSIGNED) continue;
    const agent = Number(t.assigned_to);
    if (!Number.isFinite(agent) || agent <= 0) continue;

    const st = loadAgentState(agentStatePath(taskFile, agent));
    const idleS = st.last_used_epoch > 0 ? now - st.last_used_epoch : 60 * 60;
    const idleMin = Math.max(0, Math.trunc((idleS + 30) / 60));
    const score = activityScoreFromIdleMinutes(idleMin);

    let hasTrend = false;
    let trend = 0.0;
    if (Number.isFinite(st.last_score) && st.last_score >= 0.0) {
      trend = score - st.last_score;
      hasTrend = true;
    }

    st.last_score = score;
    st.last_score_epoch = now;
    saveAgentState(agentStatePath(taskFile, agent), st);

    rows.push({
      agent,
      task: t.source_qualified,
      since: t.assigned_at || "",
      idleMin,
      score,
      trend,
      hasTrend,
    });
  }

  if (rows.length === 0) {
    process.stdout.write("No agents currently assigned.\n");
    return;
  }

  rows.sort((a, b) => a.agent - b.agent);

  const header =
    `${"Agent".padEnd(8)}` +
    `${"Working On".padEnd(34)}` +
    `${"Idle".padEnd(10)}` +
    `${"Active".padEnd(10)}` +
    "Trend\n";
  process.stdout.write(header);
  process.stdout.write("-".repeat(76) + "\n");

  for (const r of rows) {
    const trendS = r.hasTrend ? `${r.trend >= 0 ? "+" : ""}${r.trend.toFixed(0)}%` : "";
    process.stdout.write(
      `${String(r.agent).padEnd(8)}` +
        `${r.task.slice(0, 32).padEnd(34)}` +
        `${formatIdleMinutes(r.idleMin).padEnd(10)}` +
        `${`${r.score.toFixed(0)}%`.padEnd(10)}` +
        `${trendS}\n`,
    );
  }
}

