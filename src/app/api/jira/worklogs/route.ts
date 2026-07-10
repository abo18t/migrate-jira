import { NextRequest } from "next/server";
import { JiraClient } from "@/lib/jira";

type SourceIssue = {
  key: string;
  fields?: { summary?: string; issuetype?: { name?: string; subtask?: boolean } };
  worklogs?: Array<{ timeSpentSeconds: number; started: string; comment?: string | unknown; author?: { displayName?: string } }>;
};

type SourceBoard = {
  project?: { projectKey?: string; projectName?: string };
  issues: SourceIssue[];
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const {
    domain,
    email,
    apiToken,
    keyMapping: providedKeyMapping,
    projectMapping,
    importData,
    safeMode,
  } = body as {
    domain?: string;
    email?: string;
    apiToken?: string;
    keyMapping?: Record<string, string>;
    projectMapping?: Record<string, string>;
    importData?: { boards: SourceBoard[] };
    safeMode?: boolean;
  };

  if (!domain || !email || !apiToken || !importData) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!providedKeyMapping && !projectMapping) {
    return new Response(
      JSON.stringify({ error: "Provide either keyMapping or projectMapping" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
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
        const boards = importData.boards;

        // Build / derive keyMapping
        const keyMapping: Record<string, string> = { ...(providedKeyMapping || {}) };

        const typeCategoryOf = (name: string | undefined, subtask?: boolean): 'epic' | 'standard' | 'subtask' => {
          const t = (name || '').toLowerCase();
          if (t === 'epic') return 'epic';
          if (subtask || t === 'subtask' || t === 'sub-task') return 'subtask';
          return 'standard';
        };

        if (projectMapping) {
          // Resolve unique source projects from boards
          const sourceProjects = new Set<string>();
          for (const b of boards) {
            const k = b.project?.projectKey;
            if (k) sourceProjects.add(k);
          }

          for (const srcProjectKey of sourceProjects) {
            const targetProjectKey = projectMapping[srcProjectKey];
            if (!targetProjectKey) continue;

            // List board names for this source project (for UI trace)
            const boardNamesForProject = boards
              .filter(b => b.project?.projectKey === srcProjectKey)
              .map(b => (b as unknown as { name?: string }).name || "unnamed");
            const boardLabel = boardNamesForProject.length > 0 ? ` (boards: ${boardNamesForProject.join(", ")})` : "";

            send({ type: "status", message: `Scanning target project ${targetProjectKey} for source ${srcProjectKey}${boardLabel}...` });
            let targetIssues: Array<{ key: string; summary: string; typeCategory: 'epic' | 'standard' | 'subtask' }> = [];
            try {
              targetIssues = await client.getProjectIssuesForMatching(targetProjectKey);
            } catch (err) {
              send({ type: "status", message: `Warning: scan failed for ${targetProjectKey}: ${err instanceof Error ? err.message : 'error'}` });
              continue;
            }

            const summaryToTargets: Record<string, Array<{ key: string; typeCategory: 'epic' | 'standard' | 'subtask' }>> = {};
            for (const ti of targetIssues) {
              if (!summaryToTargets[ti.summary]) summaryToTargets[ti.summary] = [];
              summaryToTargets[ti.summary].push({ key: ti.key, typeCategory: ti.typeCategory });
            }

            const claimed = new Set<string>();
            let matched = 0;
            let unmatched = 0;

            // Collect source issues for this project, sorted by key number
            const srcIssues: SourceIssue[] = [];
            for (const b of boards) {
              if (b.project?.projectKey !== srcProjectKey) continue;
              for (const iss of b.issues) srcIssues.push(iss);
            }
            srcIssues.sort((a, b) => {
              const an = parseInt((a.key.split('-')[1] || '0'), 10);
              const bn = parseInt((b.key.split('-')[1] || '0'), 10);
              return an - bn;
            });

            for (const issue of srcIssues) {
              if (keyMapping[issue.key]) continue; // already provided
              const summary = issue.fields?.summary;
              const candidates = summary ? summaryToTargets[summary] : undefined;
              if (!candidates || candidates.length === 0) {
                unmatched++;
                continue;
              }
              const srcCategory = typeCategoryOf(issue.fields?.issuetype?.name, issue.fields?.issuetype?.subtask);
              const match = candidates.find(c => !claimed.has(c.key) && c.typeCategory === srcCategory);
              if (match) {
                keyMapping[issue.key] = match.key;
                claimed.add(match.key);
                matched++;
              } else {
                unmatched++;
              }
            }

            send({ type: "status", message: `${srcProjectKey} → ${targetProjectKey}: matched ${matched}, unmatched ${unmatched}` });
          }
        }

        // Collect all issues with worklogs
        const issuesWithWorklogs: Array<{
          sourceKey: string;
          targetKey: string;
          summary: string;
          boardName: string;
          sourceProjectKey: string;
          targetProjectKey: string;
          worklogs: Array<{ timeSpentSeconds: number; started: string; comment?: string | unknown; author?: { displayName?: string } }>;
        }> = [];

        for (const board of boards) {
          const boardName = (board as unknown as { name?: string }).name || board.project?.projectName || board.project?.projectKey || "unknown board";
          const srcProjectKey = board.project?.projectKey || "";
          const tgtProjectKey = (projectMapping && srcProjectKey && projectMapping[srcProjectKey]) || "";
          for (const issue of board.issues) {
            const targetKey = keyMapping[issue.key];
            if (targetKey && issue.worklogs && issue.worklogs.length > 0) {
              issuesWithWorklogs.push({
                sourceKey: issue.key,
                targetKey,
                summary: issue.fields?.summary || "",
                boardName,
                sourceProjectKey: srcProjectKey,
                targetProjectKey: tgtProjectKey,
                worklogs: issue.worklogs,
              });
            }
          }
        }

        const total = issuesWithWorklogs.length;
        send({
          type: "status",
          message: `Found ${total} issues with worklogs to ${safeMode ? "safely re-sync" : "sync"}`,
          keyMappingSize: Object.keys(keyMapping).length,
        });

        let synced = 0;
        let failed = 0;
        let worklogsAdded = 0;
        let worklogsDeleted = 0;
        let worklogsSkipped = 0;

        const toolEmail = String(email).toLowerCase();

        const dateKey = (iso: string) => (iso || "").slice(0, 10); // YYYY-MM-DD

        for (let i = 0; i < issuesWithWorklogs.length; i++) {
          const item = issuesWithWorklogs[i];
          const summarySnippet = item.summary ? ` "${item.summary.slice(0, 60)}${item.summary.length > 60 ? "…" : ""}"` : "";
          const projectLabel = item.sourceProjectKey && item.targetProjectKey
            ? `${item.sourceProjectKey}→${item.targetProjectKey}`
            : (item.targetProjectKey || item.sourceProjectKey || "");
          send({
            type: "progress",
            message: `[${i + 1}/${total}] [${projectLabel}] [${item.boardName}] ${item.sourceKey} → ${item.targetKey}${summarySnippet} — ${item.worklogs.length} worklogs`,
            issueIndex: i + 1,
            totalIssues: total,
            board: item.boardName,
            sourceProjectKey: item.sourceProjectKey,
            targetProjectKey: item.targetProjectKey,
            sourceKey: item.sourceKey,
            targetKey: item.targetKey,
            summary: item.summary,
          });

          try {
            if (safeMode) {
              const sourceDates = new Set<string>();
              for (const wl of item.worklogs) {
                const d = dateKey(wl.started);
                if (d) sourceDates.add(d);
              }

              let targetWorklogs: Array<{ id: string; started: string; author: { emailAddress?: string } }> = [];
              try {
                const raw = await client.getIssueWorklogs(item.targetKey);
                targetWorklogs = raw as unknown as typeof targetWorklogs;
              } catch {
                targetWorklogs = [];
              }

              for (const tw of targetWorklogs) {
                const authorEmail = (tw.author?.emailAddress || "").toLowerCase();
                const d = dateKey(tw.started);
                if (authorEmail === toolEmail && sourceDates.has(d)) {
                  try {
                    await client["fetch"](
                      `/rest/api/3/issue/${item.targetKey}/worklog/${tw.id}`,
                      { method: "DELETE" }
                    );
                    worklogsDeleted++;
                  } catch {
                    // Continue
                  }
                } else {
                  worklogsSkipped++;
                }
              }
            } else {
              const deleted = await client.deleteAllWorklogs(item.targetKey);
              worklogsDeleted += deleted;
            }

            for (const worklog of item.worklogs) {
              try {
                await client.addWorklog(item.targetKey, {
                  timeSpentSeconds: worklog.timeSpentSeconds,
                  started: worklog.started,
                  comment: worklog.comment || undefined,
                  originalAuthor: worklog.author?.displayName || undefined,
                });
                worklogsAdded++;
              } catch {
                // Continue with next worklog
              }
            }
            synced++;
          } catch {
            failed++;
          }
        }

        send({
          type: "complete",
          results: { synced, failed, worklogsAdded, worklogsDeleted, worklogsSkipped, total, keyMappingSize: Object.keys(keyMapping).length },
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
