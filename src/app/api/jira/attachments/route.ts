import { JiraClient } from "@/lib/jira";

interface AttachmentIssue {
  sourceKey: string;
  targetKey: string;
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    content: string; // URL to download from source
  }[];
}

// Export attachments from source
export async function POST(request: Request) {
  const { 
    action,
    sourceDomain, 
    sourceEmail, 
    sourceApiToken,
    targetDomain,
    targetEmail,
    targetApiToken,
    keyMapping, // { "OLD-1": "NEW-1", ... }
  } = await request.json();

  if (action === "export") {
    return handleExport(sourceDomain, sourceEmail, sourceApiToken, keyMapping);
  } else if (action === "import") {
    return handleImport(targetDomain, targetEmail, targetApiToken, keyMapping, request);
  }

  return new Response(JSON.stringify({ error: "Invalid action" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleExport(
  domain: string, 
  email: string, 
  apiToken: string, 
  keyMapping: Record<string, string>
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const client = new JiraClient({ domain, email, apiToken });
        const sourceKeys = Object.keys(keyMapping);
        
        send({ type: "status", message: `Scanning ${sourceKeys.length} issues for attachments...` });

        const issuesWithAttachments: AttachmentIssue[] = [];
        let totalAttachments = 0;

        for (let i = 0; i < sourceKeys.length; i++) {
          const sourceKey = sourceKeys[i];
          const targetKey = keyMapping[sourceKey];

          try {
            const attachments = await client.getIssueAttachments(sourceKey);
            
            if (attachments.length > 0) {
              issuesWithAttachments.push({
                sourceKey,
                targetKey,
                attachments: attachments.map(a => ({
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                  content: a.content,
                })),
              });
              totalAttachments += attachments.length;
            }
          } catch {
            // Skip issues that can't be accessed
          }

          if ((i + 1) % 10 === 0 || i === sourceKeys.length - 1) {
            send({ 
              type: "progress", 
              message: `Scanned ${i + 1}/${sourceKeys.length} issues, found ${totalAttachments} attachments`,
              current: i + 1,
              total: sourceKeys.length,
            });
          }
        }

        send({
          type: "complete",
          issuesWithAttachments,
          totalAttachments,
          totalIssues: issuesWithAttachments.length,
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

async function handleImport(
  domain: string,
  email: string,
  apiToken: string,
  _keyMapping: Record<string, string>,
  request: Request
) {
  const body = await request.json();
  const { issuesWithAttachments } = body as { issuesWithAttachments: AttachmentIssue[] };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const sourceClient = new JiraClient({ 
          domain: body.sourceDomain, 
          email: body.sourceEmail, 
          apiToken: body.sourceApiToken 
        });
        const targetClient = new JiraClient({ domain, email, apiToken });

        let uploaded = 0;
        let failed = 0;
        const totalAttachments = issuesWithAttachments.reduce((sum, i) => sum + i.attachments.length, 0);

        send({ type: "status", message: `Uploading ${totalAttachments} attachments...` });

        for (const issue of issuesWithAttachments) {
          send({ type: "status", message: `Processing ${issue.targetKey} (${issue.attachments.length} files)...` });

          for (const att of issue.attachments) {
            try {
              // Download from source
              const downloaded = await sourceClient.downloadAttachment(att.content);
              if (!downloaded) {
                failed++;
                continue;
              }

              // Upload to target
              const success = await targetClient.addAttachment(
                issue.targetKey,
                att.filename,
                downloaded.data,
                att.mimeType
              );

              if (success) {
                uploaded++;
              } else {
                failed++;
              }

              send({
                type: "progress",
                message: `${att.filename} -> ${issue.targetKey}`,
                uploaded,
                failed,
                total: totalAttachments,
              });

            } catch (error) {
              failed++;
              console.log(`[attachment] Error:`, error);
            }
          }
        }

        send({
          type: "complete",
          uploaded,
          failed,
          total: totalAttachments,
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
