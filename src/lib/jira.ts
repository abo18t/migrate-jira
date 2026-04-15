// Clean ADF nodes by removing localId attributes that may cause issues in target workspace
function cleanAdfNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(cleanAdfNode);

  const n = { ...(node as Record<string, unknown>) };

  // Remove localId from attrs (Jira generates new ones)
  if (n.attrs && typeof n.attrs === 'object') {
    const attrs = { ...(n.attrs as Record<string, unknown>) };
    delete attrs.localId;
    n.attrs = Object.keys(attrs).length > 0 ? attrs : undefined;
  }

  // Recurse into content
  if (Array.isArray(n.content)) {
    n.content = (n.content as unknown[]).map(cleanAdfNode);
  }

  return n;
}

// Convert wiki markup links [text|url] in ADF text nodes to proper ADF link nodes
function fixWikiLinksInAdf(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;

  const n = node as Record<string, unknown>;

  // Process text node: split wiki links into text + link nodes
  if (n.type === 'text' && typeof n.text === 'string') {
    const text = n.text as string;
    // Match [text|url] or [url]
    const linkRegex = /\[([^\]|]+?)(?:\|([^\]]+?))?\]/g;
    
    if (!linkRegex.test(text)) return node;
    
    // Reset regex
    linkRegex.lastIndex = 0;
    const parts: unknown[] = [];
    let lastIndex = 0;
    let match;
    
    while ((match = linkRegex.exec(text)) !== null) {
      // Add text before the link
      if (match.index > lastIndex) {
        const beforeText = text.slice(lastIndex, match.index);
        if (beforeText) {
          parts.push({ type: 'text', text: beforeText, ...(n.marks ? { marks: n.marks } : {}) });
        }
      }
      
      const part1 = match[1];
      const part2 = match[2];
      // [text|url] -> part1=text, part2=url  OR  [url] -> part1=url, part2=undefined
      const linkText = part2 ? part1 : part1;
      const linkUrl = part2 || part1;
      
      // Only convert if it looks like a URL
      if (linkUrl.startsWith('http') || linkUrl.startsWith('mailto:') || linkUrl.startsWith('/')) {
        parts.push({
          type: 'text',
          text: linkText,
          marks: [
            ...(Array.isArray(n.marks) ? n.marks : []),
            { type: 'link', attrs: { href: linkUrl } },
          ],
        });
      } else {
        // Not a URL, keep as-is
        parts.push({ type: 'text', text: match[0], ...(n.marks ? { marks: n.marks } : {}) });
      }
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
      parts.push({ type: 'text', text: text.slice(lastIndex), ...(n.marks ? { marks: n.marks } : {}) });
    }
    
    return parts.length === 1 ? parts[0] : parts;
  }

  // Recurse into content array
  if (Array.isArray(n.content)) {
    const newContent: unknown[] = [];
    for (const child of n.content) {
      const result = fixWikiLinksInAdf(child);
      if (Array.isArray(result)) {
        newContent.push(...result);
      } else {
        newContent.push(result);
      }
    }
    return { ...n, content: newContent };
  }

  return node;
}

// Extract ADF JSON from wiki markup wrapper {adf:display=block}...{adf} or {adf}...{adf}
function extractAdfFromWikiMarkup(text: string): unknown | null {
  // Match {adf:display=block} or {adf} wrapper
  const adfMatch = text.match(/\{adf(?::display=\w+)?\}\s*([\s\S]*?)\s*\{adf\}/);
  if (adfMatch && adfMatch[1]) {
    try {
      const jsonStr = adfMatch[1].trim();
      const parsed = JSON.parse(jsonStr);
      // If it's a full ADF document, return as-is
      if (parsed.type === 'doc' && parsed.version && parsed.content) {
        return parsed;
      }
      // If it's a single node (like table), wrap in doc
      if (parsed.type) {
        return {
          type: 'doc',
          version: 1,
          content: [parsed],
        };
      }
    } catch {
      // Not valid JSON, continue with normal processing
    }
  }
  return null;
}

// Convert plain text with wiki markup to proper ADF document
function plainTextToAdf(text: string): unknown {
  // First, check if text contains ADF JSON in wiki markup wrapper
  const extractedAdf = extractAdfFromWikiMarkup(text);
  if (extractedAdf) {
    return fixWikiLinksInAdf(extractedAdf);
  }

  const lines = text.split('\n');
  const content: unknown[] = [];
  let currentList: unknown[] | null = null;

  for (const line of lines) {
    // Bullet list item: "* text"
    if (line.match(/^\* /)) {
      if (!currentList) {
        currentList = [];
      }
      currentList.push({
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: line.slice(2) }],
        }],
      });
      continue;
    }

    // Flush any pending list
    if (currentList) {
      content.push({ type: 'bulletList', content: currentList });
      currentList = null;
    }

    // Horizontal rule: "----"
    if (line.trim() === '----') {
      content.push({ type: 'rule' });
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      content.push({ type: 'paragraph', content: [] });
      continue;
    }

    // Normal paragraph
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    });
  }

  // Flush trailing list
  if (currentList) {
    content.push({ type: 'bulletList', content: currentList });
  }

  // Ensure at least one node
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [] });
  }

  return fixWikiLinksInAdf({
    type: 'doc',
    version: 1,
    content,
  });
}

export interface JiraCredentials {
  domain: string;
  email: string;
  apiToken: string;
}

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
  location?: {
    projectId: number;
    projectKey: string;
    projectName: string;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: string;
    issuetype: { name: string };
    status: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string; emailAddress: string };
    reporter?: { displayName: string; emailAddress: string };
    created: string;
    updated: string;
    labels?: string[];
    components?: { name: string }[];
    [key: string]: unknown;
  };
  changelog?: {
    histories: {
      items: {
        field: string;
        fromString: string;
        toString: string;
      }[];
    }[];
  };
}

export interface JiraWorklog {
  id: string;
  author: { displayName: string; emailAddress: string; accountId?: string };
  timeSpent: string;
  timeSpentSeconds: number;
  started: string;
  comment?: unknown; // Can be string or ADF object
}

export interface JiraComment {
  id: string;
  author: { displayName: string; emailAddress: string };
  body: string;
  created: string;
  updated: string;
}

export interface JiraSprint {
  id: number;
  self: string;
  state: 'active' | 'closed' | 'future';
  name: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  createdDate?: string;
  originBoardId: number;
  goal?: string;
}

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(credentials: JiraCredentials) {
    this.baseUrl = `https://${credentials.domain}.atlassian.net`;
    this.authHeader = Buffer.from(
      `${credentials.email}:${credentials.apiToken}`
    ).toString("base64");
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[JiraClient] ${options?.method || 'GET'} ${endpoint}`);
    
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Basic ${this.authHeader}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.log(`[JiraClient] Error ${response.status}:`, error.slice(0, 200));
      throw new Error(`Jira API Error: ${response.status} - ${error}`);
    }

    // Handle empty response (204 No Content)
    const text = await response.text();
    console.log(`[JiraClient] Response: ${response.status}, body length: ${text.length}`);
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  async getBoards(startAt = 0, maxResults = 50): Promise<{ values: JiraBoard[]; total: number }> {
    return this.fetch<{ values: JiraBoard[]; total: number }>(
      `/rest/agile/1.0/board?startAt=${startAt}&maxResults=${maxResults}`
    );
  }

  async getAllBoards(): Promise<JiraBoard[]> {
    const allBoards: JiraBoard[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const response = await this.getBoards(startAt, maxResults);
      allBoards.push(...response.values);

      if (allBoards.length >= response.total) {
        break;
      }
      startAt += maxResults;
    }

    return allBoards;
  }

  async getProjects(): Promise<JiraProject[]> {
    return this.fetch<JiraProject[]>("/rest/api/3/project");
  }

  // Get all issue types available in the workspace
  async getIssueTypes(): Promise<{ id: string; name: string; subtask: boolean }[]> {
    return this.fetch<{ id: string; name: string; subtask: boolean }[]>("/rest/api/3/issuetype");
  }

  // Get all fields (system + custom) with their names and IDs
  async getFields(): Promise<{ id: string; name: string; custom: boolean; schema?: { type: string } }[]> {
    return this.fetch<{ id: string; name: string; custom: boolean; schema?: { type: string } }[]>(
      "/rest/api/3/field"
    );
  }

  // Get custom fields only, mapped by name
  async getCustomFieldsByName(): Promise<Record<string, string>> {
    const fields = await this.getFields();
    const result: Record<string, string> = {};
    for (const field of fields) {
      if (field.custom) {
        result[field.name.toLowerCase()] = field.id;
      }
    }
    return result;
  }

  // Get all issues in a project for reimport matching
  // typeCategory: 'epic' | 'standard' | 'subtask' — determines what types are compatible
  async getProjectIssuesForMatching(projectKey: string): Promise<Array<{ key: string; summary: string; typeCategory: 'epic' | 'standard' | 'subtask' }>> {
    const result: Array<{ key: string; summary: string; typeCategory: 'epic' | 'standard' | 'subtask' }> = [];
    const maxResults = 100;
    let nextPageToken: string | undefined;
    
    while (true) {
      const body: Record<string, unknown> = {
        jql: `project=${projectKey} ORDER BY key ASC`,
        fields: ["summary", "issuetype"],
        maxResults,
      };
      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }
      
      const data = await this.fetch<{ 
        issues: { key: string; fields: { summary: string; issuetype?: { name?: string; subtask?: boolean; hierarchyLevel?: number } } }[]; 
        nextPageToken?: string;
        isLast?: boolean;
      }>(
        `/rest/api/3/search/jql`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      
      for (const issue of data.issues) {
        const typeName = (issue.fields.issuetype?.name || '').toLowerCase();
        let typeCategory: 'epic' | 'standard' | 'subtask';
        if (typeName === 'epic') {
          typeCategory = 'epic';
        } else if (issue.fields.issuetype?.subtask || typeName === 'subtask' || typeName === 'sub-task') {
          typeCategory = 'subtask';
        } else {
          typeCategory = 'standard';
        }
        result.push({ key: issue.key, summary: issue.fields.summary, typeCategory });
      }
      
      if (data.isLast || !data.nextPageToken || data.issues.length === 0) break;
      nextPageToken = data.nextPageToken;
    }
    
    return result;
  }

  async getBoardIssues(
    boardId: number,
    startAt = 0,
    maxResults = 50
  ): Promise<{ issues: JiraIssue[]; total: number }> {
    return this.fetch<{ issues: JiraIssue[]; total: number }>(
      `/rest/agile/1.0/board/${boardId}/issue?startAt=${startAt}&maxResults=${maxResults}&expand=changelog`
    );
  }

  async getAllBoardIssues(boardId: number): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const response = await this.getBoardIssues(boardId, startAt, maxResults);
      allIssues.push(...response.issues);

      if (allIssues.length >= response.total) {
        break;
      }
      startAt += maxResults;
    }

    return allIssues;
  }

  async getBoardSprints(
    boardId: number,
    startAt = 0,
    maxResults = 50,
    state?: 'active' | 'closed' | 'future'
  ): Promise<{ values: JiraSprint[]; total: number }> {
    const stateParam = state ? `&state=${state}` : '';
    return this.fetch<{ values: JiraSprint[]; total: number }>(
      `/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=${maxResults}${stateParam}`
    );
  }

  async getAllBoardSprints(boardId: number): Promise<JiraSprint[]> {
    const allSprints: JiraSprint[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      try {
        const response = await this.getBoardSprints(boardId, startAt, maxResults);
        allSprints.push(...response.values);

        if (allSprints.length >= response.total) {
          break;
        }
        startAt += maxResults;
      } catch {
        // Board might not support sprints (Kanban without sprints)
        break;
      }
    }

    return allSprints;
  }

  async getBacklogIssues(
    boardId: number,
    startAt = 0,
    maxResults = 50
  ): Promise<{ issues: JiraIssue[]; total: number }> {
    return this.fetch<{ issues: JiraIssue[]; total: number }>(
      `/rest/agile/1.0/board/${boardId}/backlog?startAt=${startAt}&maxResults=${maxResults}&expand=changelog`
    );
  }

  async getAllBacklogIssues(boardId: number): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      try {
        const response = await this.getBacklogIssues(boardId, startAt, maxResults);
        allIssues.push(...response.issues);

        if (allIssues.length >= response.total) {
          break;
        }
        startAt += maxResults;
      } catch {
        // Board might not have backlog
        break;
      }
    }

    return allIssues;
  }

  async getIssueWorklogs(issueKey: string): Promise<JiraWorklog[]> {
    const response = await this.fetch<{ worklogs: JiraWorklog[] }>(
      `/rest/api/3/issue/${issueKey}/worklog`
    );
    return response.worklogs;
  }

  async getIssueComments(issueKey: string): Promise<JiraComment[]> {
    const response = await this.fetch<{ comments: JiraComment[] }>(
      `/rest/api/3/issue/${issueKey}/comment`
    );
    return response.comments;
  }

  // Delete all comments from an issue
  async deleteAllComments(issueKey: string): Promise<number> {
    try {
      const comments = await this.getIssueComments(issueKey);
      let deleted = 0;
      for (const comment of comments) {
        try {
          await this.fetch(`/rest/api/3/issue/${issueKey}/comment/${comment.id}`, { method: "DELETE" });
          deleted++;
        } catch {
          // Continue
        }
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  // Delete all worklogs from an issue
  async deleteAllWorklogs(issueKey: string): Promise<number> {
    try {
      const worklogs = await this.getIssueWorklogs(issueKey);
      let deleted = 0;
      for (const worklog of worklogs) {
        try {
          await this.fetch(`/rest/api/3/issue/${issueKey}/worklog/${worklog.id}`, { method: "DELETE" });
          deleted++;
        } catch {
          // Continue
        }
      }
      return deleted;
    } catch {
      return 0;
    }
  }

  // Get issue attachments
  async getIssueAttachments(issueKey: string): Promise<{
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    content: string; // URL to download
  }[]> {
    const issue = await this.fetch<{
      fields: {
        attachment: {
          id: string;
          filename: string;
          mimeType: string;
          size: number;
          content: string;
        }[];
      };
    }>(`/rest/api/3/issue/${issueKey}?fields=attachment`);
    return issue.fields.attachment || [];
  }

  // Download attachment content as base64
  async downloadAttachment(url: string): Promise<{ data: string; mimeType: string } | null> {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Basic ${this.authHeader}`,
        },
      });
      if (!response.ok) return null;
      
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      
      return { data: base64, mimeType };
    } catch (error) {
      console.log(`[downloadAttachment] Failed:`, error);
      return null;
    }
  }

  // Upload attachment to issue
  async addAttachment(issueKey: string, filename: string, base64Data: string, mimeType: string): Promise<boolean> {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const blob = new Blob([buffer], { type: mimeType });
      
      const formData = new FormData();
      formData.append('file', blob, filename);

      const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.authHeader}`,
          'X-Atlassian-Token': 'no-check',
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        console.log(`[addAttachment] Failed ${filename}:`, error.slice(0, 200));
        return false;
      }
      
      console.log(`[addAttachment] Success: ${filename} -> ${issueKey}`);
      return true;
    } catch (error) {
      console.log(`[addAttachment] Error:`, error);
      return false;
    }
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.fetch<JiraIssue>(
      `/rest/api/3/issue/${issueKey}?expand=changelog`
    );
  }

  async getSubtasks(issueKey: string): Promise<JiraIssue[]> {
    const issue = await this.fetch<JiraIssue>(
      `/rest/api/3/issue/${issueKey}?fields=subtasks`
    );
    
    const subtasks: JiraIssue[] = [];
    const subtaskRefs = issue.fields.subtasks as { key: string }[] | undefined;
    
    if (subtaskRefs && subtaskRefs.length > 0) {
      for (const subtask of subtaskRefs) {
        const fullSubtask = await this.getIssue(subtask.key);
        subtasks.push(fullSubtask);
      }
    }
    
    return subtasks;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.fetch("/rest/api/3/myself");
      return true;
    } catch {
      return false;
    }
  }

  // Find user by email
  async findUserByEmail(email: string): Promise<string | null> {
    try {
      const users = await this.fetch<{ accountId: string; emailAddress?: string }[]>(
        `/rest/api/3/user/search?query=${encodeURIComponent(email)}`
      );
      // Find exact match by email
      const user = users.find(u => u.emailAddress?.toLowerCase() === email.toLowerCase());
      return user?.accountId || (users.length > 0 ? users[0].accountId : null);
    } catch {
      return null;
    }
  }

  // Cache for user lookups (email -> accountId)
  private userCache: Map<string, string | null> = new Map();

  async findUserCached(email: string): Promise<string | null> {
    if (this.userCache.has(email)) {
      return this.userCache.get(email) || null;
    }
    const accountId = await this.findUserByEmail(email);
    this.userCache.set(email, accountId);
    return accountId;
  }

  async createIssue(projectKey: string, issue: {
    summary: string;
    description?: string | object; // Can be plain text or ADF object
    issuetype: string;
    priority?: string;
    labels?: string[];
    assigneeAccountId?: string; // Account ID in destination workspace
    parentKey?: string;
    duedate?: string;
    timeoriginalestimate?: number;
    customFields?: Record<string, unknown>;
  }): Promise<{ id: string; key: string }> {
    const body: Record<string, unknown> = {
      fields: {
        project: { key: projectKey },
        summary: issue.summary,
        issuetype: { name: issue.issuetype },
      },
    };

    if (issue.parentKey) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        parent: { key: issue.parentKey },
      };
    }

    if (issue.description) {
      const desc = typeof issue.description === 'object' && issue.description !== null
        ? cleanAdfNode(fixWikiLinksInAdf(issue.description))
        : plainTextToAdf(String(issue.description));
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        description: desc,
      };
    }

    if (issue.priority) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        priority: { name: issue.priority },
      };
    }

    if (issue.labels && issue.labels.length > 0) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        labels: issue.labels,
      };
    }

    if (issue.duedate) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        duedate: issue.duedate,
      };
    }

    // Note: timeoriginalestimate often not allowed on screen, skip it
    // if (issue.timeoriginalestimate) { ... }

    // Add custom fields (story points, start date, color, etc.)
    if (issue.customFields) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        ...issue.customFields,
      };
    }

    // Note: assignee is handled separately via assignIssue() to avoid failing the whole create
    return this.fetch<{ id: string; key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Assign issue to user (separate call to handle permission errors gracefully)
  async assignIssue(issueKey: string, accountId: string): Promise<boolean> {
    try {
      await this.fetch(`/rest/api/3/issue/${issueKey}/assignee`, {
        method: "PUT",
        body: JSON.stringify({ accountId }),
      });
      console.log(`[assignIssue] Success: ${issueKey} -> ${accountId}`);
      return true;
    } catch (error) {
      // Log full error for debugging
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`[assignIssue] Failed ${issueKey} -> ${accountId}: ${errorMsg}`);
      return false;
    }
  }

  async updateIssue(issueKey: string, issue: {
    summary?: string;
    description?: string | object; // Can be plain text or ADF object
    issuetype?: string;
    priority?: string;
    labels?: string[];
    parentKey?: string;
    duedate?: string;
    timeoriginalestimate?: number;
    customFields?: Record<string, unknown>;
  }): Promise<void> {
    const fields: Record<string, unknown> = {};

    if (issue.summary) {
      fields.summary = issue.summary;
    }

    if (issue.issuetype) {
      fields.issuetype = { name: issue.issuetype };
    }

    if (issue.description) {
      fields.description = typeof issue.description === 'object' && issue.description !== null
        ? cleanAdfNode(fixWikiLinksInAdf(issue.description))
        : plainTextToAdf(String(issue.description));
    }

    if (issue.priority) {
      fields.priority = { name: issue.priority };
    }

    if (issue.labels && issue.labels.length > 0) {
      fields.labels = issue.labels;
    }

    // Update parent (for Epic children, not subtasks which can't change parent)
    if (issue.parentKey) {
      fields.parent = { key: issue.parentKey };
    }

    // Note: assignee is handled separately via assignIssue() to avoid permission errors

    if (issue.duedate) {
      fields.duedate = issue.duedate;
    }

    // Note: timeoriginalestimate often not allowed on screen, skip it
    // if (issue.timeoriginalestimate) { ... }

    if (issue.customFields) {
      Object.assign(fields, issue.customFields);
    }

    await this.fetch(`/rest/api/3/issue/${issueKey}`, {
      method: "PUT",
      body: JSON.stringify({ fields }),
    });
  }

  async issueExists(issueKey: string): Promise<boolean> {
    try {
      console.log(`[issueExists] Checking ${issueKey}...`);
      await this.fetch(`/rest/api/3/issue/${issueKey}?fields=key`);
      console.log(`[issueExists] ${issueKey} exists`);
      return true;
    } catch (error) {
      console.log(`[issueExists] ${issueKey} not found:`, error instanceof Error ? error.message : error);
      return false;
    }
  }

  async deleteIssue(issueKey: string): Promise<boolean> {
    try {
      await this.fetch(`/rest/api/3/issue/${issueKey}`, { method: "DELETE" });
      return true;
    } catch {
      return false;
    }
  }

  // Get the highest issue number in a project
  async getHighestIssueNumber(projectKey: string): Promise<number> {
    try {
      const response = await this.fetch<{ issues: { key: string }[] }>(
        `/rest/api/3/search/jql`,
        {
          method: "POST",
          body: JSON.stringify({
            jql: `project=${projectKey} ORDER BY created DESC`,
            fields: ["key"],
            maxResults: 1,
          }),
        }
      );
      if (response.issues.length === 0) return 0;
      const key = response.issues[0].key;
      return parseInt(key.split('-')[1]) || 0;
    } catch {
      return 0;
    }
  }

  // Create placeholder issues to fill gaps up to targetNumber
  async createPlaceholderIssues(
    projectKey: string, 
    currentHighest: number, 
    targetNumber: number,
    onProgress?: (created: number, total: number) => void
  ): Promise<number> {
    const toCreate = targetNumber - currentHighest;
    if (toCreate <= 0) return 0;
    
    let created = 0;
    for (let i = 0; i < toCreate; i++) {
      try {
        await this.fetch<{ id: string; key: string }>("/rest/api/3/issue", {
          method: "POST",
          body: JSON.stringify({
            fields: {
              project: { key: projectKey },
              summary: `[Placeholder ${currentHighest + i + 1}]`,
              issuetype: { name: "Task" },
            },
          }),
        });
        created++;
        if (onProgress) onProgress(created, toCreate);
      } catch (error) {
        console.log(`[createPlaceholderIssues] Failed at ${currentHighest + i + 1}:`, error);
        // Continue trying
      }
    }
    return created;
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.fetch(`/rest/api/3/issue/${issueKey}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: body }],
            },
          ],
        },
      }),
    });
  }

  async addWorklog(issueKey: string, worklog: {
    timeSpentSeconds: number;
    started: string;
    comment?: string | unknown; // Can be string or ADF object
    originalAuthor?: string;
  }): Promise<void> {
    // Extract text from comment (handle ADF object)
    let commentStr = '';
    if (worklog.comment) {
      if (typeof worklog.comment === 'string') {
        commentStr = worklog.comment;
      } else if (typeof worklog.comment === 'object') {
        // ADF format - extract text
        const adf = worklog.comment as { content?: { content?: { text?: string }[] }[] };
        if (adf.content) {
          const texts: string[] = [];
          for (const block of adf.content) {
            if (block.content) {
              for (const inline of block.content) {
                if (inline.text) texts.push(inline.text);
              }
            }
          }
          commentStr = texts.join('\n');
        }
      }
    }

    // Build comment text: prepend original author info if available
    const commentParts: string[] = [];
    if (worklog.originalAuthor) {
      commentParts.push(`[Logged by: ${worklog.originalAuthor}]`);
    }
    if (commentStr) {
      commentParts.push(commentStr);
    }
    const commentText = commentParts.join('\n');

    const body: Record<string, unknown> = {
      timeSpentSeconds: worklog.timeSpentSeconds,
      started: worklog.started,
    };

    if (commentText) {
      body.comment = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: commentText }],
          },
        ],
      };
    }

    await this.fetch(`/rest/api/3/issue/${issueKey}/worklog`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Update worklog comment (to fix missing author info)
  async updateWorklogComment(issueKey: string, worklogId: string, comment: string): Promise<boolean> {
    try {
      await this.fetch(`/rest/api/3/issue/${issueKey}/worklog/${worklogId}`, {
        method: "PUT",
        body: JSON.stringify({
          comment: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: comment }],
              },
            ],
          },
        }),
      });
      return true;
    } catch (error) {
      console.log(`[updateWorklogComment] Failed ${issueKey}/${worklogId}:`, error);
      return false;
    }
  }

  async getProjectIssueTypes(projectKey: string): Promise<{ name: string; id: string }[]> {
    const response = await this.fetch<{ issueTypes: { name: string; id: string }[] }>(
      `/rest/api/3/project/${projectKey}`
    );
    return response.issueTypes;
  }

  // Get project roles
  async getProjectRoles(projectKey: string): Promise<Record<string, string>> {
    // Returns { "Administrators": "https://.../role/10002", "Member": "https://.../role/10003" }
    return this.fetch<Record<string, string>>(
      `/rest/api/3/project/${projectKey}/role`
    );
  }

  // Add users to project role by accountId
  async addUsersToProjectRole(projectKey: string, roleId: number, accountIds: string[]): Promise<boolean> {
    try {
      await this.fetch(`/rest/api/3/project/${projectKey}/role/${roleId}`, {
        method: "POST",
        body: JSON.stringify({ user: accountIds }),
      });
      console.log(`[addUsersToProjectRole] Added ${accountIds.length} users to role ${roleId} in ${projectKey}`);
      return true;
    } catch (error) {
      console.log(`[addUsersToProjectRole] Failed:`, error instanceof Error ? error.message : error);
      return false;
    }
  }

  // Add all mapped staff to a project (for assignment permissions)
  async addStaffToProject(projectKey: string, accountIds: string[]): Promise<{ added: number; failed: number }> {
    const result = { added: 0, failed: 0 };
    
    try {
      // Get project roles
      const roles = await this.getProjectRoles(projectKey);
      console.log(`[addStaffToProject] Roles for ${projectKey}:`, Object.keys(roles));
      
      // Find a suitable role (prefer "Member", "Developers", or first available)
      const roleUrl = roles['Member'] || roles['Developers'] || roles['Users'] || Object.values(roles)[0];
      
      if (!roleUrl) {
        console.log(`[addStaffToProject] No roles found for ${projectKey}`);
        return result;
      }
      
      // Extract role ID from URL (e.g., ".../role/10003" -> 10003)
      const roleIdMatch = roleUrl.match(/\/role\/(\d+)$/);
      if (!roleIdMatch) {
        console.log(`[addStaffToProject] Could not extract role ID from ${roleUrl}`);
        return result;
      }
      const roleId = parseInt(roleIdMatch[1]);
      console.log(`[addStaffToProject] Using role ID ${roleId} for ${projectKey}`);
      
      // Try adding users one by one to avoid batch failures
      for (const accountId of accountIds) {
        try {
          await this.fetch(`/rest/api/3/project/${projectKey}/role/${roleId}`, {
            method: "POST",
            body: JSON.stringify({ user: [accountId] }),
          });
          result.added++;
          console.log(`[addStaffToProject] Added ${accountId} to ${projectKey}`);
        } catch (error) {
          result.failed++;
          console.log(`[addStaffToProject] Failed to add ${accountId}:`, error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      console.log(`[addStaffToProject] Error:`, error instanceof Error ? error.message : error);
      result.failed = accountIds.length;
    }
    
    return result;
  }

  async createProject(params: {
    key: string;
    name: string;
    projectTypeKey?: string;
    projectTemplate?: 'scrum' | 'kanban';
    leadAccountId?: string;
  }): Promise<{ id: string; key: string }> {
    // Get current user as default lead
    const myself = await this.fetch<{ accountId: string }>("/rest/api/3/myself");
    
    // Template keys
    const templateKey = params.projectTemplate === 'kanban' 
      ? "com.pyxis.greenhopper.jira:gh-simplified-kanban-classic"
      : "com.pyxis.greenhopper.jira:gh-simplified-scrum-classic"; // Default to Scrum
    
    // Try simplified project first (Jira Cloud Next-gen)
    try {
      return await this.fetch<{ id: string; key: string }>("/rest/api/3/project", {
        method: "POST",
        body: JSON.stringify({
          key: params.key,
          name: params.name,
          projectTypeKey: params.projectTypeKey || "software",
          projectTemplateKey: templateKey,
          leadAccountId: params.leadAccountId || myself.accountId,
        }),
      });
    } catch {
      // Fallback: try without template (classic project)
      return await this.fetch<{ id: string; key: string }>("/rest/api/3/project", {
        method: "POST",
        body: JSON.stringify({
          key: params.key,
          name: params.name,
          projectTypeKey: params.projectTypeKey || "software",
          leadAccountId: params.leadAccountId || myself.accountId,
          assigneeType: "UNASSIGNED",
        }),
      });
    }
  }

  async projectExists(projectKey: string): Promise<boolean> {
    try {
      await this.fetch(`/rest/api/3/project/${projectKey}`);
      return true;
    } catch {
      return false;
    }
  }

  // Get available transitions for an issue
  async getTransitions(issueKey: string): Promise<{ id: string; name: string; to: { name: string } }[]> {
    const response = await this.fetch<{ transitions: { id: string; name: string; to: { name: string } }[] }>(
      `/rest/api/3/issue/${issueKey}/transitions`
    );
    return response.transitions;
  }

  // Transition issue to a new status
  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.fetch(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: "POST",
      body: JSON.stringify({
        transition: { id: transitionId },
      }),
    });
  }

  // Try to transition issue to target status by name or category
  async transitionToStatus(issueKey: string, targetStatus: string, targetCategory?: string): Promise<boolean> {
    try {
      const transitions = await this.getTransitions(issueKey);
      const targetLower = targetStatus.toLowerCase();
      
      // First, try exact match (for custom statuses like IN-PROGRESS, CLOSED, ART-TODO)
      let transition = transitions.find(t => 
        t.to.name.toLowerCase() === targetLower
      );

      // If exact match found, use it
      if (transition) {
        console.log(`[transitionToStatus] Exact match found: ${targetStatus} -> ${transition.to.name}`);
        await this.transitionIssue(issueKey, transition.id);
        return true;
      }

      // Fallback: Status name mappings for common variations
      const statusMappings: Record<string, string[]> = {
        'closed': ['done', 'closed', 'resolved', 'complete', 'completed'],
        'done': ['done', 'closed', 'resolved', 'complete', 'completed'],
        'dev-todo': ['to do', 'todo', 'open', 'backlog', 'new', 'dev-todo'],
        'art-todo': ['to do', 'todo', 'open', 'backlog', 'new', 'art-todo'],
        'gd-todo': ['to do', 'todo', 'open', 'backlog', 'new', 'gd-todo'],
        'qc-todo': ['to do', 'todo', 'open', 'backlog', 'new', 'qc-todo'],
        'in-progress': ['in progress', 'in-progress', 'doing', 'active', 'started'],
        'to do': ['to do', 'todo', 'open', 'backlog', 'new'],
      };

      // Get possible matches for the target status
      const possibleMatches = statusMappings[targetLower] || [targetLower];
      
      // Find transition that leads to target status
      transition = transitions.find(t => {
        const toNameLower = t.to.name.toLowerCase();
        return possibleMatches.some(match => 
          toNameLower === match || 
          toNameLower.includes(match) || 
          match.includes(toNameLower)
        );
      });

      // If no match found, try by category
      if (!transition && targetCategory) {
        const categoryPriority: Record<string, string[]> = {
          'done': ['done', 'closed', 'resolved', 'complete'],
          'indeterminate': ['in progress', 'doing', 'active'],
          'new': ['to do', 'open', 'backlog', 'new'],
        };
        const categoryMatches = categoryPriority[targetCategory] || [];
        
        transition = transitions.find(t => {
          const toNameLower = t.to.name.toLowerCase();
          return categoryMatches.some(match => toNameLower.includes(match));
        });
      }

      if (transition) {
        console.log(`[transitionToStatus] Fallback match: ${targetStatus} -> ${transition.to.name}`);
        await this.transitionIssue(issueKey, transition.id);
        return true;
      }
      
      console.log(`[transitionToStatus] No transition found for ${targetStatus}`);
      return false;
    } catch (error) {
      console.log(`[transitionToStatus] Error:`, error);
      return false;
    }
  }

  // Create a sprint
  async createSprint(boardId: number, sprint: {
    name: string;
    startDate?: string;
    endDate?: string;
    goal?: string;
    state?: string;
  }): Promise<{ id: number }> {
    const newSprint = await this.fetch<{ id: number }>("/rest/agile/1.0/sprint", {
      method: "POST",
      body: JSON.stringify({
        name: sprint.name,
        originBoardId: boardId,
        startDate: sprint.startDate,
        endDate: sprint.endDate,
        goal: sprint.goal || "",
      }),
    });

    // Start sprint if it was active
    if (sprint.state === 'active' && sprint.startDate && sprint.endDate) {
      try {
        await this.startSprint(newSprint.id, sprint.startDate, sprint.endDate);
        console.log(`[createSprint] Started sprint ${sprint.name}`);
      } catch (error) {
        console.log(`[createSprint] Failed to start sprint:`, error);
      }
    }

    return newSprint;
  }

  // Start a sprint
  async startSprint(sprintId: number, startDate: string, endDate: string): Promise<void> {
    await this.fetch(`/rest/agile/1.0/sprint/${sprintId}`, {
      method: "POST",
      body: JSON.stringify({
        state: "active",
        startDate,
        endDate,
      }),
    });
  }

  // Close a sprint
  async closeSprint(sprintId: number): Promise<void> {
    await this.fetch(`/rest/agile/1.0/sprint/${sprintId}`, {
      method: "POST",
      body: JSON.stringify({
        state: "closed",
      }),
    });
  }

  // Delete a sprint
  async deleteSprint(sprintId: number): Promise<void> {
    await this.fetch(`/rest/agile/1.0/sprint/${sprintId}`, {
      method: "DELETE",
    });
  }

  // Get sprint issues
  async getSprintIssues(sprintId: number): Promise<string[]> {
    const issueKeys: string[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      try {
        const response = await this.fetch<{ issues: Array<{ key: string }>; total: number }>(
          `/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=${maxResults}&fields=key`
        );
        issueKeys.push(...response.issues.map(i => i.key));
        if (issueKeys.length >= response.total) break;
        startAt += maxResults;
      } catch {
        break;
      }
    }

    return issueKeys;
  }

  // Move issues to sprint (batch by 50)
  async moveIssuesToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
    const batchSize = 50;
    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      await this.fetch(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
        method: "POST",
        body: JSON.stringify({
          issues: batch,
        }),
      });
    }
  }

  // Move issues to backlog (batch by 50)
  async moveIssuesToBacklog(issueKeys: string[]): Promise<void> {
    const batchSize = 50;
    for (let i = 0; i < issueKeys.length; i += batchSize) {
      const batch = issueKeys.slice(i, i + batchSize);
      await this.fetch(`/rest/agile/1.0/backlog/issue`, {
        method: "POST",
        body: JSON.stringify({
          issues: batch,
        }),
      });
    }
  }

  // Get issue links for an issue
  async getIssueLinks(issueKey: string): Promise<Array<{
    id: string;
    type: { name: string; inward: string; outward: string };
    inwardIssue?: { key: string };
    outwardIssue?: { key: string };
  }>> {
    try {
      const response = await this.fetch<{
        fields: {
          issuelinks?: Array<{
            id: string;
            type: { name: string; inward: string; outward: string };
            inwardIssue?: { key: string };
            outwardIssue?: { key: string };
          }>;
        };
      }>(`/rest/api/3/issue/${issueKey}?fields=issuelinks`);
      return response.fields.issuelinks || [];
    } catch {
      return [];
    }
  }

  // Delete issue link by ID
  async deleteIssueLink(linkId: string): Promise<void> {
    await this.fetch(`/rest/api/3/issueLink/${linkId}`, {
      method: "DELETE",
    });
  }

  // Create issue link
  async createIssueLink(params: {
    inwardIssue: string;
    outwardIssue: string;
    linkType: string; // e.g., "Relates", "Blocks", "is blocked by"
  }): Promise<void> {
    await this.fetch(`/rest/api/3/issueLink`, {
      method: "POST",
      body: JSON.stringify({
        type: { name: params.linkType },
        inwardIssue: { key: params.inwardIssue },
        outwardIssue: { key: params.outwardIssue },
      }),
    });
  }

  // Get board for a project
  async getBoardsForProject(projectKey: string): Promise<JiraBoard[]> {
    try {
      const response = await this.fetch<{ values: JiraBoard[] }>(
        `/rest/agile/1.0/board?projectKeyOrId=${projectKey}`
      );
      return response.values;
    } catch {
      return [];
    }
  }

  // Check if project has Scrum board (supports sprints)
  async getProjectBoardType(projectKey: string): Promise<'scrum' | 'kanban' | 'unknown'> {
    try {
      const boards = await this.getBoardsForProject(projectKey);
      if (boards.length === 0) return 'unknown';
      
      // Check board type
      const board = boards[0];
      if (board.type === 'scrum') return 'scrum';
      if (board.type === 'kanban') return 'kanban';
      
      // For 'simple' type, try to check if sprints are supported
      try {
        await this.fetch(`/rest/agile/1.0/board/${board.id}/sprint?maxResults=1`);
        return 'scrum'; // If sprint endpoint works, it's scrum-like
      } catch {
        return 'kanban';
      }
    } catch {
      return 'unknown';
    }
  }
}
