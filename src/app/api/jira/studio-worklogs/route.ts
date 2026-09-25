import { NextRequest } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { JiraClient } from "@/lib/jira";
import {
  buildJiraExportCsv,
  parseMembersCsv,
  zonedDateKey,
  type ExportIssue,
  type FieldMeta,
  type ProjectInfo,
  type RawComment,
  type RawIssue,
  type RawWorklog,
  type StudioMember,
  type JiraUserRef,
} from "@/lib/jira-csv-export";

type Credentials = { domain?: string; email?: string; apiToken?: string };

type OrgResult = {
  domain: string;
  resolvedMembers: number;
  accountIds: number;
  issues: number;
  worklogs: number;
  totalHours: number;
  failedIssues: number;
  fileName: string;
  csv: string;
};

const ACCOUNT_BATCH = 20;
const CONCURRENCY = 5;

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return /Jira API Error: (429|5\d\d)/.test(msg) || /fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

type JiraUser = { accountId: string; accountType?: string; displayName?: string; emailAddress?: string; active?: boolean };

/**
 * Resolves every Jira account belonging to a member in one org. Both the SEA and
 * ENO emails are tried in every org (a member may log work in seastudio with the
 * enotion account), then the display name prefix `{staffId}-` as a fallback when
 * emails are hidden by profile visibility.
 */
async function resolveMemberAccounts(client: JiraClient, member: StudioMember): Promise<JiraUser[]> {
  const search = (query: string) =>
    withRetry(() =>
      client["fetch"]<JiraUser[]>(`/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=50`)
    ).catch(() => [] as JiraUser[]);

  const found = new Map<string, JiraUser>();
  const idPrefix = member.id ? new RegExp(`^0*${member.id}-`) : null;

  for (const email of [member.emailSea, member.emailEno]) {
    if (!email || !email.includes("@")) continue;
    const users = (await search(email)).filter((u) => u.accountType !== "app");
    const exact = users.filter((u) => u.emailAddress?.toLowerCase() === email);
    if (exact.length > 0) {
      exact.forEach((u) => found.set(u.accountId, u));
    } else if (users.length === 1 && !users[0].emailAddress) {
      // Email hidden: Jira still matches on it; accept only an unambiguous hit
      // that doesn't contradict the staff ID in the display name.
      const u = users[0];
      if (!idPrefix || !/^\d+-/.test(u.displayName || "") || idPrefix.test(u.displayName || "")) {
        found.set(u.accountId, u);
      }
    }
  }

  if (idPrefix) {
    const users = await search(`${member.id}-`);
    for (const u of users) {
      if (u.accountType !== "app" && idPrefix.test(u.displayName || "")) found.set(u.accountId, u);
    }
  }

  return [...found.values()];
}

async function searchIssues(client: JiraClient, jql: string): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  let nextPageToken: string | undefined;
  while (true) {
    const page = await withRetry(() =>
      client["fetch"]<{ issues: RawIssue[]; nextPageToken?: string; isLast?: boolean }>("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql,
          fields: ["*all"],
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
      })
    );
    out.push(...(page.issues || []));
    if (page.isLast !== false || !page.nextPageToken) break;
    nextPageToken = page.nextPageToken;
  }
  return out;
}

async function fetchAllWorklogs(client: JiraClient, issue: RawIssue): Promise<RawWorklog[]> {
  const embedded = issue.fields.worklog as { worklogs?: RawWorklog[]; total?: number } | undefined;
  if (embedded?.worklogs && (embedded.total ?? 0) <= embedded.worklogs.length) return embedded.worklogs;

  const all: RawWorklog[] = [];
  let startAt = 0;
  while (true) {
    const page = await withRetry(() =>
      client["fetch"]<{ worklogs: RawWorklog[]; total: number }>(
        `/rest/api/3/issue/${issue.key}/worklog?startAt=${startAt}&maxResults=5000`
      )
    );
    const batch = page.worklogs || [];
    all.push(...batch);
    if (batch.length === 0 || all.length >= page.total) break;
    startAt += batch.length;
  }
  return all;
}

async function fetchAllComments(client: JiraClient, issue: RawIssue): Promise<RawComment[]> {
  const embedded = issue.fields.comment as { comments?: RawComment[]; total?: number } | undefined;
  if (embedded?.comments && (embedded.total ?? 0) <= embedded.comments.length) return embedded.comments;

  const all: RawComment[] = [];
  let startAt = 0;
  while (true) {
    const page = await withRetry(() =>
      client["fetch"]<{ comments: RawComment[]; total: number }>(
        `/rest/api/3/issue/${issue.key}/comment?startAt=${startAt}&maxResults=100&orderBy=created`
      )
    );
    const batch = page.comments || [];
    all.push(...batch);
    if (batch.length === 0 || all.length >= page.total) break;
    startAt += batch.length;
  }
  return all;
}

async function fetchWatchers(client: JiraClient, issue: RawIssue): Promise<JiraUserRef[]> {
  const watches = issue.fields.watches as { watchCount?: number } | undefined;
  if (!watches?.watchCount) return [];
  const res = await withRetry(() =>
    client["fetch"]<{ watchers: JiraUserRef[] }>(`/rest/api/3/issue/${issue.key}/watchers`)
  ).catch(() => ({ watchers: [] as JiraUserRef[] }));
  return res.watchers || [];
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    seaCredentials,
    enoCredentials,
    membersCsv,
    fromDate,
    toDate,
    onlyMemberWorklogs = true,
    includeWatchers = true,
    timeZone = "Asia/Ho_Chi_Minh",
  } = body as {
    seaCredentials?: Credentials;
    enoCredentials?: Credentials;
    membersCsv?: string;
    fromDate?: string;
    toDate?: string;
    onlyMemberWorklogs?: boolean;
    includeWatchers?: boolean;
    timeZone?: string;
  };

  const orgs = [seaCredentials, enoCredentials].filter(
    (c): c is Required<Credentials> => !!(c?.domain && c.email && c.apiToken)
  );
  if (orgs.length === 0) {
    return Response.json({ error: "Provide credentials for at least one organization" }, { status: 400 });
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if ((fromDate && !dateRe.test(fromDate)) || (toDate && !dateRe.test(toDate)) || (fromDate && toDate && fromDate > toDate)) {
    return Response.json({ error: "Invalid date range" }, { status: 400 });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return Response.json({ error: `Invalid time zone: ${timeZone}` }, { status: 400 });
  }

  let members: StudioMember[];
  try {
    const text = membersCsv?.trim() ? membersCsv : await readFile(path.join(process.cwd(), "member.csv"), "utf8");
    members = parseMembersCsv(text);
  } catch {
    return Response.json({ error: "No member list provided and member.csv not found" }, { status: 400 });
  }
  if (members.length === 0) {
    return Response.json({ error: "Member list is empty" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let controllerClosed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        if (controllerClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          controllerClosed = true;
        }
      };
      const closeController = () => {
        if (!controllerClosed) {
          controllerClosed = true;
          controller.close();
        }
      };

      try {
        const results: OrgResult[] = [];

        for (const creds of orgs) {
          const org = creds.domain;
          const client = new JiraClient(creds);

          send({ type: "status", org, message: `[${org}] Checking connection...` });
          if (!(await client.testConnection())) {
            send({ type: "warning", org, message: `[${org}] Connection failed — skipped` });
            continue;
          }

          // 1. Resolve every member's accounts in this org (both emails, plus staff ID)
          const accountToMember = new Map<string, StudioMember>();
          let resolvedMembers = 0;
          await mapPool(members, CONCURRENCY, async (m) => {
            const users = await resolveMemberAccounts(client, m);
            if (users.length === 0) {
              send({ type: "warning", org, message: `[${org}] Not found: ${m.id} (${m.emailSea || "-"} / ${m.emailEno || "-"})` });
              return;
            }
            resolvedMembers++;
            for (const u of users) accountToMember.set(u.accountId, m);
            send({
              type: "status",
              org,
              message: `[${org}] ${m.id} → ${users.map((u) => u.displayName || u.accountId).join(", ")}`,
            });
          });

          const accountIds = [...accountToMember.keys()];
          send({
            type: "status",
            org,
            message: `[${org}] Resolved ${resolvedMembers}/${members.length} members (${accountIds.length} accounts)`,
          });
          if (accountIds.length === 0) {
            send({ type: "warning", org, message: `[${org}] No member accounts found — skipped` });
            continue;
          }

          // 2. Find issues with member worklogs across all projects
          const dateClause = [
            fromDate ? `worklogDate >= "${fromDate}"` : "",
            toDate ? `worklogDate <= "${toDate}"` : "",
          ].filter(Boolean).join(" AND ");
          const issuesByKey = new Map<string, RawIssue>();
          for (let i = 0; i < accountIds.length; i += ACCOUNT_BATCH) {
            const batch = accountIds.slice(i, i + ACCOUNT_BATCH);
            const jql = `worklogAuthor in (${batch.map((id) => `"${id}"`).join(", ")})${dateClause ? ` AND ${dateClause}` : ""} ORDER BY key ASC`;
            const found = await searchIssues(client, jql);
            for (const iss of found) issuesByKey.set(iss.key, iss);
            send({
              type: "status",
              org,
              message: `[${org}] Search batch ${Math.floor(i / ACCOUNT_BATCH) + 1}/${Math.ceil(accountIds.length / ACCOUNT_BATCH)}: ${issuesByKey.size} issues`,
            });
          }

          const issues = [...issuesByKey.values()].sort((a, b) => {
            const [pa, na] = a.key.split("-");
            const [pb, nb] = b.key.split("-");
            return pa.localeCompare(pb) || parseInt(na, 10) - parseInt(nb, 10);
          });

          // 3. Load field metadata + per-issue worklogs, comments, watchers, project info
          const fieldMetas = await withRetry(() => client.getFields()) as FieldMeta[];
          const projectCache = new Map<string, Promise<ProjectInfo>>();
          const loadProject = (projectId: string) => {
            if (!projectCache.has(projectId)) {
              projectCache.set(
                projectId,
                withRetry(() =>
                  client["fetch"]<{ lead?: JiraUserRef; description?: string }>(`/rest/api/3/project/${projectId}?expand=description,lead`)
                )
                  .then((p) => ({ lead: p.lead, description: p.description }))
                  .catch(() => ({}))
              );
            }
            return projectCache.get(projectId)!;
          };

          const exportItems: (ExportIssue | null)[] = new Array(issues.length).fill(null);
          let done = 0;
          let failedIssues = 0;
          let worklogCount = 0;
          let totalSeconds = 0;

          await mapPool(issues, CONCURRENCY, async (issue, idx) => {
            try {
              const [allWorklogs, comments, watchers, project] = await Promise.all([
                fetchAllWorklogs(client, issue),
                fetchAllComments(client, issue),
                includeWatchers ? fetchWatchers(client, issue) : Promise.resolve([]),
                loadProject(String((issue.fields.project as { id?: string } | undefined)?.id || "")),
              ]);

              const worklogs = allWorklogs
                .filter((wl) => {
                  if (onlyMemberWorklogs && !accountToMember.has(wl.author?.accountId || "")) return false;
                  const d = zonedDateKey(wl.started, timeZone);
                  if (fromDate && d < fromDate) return false;
                  if (toDate && d > toDate) return false;
                  return true;
                })
                .sort((a, b) => (a.started || "").localeCompare(b.started || ""));

              if (worklogs.length > 0) {
                exportItems[idx] = { issue, worklogs, comments, watchers, project };
                worklogCount += worklogs.length;
                totalSeconds += worklogs.reduce((s, wl) => s + (wl.timeSpentSeconds || 0), 0);
              }
            } catch (err) {
              failedIssues++;
              send({
                type: "warning",
                org,
                message: `[${org}] Failed ${issue.key}: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`,
              });
            }
            done++;
            send({
              type: "progress",
              org,
              message: `[${org}] [${done}/${issues.length}] ${issue.key} — ${String(issue.fields.summary || "").slice(0, 80)}`,
              issueIndex: done,
              totalIssues: issues.length,
              worklogCount,
            });
          });

          const items = exportItems.filter((x): x is ExportIssue => x !== null);
          const csv = buildJiraExportCsv(items, fieldMetas, timeZone);
          const range = fromDate || toDate ? `-${fromDate || "start"}_${toDate || "now"}` : "";
          results.push({
            domain: org,
            resolvedMembers,
            accountIds: accountIds.length,
            issues: items.length,
            worklogs: worklogCount,
            totalHours: Number((totalSeconds / 3600).toFixed(2)),
            failedIssues,
            fileName: `${org}-studio-worklogs${range}.csv`,
            csv,
          });
          send({
            type: "status",
            org,
            message: `[${org}] Done: ${items.length} issues, ${worklogCount} worklogs, ${(totalSeconds / 3600).toFixed(2)}h`,
          });
        }

        if (results.length === 0) {
          send({ type: "error", message: "No organization produced results (check credentials / member list)" });
        } else {
          send({ type: "complete", results });
        }
        closeController();
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
        closeController();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
