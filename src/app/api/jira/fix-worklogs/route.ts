import { JiraClient } from "@/lib/jira";

interface WorklogToFix {
  issueKey: string;
  worklogId: string;
  currentComment: string;
  originalAuthor: string;
  newComment: string;
}

// Helper to extract text from ADF comment
function extractTextFromAdf(comment: unknown): string {
  if (!comment) return "";
  if (typeof comment === "string") return comment;
  
  // ADF format
  const adf = comment as { content?: { content?: { text?: string }[] }[] };
  if (adf.content) {
    const texts: string[] = [];
    for (const block of adf.content) {
      if (block.content) {
        for (const inline of block.content) {
          if (inline.text) texts.push(inline.text);
        }
      }
    }
    return texts.join("\n");
  }
  
  return "";
}

export async function POST(request: Request) {
  const { 
    action,
    domain, 
    email, 
    apiToken,
    projectKeys, // Array of project keys to scan
    keyMapping,  // Source -> Target key mapping (to find original author)
    sourceDomain,
    sourceEmail,
    sourceApiToken,
  } = await request.json();

  if (!domain || !email || !apiToken) {
    return new Response(JSON.stringify({ error: "Missing credentials" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (action === "scan") {
    return handleScan(domain, email, apiToken, projectKeys, keyMapping, sourceDomain, sourceEmail, sourceApiToken);
  } else if (action === "fix") {
    return handleFix(domain, email, apiToken, request);
  }

  return new Response(JSON.stringify({ error: "Invalid action. Use 'scan' or 'fix'" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleScan(
  domain: string,
  email: string,
  apiToken: string,
  projectKeys: string[],
  keyMapping: Record<string, string>,
  sourceDomain?: string,
  sourceEmail?: string,
  sourceApiToken?: string,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const targetClient = new JiraClient({ domain, email, apiToken });
        
        // Build reverse mapping: target key -> source key
        const reverseMapping: Record<string, string> = {};
        for (const [sourceKey, targetKey] of Object.entries(keyMapping || {})) {
          reverseMapping[targetKey] = sourceKey;
        }

        // Source client for looking up original worklog authors
        let sourceClient: JiraClient | null = null;
        if (sourceDomain && sourceEmail && sourceApiToken) {
          sourceClient = new JiraClient({ domain: sourceDomain, email: sourceEmail, apiToken: sourceApiToken });
        }

        const worklogsToFix: WorklogToFix[] = [];
        let totalIssuesScanned = 0;
        let totalWorklogsScanned = 0;

        for (const projectKey of projectKeys) {
          send({ type: "status", message: `Scanning project ${projectKey}...` });

          // Get all issues in project
          let startAt = 0;
          const maxResults = 100;

          while (true) {
            const response = await targetClient["fetch"]<{ issues: { key: string }[]; total: number }>(
              `/rest/api/3/search?jql=project=${projectKey} ORDER BY key ASC&fields=key&startAt=${startAt}&maxResults=${maxResults}`
            );

            for (const issue of response.issues) {
              totalIssuesScanned++;
              
              // Get worklogs for this issue
              const worklogs = await targetClient.getIssueWorklogs(issue.key);
              
              for (const worklog of worklogs) {
                totalWorklogsScanned++;
                const commentText = extractTextFromAdf(worklog.comment);
                
                // Check if this worklog already has "[Logged by: ...]"
                if (commentText.includes("[Logged by:")) {
                  continue; // Already fixed
                }

                // Try to find original author
                let originalAuthor = "";
                
                // Method 1: Look up from source if we have mapping and source credentials
                const sourceKey = reverseMapping[issue.key];
                if (sourceClient && sourceKey) {
                  try {
                    const sourceWorklogs = await sourceClient.getIssueWorklogs(sourceKey);
                    // Match by started time and timeSpentSeconds
                    const matchingWorklog = sourceWorklogs.find(sw => 
                      sw.started === worklog.started && 
                      sw.timeSpentSeconds === worklog.timeSpentSeconds
                    );
                    if (matchingWorklog) {
                      originalAuthor = matchingWorklog.author.displayName;
                    }
                  } catch {
                    // Source issue might not exist anymore
                  }
                }

                // If we found original author and it's different from current author
                if (originalAuthor && originalAuthor !== worklog.author.displayName) {
                  const newComment = commentText 
                    ? `[Logged by: ${originalAuthor}]\n${commentText}`
                    : `[Logged by: ${originalAuthor}]`;

                  worklogsToFix.push({
                    issueKey: issue.key,
                    worklogId: worklog.id,
                    currentComment: commentText,
                    originalAuthor,
                    newComment,
                  });
                }
              }

              if (totalIssuesScanned % 10 === 0) {
                send({
                  type: "progress",
                  message: `Scanned ${totalIssuesScanned} issues, ${totalWorklogsScanned} worklogs, found ${worklogsToFix.length} to fix`,
                  issuesScanned: totalIssuesScanned,
                  worklogsScanned: totalWorklogsScanned,
                  toFix: worklogsToFix.length,
                });
              }
            }

            startAt += response.issues.length;
            if (startAt >= response.total || response.issues.length === 0) break;
          }
        }

        send({
          type: "complete",
          worklogsToFix,
          summary: {
            issuesScanned: totalIssuesScanned,
            worklogsScanned: totalWorklogsScanned,
            toFix: worklogsToFix.length,
          },
        });
        controller.close();

      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
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

async function handleFix(
  domain: string,
  email: string,
  apiToken: string,
  request: Request,
) {
  const body = await request.json();
  const { worklogsToFix } = body as { worklogsToFix: WorklogToFix[] };

  if (!worklogsToFix || worklogsToFix.length === 0) {
    return new Response(JSON.stringify({ error: "No worklogs to fix" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const client = new JiraClient({ domain, email, apiToken });
        
        let fixed = 0;
        let failed = 0;

        send({ type: "status", message: `Fixing ${worklogsToFix.length} worklogs...` });

        for (let i = 0; i < worklogsToFix.length; i++) {
          const worklog = worklogsToFix[i];
          
          try {
            const success = await client.updateWorklogComment(
              worklog.issueKey,
              worklog.worklogId,
              worklog.newComment
            );

            if (success) {
              fixed++;
            } else {
              failed++;
            }
          } catch {
            failed++;
          }

          if ((i + 1) % 5 === 0 || i === worklogsToFix.length - 1) {
            send({
              type: "progress",
              message: `Fixed ${fixed}/${worklogsToFix.length}, failed: ${failed}`,
              fixed,
              failed,
              total: worklogsToFix.length,
              current: i + 1,
            });
          }
        }

        send({
          type: "complete",
          fixed,
          failed,
          total: worklogsToFix.length,
        });
        controller.close();

      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
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
