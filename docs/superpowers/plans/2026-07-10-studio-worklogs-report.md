# Studio Worklogs Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an app UI flow that fetches studio-member worklogs from SEA and ENO Jira organizations for an inclusive date range and downloads a CSV report.

**Architecture:** Add focused report helpers in `src/lib/worklog-report.ts`, a general JQL search method in `src/lib/jira.ts`, a streaming Route Handler at `src/app/api/jira/worklogs-report/route.ts`, and a new `worklogs-report` UI mode in `src/app/page.tsx`. The API resolves both SEA and ENO emails from `member.csv` to accountIds per org, searches all Jira spaces via JQL batches, fetches issue worklogs, filters rows, builds CSV, then streams progress plus final CSV.

**Tech Stack:** Next.js 16.2.3 App Router Route Handlers, React 19.2.4 client component UI, TypeScript 5 strict mode, Jira REST API v3, Jira JQL, Server-Sent Events via Web Streams.

## Global Constraints

- Read relevant Next.js 16 docs before Route Handler changes: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `node_modules/next/dist/docs/01-app/02-guides/streaming.md`.
- Do not replace existing `/api/jira/worklogs` behavior; existing edit/re-sync UI depends on it.
- Use a new route: `src/app/api/jira/worklogs-report/route.ts`.
- Use `member.csv` from repository root at runtime on the server.
- Resolve both `Email SEA` and `Email ENO` for every member in each organization.
- Query across all Jira spaces by omitting any `project = ...` clause.
- Date range is inclusive and uses `YYYY-MM-DD` dates.
- CSV header order must exactly match: `Project Name,Issue Type,Epic,Parent,Ticket No,Status,Summary,Log Date & Time,Worklog Created,Worklog Updated,Log user,Assignee,Reporter,Hr. Spent,Ori. Estm.,Total Worklogs,Rem. Estm.,Estm. Variance,Comment`.
- Estimate variance formula: `originalEstimateSeconds - totalAllWorklogSeconds - remainingEstimateSeconds`, displayed as hours.
- No database. No server-side report persistence.
- Existing user changes may exist in `src/app/page.tsx` and `src/app/api/jira/worklogs/route.ts`; inspect diffs before editing.
- Do not commit unless explicitly instructed by the user.

---

## File Structure

- Create: `src/lib/worklog-report.ts`
  - Pure helpers and report types: member CSV parsing, date validation, batching, CSV escaping, ADF/plain text conversion, hours formatting, row building.
- Modify: `src/lib/jira.ts`
  - Add `JiraSearchIssue` type and `searchIssuesByJql(jql, fields)` method using `POST /rest/api/3/search/jql` with `nextPageToken`.
- Create: `src/app/api/jira/worklogs-report/route.ts`
  - POST-only SSE endpoint for generating the report.
- Modify: `src/app/page.tsx`
  - Add `worklogs-report` mode, state, handlers, home card, credential/date UI, streaming progress UI, CSV download UI.
- Verify only: `package.json`
  - Use existing `pnpm lint` and `pnpm build`. Do not add dependencies.

---

### Task 1: Add pure worklog report helpers

**Files:**
- Create: `src/lib/worklog-report.ts`
- Verify: `pnpm lint`

**Interfaces:**
- Produces:
  - `export type StudioMember = { pu: string; id: string; emailSea: string; emailEno: string }`
  - `export type ReportMember = StudioMember & { matchedEmail?: string }`
  - `export type WorklogReportIssue = { key: string; fields: { project?: { name?: string }; issuetype?: { name?: string }; status?: { name?: string }; summary?: string; parent?: { key?: string; fields?: { issuetype?: { name?: string } } }; assignee?: { displayName?: string }; reporter?: { displayName?: string }; timetracking?: { originalEstimate?: string; remainingEstimate?: string; originalEstimateSeconds?: number; remainingEstimateSeconds?: number }; [key: string]: unknown } }`
  - `export type WorklogReportWorklog = { id: string; author?: { displayName?: string; emailAddress?: string; accountId?: string }; timeSpentSeconds?: number; started?: string; created?: string; updated?: string; comment?: unknown }`
  - `export const WORKLOG_REPORT_HEADERS: string[]`
  - `export function parseStudioMembersCsv(csv: string): StudioMember[]`
  - `export function validateDateRange(fromDate: string, toDate: string): string | null`
  - `export function isWorklogInDateRange(started: string | undefined, fromDate: string, toDate: string): boolean`
  - `export function uniqueMemberEmails(member: StudioMember): string[]`
  - `export function chunkArray<T>(items: T[], size: number): T[][]`
  - `export function adfToPlainText(value: unknown): string`
  - `export function secondsToHours(seconds: number | undefined): string`
  - `export function csvEscape(value: unknown): string`
  - `export function rowsToCsv(rows: string[][]): string`
  - `export function buildWorklogReportRow(args: { issue: WorklogReportIssue; worklog: WorklogReportWorklog; member: ReportMember; totalAllWorklogSeconds: number }): string[]`

- Consumes: none.

- [ ] **Step 1: Create helper file with concrete implementation**

Create `src/lib/worklog-report.ts`:

```ts
export type StudioMember = {
  pu: string;
  id: string;
  emailSea: string;
  emailEno: string;
};

export type ReportMember = StudioMember & {
  matchedEmail?: string;
};

export type WorklogReportIssue = {
  key: string;
  fields: {
    project?: { name?: string };
    issuetype?: { name?: string };
    status?: { name?: string };
    summary?: string;
    parent?: { key?: string; fields?: { issuetype?: { name?: string } } };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    timetracking?: {
      originalEstimate?: string;
      remainingEstimate?: string;
      originalEstimateSeconds?: number;
      remainingEstimateSeconds?: number;
    };
    [key: string]: unknown;
  };
};

export type WorklogReportWorklog = {
  id: string;
  author?: { displayName?: string; emailAddress?: string; accountId?: string };
  timeSpentSeconds?: number;
  started?: string;
  created?: string;
  updated?: string;
  comment?: unknown;
};

export const WORKLOG_REPORT_HEADERS = [
  "Project Name",
  "Issue Type",
  "Epic",
  "Parent",
  "Ticket No",
  "Status",
  "Summary",
  "Log Date & Time",
  "Worklog Created",
  "Worklog Updated",
  "Log user",
  "Assignee",
  "Reporter",
  "Hr. Spent",
  "Ori. Estm.",
  "Total Worklogs",
  "Rem. Estm.",
  "Estm. Variance",
  "Comment",
];

export function parseStudioMembersCsv(csv: string): StudioMember[] {
  const lines = csv.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 1) return [];

  return lines.slice(1).map(line => {
    const [pu = "", id = "", emailSea = "", emailEno = ""] = line.split(",");
    return {
      pu: pu.trim(),
      id: id.trim(),
      emailSea: emailSea.trim(),
      emailEno: emailEno.trim(),
    };
  }).filter(member => member.id.length > 0);
}

export function validateDateRange(fromDate: string, toDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return "From date must use YYYY-MM-DD";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return "To date must use YYYY-MM-DD";
  if (Number.isNaN(Date.parse(`${fromDate}T00:00:00.000Z`))) return "From date is invalid";
  if (Number.isNaN(Date.parse(`${toDate}T00:00:00.000Z`))) return "To date is invalid";
  if (fromDate > toDate) return "From date must be before or equal to to date";
  return null;
}

export function isWorklogInDateRange(started: string | undefined, fromDate: string, toDate: string): boolean {
  const day = (started || "").slice(0, 10);
  return day >= fromDate && day <= toDate;
}

export function uniqueMemberEmails(member: StudioMember): string[] {
  return Array.from(new Set([member.emailSea, member.emailEno]
    .map(email => email.trim().toLowerCase())
    .filter(Boolean)));
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function adfToPlainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(adfToPlainText).filter(Boolean).join(" ").trim();
  if (typeof value !== "object") return "";

  const node = value as { text?: unknown; content?: unknown; attrs?: { text?: unknown }; type?: unknown };
  const parts: string[] = [];
  if (typeof node.text === "string") parts.push(node.text);
  if (typeof node.attrs?.text === "string") parts.push(node.attrs.text);
  if (Array.isArray(node.content)) parts.push(adfToPlainText(node.content));
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function secondsToHours(seconds: number | undefined): string {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
  return (value / 3600).toFixed(2);
}

export function csvEscape(value: unknown): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

export function rowsToCsv(rows: string[][]): string {
  return rows.map(row => row.map(csvEscape).join(",")).join("\n");
}

function getEpicKey(issue: WorklogReportIssue): string {
  const fields = issue.fields;
  const parent = fields.parent;
  const parentType = parent?.fields?.issuetype?.name?.toLowerCase();
  if (parent?.key && parentType === "epic") return parent.key;

  const epicLikeEntry = Object.entries(fields).find(([key, value]) => {
    const lower = key.toLowerCase();
    return lower.includes("epic") && typeof value === "string" && value.length > 0;
  });
  return typeof epicLikeEntry?.[1] === "string" ? epicLikeEntry[1] : "";
}

export function buildWorklogReportRow(args: {
  issue: WorklogReportIssue;
  worklog: WorklogReportWorklog;
  member: ReportMember;
  totalAllWorklogSeconds: number;
}): string[] {
  const { issue, worklog, member, totalAllWorklogSeconds } = args;
  const fields = issue.fields;
  const originalSeconds = fields.timetracking?.originalEstimateSeconds || 0;
  const remainingSeconds = fields.timetracking?.remainingEstimateSeconds || 0;
  const varianceSeconds = originalSeconds - totalAllWorklogSeconds - remainingSeconds;
  const logUser = member.matchedEmail || member.emailEno || member.emailSea || worklog.author?.displayName || "";

  return [
    fields.project?.name || "",
    fields.issuetype?.name || "",
    getEpicKey(issue),
    fields.parent?.key || "",
    issue.key,
    fields.status?.name || "",
    fields.summary || "",
    worklog.started || "",
    worklog.created || "",
    worklog.updated || "",
    logUser,
    fields.assignee?.displayName || "",
    fields.reporter?.displayName || "",
    secondsToHours(worklog.timeSpentSeconds),
    fields.timetracking?.originalEstimate || secondsToHours(originalSeconds),
    secondsToHours(totalAllWorklogSeconds),
    fields.timetracking?.remainingEstimate || secondsToHours(remainingSeconds),
    secondsToHours(varianceSeconds),
    adfToPlainText(worklog.comment),
  ];
}
```

- [ ] **Step 2: Verify helper compiles**

Run:

```bash
pnpm lint
```

Expected: command exits `0`. If it fails on formatting or TypeScript lint issues in `src/lib/worklog-report.ts`, fix only this helper file.

---

### Task 2: Add Jira JQL search support

**Files:**
- Modify: `src/lib/jira.ts`
- Verify: `pnpm lint`

**Interfaces:**
- Consumes: `JiraClient` existing private `fetch<T>()`.
- Produces:
  - `export type JiraSearchIssue = JiraIssue`
  - `JiraClient.searchIssuesByJql(jql: string, fields: string[]): Promise<JiraSearchIssue[]>`

- [ ] **Step 1: Add exported search issue type**

In `src/lib/jira.ts`, immediately after `export interface JiraIssue { ... }`, add:

```ts
export type JiraSearchIssue = JiraIssue;
```

- [ ] **Step 2: Add generic JQL search method**

In `src/lib/jira.ts`, immediately after `getProjectIssuesForMatching(...)`, add:

```ts
  async searchIssuesByJql(jql: string, fields: string[]): Promise<JiraSearchIssue[]> {
    const result: JiraSearchIssue[] = [];
    const maxResults = 100;
    let nextPageToken: string | undefined;

    while (true) {
      const body: Record<string, unknown> = {
        jql,
        fields,
        maxResults,
      };
      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }

      const data = await this.fetch<{
        issues: JiraSearchIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>(
        `/rest/api/3/search/jql`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );

      result.push(...data.issues);

      if (data.isLast || !data.nextPageToken || data.issues.length === 0) break;
      nextPageToken = data.nextPageToken;
    }

    return result;
  }
```

- [ ] **Step 3: Verify client compiles**

Run:

```bash
pnpm lint
```

Expected: command exits `0`.

---

### Task 3: Add streaming worklogs report API

**Files:**
- Create: `src/app/api/jira/worklogs-report/route.ts`
- Verify: `pnpm lint`

**Interfaces:**
- Consumes:
  - `JiraClient.testConnection()`
  - `JiraClient.findUserCached(email: string)`
  - `JiraClient.searchIssuesByJql(jql: string, fields: string[])`
  - `JiraClient.getIssueWorklogs(issueKey: string)`
  - helpers from `src/lib/worklog-report.ts`
- Produces:
  - POST SSE endpoint `/api/jira/worklogs-report`
  - Request body:
    ```ts
    {
      sourceCredentials: JiraCredentials;
      targetCredentials: JiraCredentials;
      fromDate: string;
      toDate: string;
    }
    ```
  - SSE events: `status`, `progress`, `warning`, `complete`, `error`

- [ ] **Step 1: Create route file**

Create `src/app/api/jira/worklogs-report/route.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { JiraClient, JiraCredentials } from "@/lib/jira";
import {
  WORKLOG_REPORT_HEADERS,
  ReportMember,
  WorklogReportIssue,
  WorklogReportWorklog,
  buildWorklogReportRow,
  chunkArray,
  isWorklogInDateRange,
  parseStudioMembersCsv,
  rowsToCsv,
  uniqueMemberEmails,
  validateDateRange,
} from "@/lib/worklog-report";

type WorklogReportRequest = {
  sourceCredentials?: JiraCredentials;
  targetCredentials?: JiraCredentials;
  fromDate?: string;
  toDate?: string;
};

type ResolvedOrg = {
  label: "SEA" | "ENO";
  domain: string;
  client: JiraClient;
  accountToMember: Map<string, ReportMember>;
  accountIds: string[];
};

const ISSUE_FIELDS = [
  "project",
  "issuetype",
  "status",
  "summary",
  "parent",
  "assignee",
  "reporter",
  "timetracking",
  "customfield_10014",
  "customfield_10008",
];

function missingCredentials(credentials: JiraCredentials | undefined): boolean {
  return !credentials?.domain || !credentials.email || !credentials.apiToken;
}

function sendEvent(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, data: Record<string, unknown>) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

async function resolveOrgMembers(params: {
  label: "SEA" | "ENO";
  client: JiraClient;
  domain: string;
  members: ReturnType<typeof parseStudioMembersCsv>;
  send: (data: Record<string, unknown>) => void;
}): Promise<ResolvedOrg> {
  const accountToMember = new Map<string, ReportMember>();
  const accountIds = new Set<string>();
  let resolvedEmails = 0;
  let unresolvedEmails = 0;

  for (const member of params.members) {
    for (const email of uniqueMemberEmails(member)) {
      const accountId = await params.client.findUserCached(email);
      if (accountId) {
        resolvedEmails++;
        accountIds.add(accountId);
        accountToMember.set(accountId, { ...member, matchedEmail: email });
      } else {
        unresolvedEmails++;
        params.send({ type: "warning", message: `[${params.label}] Cannot resolve ${email} for member ${member.id}` });
      }
    }
  }

  params.send({
    type: "status",
    message: `[${params.label}] Resolved ${accountIds.size} unique account(s) from ${resolvedEmails} email hit(s); ${unresolvedEmails} unresolved email(s)`,
  });

  return {
    label: params.label,
    domain: params.domain,
    client: params.client,
    accountToMember,
    accountIds: Array.from(accountIds),
  };
}

async function collectOrgRows(params: {
  org: ResolvedOrg;
  fromDate: string;
  toDate: string;
  send: (data: Record<string, unknown>) => void;
}): Promise<{ rows: string[][]; issuesScanned: number; worklogsMatched: number; failedIssues: number }> {
  const batches = chunkArray(params.org.accountIds, 25);
  const issuesByKey = new Map<string, WorklogReportIssue>();

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const quotedAccountIds = batch.map(id => `"${id.replace(/"/g, '\\"')}"`).join(", ");
    const jql = `worklogAuthor in (${quotedAccountIds}) AND worklogDate >= "${params.fromDate}" AND worklogDate <= "${params.toDate}" ORDER BY updated DESC`;

    params.send({
      type: "status",
      message: `[${params.org.label}] Searching batch ${batchIndex + 1}/${batches.length} (${batch.length} accountIds)` ,
    });

    const issues = await params.org.client.searchIssuesByJql(jql, ISSUE_FIELDS) as WorklogReportIssue[];
    for (const issue of issues) {
      issuesByKey.set(issue.key, issue);
    }
  }

  const issues = Array.from(issuesByKey.values());
  params.send({
    type: "status",
    message: `[${params.org.label}] Found ${issues.length} unique issue(s) with matching worklogs`,
  });

  const rows: string[][] = [];
  let failedIssues = 0;
  let worklogsMatched = 0;

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    params.send({
      type: "progress",
      message: `[${params.org.label}] Fetching worklogs ${i + 1}/${issues.length}: ${issue.key}`,
      org: params.org.label,
      issueIndex: i + 1,
      totalIssues: issues.length,
      issueKey: issue.key,
    });

    try {
      const worklogs = await params.org.client.getIssueWorklogs(issue.key) as WorklogReportWorklog[];
      const totalAllWorklogSeconds = worklogs.reduce((sum, worklog) => sum + (worklog.timeSpentSeconds || 0), 0);

      for (const worklog of worklogs) {
        const accountId = worklog.author?.accountId;
        if (!accountId) continue;
        const member = params.org.accountToMember.get(accountId);
        if (!member) continue;
        if (!isWorklogInDateRange(worklog.started, params.fromDate, params.toDate)) continue;

        rows.push(buildWorklogReportRow({ issue, worklog, member, totalAllWorklogSeconds }));
        worklogsMatched++;
      }
    } catch (error) {
      failedIssues++;
      params.send({
        type: "warning",
        message: `[${params.org.label}] Failed to fetch worklogs for ${issue.key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
  }

  return { rows, issuesScanned: issues.length, worklogsMatched, failedIssues };
}

export async function POST(request: NextRequest) {
  const body = await request.json() as WorklogReportRequest;
  const { sourceCredentials, targetCredentials, fromDate = "", toDate = "" } = body;

  if (missingCredentials(sourceCredentials) || missingCredentials(targetCredentials)) {
    return Response.json({ error: "Missing SEA or ENO credentials" }, { status: 400 });
  }

  const dateError = validateDateRange(fromDate, toDate);
  if (dateError) {
    return Response.json({ error: dateError }, { status: 400 });
  }

  const sourceClient = new JiraClient(sourceCredentials);
  const targetClient = new JiraClient(targetCredentials);

  const [sourceOk, targetOk] = await Promise.all([
    sourceClient.testConnection(),
    targetClient.testConnection(),
  ]);

  if (!sourceOk) return Response.json({ error: "Invalid SEA credentials" }, { status: 401 });
  if (!targetOk) return Response.json({ error: "Invalid ENO credentials" }, { status: 401 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let controllerClosed = false;
      const send = (data: Record<string, unknown>) => {
        if (controllerClosed) return;
        try {
          sendEvent(controller, encoder, data);
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
        send({ type: "status", message: "Loading member.csv..." });
        const csv = await readFile(join(process.cwd(), "member.csv"), "utf8");
        const members = parseStudioMembersCsv(csv);
        send({ type: "status", message: `Loaded ${members.length} studio member(s)` });

        const orgs = await Promise.all([
          resolveOrgMembers({ label: "SEA", client: sourceClient, domain: sourceCredentials.domain, members, send }),
          resolveOrgMembers({ label: "ENO", client: targetClient, domain: targetCredentials.domain, members, send }),
        ]);

        const activeOrgs = orgs.filter(org => org.accountIds.length > 0);
        for (const org of orgs) {
          if (org.accountIds.length === 0) {
            send({ type: "warning", message: `[${org.label}] No member accountIds resolved; skipping ${org.domain}.atlassian.net` });
          }
        }
        if (activeOrgs.length === 0) {
          throw new Error("No member accountIds resolved in either organization");
        }

        const allRows: string[][] = [];
        let totalIssuesScanned = 0;
        let totalWorklogsMatched = 0;
        let totalFailedIssues = 0;

        for (const org of activeOrgs) {
          const result = await collectOrgRows({ org, fromDate, toDate, send });
          allRows.push(...result.rows);
          totalIssuesScanned += result.issuesScanned;
          totalWorklogsMatched += result.worklogsMatched;
          totalFailedIssues += result.failedIssues;
        }

        const csvOutput = rowsToCsv([WORKLOG_REPORT_HEADERS, ...allRows]);
        send({
          type: "complete",
          csv: csvOutput,
          results: {
            rows: allRows.length,
            issuesScanned: totalIssuesScanned,
            worklogsMatched: totalWorklogsMatched,
            failedIssues: totalFailedIssues,
            fromDate,
            toDate,
          },
        });
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
```

- [ ] **Step 2: Verify API route compiles**

Run:

```bash
pnpm lint
```

Expected: command exits `0`.

---

### Task 4: Add worklogs report UI state and handlers

**Files:**
- Modify: `src/app/page.tsx`
- Verify: `pnpm lint`

**Interfaces:**
- Consumes: `/api/jira/worklogs-report` SSE events from Task 3.
- Produces:
  - `Mode` includes `"worklogs-report"`
  - `WorklogReportStep = "config" | "running" | "complete"`
  - Handler `runWorklogsReport()`
  - Handler `downloadWorklogsReport()`

- [ ] **Step 1: Extend mode and add state**

In `src/app/page.tsx`, update the mode type near line 53:

```ts
type Mode = "select" | "export" | "import" | "attachments" | "fix-worklogs" | "edit-worklogs" | "worklogs-report";
type WorklogReportStep = "config" | "running" | "complete";
```

Inside `Home()`, after the Edit Worklogs state block, add:

```ts
  // Studio Worklogs Report state
  const [worklogReportStep, setWorklogReportStep] = useState<WorklogReportStep>("config");
  const [worklogReportSourceCredentials, setWorklogReportSourceCredentials] = useState({
    domain: "seastudio",
    email: "",
    apiToken: "",
  });
  const [worklogReportTargetCredentials, setWorklogReportTargetCredentials] = useState({
    domain: "enotion",
    email: "",
    apiToken: "",
  });
  const today = new Date().toISOString().slice(0, 10);
  const [worklogReportDates, setWorklogReportDates] = useState({
    fromDate: today,
    toDate: today,
  });
  const [worklogReportProgress, setWorklogReportProgress] = useState({
    message: "",
    issueIndex: 0,
    totalIssues: 0,
  });
  const [worklogReportLog, setWorklogReportLog] = useState<string[]>([]);
  const [worklogReportCsv, setWorklogReportCsv] = useState("");
  const [worklogReportResult, setWorklogReportResult] = useState<{
    rows: number;
    issuesScanned: number;
    worklogsMatched: number;
    failedIssues: number;
    fromDate: string;
    toDate: string;
  } | null>(null);
```

- [ ] **Step 2: Load saved credentials into report state**

In the existing `useEffect`, inside `if (savedEmail) { ... }`, after `setEditWlCredentials(...)`, add:

```ts
      setWorklogReportSourceCredentials(prev => ({
        ...prev,
        email: savedEmail,
        apiToken: savedExportToken || "",
        domain: savedExportDomain || prev.domain,
      }));
      setWorklogReportTargetCredentials(prev => ({
        ...prev,
        email: savedEmail,
        apiToken: savedImportToken || "",
        domain: savedImportDomain || prev.domain,
      }));
```

- [ ] **Step 3: Reset report state in resetAll**

In `resetAll()`, after edit worklog resets, add:

```ts
    setWorklogReportStep("config");
    setWorklogReportProgress({ message: "", issueIndex: 0, totalIssues: 0 });
    setWorklogReportLog([]);
    setWorklogReportCsv("");
    setWorklogReportResult(null);
```

- [ ] **Step 4: Add run and download handlers**

After `runEditWorklogs`, add:

```ts
  const runWorklogsReport = async () => {
    if (!worklogReportSourceCredentials.domain || !worklogReportSourceCredentials.email || !worklogReportSourceCredentials.apiToken) {
      setError("Please enter SEA credentials");
      return;
    }
    if (!worklogReportTargetCredentials.domain || !worklogReportTargetCredentials.email || !worklogReportTargetCredentials.apiToken) {
      setError("Please enter ENO credentials");
      return;
    }
    if (!worklogReportDates.fromDate || !worklogReportDates.toDate) {
      setError("Please choose from and to dates");
      return;
    }
    if (worklogReportDates.fromDate > worklogReportDates.toDate) {
      setError("From date must be before or equal to to date");
      return;
    }

    setWorklogReportStep("running");
    setWorklogReportCsv("");
    setWorklogReportResult(null);
    setWorklogReportProgress({ message: "Starting...", issueIndex: 0, totalIssues: 0 });
    setWorklogReportLog([]);
    setError("");

    try {
      const response = await fetch("/api/jira/worklogs-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCredentials: worklogReportSourceCredentials,
          targetCredentials: worklogReportTargetCredentials,
          fromDate: worklogReportDates.fromDate,
          toDate: worklogReportDates.toDate,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Report failed with HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let finalCsv = "";
      let finalResult: typeof worklogReportResult = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = JSON.parse(line.slice(6));
          if (data.type === "progress" || data.type === "status" || data.type === "warning") {
            setWorklogReportProgress(prev => ({
              message: data.message || prev.message,
              issueIndex: data.issueIndex ?? prev.issueIndex,
              totalIssues: data.totalIssues ?? prev.totalIssues,
            }));
            if (data.message) {
              const ts = new Date().toLocaleTimeString();
              setWorklogReportLog(prev => [...prev.slice(-499), `[${ts}] ${data.type === "warning" ? "⚠ " : ""}${data.message}`]);
            }
          } else if (data.type === "complete") {
            finalCsv = data.csv || "";
            finalResult = data.results || null;
          } else if (data.type === "error") {
            throw new Error(data.message || "Report failed");
          }
        }
      }

      setWorklogReportCsv(finalCsv);
      setWorklogReportResult(finalResult);
      setWorklogReportStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worklogs report failed");
      setWorklogReportStep("config");
    }
  };

  const downloadWorklogsReport = () => {
    if (!worklogReportCsv) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([worklogReportCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `studio-worklogs-${worklogReportDates.fromDate}-to-${worklogReportDates.toDate}-${timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
```

- [ ] **Step 5: Verify UI handlers compile**

Run:

```bash
pnpm lint
```

Expected: command exits `0`.

---

### Task 5: Add worklogs report UI screens

**Files:**
- Modify: `src/app/page.tsx`
- Verify: `pnpm lint`

**Interfaces:**
- Consumes: state and handlers from Task 4.
- Produces: user-visible report mode.

- [ ] **Step 1: Add home card**

In mode selection grid after the Edit Worklogs card, add:

```tsx
            <Card
              className="cursor-pointer hover:border-cyan-500 transition-colors"
              onClick={() => setMode("worklogs-report")}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg className="w-6 h-6 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Worklogs Report
                </CardTitle>
                <CardDescription>
                  Export studio member worklogs from SEA and ENO by date range
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full">Generate CSV</Button>
              </CardContent>
            </Card>
```

- [ ] **Step 2: Update page title/subtitle**

In the title ternary, add a branch before `"Fix Worklogs"`:

```tsx
               mode === "worklogs-report" ? "Worklogs Report" :
```

In the subtitle ternary, add a branch before the final `Fix worklogs` fallback:

```tsx
                : mode === "worklogs-report"
                ? `Fetch worklogs from ${worklogReportSourceCredentials.domain}.atlassian.net and ${worklogReportTargetCredentials.domain}.atlassian.net`
```

- [ ] **Step 3: Add mode JSX**

Before the Edit Worklogs mode block, add:

```tsx
        {/* STUDIO WORKLOGS REPORT MODE */}
        {mode === "worklogs-report" && (
          <>
            {worklogReportStep === "config" && (
              <Card>
                <CardHeader>
                  <CardTitle>Generate Studio Worklogs CSV</CardTitle>
                  <CardDescription>
                    Resolve members from member.csv, search worklogs across all spaces in both Jira organizations, then download a CSV.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid md:grid-cols-2 gap-6">
                    <div className="space-y-4 p-4 border rounded-lg">
                      <h3 className="font-medium">SEA Workspace</h3>
                      <div className="space-y-2">
                        <Label htmlFor="report-source-domain">Workspace Domain</Label>
                        <div className="flex items-center gap-2">
                          <span className="text-zinc-500">https://</span>
                          <Input
                            id="report-source-domain"
                            value={worklogReportSourceCredentials.domain}
                            onChange={(e) => setWorklogReportSourceCredentials({ ...worklogReportSourceCredentials, domain: e.target.value })}
                            placeholder="seastudio"
                          />
                          <span className="text-zinc-500">.atlassian.net</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="report-source-email">Email</Label>
                        <Input
                          id="report-source-email"
                          type="email"
                          value={worklogReportSourceCredentials.email}
                          onChange={(e) => setWorklogReportSourceCredentials({ ...worklogReportSourceCredentials, email: e.target.value })}
                          placeholder="your-email@example.com"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="report-source-token">API Token</Label>
                        <Input
                          id="report-source-token"
                          type="password"
                          value={worklogReportSourceCredentials.apiToken}
                          onChange={(e) => setWorklogReportSourceCredentials({ ...worklogReportSourceCredentials, apiToken: e.target.value })}
                          placeholder="SEA Jira API token"
                        />
                      </div>
                    </div>

                    <div className="space-y-4 p-4 border rounded-lg">
                      <h3 className="font-medium">ENO Workspace</h3>
                      <div className="space-y-2">
                        <Label htmlFor="report-target-domain">Workspace Domain</Label>
                        <div className="flex items-center gap-2">
                          <span className="text-zinc-500">https://</span>
                          <Input
                            id="report-target-domain"
                            value={worklogReportTargetCredentials.domain}
                            onChange={(e) => setWorklogReportTargetCredentials({ ...worklogReportTargetCredentials, domain: e.target.value })}
                            placeholder="enotion"
                          />
                          <span className="text-zinc-500">.atlassian.net</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="report-target-email">Email</Label>
                        <Input
                          id="report-target-email"
                          type="email"
                          value={worklogReportTargetCredentials.email}
                          onChange={(e) => setWorklogReportTargetCredentials({ ...worklogReportTargetCredentials, email: e.target.value })}
                          placeholder="your-email@example.com"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="report-target-token">API Token</Label>
                        <Input
                          id="report-target-token"
                          type="password"
                          value={worklogReportTargetCredentials.apiToken}
                          onChange={(e) => setWorklogReportTargetCredentials({ ...worklogReportTargetCredentials, apiToken: e.target.value })}
                          placeholder="ENO Jira API token"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="report-from-date">From Date</Label>
                      <Input
                        id="report-from-date"
                        type="date"
                        value={worklogReportDates.fromDate}
                        onChange={(e) => setWorklogReportDates({ ...worklogReportDates, fromDate: e.target.value })}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="report-to-date">To Date</Label>
                      <Input
                        id="report-to-date"
                        type="date"
                        value={worklogReportDates.toDate}
                        onChange={(e) => setWorklogReportDates({ ...worklogReportDates, toDate: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      onClick={runWorklogsReport}
                      disabled={loading}
                      className="flex-1"
                    >
                      Generate CSV
                    </Button>
                    <Button variant="outline" onClick={resetAll}>Back</Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {worklogReportStep === "running" && (
              <Card>
                <CardHeader>
                  <CardTitle>Generating Worklogs Report...</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 break-words">{worklogReportProgress.message}</p>
                  {worklogReportProgress.totalIssues > 0 && (
                    <>
                      <Progress value={(worklogReportProgress.issueIndex / worklogReportProgress.totalIssues) * 100} />
                      <p className="text-xs text-zinc-500 text-center">
                        {worklogReportProgress.issueIndex} / {worklogReportProgress.totalIssues} issues
                      </p>
                    </>
                  )}
                  <div>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-zinc-500">Activity log ({worklogReportLog.length} events)</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigator.clipboard?.writeText(worklogReportLog.join("\n"))}
                        disabled={worklogReportLog.length === 0}
                      >
                        Copy log
                      </Button>
                    </div>
                    <div className="mt-1 h-64 overflow-auto rounded border bg-zinc-50 dark:bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed">
                      {worklogReportLog.length === 0 ? (
                        <div className="text-zinc-400">Waiting for events…</div>
                      ) : (
                        worklogReportLog.slice().reverse().map((line, idx) => (
                          <div key={idx} className="whitespace-pre-wrap break-words">{line}</div>
                        ))
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {worklogReportStep === "complete" && worklogReportResult && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-green-600">Worklogs Report Ready</CardTitle>
                  <CardDescription>
                    {worklogReportResult.fromDate} → {worklogReportResult.toDate}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold text-green-600">{worklogReportResult.rows}</div>
                      <div className="text-sm text-zinc-500">CSV Rows</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-blue-600">{worklogReportResult.issuesScanned}</div>
                      <div className="text-sm text-zinc-500">Issues Scanned</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-cyan-600">{worklogReportResult.worklogsMatched}</div>
                      <div className="text-sm text-zinc-500">Worklogs Matched</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-orange-600">{worklogReportResult.failedIssues}</div>
                      <div className="text-sm text-zinc-500">Failed Issues</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={downloadWorklogsReport} disabled={!worklogReportCsv}>
                      Download CSV
                    </Button>
                    <Button variant="outline" onClick={() => setWorklogReportStep("config")}>
                      Generate Another
                    </Button>
                    <Button variant="outline" onClick={resetAll}>
                      Back to Home
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
```

- [ ] **Step 4: Verify UI renders compile-time**

Run:

```bash
pnpm lint
```

Expected: command exits `0`.

---

### Task 6: Full verification

**Files:**
- Verify only: all changed files

**Interfaces:**
- Consumes all prior tasks.
- Produces verified working feature.

- [ ] **Step 1: Run lint**

Run:

```bash
pnpm lint
```

Expected: exits `0`.

- [ ] **Step 2: Run production build**

Run:

```bash
pnpm build
```

Expected: exits `0`.

- [ ] **Step 3: Start app**

Run:

```bash
pnpm dev
```

Expected: dev server starts and prints a local URL.

- [ ] **Step 4: Browser smoke test**

Use Chrome DevTools MCP or manual browser:

1. Open the local URL.
2. Confirm home page shows `Worklogs Report` card.
3. Click `Worklogs Report`.
4. Confirm fields exist:
   - SEA Workspace domain/email/token.
   - ENO Workspace domain/email/token.
   - From Date.
   - To Date.
   - Generate CSV button.
5. Enter invalid dates where From Date is later than To Date.
6. Click Generate CSV.
7. Expected: error `From date must be before or equal to to date`.
8. If real credentials are available, enter both credential sets, choose a small date range, generate report, confirm progress log streams, then download CSV.
9. Open CSV and confirm exact first line:

```text
Project Name,Issue Type,Epic,Parent,Ticket No,Status,Summary,Log Date & Time,Worklog Created,Worklog Updated,Log user,Assignee,Reporter,Hr. Spent,Ori. Estm.,Total Worklogs,Rem. Estm.,Estm. Variance,Comment
```

- [ ] **Step 5: Report final status**

Report:

- Files changed.
- `pnpm lint` result.
- `pnpm build` result.
- Browser smoke result.
- Whether real credential end-to-end report was run or skipped because credentials are not available.

Do not claim real Jira data was verified unless real credentials were used.

---

## Self-review

- Spec coverage: UI mode, two credentials, date range, accountId resolution using both emails, all-space JQL, issue worklog fetch, all-worklog total, variance formula, CSV headers, SSE warnings/errors, and verification are covered.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: route and UI consume helper signatures defined in Task 1; Jira client method defined in Task 2 is consumed in Task 3.
