import { JiraClient, JiraBoard } from "@/lib/jira";

// Store export data temporarily
const exportDataStore = new Map<string, unknown>();

export async function POST(request: Request) {
  const { domain, email, apiToken, boardIds } = await request.json();

  if (!domain || !email || !apiToken || !boardIds || !Array.isArray(boardIds)) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const exportId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const client = new JiraClient({ domain, email, apiToken });

        send({ type: "status", message: "Fetching boards..." });

        const allBoards = await client.getAllBoards();
        const selectedBoards = allBoards.filter((b: JiraBoard) => boardIds.includes(b.id));

        send({ type: "status", message: `Found ${selectedBoards.length} boards to export` });

        // Fetch source workspace field metadata
        send({ type: "status", message: "Fetching field metadata..." });
        let fieldMetadata: { id: string; name: string; custom: boolean }[] = [];
        try {
          fieldMetadata = await client.getFields();
        } catch {
          send({ type: "status", message: "Warning: Could not fetch field metadata" });
        }

        const exportData: Record<string, unknown> = {
          exportedAt: new Date().toISOString(),
          sourceWorkspace: domain,
          fieldMetadata: fieldMetadata
            .filter(f => f.custom)
            .map(f => ({ id: f.id, name: f.name })),
          boards: [],
          workflow: {
            statuses: [] as string[],
            transitions: [] as { from: string; to: string; count: number }[],
          },
        };

        // Track all status transitions across all boards
        const transitionCounts = new Map<string, number>();
        const allStatuses = new Set<string>();

        for (let bi = 0; bi < selectedBoards.length; bi++) {
          const board = selectedBoards[bi];
          
          send({
            type: "progress",
            message: `Exporting board: ${board.name}`,
            boardIndex: bi + 1,
            totalBoards: selectedBoards.length,
          });

          const boardData: Record<string, unknown> = {
            id: board.id,
            name: board.name,
            type: board.type,
            project: board.location,
            sprints: [],
            backlogIssues: [],
            issues: [],
          };

          // Get all sprints for this board
          send({ type: "status", message: `Fetching sprints for ${board.name}...` });
          try {
            const sprints = await client.getAllBoardSprints(board.id);
            boardData.sprints = sprints;
            send({ type: "status", message: `Found ${sprints.length} sprints in ${board.name}` });
          } catch {
            send({ type: "status", message: `No sprints found for ${board.name} (Kanban board)` });
          }

          // Get backlog issues
          send({ type: "status", message: `Fetching backlog for ${board.name}...` });
          try {
            const backlogIssues = await client.getAllBacklogIssues(board.id);
            boardData.backlogIssues = backlogIssues.map(i => i.key);
            send({ type: "status", message: `Found ${backlogIssues.length} backlog items in ${board.name}` });
          } catch {
            send({ type: "status", message: `No backlog found for ${board.name}` });
          }

          // Get all issues for this board
          send({ type: "status", message: `Fetching issues for ${board.name}...` });
          const issues = await client.getAllBoardIssues(board.id);
          
          send({
            type: "progress",
            message: `Found ${issues.length} issues in ${board.name}`,
            boardIndex: bi + 1,
            totalBoards: selectedBoards.length,
            totalIssues: issues.length,
          });

          // For each issue, get worklogs, comments, and full subtasks
          for (let ii = 0; ii < issues.length; ii++) {
            const issue = issues[ii];
            
            // Check if issue has subtasks
            const subtaskRefs = issue.fields.subtasks as { key: string }[] | undefined;
            const hasSubtasks = subtaskRefs && subtaskRefs.length > 0;
            
            send({
              type: "issue",
              message: `Processing ${issue.key}: ${issue.fields.summary.slice(0, 50)}...${hasSubtasks ? ` (+${subtaskRefs.length} subtasks)` : ''}`,
              boardIndex: bi + 1,
              totalBoards: selectedBoards.length,
              issueIndex: ii + 1,
              totalIssues: issues.length,
              issueKey: issue.key,
            });

            const [worklogs, comments] = await Promise.all([
              client.getIssueWorklogs(issue.key),
              client.getIssueComments(issue.key),
            ]);

            // Fetch full subtask data with their worklogs and comments
            const subtasksWithData: unknown[] = [];
            if (hasSubtasks) {
              for (const subtaskRef of subtaskRefs) {
                try {
                  const [fullSubtask, subtaskWorklogs, subtaskComments] = await Promise.all([
                    client.getIssue(subtaskRef.key),
                    client.getIssueWorklogs(subtaskRef.key),
                    client.getIssueComments(subtaskRef.key),
                  ]);
                  subtasksWithData.push({
                    ...fullSubtask,
                    worklogs: subtaskWorklogs,
                    comments: subtaskComments,
                  });
                } catch {
                  // Skip failed subtask fetch
                }
              }
            }

            (boardData.issues as unknown[]).push({
              ...issue,
              worklogs,
              comments,
              subtasksData: subtasksWithData,
            });

            // Extract status transitions from changelog
            if (issue.changelog?.histories) {
              for (const history of issue.changelog.histories) {
                for (const item of history.items || []) {
                  if (item.field === 'status' && item.fromString && item.toString) {
                    allStatuses.add(item.fromString);
                    allStatuses.add(item.toString);
                    const key = `${item.fromString}|||${item.toString}`;
                    transitionCounts.set(key, (transitionCounts.get(key) || 0) + 1);
                  }
                }
              }
            }
            
            // Also add current status
            const currentStatus = issue.fields.status?.name;
            if (currentStatus) {
              allStatuses.add(currentStatus);
            }
          }

          (exportData.boards as unknown[]).push(boardData);
        }

        // Build workflow summary
        const workflow = exportData.workflow as { statuses: string[]; transitions: { from: string; to: string; count: number }[] };
        workflow.statuses = Array.from(allStatuses).sort();
        workflow.transitions = Array.from(transitionCounts.entries())
          .map(([key, count]) => {
            const [from, to] = key.split('|||');
            return { from, to, count };
          })
          .sort((a, b) => b.count - a.count);

        // Store data and send ID instead of full data
        exportDataStore.set(exportId, exportData);
        
        // Clean up old exports after 5 minutes
        setTimeout(() => exportDataStore.delete(exportId), 5 * 60 * 1000);

        send({ type: "complete", exportId });
        controller.close();
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
        controller.close();
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const exportId = url.searchParams.get("id");

  if (!exportId) {
    return new Response(JSON.stringify({ error: "Missing export ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = exportDataStore.get(exportId);
  
  if (!data) {
    return new Response(JSON.stringify({ error: "Export not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Remove from store after fetching
  exportDataStore.delete(exportId);

  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
}
