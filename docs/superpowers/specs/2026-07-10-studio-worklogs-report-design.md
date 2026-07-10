# Studio Worklogs Report Design

## Goal

Add an app UI flow to fetch all worklogs for studio members across two Jira organizations and export a CSV report. Members come from `member.csv`. The search uses Jira JQL across all projects/spaces, scoped by a user-selected date range.

## Scope

- Add a new UI mode for generating a worklogs report.
- Collect credentials for both SEA and ENO Jira organizations.
- Collect inclusive `from` and `to` worklog dates.
- Resolve member emails to Jira `accountId` values per organization.
- Query issues with matching worklogs across all projects/spaces.
- Fetch issue worklogs, filter by resolved member accountIds and date range.
- Export a CSV with the requested columns.

Out of scope:

- Persisting reports server-side.
- Scheduling recurring reports.
- Importing or editing worklogs.
- Adding database storage.

## Architecture

### UI

Add a `worklogs-report` mode in `src/app/page.tsx`.

The mode includes:

1. SEA Jira credentials.
2. ENO Jira credentials.
3. Date range inputs: `fromDate`, `toDate`.
4. A generate button.
5. Streaming progress display.
6. Completion state with CSV download.

The client consumes Server-Sent Events using the existing reader-loop pattern used by export/import/worklog flows.

### API

Add or extend a route under `src/app/api/jira/worklogs/route.ts` for report generation.

Request shape:

```ts
{
  sourceCredentials: JiraCredentials,
  targetCredentials: JiraCredentials,
  fromDate: string, // YYYY-MM-DD
  toDate: string    // YYYY-MM-DD
}
```

The route validates both credential sets before streaming. After validation, it streams progress events and a final `complete` event containing the CSV string plus summary counts.

### Jira client

Add reusable JiraClient capabilities in `src/lib/jira.ts`:

- General JQL issue search across all projects/spaces using `POST /rest/api/3/search/jql` and `nextPageToken` pagination.
- Worklog report issue fields retrieval.
- Existing `findUserByEmail` and `getIssueWorklogs` are reused.

## Member resolution

Members come from `member.csv` with columns:

- `ID`
- `Email SEA`
- `Email ENO`

For each organization:

1. Try resolving both `Email SEA` and `Email ENO` for every member.
2. Keep every successful `accountId`.
3. Deduplicate accountIds per organization.
4. Map `accountId -> member`.

This handles SEA worklogs authored by accounts using ENO emails.

Unresolved member emails are warnings, not fatal. If no accountIds resolve for an organization, that organization is skipped with a warning. If neither organization resolves any accountIds, the request fails.

## JQL strategy

For each organization, build JQL batches from resolved accountIds:

```jql
worklogAuthor in ("accountId1", "accountId2") AND worklogDate >= "YYYY-MM-DD" AND worklogDate <= "YYYY-MM-DD" ORDER BY updated DESC
```

AccountIds are batched to avoid JQL length limits. Each batch searches across all spaces by not adding a `project = ...` clause.

For each matching issue:

1. Fetch all worklogs for the issue.
2. Compute total all-worklog seconds for that issue, without member/date filtering.
3. Filter rows to worklogs whose `author.accountId` belongs to a resolved studio member.
4. Filter rows to `started` within the inclusive date range.
5. Convert each kept worklog into one CSV row.

Issues can appear in multiple batches. Deduplicate by issue key per organization before fetching worklogs.

## CSV output

Headers, in order:

```text
Project Name,Issue Type,Epic,Parent,Ticket No,Status,Summary,Log Date & Time,Worklog Created,Worklog Updated,Log user,Assignee,Reporter,Hr. Spent,Ori. Estm.,Total Worklogs,Rem. Estm.,Estm. Variance,Comment
```

Column mapping:

| Column | Source |
| --- | --- |
| Project Name | `issue.fields.project.name` |
| Issue Type | `issue.fields.issuetype.name` |
| Epic | epic parent/key if available; otherwise empty |
| Parent | `issue.fields.parent.key` if present |
| Ticket No | `issue.key` |
| Status | `issue.fields.status.name` |
| Summary | `issue.fields.summary` |
| Log Date & Time | `worklog.started` |
| Worklog Created | `worklog.created` |
| Worklog Updated | `worklog.updated` |
| Log user | matched member display/email fallback Jira author displayName |
| Assignee | `issue.fields.assignee.displayName` |
| Reporter | `issue.fields.reporter.displayName` |
| Hr. Spent | `worklog.timeSpentSeconds / 3600` |
| Ori. Estm. | `issue.fields.timetracking.originalEstimate` |
| Total Worklogs | total all Jira worklog seconds for the issue, shown as hours |
| Rem. Estm. | `issue.fields.timetracking.remainingEstimate` |
| Estm. Variance | `originalEstimateSeconds - totalAllWorklogSeconds - remainingEstimateSeconds`, shown as hours |
| Comment | worklog comment as plain text |

CSV escaping handles commas, quotes, and newlines.

## Errors and warnings

Fatal errors:

- Invalid SEA credentials.
- Invalid ENO credentials.
- Invalid date range.
- No member accountIds resolved in either organization.
- Repeated failed JQL search batch after retry policy.

Warnings:

- A member email cannot be resolved in one organization.
- One organization resolves no users.
- A single issue worklog fetch fails; report continues when possible.

SSE event types:

- `status`
- `progress`
- `warning`
- `complete`
- `error`

## Testing and verification

Implementation should verify:

- CSV header order exactly matches the requested output.
- CSV escaping works for commas, quotes, and newlines.
- Date range filtering is inclusive.
- AccountId resolution tries both SEA and ENO emails per organization.
- Duplicate accountIds and duplicate issue keys are deduplicated.
- Estimate variance uses `originalEstimateSeconds - totalAllWorklogSeconds - remainingEstimateSeconds`.
- UI can generate and download the CSV from a streaming API response.

Manual app verification:

1. Start the app with `pnpm dev`.
2. Open the UI.
3. Select the Worklogs Report mode.
4. Enter SEA and ENO credentials.
5. Pick a date range.
6. Generate the report.
7. Confirm progress streams.
8. Download CSV.
9. Confirm headers and sample rows.