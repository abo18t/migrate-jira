// Builds a CSV with the same raw structure as Jira's "Export > CSV (all fields)":
// one row per issue, repeated "Log Work" / "Comment" / "Sprint" / link columns,
// and "Log Work" cells formatted as `comment;dd/MMM/yy h:mm AM;accountId;seconds`.

export type JiraUserRef = { accountId?: string; displayName?: string; emailAddress?: string } | null | undefined;

export type RawWorklog = {
  id: string;
  author?: JiraUserRef;
  comment?: unknown;
  started?: string;
  timeSpentSeconds?: number;
};

export type RawComment = {
  author?: JiraUserRef;
  body?: unknown;
  created?: string;
};

export type RawIssue = {
  id: string;
  key: string;
  fields: Record<string, unknown>;
};

export type ProjectInfo = {
  lead?: JiraUserRef;
  description?: string;
};

export type FieldMeta = {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
};

export type ExportIssue = {
  issue: RawIssue;
  worklogs: RawWorklog[];
  comments: RawComment[];
  watchers: JiraUserRef[];
  project?: ProjectInfo;
};

const SPRINT_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return {
    year: get("year"),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: get("hour"),
    minute: get("minute"),
    dayPeriod: get("dayPeriod").toUpperCase(),
  };
}

/** Jira CSV date format: `09/Jul/25 6:09 PM` in the given time zone. */
export function formatJiraDate(value: unknown, timeZone: string): string {
  if (typeof value !== "string" || !value) return "";
  // Plain dates (due date, date-picker custom fields) have no time zone
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain) {
    return `${plain[3]}/${MONTHS[parseInt(plain[2], 10) - 1]}/${plain[1].slice(2)} 12:00 AM`;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = zonedParts(d, timeZone);
  return `${String(p.day).padStart(2, "0")}/${MONTHS[p.month - 1]}/${p.year.slice(2)} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** `YYYY-MM-DD` of an ISO timestamp in the given time zone. */
export function zonedDateKey(value: string | undefined, timeZone: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const p = zonedParts(d, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Flattens an ADF document (or plain string) to text, one line per block. */
export function adfToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);

  const blocks = new Set(["paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule", "tableRow"]);
  let out = "";
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
    if (n.type === "hardBreak") out += "\n";
    if (typeof n.text === "string") out += n.text;
    if (n.type === "mention" && n.attrs?.text) out += String(n.attrs.text);
    if ((n.type === "inlineCard" || n.type === "blockCard") && n.attrs?.url) out += String(n.attrs.url);
    if (n.type === "rule") out += "----";
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (n.type && blocks.has(n.type) && !out.endsWith("\n")) out += "\n";
  };
  walk(value);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

function secondsOrEmpty(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}

/** Converts an arbitrary custom field value to one or more CSV cell values. */
function customFieldCells(value: unknown, meta: FieldMeta, timeZone: string): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => customFieldCells(v, meta, timeZone));
  }
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (typeof value === "string") {
    if (meta.schema?.type === "date" || meta.schema?.type === "datetime") return [formatJiraDate(value, timeZone)];
    return [value];
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.type === "doc") return [adfToText(o)];
    // Sprint objects
    if (meta.schema?.custom === SPRINT_SCHEMA && typeof o.name === "string") return [o.name];
    // Cascading select: parent + child
    if (typeof o.value === "string" && o.child && typeof (o.child as { value?: unknown }).value === "string") {
      return [o.value, String((o.child as { value: string }).value)];
    }
    if (typeof o.value === "string") return [o.value];
    if (typeof o.displayName === "string") return [o.displayName];
    if (typeof o.name === "string") return [o.name];
    if (typeof o.key === "string") return [o.key];
    const json = JSON.stringify(o);
    return json === "{}" ? [] : [json];
  }
  return [String(value)];
}

type Row = Map<string, string[]>;

/**
 * Builds the CSV. Column groups follow Jira's own export ordering; repeatable
 * columns are expanded to the maximum count across all rows.
 */
export function buildJiraExportCsv(items: ExportIssue[], fieldMetas: FieldMeta[], timeZone: string): string {
  const customMetas = fieldMetas.filter((f) => f.custom);
  const customHeader = (m: FieldMeta) => (m.schema?.custom === SPRINT_SCHEMA ? "Sprint" : `Custom field (${m.name})`);

  const rows: Row[] = [];
  const linkHeaders = new Set<string>();
  const customUsed = new Map<string, FieldMeta>(); // header -> meta (first one wins for duplicates by name)
  const customHeadersById = new Map<string, string>();

  for (const m of customMetas) customHeadersById.set(m.id, customHeader(m));

  for (const item of items) {
    const f = item.issue.fields;
    const row: Row = new Map();
    const set = (h: string, v: unknown) => row.set(h, [str(v)]);
    const push = (h: string, v: string) => {
      const arr = row.get(h) || [];
      arr.push(v);
      row.set(h, arr);
    };

    const project = (f.project || {}) as { key?: string; name?: string; projectTypeKey?: string };
    const user = (u: unknown) => u as JiraUserRef;
    const status = (f.status || {}) as { name?: string; statusCategory?: { name?: string } };
    const parent = f.parent as { id?: string; key?: string; fields?: { summary?: string } } | undefined;

    set("Summary", f.summary);
    set("Issue key", item.issue.key);
    set("Issue id", item.issue.id);
    set("Issue Type", (f.issuetype as { name?: string } | undefined)?.name);
    set("Status", status.name);
    set("Project key", project.key);
    set("Project name", project.name);
    set("Project type", project.projectTypeKey);
    set("Project lead", item.project?.lead?.displayName);
    set("Project lead id", item.project?.lead?.accountId);
    set("Project description", item.project?.description);
    set("Priority", (f.priority as { name?: string } | undefined)?.name);
    set("Resolution", (f.resolution as { name?: string } | undefined)?.name);
    set("Assignee", user(f.assignee)?.displayName);
    set("Assignee Id", user(f.assignee)?.accountId);
    set("Reporter", user(f.reporter)?.displayName);
    set("Reporter Id", user(f.reporter)?.accountId);
    set("Creator", user(f.creator)?.displayName);
    set("Creator Id", user(f.creator)?.accountId);
    set("Created", formatJiraDate(f.created, timeZone));
    set("Updated", formatJiraDate(f.updated, timeZone));
    set("Last Viewed", formatJiraDate(f.lastViewed, timeZone));
    set("Resolved", formatJiraDate(f.resolutiondate, timeZone));
    for (const v of (f.versions as { name?: string }[] | undefined) || []) push("Affects versions", str(v.name));
    for (const v of (f.fixVersions as { name?: string }[] | undefined) || []) push("Fix versions", str(v.name));
    for (const c of (f.components as { name?: string }[] | undefined) || []) push("Components", str(c.name));
    set("Due date", formatJiraDate(f.duedate, timeZone));
    set("Votes", (f.votes as { votes?: number } | undefined)?.votes ?? 0);
    for (const l of (f.labels as string[] | undefined) || []) push("Labels", l);
    set("Description", adfToText(f.description));
    set("Environment", adfToText(f.environment));
    for (const w of item.watchers) {
      push("Watchers", str(w?.displayName));
      push("Watchers Id", str(w?.accountId));
    }

    for (const wl of item.worklogs) {
      push(
        "Log Work",
        `${adfToText(wl.comment)};${formatJiraDate(wl.started, timeZone)};${wl.author?.accountId || ""};${wl.timeSpentSeconds ?? 0}`
      );
    }

    set("Original estimate", secondsOrEmpty(f.timeoriginalestimate));
    set("Remaining Estimate", secondsOrEmpty(f.timeestimate));
    set("Time Spent", secondsOrEmpty(f.timespent));
    set("Work Ratio", typeof f.workratio === "number" && f.workratio >= 0 ? `${f.workratio}%` : "");
    set("Σ Original Estimate", secondsOrEmpty(f.aggregatetimeoriginalestimate));
    set("Σ Remaining Estimate", secondsOrEmpty(f.aggregatetimeestimate));
    set("Σ Time Spent", secondsOrEmpty(f.aggregatetimespent));
    set("Security Level", (f.security as { name?: string } | undefined)?.name);

    type Link = { type?: { name?: string }; inwardIssue?: { key?: string }; outwardIssue?: { key?: string } };
    for (const link of (f.issuelinks as Link[] | undefined) || []) {
      const name = link.type?.name || "Relates";
      if (link.inwardIssue?.key) {
        const h = `Inward issue link (${name})`;
        linkHeaders.add(h);
        push(h, link.inwardIssue.key);
      }
      if (link.outwardIssue?.key) {
        const h = `Outward issue link (${name})`;
        linkHeaders.add(h);
        push(h, link.outwardIssue.key);
      }
    }

    type Attachment = { created?: string; author?: JiraUserRef; filename?: string; content?: string };
    for (const a of (f.attachment as Attachment[] | undefined) || []) {
      push("Attachment", `${formatJiraDate(a.created, timeZone)};${a.author?.accountId || ""};${a.filename || ""};${a.content || ""}`);
    }

    for (const m of customMetas) {
      const cells = customFieldCells(f[m.id], m, timeZone);
      if (cells.length === 0) continue;
      const h = customHeadersById.get(m.id)!;
      if (!customUsed.has(h)) customUsed.set(h, m);
      for (const c of cells) push(h, c);
    }

    for (const c of item.comments) {
      push("Comment", `${formatJiraDate(c.created, timeZone)};${c.author?.accountId || ""};${adfToText(c.body)}`);
    }

    set("Parent", parent?.id);
    set("Parent key", parent?.key);
    set("Parent summary", parent?.fields?.summary);
    set("Status category", status.statusCategory?.name);
    set("Status category changed", formatJiraDate(f.statuscategorychangedate, timeZone));

    rows.push(row);
  }

  // Custom field columns are sorted by field name like Jira ("Sprint" sorts as "Sprint")
  const bareName = (h: string) => h.replace(/^Custom field \((.*)\)$/, "$1");
  const customHeaders = [...customUsed.keys()].sort((a, b) => (bareName(a) < bareName(b) ? -1 : bareName(a) > bareName(b) ? 1 : 0));
  const sortedLinks = [...linkHeaders].sort((a, b) => {
    // Inward before outward, then by link type name
    const ai = a.startsWith("Inward") ? 0 : 1;
    const bi = b.startsWith("Inward") ? 0 : 1;
    return ai - bi || a.localeCompare(b);
  });

  const headerOrder = [
    "Summary", "Issue key", "Issue id", "Issue Type", "Status", "Project key", "Project name", "Project type",
    "Project lead", "Project lead id", "Project description", "Priority", "Resolution", "Assignee", "Assignee Id",
    "Reporter", "Reporter Id", "Creator", "Creator Id", "Created", "Updated", "Last Viewed", "Resolved",
    "Affects versions", "Fix versions", "Components", "Due date", "Votes", "Labels", "Description", "Environment",
    "Watchers", "Watchers Id", "Log Work",
    "Original estimate", "Remaining Estimate", "Time Spent", "Work Ratio",
    "Σ Original Estimate", "Σ Remaining Estimate", "Σ Time Spent", "Security Level",
    ...sortedLinks,
    "Attachment",
    ...customHeaders,
    "Comment", "Parent", "Parent key", "Parent summary", "Status category", "Status category changed",
  ];

  // Repeatable columns only appear if used, and expand to the max count;
  // single-value system columns always appear (Jira always includes them).
  const repeatable = new Set([
    "Affects versions", "Fix versions", "Components", "Labels", "Watchers", "Watchers Id", "Log Work",
    "Attachment", "Comment", ...sortedLinks, ...customHeaders,
  ]);
  const columns: { header: string; index: number }[] = [];
  for (const h of headerOrder) {
    const count = rows.reduce((max, r) => Math.max(max, r.get(h)?.length || 0), 0);
    if (repeatable.has(h)) {
      for (let i = 0; i < count; i++) columns.push({ header: h, index: i });
    } else {
      columns.push({ header: h, index: 0 });
    }
  }

  const lines = [columns.map((c) => csvEscape(c.header)).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => csvEscape(r.get(c.header)?.[c.index] ?? "")).join(","));
  }
  // BOM so Excel opens UTF-8 (Vietnamese) correctly, same as Jira's export
  return "﻿" + lines.join("\n") + "\n";
}

export type StudioMember = { pu: string; id: string; emailSea: string; emailEno: string };

/** Parses member.csv (`PU,ID,Email SEA,Email ENO`). */
export function parseMembersCsv(text: string): StudioMember[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iPu = col("pu");
  const iId = col("id");
  const iSea = col("email sea");
  const iEno = col("email eno");
  return lines.slice(1).map((line) => {
    const c = line.split(",").map((v) => v.trim());
    return {
      pu: iPu >= 0 ? c[iPu] || "" : "",
      id: iId >= 0 ? c[iId] || "" : "",
      emailSea: iSea >= 0 ? (c[iSea] || "").toLowerCase() : "",
      emailEno: iEno >= 0 ? (c[iEno] || "").toLowerCase() : "",
    };
  }).filter((m) => m.id || m.emailSea || m.emailEno);
}
