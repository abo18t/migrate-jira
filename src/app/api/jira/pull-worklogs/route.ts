import { NextRequest } from "next/server";
import { JiraClient } from "@/lib/jira";

type IssueRow = {
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name?: string };
    status?: { name?: string };
    assignee?: { displayName?: string; emailAddress?: string } | null;
    project?: { key?: string; name?: string };
    parent?: { key?: string };
  };
};

type WorklogRow = {
  id: string;
  author?: { displayName?: string; emailAddress?: string; accountId?: string };
  timeSpent?: string;
  timeSpentSeconds?: number;
  started?: string;
  created?: string;
  updated?: string;
  comment?: unknown;
};

function adfToPlainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);

  const texts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (typeof n.text === "string") texts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(value);
  return texts.join("").trim();
}

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function secondsToHours(seconds: number | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "";
  return (seconds / 3600).toFixed(2);
}

const CSV_HEADERS = [
  "Project Key",
  "Project Name",
  "Issue Key",
  "Parent",
  "Issue Type",
  "Status",
  "Summary",
  "Assignee",
  "Author",
  "Author Email",
  "Started",
  "Created",
  "Updated",
  "Time Spent",
  "Hours",
  "Seconds",
  "Comment",
  "Worklog ID",
];

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { domain, email, apiToken, projectKey } = body as {
    domain?: string;
    email?: string;
    apiToken?: string;
    projectKey?: string;
  };

  if (!domain || !email || !apiToken || !projectKey) {
    return new Response(JSON.stringify({ error: "Missing required fields: domain, email, apiToken, projectKey" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cleanKey = String(projectKey).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+$/.test(cleanKey)) {
    return new Response(JSON.stringify({ error: "Invalid project key" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
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
        const client = new JiraClient({ domain, email, apiToken });

        send({ type: "status", message: `Loading issues for project ${cleanKey}...` });

        // Prefer issues that have worklogs to cut API volume
        const issues: IssueRow[] = [];
        let nextPageToken: string | undefined;
        const fields = [
          "summary",
          "issuetype",
          "status",
          "assignee",
          "project",
          "parent",
        ];

        while (true) {
          const page = await client["fetch"]<{
            issues: IssueRow[];
            nextPageToken?: string;
            isLast?: boolean;
          }>("/rest/api/3/search/jql", {
            method: "POST",
            body: JSON.stringify({
              jql: `project=${cleanKey} AND worklogDate is not EMPTY ORDER BY key ASC`,
              fields,
              maxResults: 100,
              ...(nextPageToken ? { nextPageToken } : {}),
            }),
          });

          issues.push(...(page.issues || []));
          send({
            type: "status",
            message: `Found ${issues.length} issues with worklogs...`,
            issueCount: issues.length,
          });

          if (page.isLast !== false || !page.nextPageToken) break;
          nextPageToken = page.nextPageToken;
        }

        const totalIssues = issues.length;
        send({
          type: "status",
          message: `Fetching worklogs for ${totalIssues} issues...`,
          totalIssues,
        });

        const rows: string[][] = [CSV_HEADERS];
        let worklogCount = 0;
        let failedIssues = 0;

        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i];
          send({
            type: "progress",
            message: `[${i + 1}/${totalIssues}] ${issue.key} — ${issue.fields?.summary || ""}`,
            issueIndex: i + 1,
            totalIssues,
            currentIssueKey: issue.key,
            worklogCount,
          });

          try {
            // getIssueWorklogs returns first page; re-fetch with paging if needed
            let startAt = 0;
            const maxResults = 1000;
            const allWorklogs: WorklogRow[] = [];

            while (true) {
              const page = await client["fetch"]<{
                worklogs: WorklogRow[];
                total: number;
                startAt: number;
                maxResults: number;
              }>(`/rest/api/3/issue/${issue.key}/worklog?startAt=${startAt}&maxResults=${maxResults}`);

              const batch = page.worklogs || [];
              allWorklogs.push(...batch);
              if (allWorklogs.length >= (page.total || batch.length) || batch.length === 0) break;
              startAt += batch.length;
            }

            const projectKeyOut = issue.fields?.project?.key || cleanKey;
            const projectName = issue.fields?.project?.name || "";
            const parent = issue.fields?.parent?.key || "";
            const issueType = issue.fields?.issuetype?.name || "";
            const status = issue.fields?.status?.name || "";
            const summary = issue.fields?.summary || "";
            const assignee = issue.fields?.assignee?.displayName || "";

            for (const wl of allWorklogs) {
              rows.push([
                projectKeyOut,
                projectName,
                issue.key,
                parent,
                issueType,
                status,
                summary,
                assignee,
                wl.author?.displayName || "",
                wl.author?.emailAddress || "",
                wl.started || "",
                wl.created || "",
                wl.updated || "",
                wl.timeSpent || "",
                secondsToHours(wl.timeSpentSeconds),
                String(wl.timeSpentSeconds ?? ""),
                adfToPlainText(wl.comment),
                wl.id || "",
              ]);
              worklogCount++;
            }
          } catch (err) {
            failedIssues++;
            send({
              type: "status",
              message: `Warning: failed ${issue.key}: ${err instanceof Error ? err.message : "error"}`,
            });
          }
        }

        const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
        const totalHours = rows
          .slice(1)
          .reduce((sum, r) => sum + (parseFloat(r[14]) || 0), 0);

        send({
          type: "complete",
          results: {
            projectKey: cleanKey,
            totalIssues,
            failedIssues,
            worklogCount,
            totalHours: Number(totalHours.toFixed(2)),
            fileName: `${cleanKey}-worklogs-${new Date().toISOString().slice(0, 10)}.csv`,
          },
          csv,
        });
        closeController();
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
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
