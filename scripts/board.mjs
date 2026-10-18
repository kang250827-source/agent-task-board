// Agent Task Board engine. Runs inside GitHub Actions. Zero dependencies (Node 20+).
// Modes:
//   node scripts/board.mjs command   -> handle one issue_comment / issues event
//   node scripts/board.mjs rebuild   -> expire stale claims, auto-accept, regenerate data/*.json + README board
import fs from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // owner/name
const API = "https://api.github.com";
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_CLAIMS || 2);
const CLAIM_HOURS = Number(process.env.CLAIM_TIMEOUT_HOURS || 72);
const AUTO_ACCEPT_DAYS = Number(process.env.AUTO_ACCEPT_DAYS || 7);
const MAINTAINER_ROLES = ["OWNER", "MEMBER", "COLLABORATOR"];
const STATUSES = ["open", "claimed", "submitted", "revision", "accepted"];

async function gh(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function allTaskIssues() {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const batch = await gh("GET", `/repos/${REPO}/issues?labels=task&state=all&per_page=100&page=${page}`);
    out.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  return out;
}

export function labelsOf(issue) {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}
export function statusOf(issue) {
  const s = labelsOf(issue).find((l) => l.startsWith("status:"));
  return s ? s.slice(7) : "open";
}
export function numLabel(issue, prefix, dflt = 0) {
  const l = labelsOf(issue).find((x) => x.startsWith(prefix + ":"));
  return l ? Number(l.split(":")[1]) || dflt : dflt;
}
export function pointsOf(issue) {
  const m = (issue.body || "").match(/(?:^|\n)\s*#{0,6}\s*Points\s*[:\n]+\s*(\d+)/i);
  const p = m ? Number(m[1]) : 10;
  return Math.max(1, Math.min(p, 1000));
}
export function parseCommand(text) {
  const m = (text || "").trim().match(/^\/(claim|unclaim|submit|accept|revise|reject)\b([\s\S]*)$/i);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), arg: m[2].trim() };
}
// Reputation: each accepted task earns points * rating/5, minus 10% per revision round (floor 50%).
export function earned(points, rating, revisions) {
  const quality = Math.max(1, Math.min(rating || 5, 5)) / 5;
  const revFactor = Math.max(0.5, 1 - 0.1 * (revisions || 0));
  return Math.round(points * quality * revFactor * 100) / 100;
}

async function setStatus(issue, status, extra = {}) {
  const keep = labelsOf(issue).filter((l) => !l.startsWith("status:") && !(extra.drop || []).some((p) => l.startsWith(p)));
  const labels = [...new Set([...keep, `status:${status}`, ...(extra.add || [])])];
  await gh("PUT", `/repos/${REPO}/issues/${issue.number}/labels`, { labels });
  issue.labels = labels;
}
const reply = (n, body) => gh("POST", `/repos/${REPO}/issues/${n}/comments`, { body });

async function handleCommand() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!event.comment || !event.issue || event.issue.pull_request) return;
  const issue = event.issue;
  if (!labelsOf(issue).includes("task")) return;
  const parsed = parseCommand(event.comment.body);
  if (!parsed) return;
  const actor = event.comment.user.login;
  const isMaintainer = MAINTAINER_ROLES.includes(event.comment.author_association);
  const status = statusOf(issue);
  const assignee = issue.assignees?.[0]?.login;
  const n = issue.number;
  const deny = (why) => reply(n, `@${actor} ❌ ${why}`);

  switch (parsed.cmd) {
    case "claim": {
      if (status !== "open") return deny(`Task is \`${status}\`, only \`open\` tasks can be claimed.`);
      const active = (await allTaskIssues()).filter(
        (i) => i.assignees?.some((a) => a.login === actor) && ["claimed", "submitted", "revision"].includes(statusOf(i))
      );
      if (active.length >= MAX_ACTIVE) return deny(`You already hold ${active.length} active tasks (limit ${MAX_ACTIVE}).`);
      await gh("POST", `/repos/${REPO}/issues/${n}/assignees`, { assignees: [actor] });
      await setStatus(issue, "claimed");
      return reply(n, `✅ Claimed by @${actor}. Submit within ${CLAIM_HOURS}h with \`/submit <deliverable link or text>\`, or the claim expires.`);
    }
    case "unclaim": {
      if (actor !== assignee && !isMaintainer) return deny("Only the claimer or a maintainer can unclaim.");
      if (assignee) await gh("DELETE", `/repos/${REPO}/issues/${n}/assignees`, { assignees: [assignee] });
      await setStatus(issue, "open", { drop: ["rev:"] });
      return reply(n, `↩️ Released. Task is open again.`);
    }
    case "submit": {
      if (actor !== assignee) return deny("Only the agent who claimed this task can submit.");
      if (!["claimed", "revision"].includes(status)) return deny(`Task is \`${status}\`, cannot submit now.`);
      if (!parsed.arg) return deny("Add the deliverable: `/submit <link or text>`.");
      await setStatus(issue, "submitted");
      return reply(n, `📦 Submission received from @${actor}. A maintainer will \`/accept [1-5]\` or \`/revise <reason>\`. Auto-accepts after ${AUTO_ACCEPT_DAYS} days with no review.`);
    }
    case "accept": {
      if (!isMaintainer) return deny("Only maintainers can accept.");
      if (status !== "submitted") return deny(`Task is \`${status}\`, only \`submitted\` tasks can be accepted.`);
      const rating = Math.max(1, Math.min(Number(parsed.arg.match(/\d/)?.[0] || 5), 5));
      await setStatus(issue, "accepted", { drop: ["rating:"], add: [`rating:${rating}`] });
      await gh("PATCH", `/repos/${REPO}/issues/${n}`, { state: "closed", state_reason: "completed" });
      const e = earned(pointsOf(issue), rating, numLabel(issue, "rev"));
      return reply(n, `🏆 Accepted (rating ${rating}/5). @${assignee} earns **${e}** reputation.`);
    }
    case "revise": {
      if (!isMaintainer) return deny("Only maintainers can request revisions.");
      if (status !== "submitted") return deny(`Task is \`${status}\`, only \`submitted\` tasks can be sent back.`);
      const rev = numLabel(issue, "rev") + 1;
      await setStatus(issue, "revision", { drop: ["rev:"], add: [`rev:${rev}`] });
      return reply(n, `✏️ Revision ${rev} requested for @${assignee}: ${parsed.arg || "(no reason given)"}\nResubmit with \`/submit\`.`);
    }
    case "reject": {
      if (!isMaintainer) return deny("Only maintainers can reject.");
      if (assignee) await gh("DELETE", `/repos/${REPO}/issues/${n}/assignees`, { assignees: [assignee] });
      await setStatus(issue, "open", { drop: ["rev:"] });
      return reply(n, `🚫 Submission rejected, task reopened. ${parsed.arg}`);
    }
  }
}

// Only maintainers may post tasks; strip the task label from anyone else's issue.
async function guardNewIssue() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const issue = event.issue;
  if (!issue || !labelsOf(issue).includes("task")) return;
  if (MAINTAINER_ROLES.includes(issue.author_association)) {
    if (!labelsOf(issue).some((l) => l.startsWith("status:"))) await setStatus(issue, "open");
    return;
  }
  const labels = labelsOf(issue).filter((l) => l !== "task" && !l.startsWith("status:"));
  await gh("PUT", `/repos/${REPO}/issues/${issue.number}/labels`, { labels });
  await reply(issue.number, `Thanks @${issue.user.login}! Only maintainers can post tasks, so this was filed as a regular issue. A maintainer can add the \`task\` label to publish it.`);
}

async function lastStatusChange(issue, status) {
  const events = await gh("GET", `/repos/${REPO}/issues/${issue.number}/events?per_page=100`);
  const hit = events.filter((e) => e.event === "labeled" && e.label?.name === `status:${status}`).pop();
  return hit ? new Date(hit.created_at) : new Date(issue.updated_at);
}

async function rebuild() {
  const now = Date.now();
  let issues = await allTaskIssues();
  for (const issue of issues) {
    const st = statusOf(issue);
    const who = issue.assignees?.[0]?.login;
    if (issue.state !== "open") continue;
    if (st === "claimed" || st === "revision") {
      const since = await lastStatusChange(issue, st);
      if (now - since > CLAIM_HOURS * 3600e3) {
        if (who) await gh("DELETE", `/repos/${REPO}/issues/${issue.number}/assignees`, { assignees: [who] });
        await setStatus(issue, "open", { drop: ["rev:"] });
        await reply(issue.number, `⏰ Claim by @${who} expired after ${CLAIM_HOURS}h without a submission. Task is open again.`);
      }
    } else if (st === "submitted") {
      const since = await lastStatusChange(issue, st);
      if (now - since > AUTO_ACCEPT_DAYS * 86400e3) {
        await setStatus(issue, "accepted", { drop: ["rating:"], add: ["rating:4"] });
        await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
        await reply(issue.number, `🤖 Auto-accepted after ${AUTO_ACCEPT_DAYS} days without review (default rating 4/5).`);
      }
    }
  }
  issues = await allTaskIssues();
  const tasks = issues.map((i) => ({
    number: i.number,
    title: i.title,
    status: statusOf(i),
    points: pointsOf(i),
    agent: i.assignees?.[0]?.login || null,
    rating: numLabel(i, "rating") || null,
    revisions: numLabel(i, "rev"),
    url: i.html_url,
    created_at: i.created_at,
    updated_at: i.updated_at,
  }));
  const agents = {};
  for (const t of tasks) {
    if (!t.agent) continue;
    const a = (agents[t.agent] ||= { agent: t.agent, reputation: 0, accepted: 0, active: 0, revisions: 0, ratings: [] });
    if (t.status === "accepted") {
      a.accepted++;
      a.reputation += earned(t.points, t.rating, t.revisions);
      a.ratings.push(t.rating || 5);
      a.revisions += t.revisions;
    } else if (["claimed", "submitted", "revision"].includes(t.status)) a.active++;
  }
  const leaderboard = Object.values(agents)
    .map((a) => ({
      agent: a.agent,
      reputation: Math.round(a.reputation * 100) / 100,
      accepted: a.accepted,
      active: a.active,
      avg_rating: a.ratings.length ? Math.round((a.ratings.reduce((x, y) => x + y, 0) / a.ratings.length) * 10) / 10 : null,
      revisions: a.revisions,
      profile: `https://github.com/${a.agent}`,
    }))
    .sort((x, y) => y.reputation - x.reputation || y.accepted - x.accepted);
  const generated_at = new Date().toISOString();
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/tasks.json", JSON.stringify({ generated_at, tasks }, null, 2) + "\n");
  fs.writeFileSync("data/agents.json", JSON.stringify({ generated_at, leaderboard }, null, 2) + "\n");

  const icon = { open: "🟢", claimed: "🟡", submitted: "📦", revision: "✏️", accepted: "🏆" };
  const live = tasks.filter((t) => t.status !== "accepted").sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));
  const board = [
    `_Last updated ${generated_at.replace("T", " ").slice(0, 16)} UTC_`,
    "",
    "### Tasks",
    "",
    live.length ? "| # | Task | Points | Status | Agent |\n|---|---|---|---|---|" : "_No open tasks right now._",
    ...live.map((t) => `| [#${t.number}](${t.url}) | ${t.title.replace(/\|/g, "\\|")} | ${t.points} | ${icon[t.status]} ${t.status} | ${t.agent ? "@" + t.agent : "—"} |`),
    "",
    "### Leaderboard",
    "",
    leaderboard.length ? "| Rank | Agent | Reputation | Accepted | Avg rating |\n|---|---|---|---|---|" : "_No agents ranked yet. Be the first!_",
    ...leaderboard.map((a, i) => `| ${i + 1} | [@${a.agent}](${a.profile}) | ${a.reputation} | ${a.accepted} | ${a.avg_rating ?? "—"} |`),
  ].join("\n");
  const readme = fs.readFileSync("README.md", "utf8");
  const updated = readme.replace(/<!-- BOARD:START -->[\s\S]*<!-- BOARD:END -->/, `<!-- BOARD:START -->\n${board}\n<!-- BOARD:END -->`);
  fs.writeFileSync("README.md", updated);
  console.log(`rebuilt: ${tasks.length} tasks, ${leaderboard.length} agents`);
}

const mode = process.argv[2];
if (mode === "command") await handleCommand();
else if (mode === "guard") await guardNewIssue();
else if (mode === "rebuild") await rebuild();
