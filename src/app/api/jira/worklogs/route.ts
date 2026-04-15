import { NextRequest } from "next/server";
import { JiraClient } from "@/lib/jira";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { domain, email, apiToken, keyMapping, importData } = body;

  if (!domain || !email || !apiToken || !keyMapping || !importData) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
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
        const boards = (importData as { boards: Array<{ issues: Array<{
          key: string;
          worklogs?: Array<{ timeSpentSeconds: number; started: string; comment?: string | unknown; author?: { displayName?: string } }>;
        }> }> }).boards;

        // Collect all issues with worklogs
        const issuesWithWorklogs: Array<{
          sourceKey: string;
          targetKey: string;
          worklogs: Array<{ timeSpentSeconds: number; started: string; comment?: string | unknown; author?: { displayName?: string } }>;
        }> = [];

        for (const board of boards) {
          for (const issue of board.issues) {
            const targetKey = keyMapping[issue.key];
            if (targetKey && issue.worklogs && issue.worklogs.length > 0) {
              issuesWithWorklogs.push({
                sourceKey: issue.key,
                targetKey,
                worklogs: issue.worklogs,
              });
            }
          }
        }

        const total = issuesWithWorklogs.length;
        send({ type: "status", message: `Found ${total} issues with worklogs to sync` });

        let synced = 0;
        let failed = 0;
        let worklogsAdded = 0;

        for (let i = 0; i < issuesWithWorklogs.length; i++) {
          const item = issuesWithWorklogs[i];
          send({
            type: "progress",
            message: `[${i + 1}/${total}] ${item.targetKey}: ${item.worklogs.length} worklogs...`,
            issueIndex: i + 1,
            totalIssues: total,
          });

          try {
            // Delete existing worklogs first
            await client.deleteAllWorklogs(item.targetKey);

            // Add worklogs from source
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
          results: { synced, failed, worklogsAdded, total },
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
