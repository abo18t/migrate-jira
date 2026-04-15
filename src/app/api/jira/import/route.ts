import { JiraClient } from "@/lib/jira";
import { getEmailFromDisplayName } from "@/lib/staff-mapping";

interface IssueLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { key: string };
  outwardIssue?: { key: string };
}

interface ImportIssue {
  key: string;
  fields: {
    summary: string;
    description?: string;
    issuetype: { name: string };
    status?: {
      name: string;
      statusCategory?: { key: string; name: string };
    };
    priority?: { name: string };
    labels?: string[];
    parent?: { key: string };
    assignee?: { accountId: string; emailAddress?: string; displayName?: string };
    duedate?: string;
    timeoriginalestimate?: number;
    sprint?: { id: number; name: string } | null;
    closedSprints?: { id: number; name: string; state: string }[];
    issuelinks?: IssueLink[];
    // Custom fields - common ones
    customfield_10015?: string; // Start date
    customfield_10016?: number; // Story points (varies by instance)
    customfield_10017?: string; // Color
    [key: string]: unknown;
  };
  worklogs?: {
    timeSpentSeconds: number;
    started: string;
    comment?: string;
    author?: { displayName: string };
  }[];
  comments?: {
    body: string;
    created: string;
    author?: { displayName: string };
  }[];
  attachmentData?: {
    filename: string;
    mimeType: string;
    data: string; // base64
  }[];
  subtasksData?: ImportIssue[];
}

interface ImportSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

interface ImportBoard {
  name: string;
  project?: { projectKey: string; projectName: string };
  sprints?: ImportSprint[];
  backlogIssues?: string[];
  issues: ImportIssue[];
}

interface ImportData {
  boards: ImportBoard[];
}

// Standard issue types that most Jira instances have
const STANDARD_ISSUE_TYPES = ['epic', 'story', 'task', 'bug', 'subtask', 'sub-task', 'phase', 'improvement'];

// Default issue type mapping for custom types
const DEFAULT_ISSUE_TYPE_MAPPING: Record<string, string> = {
  'feature': 'Story',
  'spike': 'Task',
  'technical task': 'Task',
  'design': 'Task',
  'research': 'Task',
};

export async function POST(request: Request) {
  console.log("=== IMPORT API CALLED ===");

  let requestBody;
  try {
    console.log("Step 1: Parsing request body...");
    requestBody = await request.json();
    console.log("Step 1: OK - body parsed");
  } catch (parseError) {
    console.error("Step 1: FAILED - parse error:", parseError);
    return new Response(JSON.stringify({ error: "Invalid request body: " + (parseError instanceof Error ? parseError.message : "Unknown") }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const {
    domain,
    email,
    apiToken,
    projectMapping,
    importData,
    autoCreateProjects,
    fieldMapping,
    issueTypeMapping,
    reimportMode,
    reimportOptions: reimportOptionsInput,
    existingKeyMapping: existingKeyMappingInput,
    streaming,
  } = requestBody;

  const reimportOpts = {
    updateFields: true,
    updateComments: true,
    updateWorklogs: true,
    updateLinks: true,
    updateSprintsOnly: false,
    ...(reimportOptionsInput || {}),
  };

  // For reimport mode: old key -> new key mapping from previous audit log
  // Detect and discard identity mappings ONLY when NOT in sprintsOnly mode // (identity mappings are valid when source and target use the same project key)
  let existingKeyMapping: Record<string, string> = existingKeyMappingInput || {};
  if (Object.keys(existingKeyMapping).length > 0 && !reimportOptionsInput?.updateSprintsOnly) {
    const hasRealMapping = Object.entries(existingKeyMapping).some(([k, v]) => k !== v);
    if (!hasRealMapping) {
      console.log("[reimport] Detected identity key mapping (all keys map to themselves) - discarding, will use summary matching instead");
      existingKeyMapping = {};
    }
  }

  let matchMethodUsed: 'audit-log' | 'summary' | 'none' = Object.keys(existingKeyMapping).length > 0 ? 'audit-log' : 'none';

  console.log("Step 2: Request params:", {
    domain,
    streaming,
    reimportMode,
    projectCount: importData?.boards?.length || 0,
    issueCount: importData?.boards?.reduce((sum: number, b: { issues?: unknown[] }) => sum + (b.issues?.length || 0), 0) || 0,
  });

  if (!domain || !email || !apiToken || !projectMapping || !importData) {
    console.log("Step 3: FAILED - missing required fields");
    return new Response(JSON.stringify({ error: "Missing required fields" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Step 3: Validation passed");

  // If not streaming, fall back to original JSON response
  if (!streaming) {
    console.log("Step 4: Using non-streaming mode");
    return handleNonStreamingImport({
      domain, email, apiToken, projectMapping, importData,
      autoCreateProjects, fieldMapping, issueTypeMapping, reimportMode,
    });
  }

  console.log("Step 4: Using streaming mode");

  // Streaming SSE response
  const encoder = new TextEncoder();
  let controllerClosed = false;
  const stream = new ReadableStream({
    async start(controller) {
      console.log("Step 5: Stream started");

      const send = (data: Record<string, unknown>) => {
        if (controllerClosed) return;
        try {
          const msg = `data: ${JSON.stringify(data)}\n\n`;
          console.log("SSE send:", data.type, data.message || "");
          controller.enqueue(encoder.encode(msg));
        } catch (e) {
          console.log("SSE send failed (controller closed):", e instanceof Error ? e.message : e);
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

        // Get target workspace custom fields by name
        send({ type: "status", message: "Fetching target workspace fields..." });
        const targetFields = await client.getCustomFieldsByName();
        console.log("[import] Target custom fields:", Object.keys(targetFields).slice(0, 10));

        // Map fields by name (case-insensitive)
        const fieldIds = {
          storyPoints: targetFields['story points'] || targetFields['story point estimate'] || fieldMapping?.storyPoints || 'customfield_10016',
          startDate: targetFields['start date'] || fieldMapping?.startDate || 'customfield_10015',
          projectWeight: targetFields['project weight'] || fieldMapping?.projectWeight || null,
          color: targetFields['color'] || targetFields['issue color'] || null,
        };
        console.log("[import] Field IDs:", fieldIds);

        // Fetch available issue types from target workspace
        send({ type: "status", message: "Fetching target issue types..." });
        let targetIssueTypes: { id: string; name: string; subtask: boolean }[] = [];
        try {
          targetIssueTypes = await client.getIssueTypes();
        } catch {
          send({ type: "status", message: "Warning: Could not fetch issue types, using defaults" });
        }
        // Build lowercase -> exact name lookup for target issue types
        const targetTypeByLower = new Map<string, string>();
        for (const t of targetIssueTypes) {
          targetTypeByLower.set(t.name.toLowerCase(), t.name);
        }
        console.log("[import] Available issue types:", Array.from(targetTypeByLower.values()));

        // Merge default and custom issue type mapping
        const issueTypes: Record<string, string> = {
          ...DEFAULT_ISSUE_TYPE_MAPPING,
          ...Object.fromEntries(
            Object.entries(issueTypeMapping || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
          ),
        };

        // Helper to resolve exact target type name (case-insensitive match)
        const resolveTargetType = (name: string): string | undefined => {
          return targetTypeByLower.get(name.toLowerCase());
        };

        // Helper to map issue type, validated against target workspace
        const mapIssueType = (originalType: string): string => {
          // If the original type exists in target (case-insensitive), use target's exact name
          const exactMatch = resolveTargetType(originalType);
          if (exactMatch) {
            return exactMatch;
          }

          // Check explicit mapping
          const lower = originalType.toLowerCase();
          if (issueTypes[lower]) {
            const mapped = issueTypes[lower];
            const exactMapped = resolveTargetType(mapped);
            if (exactMapped) {
              return exactMapped;
            }
          }

          // Fallback: try common types in order of preference
          for (const fallback of ['Task', 'Story', 'Bug']) {
            const exact = resolveTargetType(fallback);
            if (exact) return exact;
          }

          return 'Task';
        };

        const results: {
          success: { oldKey: string; newKey: string; project: string; action: 'created' | 'updated'; matchMethod?: string }[];
          failed: { oldKey: string; error: string }[];
          createdProjects: string[];
          skipped: { oldKey: string; reason: string }[];
          warnings: string[];
          linksCreated: number;
          linksFailed: number;
          linksDetail: { source: string; target: string; type: string; action: 'created' | 'deleted' }[];
          assigneesSet: number;
          assigneesFailed: number;
          attachmentsUploaded: number;
          attachmentsFailed: number;
        } = {
          success: [],
          failed: [],
          createdProjects: [],
          skipped: [],
          warnings: [],
          linksCreated: 0,
          linksFailed: 0,
          linksDetail: [],
          assigneesSet: 0,
          assigneesFailed: 0,
          attachmentsUploaded: 0,
          attachmentsFailed: 0,
        };

        const keyMapping: Record<string, string> = {};
        const projectCreationErrors: Record<string, string> = {};

        // Calculate total issues across all boards
        const boards = (importData as ImportData).boards;
        const totalIssues = boards.reduce((sum, b) => sum + b.issues.length, 0);
        let globalIssueIndex = 0;

        send({ type: "status", message: "Starting import...", totalIssues, totalProjects: boards.length });

        // Auto-create projects if needed
        if (autoCreateProjects) {
          for (const board of boards) {
            const sourceProjectKey = board.project?.projectKey;
            const sourceProjectName = board.project?.projectName;
            const targetProjectKey = sourceProjectKey ? projectMapping[sourceProjectKey] : null;

            if (targetProjectKey && sourceProjectKey === targetProjectKey) {
              const exists = await client.projectExists(targetProjectKey);
              if (!exists) {
                send({ type: "status", message: `Creating project ${targetProjectKey}...` });
                try {
                  await client.createProject({
                    key: targetProjectKey,
                    name: sourceProjectName || targetProjectKey,
                    projectTypeKey: "software",
                    projectTemplate: "scrum",
                  });
                  results.createdProjects.push(targetProjectKey);
                } catch (error) {
                  const errorMsg = error instanceof Error ? error.message : "Unknown error";
                  projectCreationErrors[targetProjectKey] = errorMsg;
                }
              }
            }
          }
        }

        // Process each board
        for (let pi = 0; pi < boards.length; pi++) {
          const board = boards[pi];
          const sourceProjectKey = board.project?.projectKey;
          const targetProjectKey = sourceProjectKey ? projectMapping[sourceProjectKey] : null;

          send({
            type: "progress",
            message: `Processing project ${targetProjectKey || sourceProjectKey}`,
            projectIndex: pi + 1,
            totalProjects: boards.length,
            issueIndex: globalIssueIndex,
            totalIssues,
          });

          if (!targetProjectKey) {
            for (const issue of board.issues) {
              results.failed.push({
                oldKey: issue.key,
                error: `No project mapping found for ${sourceProjectKey}`,
              });
              globalIssueIndex++;
            }
            continue;
          }

          if (projectCreationErrors[targetProjectKey]) {
            for (const issue of board.issues) {
              results.failed.push({
                oldKey: issue.key,
                error: `Project "${targetProjectKey}" could not be created: ${projectCreationErrors[targetProjectKey]}`,
              });
              globalIssueIndex++;
            }
            continue;
          }

          const projectExists = await client.projectExists(targetProjectKey);
          if (!projectExists) {
            for (const issue of board.issues) {
              results.failed.push({
                oldKey: issue.key,
                error: `Project "${targetProjectKey}" does not exist.`,
              });
              globalIssueIndex++;
            }
            continue;
          }

          const boardType = await client.getProjectBoardType(targetProjectKey);
          const isKanban = boardType === 'kanban';
          if (isKanban && board.sprints && board.sprints.length > 0) {
            results.warnings.push(
              `Project "${targetProjectKey}" is Kanban - sprints will be skipped (${board.sprints.length} sprints in source).`
            );
            send({ type: "status", message: `Note: ${targetProjectKey} is Kanban, sprints will be skipped` });
          }

          // REIMPORT MODE: Build key mapping and scan existing issues
          const issuesToCreate: ImportIssue[] = [];
          const existingIssueKeys = new Set<string>();


          if (reimportMode) {
            // If no audit log provided, scan target and match by summary
            if (Object.keys(existingKeyMapping).length === 0) {
              send({ type: "status", message: `Scanning ${targetProjectKey} issues for matching...`, phase: "scanning" });
              try {
                const targetIssues = await client.getProjectIssuesForMatching(targetProjectKey);

                // Build summary -> list of target issues (handle duplicates)
                const summaryToTargets: Record<string, Array<{ key: string; typeCategory: 'epic' | 'standard' | 'subtask' }>> = {};
                for (const ti of targetIssues) {
                  if (!summaryToTargets[ti.summary]) summaryToTargets[ti.summary] = [];
                  summaryToTargets[ti.summary].push({ key: ti.key, typeCategory: ti.typeCategory });
                }

                // Track which target keys have been claimed
                const claimedTargetKeys = new Set<string>();
                const matchCount = { found: 0, notFound: 0, typeSkipped: 0 };

                // Sort source issues by key number for deterministic matching
                const sortedSourceIssues = [...board.issues].sort((a, b) => {
                  const aNum = parseInt(a.key.split('-')[1]) || 0;
                  const bNum = parseInt(b.key.split('-')[1]) || 0;
                  return aNum - bNum;
                });

                for (const issue of sortedSourceIssues) {
                  const summary = issue.fields.summary;
                  const candidates = summary ? summaryToTargets[summary] : undefined;
                  if (candidates && candidates.length > 0) {
                    // Determine source type category: epic | standard | subtask
                    const srcTypeName = (issue.fields.issuetype?.name || '').toLowerCase();
                    const srcCategory: 'epic' | 'standard' | 'subtask' =
                      srcTypeName === 'epic' ? 'epic' :
                      (srcTypeName === 'subtask' || srcTypeName === 'sub-task') ? 'subtask' : 'standard';

                    // Only match compatible type categories (epic↔epic, standard↔standard, subtask↔subtask)
                    const match = candidates.find(c => !claimedTargetKeys.has(c.key) && c.typeCategory === srcCategory);
                    if (match) {
                      existingKeyMapping[issue.key] = match.key;
                      claimedTargetKeys.add(match.key);
                      matchCount.found++;
                    } else {
                      // Type-mismatched candidate exists - claim it but don't match, create new instead
                      const mismatch = candidates.find(c => !claimedTargetKeys.has(c.key));
                      if (mismatch) {
                        claimedTargetKeys.add(mismatch.key);
                        matchCount.typeSkipped++;
                        results.warnings.push(`${issue.key} (${issue.fields.issuetype?.name}) vs ${mismatch.key} (${mismatch.typeCategory}): type incompatible, creating new. Delete ${mismatch.key} manually.`);
                      } else {
                        matchCount.notFound++;
                      }
                    }
                  } else {
                    matchCount.notFound++;
                  }
                }

                send({ type: "status", message: `Matched ${matchCount.found}/${board.issues.length} issues by summary${matchCount.typeSkipped > 0 ? ` (${matchCount.typeSkipped} type mismatches)` : ''}` });
                if (matchCount.notFound > 0) {
                  results.warnings.push(`${matchCount.notFound} issues not found in target ${targetProjectKey}`);
                }
                if (matchCount.typeSkipped > 0) {
                  results.warnings.push(`${matchCount.typeSkipped} issues skipped due to type mismatch (subtask vs non-subtask) in ${targetProjectKey}`);
                }
                matchMethodUsed = 'summary';
              } catch (scanErr) {
                send({ type: "status", message: `Warning: Could not scan target issues: ${scanErr instanceof Error ? scanErr.message : 'Unknown'}` });
              }
            }

            // Verify which mapped issues actually exist
            send({ type: "status", message: `Verifying existing issues in ${targetProjectKey}...` });

            for (const issue of board.issues) {
              const expectedKey = existingKeyMapping[issue.key];

              if (expectedKey) {
                const exists = await client.issueExists(expectedKey);
                if (exists) {
                  existingIssueKeys.add(issue.key);
                } else {
                  delete existingKeyMapping[issue.key];
                  issuesToCreate.push(issue);
                }
              } else {
                issuesToCreate.push(issue);
              }
            }

            send({
              type: "status",
              message: `Found ${existingIssueKeys.size} existing, ${issuesToCreate.length} to create`
            });

            // updateSprintsOnly: build keyMapping from existing matches, skip issues
            if (reimportOpts.updateSprintsOnly) {
              send({ type: "status", message: `⚡ Sprints-only mode: skipping issue updates, building key mapping...` });
              for (const issue of board.issues) {
                const mapped = existingKeyMapping[issue.key];
                if (mapped) {
                  // Include all mapped issues (both verified-existing and newly found)
                  keyMapping[issue.key] = mapped;
                } else {
                  // Fallback: try key-number based mapping (OLD-123 → NEW-123)
                  const issueNum = issue.key.split('-')[1];
                  const fallbackKey = `${targetProjectKey}-${issueNum}`;
                  const fallbackExists = await client.issueExists(fallbackKey);
                  if (fallbackExists) {
                    keyMapping[issue.key] = fallbackKey;
                  }
                }
              }
              send({ type: "status", message: `Key mapping: ${Object.keys(keyMapping).length}/${board.issues.length} issues mapped` });
              // Skip to sprint handling (after the issue processing blocks)
              // We jump past the issue creation/update sections below
            }
          }

          if (reimportMode && reimportOpts.updateSprintsOnly) {
            // Skip staff adding & issue processing entirely — go straight to sprints
          } else {

          // Auto-add staff to project for assignment permissions
          // Collect unique assignee emails from issues
          const staffEmails = new Set<string>();
          for (const issue of board.issues) {
            const assignee = issue.fields.assignee;
            if (assignee) {
              const mappedEmail = getEmailFromDisplayName(assignee.displayName || '');
              const email = mappedEmail || assignee.emailAddress;
              if (email) staffEmails.add(email);
            }
          }

          if (staffEmails.size > 0) {
            send({ type: "status", message: `Adding ${staffEmails.size} staff members to ${targetProjectKey}...` });
            // Resolve emails to accountIds
            const staffAccountIds: string[] = [];
            for (const email of staffEmails) {
              const accountId = await client.findUserCached(email);
              if (accountId) staffAccountIds.push(accountId);
            }

            if (staffAccountIds.length > 0) {
              const addResult = await client.addStaffToProject(targetProjectKey, staffAccountIds);
              if (addResult.added > 0) {
                send({ type: "status", message: `Added ${addResult.added} staff to project role` });
              }
              if (addResult.failed > 0) {
                results.warnings.push(`Failed to add ${addResult.failed} staff to ${targetProjectKey}`);
              }
            }
          }

          // Sort all issues: Epics first, then by key number, but parents before children
          const sortIssues = (issues: ImportIssue[]) => [...issues].sort((a, b) => {
            const aType = a.fields.issuetype?.name?.toLowerCase() || '';
            const bType = b.fields.issuetype?.name?.toLowerCase() || '';
            const aIsEpic = aType === 'epic';
            const bIsEpic = bType === 'epic';
            const aIsSubtask = aType === 'subtask' || aType === 'sub-task';
            const bIsSubtask = bType === 'subtask' || bType === 'sub-task';
            const aHasParent = !!a.fields.parent;
            const bHasParent = !!b.fields.parent;

            // Epics first
            if (aIsEpic && !bIsEpic) return -1;
            if (!aIsEpic && bIsEpic) return 1;

            // Non-subtask without parent before those with parent
            if (!aIsSubtask && !bIsSubtask) {
              if (!aHasParent && bHasParent) return -1;
              if (aHasParent && !bHasParent) return 1;
            }

            // Subtasks last
            if (!aIsSubtask && bIsSubtask) return -1;
            if (aIsSubtask && !bIsSubtask) return 1;

            // Within same category, sort by key number
            const aNum = parseInt(a.key.split('-')[1]) || 0;
            const bNum = parseInt(b.key.split('-')[1]) || 0;
            return aNum - bNum;
          });

          // Helper to process custom fields for an issue
          const buildCustomFields = (issue: ImportIssue) => {
            const customFields: Record<string, unknown> = {};

            const storyPointsValue = issue.fields.customfield_10016
              || issue.fields['Story Points']
              || issue.fields['Story Point Estimate'];
            if (storyPointsValue !== null && storyPointsValue !== undefined && fieldIds.storyPoints) {
              customFields[fieldIds.storyPoints] = storyPointsValue;
            }

            const colorValue = issue.fields.customfield_10017;
            if (colorValue && fieldIds.color) {
              customFields[fieldIds.color] = colorValue;
            }

            const projectWeightValue = issue.fields.customfield_10375
              || issue.fields['Project Weight'];
            if (projectWeightValue !== null && projectWeightValue !== undefined && fieldIds.projectWeight) {
              customFields[fieldIds.projectWeight] = projectWeightValue;
            }

            const startDateValue = issue.fields.customfield_10015;
            if (startDateValue && fieldIds.startDate) {
              customFields[fieldIds.startDate] = startDateValue;
            }

            return customFields;
          };

          // Helper to resolve assignee
          const resolveAssignee = async (issue: ImportIssue): Promise<string | undefined> => {
            const assignee = issue.fields.assignee;
            if (!assignee) return undefined;

            const mappedEmail = getEmailFromDisplayName(assignee.displayName || '');
            const emailToSearch = mappedEmail || assignee.emailAddress;

            if (emailToSearch) {
              const foundAccountId = await client.findUserCached(emailToSearch);
              if (foundAccountId) {
                return foundAccountId;
              } else {
                results.assigneesFailed++;
                results.warnings.push(`${issue.key}: Assignee "${assignee.displayName}" (${emailToSearch}) not found`);
              }
            } else {
              results.warnings.push(`${issue.key}: No email for assignee "${assignee.displayName}"`);
            }
            return undefined;
          };

          // Helper to update issue data (status, assignee, comments, worklogs)
          const updateIssueData = async (issue: ImportIssue, targetKey: string, assigneeAccountId?: string, isUpdate = false) => {
            // Assign issue
            if (assigneeAccountId) {
              const assigned = await client.assignIssue(targetKey, assigneeAccountId);
              if (assigned) {
                results.assigneesSet++;
              } else {
                results.assigneesFailed++;
              }
            }

            // Transition to original status
            const originalStatus = issue.fields.status?.name;
            const statusCategory = issue.fields.status?.statusCategory?.key;
            if (originalStatus) {
              try {
                await client.transitionToStatus(targetKey, originalStatus, statusCategory);
              } catch {
                // Continue
              }
            }

            // Comments: skip if update mode and option is off
            const shouldUpdateComments = !isUpdate || reimportOpts.updateComments;
            if (shouldUpdateComments) {
              if (isUpdate) await client.deleteAllComments(targetKey);
              if (issue.comments && issue.comments.length > 0) {
                for (const comment of issue.comments) {
                  try {
                    const commentText = typeof comment.body === "string" ? comment.body : "";
                    if (commentText) {
                      await client.addComment(targetKey, commentText);
                    }
                  } catch {
                    // Continue
                  }
                }
              }
            }

            // Worklogs handled separately via /api/jira/worklogs
          };

          // REIMPORT MODE: Single-pass processing (update or create each issue, links handled after)
          if (reimportMode) {
            const allIssues = sortIssues(board.issues);
            send({ type: "status", message: `Processing ${allIssues.length} issues (${existingIssueKeys.size} existing, ${issuesToCreate.length} to create)...` });

            for (const issue of allIssues) {
              globalIssueIndex++;
              const isExisting = existingIssueKeys.has(issue.key);
              const customFields = buildCustomFields(issue);
              const description = issue.fields.description;
              const originalIssueType = issue.fields.issuetype?.name || "Task";
              const issueTypeLower = originalIssueType.toLowerCase();
              const isSubtask = issueTypeLower === 'subtask' || issueTypeLower === 'sub-task';
              const mappedIssueType = mapIssueType(originalIssueType);

              if (isExisting) {
                // === UPDATE existing issue ===
                const targetKey = existingKeyMapping[issue.key];
                send({
                  type: "progress",
                  message: `Updating ${targetKey}: ${issue.fields.summary.slice(0, 50)}...`,
                  issueKey: issue.key,
                  projectIndex: pi + 1,
                  totalProjects: boards.length,
                  issueIndex: globalIssueIndex,
                  totalIssues,
                  phase: "issues",
                });

                try {
                  if (reimportOpts.updateFields) {
                    // Update fields + issue type
                    const updateFields = {
                      summary: issue.fields.summary,
                      issuetype: isSubtask ? undefined : mappedIssueType,
                      description,
                      priority: issue.fields.priority?.name,
                      labels: issue.fields.labels,
                      duedate: issue.fields.duedate,
                      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                    };
                    const basicFields = {
                      summary: issue.fields.summary,
                      description,
                      priority: issue.fields.priority?.name,
                      labels: issue.fields.labels,
                      duedate: issue.fields.duedate,
                    };
                    try {
                      await client.updateIssue(targetKey, updateFields);
                    } catch (updateErr) {
                      const errMsg = updateErr instanceof Error ? updateErr.message : '';
                      // Retry progressively: without issuetype, then without custom fields
                      try {
                        await client.updateIssue(targetKey, { ...updateFields, issuetype: undefined });
                      } catch {
                        await client.updateIssue(targetKey, basicFields);
                        results.warnings.push(`${issue.key}: Custom fields skipped`);
                      }
                      if (errMsg.includes('issuetype')) {
                        results.warnings.push(`${issue.key}: Issue type change to "${mappedIssueType}" skipped`);
                      }
                    }

                    // Update parent separately
                    if (issue.fields.parent) {
                      const parentKey = issue.fields.parent.key;
                      const newParentKey = parentKey ? (existingKeyMapping[parentKey] || keyMapping[parentKey]) : undefined;
                      if (newParentKey) {
                        try {
                          await client.updateIssue(targetKey, { parentKey: newParentKey });
                        } catch (parentErr) {
                          results.warnings.push(`${issue.key}: Parent → ${newParentKey} failed: ${parentErr instanceof Error ? parentErr.message.slice(0, 60) : 'unknown'}`);
                        }
                      } else if (parentKey) {
                        results.warnings.push(`${issue.key}: Parent ${parentKey} not found in mapping`);
                      }
                    }

                    // Update assignee & status
                    const assigneeAccountId = await resolveAssignee(issue);
                    await updateIssueData(issue, targetKey, assigneeAccountId, true);
                  }

                  keyMapping[issue.key] = targetKey;
                  results.success.push({ oldKey: issue.key, newKey: targetKey, project: targetProjectKey, action: 'updated', matchMethod: matchMethodUsed !== 'none' ? matchMethodUsed : undefined });
                  send({ type: "issue_complete", oldKey: issue.key, newKey: targetKey, action: 'updated', issueIndex: globalIssueIndex, totalIssues });
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : "Unknown error";
                  results.failed.push({ oldKey: issue.key, error: errorMessage });
                  send({ type: "status", message: `Failed ${issue.key}: ${errorMessage.slice(0, 100)}` });
                }

              } else {
                // === CREATE new issue ===
                const hasParent = !!issue.fields.parent;
                const isEpic = mappedIssueType.toLowerCase() === 'epic';

                send({
                  type: "progress",
                  message: `Creating ${issue.key}: ${issue.fields.summary.slice(0, 50)}...`,
                  issueKey: issue.key,
                  projectIndex: pi + 1,
                  totalProjects: boards.length,
                  issueIndex: globalIssueIndex,
                  totalIssues,
                  phase: "issues",
                });

                try {
                  let created: { key: string };

                  const getValidParentKey = async (parentKey: string | undefined): Promise<string | null> => {
                    if (!parentKey) return null;
                    const newParentKey = existingKeyMapping[parentKey] || keyMapping[parentKey];
                    if (!newParentKey) return null;
                    // Just verify parent exists, don't check type (trust source data)
                    const exists = await client.issueExists(newParentKey);
                    if (!exists) {
                      results.warnings.push(`${issue.key}: Parent ${newParentKey} not found`);
                      return null;
                    }
                    return newParentKey;
                  };

                  if (isSubtask) {
                    const newParentKey = await getValidParentKey(issue.fields.parent?.key);
                    if (!newParentKey) {
                      results.failed.push({ oldKey: issue.key, error: `Parent not valid for subtask. Skipping.` });
                      continue;
                    }
                    created = await client.createIssue(targetProjectKey, {
                      summary: issue.fields.summary, description, issuetype: "Subtask",
                      priority: issue.fields.priority?.name, labels: issue.fields.labels,
                      parentKey: newParentKey, duedate: issue.fields.duedate,
                      customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                    });
                  } else if (hasParent && !isEpic) {
                    const newParentKey = await getValidParentKey(issue.fields.parent?.key);
                    try {
                      created = await client.createIssue(targetProjectKey, {
                        summary: issue.fields.summary, description, issuetype: mappedIssueType,
                        priority: issue.fields.priority?.name, labels: issue.fields.labels,
                        parentKey: newParentKey || undefined, duedate: issue.fields.duedate,
                        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                      });
                    } catch (parentErr) {
                      const errMsg = parentErr instanceof Error ? parentErr.message : '';
                      if (errMsg.includes('parent') || errMsg.includes('pid') || errMsg.includes('sub-task')) {
                        results.warnings.push(`${issue.key}: Creating without parent`);
                        created = await client.createIssue(targetProjectKey, {
                          summary: issue.fields.summary, description, issuetype: mappedIssueType,
                          priority: issue.fields.priority?.name, labels: issue.fields.labels,
                          duedate: issue.fields.duedate,
                          customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                        });
                      } else { throw parentErr; }
                    }
                  } else {
                    try {
                      created = await client.createIssue(targetProjectKey, {
                        summary: issue.fields.summary, description, issuetype: mappedIssueType,
                        priority: issue.fields.priority?.name, labels: issue.fields.labels,
                        duedate: issue.fields.duedate,
                        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                      });
                    } catch (createErr) {
                      const errMsg = createErr instanceof Error ? createErr.message : '';
                      if (errMsg.includes('customfield_') || errMsg.includes('cannot be set')) {
                        created = await client.createIssue(targetProjectKey, {
                          summary: issue.fields.summary, description, issuetype: mappedIssueType,
                          priority: issue.fields.priority?.name, labels: issue.fields.labels,
                          duedate: issue.fields.duedate,
                        });
                        results.warnings.push(`${issue.key}: Custom fields skipped`);
                      } else { throw createErr; }
                    }
                  }

                  keyMapping[issue.key] = created.key;
                  existingKeyMapping[issue.key] = created.key;
                  const assigneeAccountId = await resolveAssignee(issue);
                  await updateIssueData(issue, created.key, assigneeAccountId);

                  results.success.push({ oldKey: issue.key, newKey: created.key, project: targetProjectKey, action: 'created', matchMethod: 'created' });
                  send({ type: "issue_complete", oldKey: issue.key, newKey: created.key, action: 'created', issueIndex: globalIssueIndex, totalIssues });
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : "Unknown error";
                  results.failed.push({ oldKey: issue.key, error: errorMessage });
                  send({ type: "status", message: `Failed ${issue.key}: ${errorMessage.slice(0, 100)}` });
                }
              }
            }

          } else {
            // NORMAL IMPORT: Create all issues (original logic)
            const allIssues = sortIssues(board.issues);

          // Process issues
          for (let ii = 0; ii < allIssues.length; ii++) {
            const issue = allIssues[ii];
            globalIssueIndex++;

            const originalIssueType = issue.fields.issuetype?.name || "Task";
            const issueTypeLower = originalIssueType.toLowerCase();
            const isSubtask = issueTypeLower === "subtask" || issueTypeLower === "sub-task";
            const hasParent = !!issue.fields.parent;

            if (keyMapping[issue.key]) {
              continue;
            }

            send({
              type: "progress",
              message: `Importing ${issue.key}: ${issue.fields.summary.slice(0, 50)}...`,
              issueKey: issue.key,
              projectIndex: pi + 1,
              totalProjects: boards.length,
              issueIndex: globalIssueIndex,
              totalIssues,
            });

            try {
              const description = issue.fields.description;
              const customFields = buildCustomFields(issue);
              const assigneeAccountId = await resolveAssignee(issue);
              const mappedIssueType = mapIssueType(originalIssueType);
              const isEpic = mappedIssueType.toLowerCase() === 'epic';

              let created: { key: string };

              // NORMAL IMPORT: Create new issues
              if (isSubtask) {
                const parentKey = issue.fields.parent?.key;
                const newParentKey = parentKey ? keyMapping[parentKey] : null;

                if (!newParentKey) {
                  results.failed.push({
                    oldKey: issue.key,
                    error: `Parent "${parentKey}" not found in key mapping. Skipping subtask.`,
                  });
                  continue;
                }

                created = await client.createIssue(targetProjectKey, {
                  summary: issue.fields.summary,
                  description,
                  issuetype: "Subtask",
                  priority: issue.fields.priority?.name,
                  labels: issue.fields.labels,
                  parentKey: newParentKey,
                  duedate: issue.fields.duedate,
                  customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                });
              } else if (hasParent && !isEpic) {
                const parentKey = issue.fields.parent?.key;
                const newParentKey = parentKey ? keyMapping[parentKey] : null;

                created = await client.createIssue(targetProjectKey, {
                  summary: issue.fields.summary,
                  description,
                  issuetype: mappedIssueType,
                  priority: issue.fields.priority?.name,
                  labels: issue.fields.labels,
                  parentKey: newParentKey || undefined,
                  duedate: issue.fields.duedate,
                  customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                });
              } else {
                try {
                  created = await client.createIssue(targetProjectKey, {
                    summary: issue.fields.summary,
                    description,
                    issuetype: mappedIssueType,
                    priority: issue.fields.priority?.name,
                    labels: issue.fields.labels,
                    duedate: issue.fields.duedate,
                    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
                  });
                } catch (createErr) {
                  const errMsg = createErr instanceof Error ? createErr.message : '';
                  if (errMsg.includes('customfield_') || errMsg.includes('cannot be set')) {
                    created = await client.createIssue(targetProjectKey, {
                      summary: issue.fields.summary,
                      description,
                      issuetype: mappedIssueType,
                      priority: issue.fields.priority?.name,
                      labels: issue.fields.labels,
                      duedate: issue.fields.duedate,
                    });
                    results.warnings.push(`${issue.key}: Custom fields skipped`);
                  } else {
                    throw createErr;
                  }
                }
              }

              keyMapping[issue.key] = created.key;

              await updateIssueData(issue, created.key, assigneeAccountId);

              results.success.push({ oldKey: issue.key, newKey: created.key, project: targetProjectKey, action: 'created' });

              send({
                type: "issue_complete",
                oldKey: issue.key,
                newKey: created.key,
                action: 'created',
                issueIndex: globalIssueIndex,
                totalIssues,
              });

            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : "Unknown error";
              console.error(`Import error at ${issue.key}:`, errorMessage);

              results.failed.push({
                oldKey: issue.key,
                error: errorMessage,
              });

              send({
                type: "status",
                message: `Failed ${issue.key}: ${errorMessage.slice(0, 100)}`,
              });
            }
          }
          } // End of else block for normal import

          } // End of updateSprintsOnly skip block

          // Handle sprints after all issues (only for Scrum projects)
          if (!isKanban && board.sprints && board.sprints.length > 0) {
            send({ type: "status", message: `Syncing sprints for ${targetProjectKey}...`, phase: "sprints" });
            try {
              const targetBoards = await client.getBoardsForProject(targetProjectKey);
              const targetBoard = targetBoards[0];

              if (targetBoard) {
                // Fetch existing sprints
                const existingSprints = await client.getAllBoardSprints(targetBoard.id);

                // --- DEDUP: group existing sprints by name, keep first, delete the rest ---
                if (reimportOpts.updateSprintsOnly) {
                  const sprintsByName: Record<string, typeof existingSprints> = {};
                  for (const s of existingSprints) {
                    if (!sprintsByName[s.name]) sprintsByName[s.name] = [];
                    sprintsByName[s.name].push(s);
                  }
                  for (const [name, dupes] of Object.entries(sprintsByName)) {
                    if (dupes.length > 1) {
                      // Sort: keep active first, then by id (oldest)
                      const sorted = [...dupes].sort((a, b) => {
                        if (a.state === 'active' && b.state !== 'active') return -1;
                        if (b.state === 'active' && a.state !== 'active') return 1;
                        return a.id - b.id;
                      });
                      const keep = sorted[0];
                      const toDelete = sorted.slice(1);
                      send({ type: "status", message: `Dedup sprint "${name}": keeping ${keep.id}, deleting ${toDelete.map(d => d.id).join(', ')}` });
                      for (const dup of toDelete) {
                        try {
                          // Move issues from dup to kept sprint before deleting
                          const dupIssueKeys = await client.getSprintIssues(dup.id);
                          if (dupIssueKeys.length > 0) {
                            await client.moveIssuesToSprint(keep.id, dupIssueKeys);
                          }
                          await client.deleteSprint(dup.id);
                        } catch (dedupErr) {
                          results.warnings.push(`Sprint dedup: could not delete duplicate "${name}" (${dup.id}): ${dedupErr instanceof Error ? dedupErr.message.slice(0, 60) : 'unknown'}`);
                        }
                      }
                    }
                  }
                  // Re-fetch after dedup
                  const freshSprints = await client.getAllBoardSprints(targetBoard.id);
                  existingSprints.length = 0;
                  existingSprints.push(...freshSprints);
                }

                // Build name → id map from (deduped) existing sprints
                const existingSprintByName: Record<string, { id: number }> = {};
                for (const s of existingSprints) {
                  existingSprintByName[s.name] = { id: s.id };
                }

                const sprintMapping: Record<number, number> = {};

                for (const sprint of board.sprints) {
                  try {
                    // Check if sprint already exists by name
                    const existing = existingSprintByName[sprint.name];
                    if (existing) {
                      sprintMapping[sprint.id] = existing.id;
                      console.log(`[sprint] Reusing existing sprint "${sprint.name}" (${existing.id})`);
                    } else {
                      const newSprint = await client.createSprint(targetBoard.id, {
                        name: sprint.name,
                        startDate: sprint.startDate,
                        endDate: sprint.endDate,
                        goal: sprint.goal,
                      });
                      sprintMapping[sprint.id] = newSprint.id;
                      console.log(`[sprint] Created sprint "${sprint.name}" (${newSprint.id})`);
                    }
                  } catch {
                    // Continue
                  }
                }

                // Build source sprint order map (index in board.sprints array) for chronological sorting
                const sourceSprintOrder: Record<number, number> = {};
                board.sprints.forEach((s, idx) => { sourceSprintOrder[s.id] = idx; });

                // --- REASSIGN: move each issue through ALL its sprints in chronological order ---
                // This ensures Jira records the full sprint history on each ticket.
                // We build an ordered list of (targetSprintId, issueKeys[]) to process sequentially.
                const sprintIssuesBatch: Record<number, string[]> = {};

                for (const issue of board.issues) {
                  const newKey = keyMapping[issue.key];
                  if (!newKey) continue;

                  const activeSprint = issue.fields.sprint;
                  const closedSprints = issue.fields.closedSprints || [];

                  // Collect all sprints this issue belongs to
                  const allSprints: { id: number; order: number }[] = [];
                  for (const cs of closedSprints) {
                    if (sprintMapping[cs.id]) {
                      allSprints.push({ id: cs.id, order: sourceSprintOrder[cs.id] ?? -1 });
                    }
                  }
                  if (activeSprint && sprintMapping[activeSprint.id]) {
                    // Avoid duplicates if active sprint is also in closedSprints
                    if (!allSprints.some(s => s.id === activeSprint.id)) {
                      allSprints.push({ id: activeSprint.id, order: sourceSprintOrder[activeSprint.id] ?? Infinity });
                    }
                  }

                  // Sort chronologically by source sprint order
                  allSprints.sort((a, b) => a.order - b.order);

                  // Add issue to each sprint batch in order
                  for (const s of allSprints) {
                    const targetId = sprintMapping[s.id];
                    if (!sprintIssuesBatch[targetId]) sprintIssuesBatch[targetId] = [];
                    sprintIssuesBatch[targetId].push(newKey);
                  }
                }

                // --- Process sprints in chronological order: start → move issues → close ---
                // This is the correct sequence to record full sprint history on each ticket.
                // Jira only records sprint history when issues are moved WHILE the sprint is active,
                // so we must: start the sprint, move issues in, then close it (for closed sprints).
                // Jira only allows one active sprint at a time, so we process sequentially.
                let sprintAssigned = 0;
                for (const sprint of board.sprints) {
                  const targetSprintId = sprintMapping[sprint.id];
                  if (!targetSprintId) continue;

                  const issueKeys = sprintIssuesBatch[targetSprintId];
                  const existing = existingSprints.find(s => s.id === targetSprintId);

                  // Re-fetch the current sprint state to get up-to-date status
                  // (earlier sprints in this loop may have changed state)
                  let currentState: 'active' | 'closed' | 'future' = (existing?.state as 'active' | 'closed' | 'future') ?? 'future';
                  try {
                    const freshSprint = await client.getSprint(targetSprintId);
                    currentState = freshSprint.state as 'active' | 'closed' | 'future';
                  } catch { /* use cached state */ }

                  send({ type: "status", message: `Processing sprint "${sprint.name}" (source=${sprint.state})` });

                  // Step 1: Start the sprint if it's still in future state
                  if (currentState === 'future' && (sprint.state === 'active' || sprint.state === 'closed') && sprint.startDate && sprint.endDate) {
                    try {
                      await client.startSprint(targetSprintId, sprint.startDate, sprint.endDate);
                      currentState = 'active';
                    } catch (err) {
                      results.warnings.push(`Sprint start "${sprint.name}" (${targetSprintId}): ${err instanceof Error ? err.message.slice(0, 60) : 'unknown'}`);
                    }
                  }

                  // Step 2: Move issues into this sprint (only while it's active, so history is recorded)
                  if (issueKeys && issueKeys.length > 0 && currentState !== 'closed') {
                    try {
                      await client.moveIssuesToSprint(targetSprintId, issueKeys);
                      sprintAssigned += issueKeys.length;
                    } catch (err) {
                      results.warnings.push(`Sprint ${targetSprintId}: failed to move ${issueKeys.length} issues: ${err instanceof Error ? err.message.slice(0, 60) : 'unknown'}`);
                    }
                  }

                  // Step 3: Close the sprint if it was closed in source
                  if (sprint.state === 'closed' && currentState !== 'closed') {
                    try {
                      await client.closeSprint(targetSprintId);
                    } catch (err) {
                      results.warnings.push(`Sprint close "${sprint.name}" (${targetSprintId}): ${err instanceof Error ? err.message.slice(0, 60) : 'unknown'}`);
                    }
                  }
                }

                if (reimportOpts.updateSprintsOnly) {
                  send({ type: "status", message: `Sprint reassign complete: ${sprintAssigned} issues moved to ${Object.keys(sprintIssuesBatch).length} sprints` });
                }
              }
            } catch {
              // Continue
            }
          }

          // Handle backlog
          if (board.backlogIssues && board.backlogIssues.length > 0) {
            const backlogNewKeys = board.backlogIssues
              .map(oldKey => keyMapping[oldKey])
              .filter((k): k is string => !!k);

            if (backlogNewKeys.length > 0) {
              try {
                await client.moveIssuesToBacklog(backlogNewKeys);
              } catch {
                // Continue
              }
            }
          }

          // Handle issue links (after all issues are created/updated)
          const shouldHandleLinks = !reimportMode || reimportOpts.updateLinks;
          if (!shouldHandleLinks) {
            send({ type: "status", message: `Skipping issue links for ${targetProjectKey} (option disabled)`, phase: "links" });
          } else {
          send({ type: "status", message: `${reimportMode ? 'Updating' : 'Creating'} issue links for ${targetProjectKey}...`, phase: "links" });
          const processedLinks = new Set<string>(); // Avoid duplicate links

          // Pass 1: Delete ALL existing links from all issues first
          if (reimportMode) {
            send({ type: "status", message: `Deleting old links for ${targetProjectKey}...`, phase: "links" });
            const deletedLinkIds = new Set<string>();
            for (const issue of board.issues) {
              const newKey = keyMapping[issue.key];
              if (!newKey) continue;
              try {
                const existingLinks = await client.getIssueLinks(newKey);
                for (const existingLink of existingLinks) {
                  if (deletedLinkIds.has(existingLink.id)) continue;
                  try {
                    await client.deleteIssueLink(existingLink.id);
                    deletedLinkIds.add(existingLink.id);
                    results.linksDetail.push({ source: newKey, target: existingLink.outwardIssue?.key || existingLink.inwardIssue?.key || '', type: existingLink.type.name, action: 'deleted' });
                  } catch { /* continue */ }
                }
              } catch { /* continue */ }
            }
            console.log(`[issueLink] Deleted ${deletedLinkIds.size} existing links`);
          }

          // Pass 2: Create all new links
          send({ type: "status", message: `Creating links for ${targetProjectKey}...`, phase: "links" });
          for (const issue of board.issues) {
            const issuelinks = issue.fields.issuelinks;
            if (!issuelinks || issuelinks.length === 0) continue;

            const newSourceKey = keyMapping[issue.key];
            if (!newSourceKey) continue;

            for (const link of issuelinks) {
              try {
                // Only process outward links to avoid duplicates
                if (link.outwardIssue) {
                  const oldTargetKey = link.outwardIssue.key;
                  const newTargetKey = keyMapping[oldTargetKey];

                  if (newTargetKey) {
                    const linkId = `${newSourceKey}-${link.type.name}-${newTargetKey}`;
                    if (!processedLinks.has(linkId)) {
                      processedLinks.add(linkId);
                      await client.createIssueLink({
                        inwardIssue: newSourceKey,
                        outwardIssue: newTargetKey,
                        linkType: link.type.name,
                      });
                      results.linksCreated++;
                      results.linksDetail.push({ source: newSourceKey, target: newTargetKey, type: link.type.name, action: 'created' });
                      console.log(`[issueLink] Created: ${newSourceKey} -${link.type.name}-> ${newTargetKey}`);
                    }
                  }
                }
              } catch (error) {
                results.linksFailed++;
                console.log(`[issueLink] Failed:`, error instanceof Error ? error.message : error);
              }
            }
          }
          } // end shouldHandleLinks
        }

        // Send complete event
        send({
          type: "complete",
          results: {
            ...results,
            keyMapping,
            totalProcessed: results.success.length + results.failed.length,
          },
        });
        closeController();

      } catch (error) {
        console.error("Streaming import error:", error);
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

// Non-streaming fallback (original implementation)
async function handleNonStreamingImport(params: {
  domain: string;
  email: string;
  apiToken: string;
  projectMapping: Record<string, string>;
  importData: ImportData;
  autoCreateProjects?: boolean;
  fieldMapping?: { storyPoints?: string; startDate?: string };
  issueTypeMapping?: Record<string, string>;
  reimportMode?: boolean;
}) {
  const {
    domain, email, apiToken, projectMapping, importData,
    autoCreateProjects, fieldMapping, issueTypeMapping, reimportMode,
  } = params;

  const fields = {
    storyPoints: fieldMapping?.storyPoints || 'customfield_10016',
    startDate: fieldMapping?.startDate || 'customfield_10015',
  };

  const issueTypes: Record<string, string> = {
    ...DEFAULT_ISSUE_TYPE_MAPPING,
    ...Object.fromEntries(
      Object.entries(issueTypeMapping || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    ),
  };

  const mapIssueType = (originalType: string): string => {
    const lower = originalType.toLowerCase();
    if (STANDARD_ISSUE_TYPES.includes(lower)) return originalType;
    if (issueTypes[lower]) return issueTypes[lower];
    return 'Task';
  };

  const client = new JiraClient({ domain, email, apiToken });

  const results: {
    success: { oldKey: string; newKey: string; project: string; action: 'created' | 'updated' }[];
    failed: { oldKey: string; error: string }[];
    createdProjects: string[];
    skipped: { oldKey: string; reason: string }[];
    warnings: string[];
  } = {
    success: [],
    failed: [],
    createdProjects: [],
    skipped: [],
    warnings: [],
  };

  const keyMapping: Record<string, string> = {};
  const projectCreationErrors: Record<string, string> = {};

  if (autoCreateProjects) {
    for (const board of importData.boards) {
      const sourceProjectKey = board.project?.projectKey;
      const sourceProjectName = board.project?.projectName;
      const targetProjectKey = sourceProjectKey ? projectMapping[sourceProjectKey] : null;

      if (targetProjectKey && sourceProjectKey === targetProjectKey) {
        const exists = await client.projectExists(targetProjectKey);
        if (!exists) {
          try {
            await client.createProject({
              key: targetProjectKey,
              name: sourceProjectName || targetProjectKey,
              projectTypeKey: "software",
              projectTemplate: "scrum",
            });
            results.createdProjects.push(targetProjectKey);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Unknown error";
            projectCreationErrors[targetProjectKey] = errorMsg;
          }
        }
      }
    }
  }

  for (const board of importData.boards) {
    const sourceProjectKey = board.project?.projectKey;
    const targetProjectKey = sourceProjectKey ? projectMapping[sourceProjectKey] : null;

    if (!targetProjectKey) {
      for (const issue of board.issues) {
        results.failed.push({
          oldKey: issue.key,
          error: `No project mapping found for ${sourceProjectKey}`,
        });
      }
      continue;
    }

    if (projectCreationErrors[targetProjectKey]) {
      for (const issue of board.issues) {
        results.failed.push({
          oldKey: issue.key,
          error: `Project "${targetProjectKey}" could not be created: ${projectCreationErrors[targetProjectKey]}`,
        });
      }
      continue;
    }

    const projectExists = await client.projectExists(targetProjectKey);
    if (!projectExists) {
      for (const issue of board.issues) {
        results.failed.push({
          oldKey: issue.key,
          error: `Project "${targetProjectKey}" does not exist.`,
        });
      }
      continue;
    }

    const boardType = await client.getProjectBoardType(targetProjectKey);
    const isKanban = boardType === 'kanban';
    if (isKanban && board.sprints && board.sprints.length > 0) {
      results.warnings.push(
        `Project "${targetProjectKey}" is Kanban - sprints will be skipped (${board.sprints.length} sprints in source).`
      );
    }

    const allIssues = [...board.issues].sort((a, b) => {
      const aNum = parseInt(a.key.split('-')[1]) || 0;
      const bNum = parseInt(b.key.split('-')[1]) || 0;
      return aNum - bNum;
    });

    for (const issue of allIssues) {
      const originalIssueType = issue.fields.issuetype?.name || "Task";
      const issueTypeLower = originalIssueType.toLowerCase();
      const isSubtask = issueTypeLower === "subtask" || issueTypeLower === "sub-task";
      const hasParent = !!issue.fields.parent;

      if (keyMapping[issue.key]) continue;

      try {
        let description = "";
        if (issue.fields.description) {
          if (typeof issue.fields.description === "string") {
            description = issue.fields.description;
          } else if (typeof issue.fields.description === "object") {
            try {
              const adf = issue.fields.description as { content?: { content?: { text?: string }[] }[] };
              const texts: string[] = [];
              for (const block of adf.content || []) {
                for (const inline of block.content || []) {
                  if (inline.text) texts.push(inline.text);
                }
              }
              description = texts.join('\n');
            } catch {
              description = "";
            }
          }
        }

        const customFields: Record<string, unknown> = {};
        const storyPoints = issue.fields[fields.storyPoints];
        if (storyPoints !== null && storyPoints !== undefined) {
          customFields[fields.storyPoints] = storyPoints;
        }
        const startDate = issue.fields[fields.startDate];
        if (startDate) {
          customFields[fields.startDate] = startDate;
        }

        const mappedIssueType = mapIssueType(originalIssueType);
        const isEpic = mappedIssueType.toLowerCase() === 'epic';

        const issueNum = issue.key.split('-')[1];
        const expectedNewKey = `${targetProjectKey}-${issueNum}`;

        let created: { key: string };
        let action: 'created' | 'updated' = 'created';

        if (reimportMode) {
          const exists = await client.issueExists(expectedNewKey);
          if (exists) {
            await client.updateIssue(expectedNewKey, {
              summary: issue.fields.summary,
              description: description,
              priority: issue.fields.priority?.name,
              labels: issue.fields.labels,
              duedate: issue.fields.duedate,
              timeoriginalestimate: issue.fields.timeoriginalestimate,
              customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
            });
            created = { key: expectedNewKey };
            action = 'updated';
          } else {
            results.skipped.push({
              oldKey: issue.key,
              reason: `Expected ${expectedNewKey} does not exist.`,
            });
            continue;
          }
        } else {
          if (isSubtask) {
            const parentKey = issue.fields.parent?.key;
            const newParentKey = parentKey ? keyMapping[parentKey] : null;

            if (!newParentKey) {
              results.failed.push({
                oldKey: issue.key,
                error: `CRITICAL: Parent "${parentKey}" not found.`,
              });
              return new Response(JSON.stringify({
                ...results,
                keyMapping,
                totalProcessed: results.success.length + results.failed.length,
                error: `Import stopped at ${issue.key}: Parent "${parentKey}" not found.`,
              }), { headers: { "Content-Type": "application/json" } });
            }

            created = await client.createIssue(targetProjectKey, {
              summary: issue.fields.summary,
              description: description,
              issuetype: "Subtask",
              priority: issue.fields.priority?.name,
              labels: issue.fields.labels,
              parentKey: newParentKey,
              duedate: issue.fields.duedate,
              timeoriginalestimate: issue.fields.timeoriginalestimate,
              customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
            });
          } else if (hasParent && !isSubtask && !isEpic) {
            created = await client.createIssue(targetProjectKey, {
              summary: issue.fields.summary,
              description: description,
              issuetype: mappedIssueType,
              priority: issue.fields.priority?.name,
              labels: issue.fields.labels,
              duedate: issue.fields.duedate,
              timeoriginalestimate: issue.fields.timeoriginalestimate,
              customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
            });
          } else {
            created = await client.createIssue(targetProjectKey, {
              summary: issue.fields.summary,
              description: description,
              issuetype: mappedIssueType,
              priority: issue.fields.priority?.name,
              labels: issue.fields.labels,
              duedate: issue.fields.duedate,
              timeoriginalestimate: issue.fields.timeoriginalestimate,
              customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
            });
          }
        }

        keyMapping[issue.key] = created.key;

        const originalStatus = issue.fields.status?.name;
        const statusCategory = issue.fields.status?.statusCategory?.key;
        if (originalStatus) {
          try {
            await client.transitionToStatus(created.key, originalStatus, statusCategory);
          } catch {
            // Continue
          }
        }

        if (issue.comments && issue.comments.length > 0) {
          for (const comment of issue.comments) {
            try {
              const commentText = typeof comment.body === "string" ? comment.body : "";
              if (commentText) {
                await client.addComment(created.key, commentText);
              }
            } catch {
              // Continue
            }
          }
        }

        if (issue.worklogs && issue.worklogs.length > 0) {
          for (const worklog of issue.worklogs) {
            try {
              await client.addWorklog(created.key, {
                timeSpentSeconds: worklog.timeSpentSeconds,
                started: worklog.started,
                comment: worklog.comment || undefined,
                originalAuthor: worklog.author?.displayName || undefined,
              });
            } catch {
              // Continue
            }
          }
        }

        results.success.push({ oldKey: issue.key, newKey: created.key, project: targetProjectKey, action });

      } catch (error) {
        results.failed.push({
          oldKey: issue.key,
          error: error instanceof Error ? error.message : "Unknown error",
        });

        return new Response(JSON.stringify({
          ...results,
          keyMapping,
          totalProcessed: results.success.length + results.failed.length,
          error: `Import stopped at ${issue.key}: ${error instanceof Error ? error.message : "Unknown error"}`,
        }), { headers: { "Content-Type": "application/json" } });
      }
    }

    // Sprints (only for Scrum projects)
    if (!isKanban && board.sprints && board.sprints.length > 0) {
      try {
        const targetBoards = await client.getBoardsForProject(targetProjectKey);
        const targetBoard = targetBoards[0];

        if (targetBoard) {
          const existingSprints = await client.getAllBoardSprints(targetBoard.id);
          const existingSprintByName: Record<string, { id: number }> = {};
          for (const s of existingSprints) {
            existingSprintByName[s.name] = { id: s.id };
          }

          const sprintMapping: Record<number, number> = {};

          for (const sprint of board.sprints) {
            try {
              const existing = existingSprintByName[sprint.name];
              if (existing) {
                sprintMapping[sprint.id] = existing.id;
              } else {
                const newSprint = await client.createSprint(targetBoard.id, {
                  name: sprint.name,
                  startDate: sprint.startDate,
                  endDate: sprint.endDate,
                  goal: sprint.goal,
                });
                sprintMapping[sprint.id] = newSprint.id;
              }
            } catch {
              // Continue
            }
          }

          // Build source sprint order map
          const sourceSprintOrder: Record<number, number> = {};
          board.sprints.forEach((s, idx) => { sourceSprintOrder[s.id] = idx; });

          // Build sprint → issue batches (all sprints each issue belongs to)
          const sprintIssuesBatch: Record<number, string[]> = {};
          for (const issue of board.issues) {
            const newKey = keyMapping[issue.key];
            if (!newKey) continue;

            const activeSprint = issue.fields.sprint;
            const closedSprints = issue.fields.closedSprints || [];

            const allSprints: { id: number; order: number }[] = [];
            for (const cs of closedSprints) {
              if (sprintMapping[cs.id]) {
                allSprints.push({ id: cs.id, order: sourceSprintOrder[cs.id] ?? -1 });
              }
            }
            if (activeSprint && sprintMapping[activeSprint.id]) {
              if (!allSprints.some(s => s.id === activeSprint.id)) {
                allSprints.push({ id: activeSprint.id, order: sourceSprintOrder[activeSprint.id] ?? Infinity });
              }
            }
            allSprints.sort((a, b) => a.order - b.order);

            for (const s of allSprints) {
              const targetId = sprintMapping[s.id];
              if (!sprintIssuesBatch[targetId]) sprintIssuesBatch[targetId] = [];
              sprintIssuesBatch[targetId].push(newKey);
            }
          }

          // Process sprints in chronological order: start → move issues → close
          for (const sprint of board.sprints) {
            const targetSprintId = sprintMapping[sprint.id];
            if (!targetSprintId) continue;

            const issueKeys = sprintIssuesBatch[targetSprintId];

            let currentState: 'active' | 'closed' | 'future' = 'future';
            try {
              const freshSprint = await client.getSprint(targetSprintId);
              currentState = freshSprint.state as 'active' | 'closed' | 'future';
            } catch { /* default to future */ }

            // Step 1: Start if future
            if (currentState === 'future' && (sprint.state === 'active' || sprint.state === 'closed') && sprint.startDate && sprint.endDate) {
              try {
                await client.startSprint(targetSprintId, sprint.startDate, sprint.endDate);
                currentState = 'active';
              } catch { /* continue */ }
            }

            // Step 2: Move issues while active
            if (issueKeys && issueKeys.length > 0 && currentState !== 'closed') {
              try {
                await client.moveIssuesToSprint(targetSprintId, issueKeys);
              } catch { /* continue */ }
            }

            // Step 3: Close if source was closed
            if (sprint.state === 'closed' && currentState !== 'closed') {
              try {
                await client.closeSprint(targetSprintId);
              } catch { /* continue */ }
            }
          }
        }
      } catch {
        // Continue
      }
    }

    if (board.backlogIssues && board.backlogIssues.length > 0) {
      const backlogNewKeys = board.backlogIssues
        .map(oldKey => keyMapping[oldKey])
        .filter((k): k is string => !!k);

      if (backlogNewKeys.length > 0) {
        try {
          await client.moveIssuesToBacklog(backlogNewKeys);
        } catch {
          // Continue
        }
      }
    }

    // Handle issue links (after all issues are created)
    const processedLinks = new Set<string>();

    for (const issue of board.issues) {
      const issuelinks = issue.fields.issuelinks;
      if (!issuelinks || issuelinks.length === 0) continue;

      const newSourceKey = keyMapping[issue.key];
      if (!newSourceKey) continue;

      for (const link of issuelinks) {
        try {
          if (link.outwardIssue) {
            const oldTargetKey = link.outwardIssue.key;
            const newTargetKey = keyMapping[oldTargetKey];

            if (newTargetKey) {
              const linkId = `${newSourceKey}-${link.type.name}-${newTargetKey}`;
              if (!processedLinks.has(linkId)) {
                processedLinks.add(linkId);
                await client.createIssueLink({
                  inwardIssue: newSourceKey,
                  outwardIssue: newTargetKey,
                  linkType: link.type.name,
                });
              }
            }
          }
        } catch {
          // Continue
        }
      }
    }
  }

  return new Response(JSON.stringify({
    ...results,
    keyMapping,
    totalProcessed: results.success.length + results.failed.length,
  }), { headers: { "Content-Type": "application/json" } });
}
