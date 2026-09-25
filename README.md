# Jira Migration Tool

Internal tool (Next.js 16) for Eighteen Studio: migrate Jira projects between workspaces (`seastudio` → `enotion`) and report log work.

No `.env` or database — Jira credentials (email + [API token](https://id.atlassian.com/manage-profile/security/api-tokens)) are entered in the UI and stored in browser cookies only.

## Run

Requires Node.js 20+ and pnpm.

```bash
pnpm install
pnpm dev          # development → http://localhost:3000
```

Production:

```bash
pnpm build        # next build + packs a self-contained app into dist/
pnpm start        # node dist/server.js → http://localhost:3000
```

`dist/` runs on any machine with Node.js, no `pnpm install` needed:

```bash
cd dist && PORT=8080 HOSTNAME=0.0.0.0 node server.js
```

> `next start` does not work here because the app is built with `output: "standalone"`.

## Scripts

| Script           | What it does                                   |
| ---------------- | ---------------------------------------------- |
| `pnpm dev`       | Dev server with hot reload                     |
| `pnpm build`     | Production build, output in `dist/`            |
| `pnpm start`     | Run the production build from `dist/`          |
| `pnpm lint`      | ESLint                                         |
| `pnpm typecheck` | TypeScript check (`tsc --noEmit`)              |

## Features

| Mode                | Purpose                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| **Export**          | Export boards, sprints, issues, worklogs, comments, changelog from the source workspace to JSON |
| **Import**          | Import the JSON into the target workspace (projects, issue types, sprints, links, statuses, assignees) |
| **Attachments**     | Copy attachments from source to target issues using the import key mapping                  |
| **Fix Worklogs**    | Add original author info to worklogs imported without it                                   |
| **Edit Worklogs**   | Re-sync worklogs only, from an export JSON + audit log                                      |
| **Pull Worklogs**   | All worklogs of one project → flat CSV                                                      |
| **Studio Worklogs** | Worklogs of every studio member across **both** organizations → CSV in Jira's own export format |

### Studio Worklogs

1. Enter credentials for the SEA and ENO organizations (leave a token empty to skip that org).
2. Upload a member list, or leave empty to use `member.csv` in the project root (in `dist/` for production):

   ```csv
   PU,ID,Email SEA,Email ENO
   PU1,487,khang.phan@seastudio.com,khang.0487@enotion.io
   ```

3. Optionally pick a worklog date range, then **Get Worklogs**.

Each member is looked up in **each** organization by SEA email, ENO email and staff ID (display name `{ID}-name-role`), because a member may log work in seastudio with an enotion account. The result is one CSV per organization, with the same columns as Jira's *Export → CSV (all fields)*: one row per issue, repeated `Log Work` columns formatted `comment;dd/MMM/yy h:mm AM;accountId;seconds`.

## Project structure

```
src/app/page.tsx              UI (all modes)
src/app/setup/page.tsx        Project setup checklist generator
src/app/api/jira/*/route.ts   API routes (SSE streaming for long jobs)
src/lib/jira.ts               Jira REST v3 + Agile API client
src/lib/jira-csv-export.ts    Jira-format CSV builder
src/lib/staff-mapping.ts      Staff ID → enotion email mapping
scripts/pack-dist.mjs         Packs the standalone build into dist/
```
