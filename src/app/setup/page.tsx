"use client";

import { useState } from "react";

const TEMPLATE = {
  columns: {
    rename: [
      { from: "In Progress", to: "IN-PROGRESS" },
      { from: "Done", to: "CLOSED" },
    ],
    create: [
      { name: "GD-TODO", category: "To-do" },
      { name: "ART-TODO", category: "To-do" },
      { name: "DEV-TODO", category: "To-do" },
      { name: "QC-TODO", category: "To-do" },
      { name: "FIXED/DONE", category: "In Progress" },
      { name: "DEPLOYED", category: "In Progress" },
      { name: "IN-TESTING", category: "In Progress" },
      { name: "WONT FIX", category: "Done" },
    ],
    order: "TO DO → GD-TODO → ART-TODO → DEV-TODO → QC-TODO → IN-PROGRESS → FIXED/DONE → DEPLOYED → IN-TESTING → WONT FIX → CLOSED",
  },
  issueTypes: [
    {
      name: "Epic",
      action: "configure",
      avatar: null,
      descriptionFields: ["Summary", "Project Weight (Number) - TẠO MỚI", "Description"],
      contextFields: ["Assignee", "Parent", "Start date", "Due date"],
      defaultDescription: null,
      defaultEnvironment: null,
    },
    {
      name: "Bug",
      action: "configure",
      avatar: "https://enotion.atlassian.net/rest/api/2/universal_avatar/view/type/issuetype/avatar/10303",
      descriptionFields: ["Summary", "Description", "Environment"],
      contextFields: ["Assignee", "Parent", "Start date", "Due date", "Priority", "Time tracking", "Original estimate", "Sprint"],
      defaultDescription: `I. [STEPS]
    1.
II. [CURRENT]
    -
III. [EXPECTED]
    -
IV. [RP]
    - Date:
    - Repro: 100%
    - Note:`,
      defaultEnvironment: `Env:
Game version:
    FE:
    BE (lobby):
    BE (in-game):
Device:
OS:
Browser:`,
    },
    {
      name: "IMPROVEMENT",
      action: "create",
      avatar: "https://enotion.atlassian.net/rest/api/2/universal_avatar/view/type/issuetype/avatar/10310",
      descriptionFields: ["Summary", "Description", "Environment"],
      contextFields: ["Assignee", "Parent", "Start date", "Due date", "Priority", "Time tracking", "Original estimate", "Sprint"],
      defaultDescription: `I. [STEPS]
    1.
II. [CURRENT]
    -
III. [EXPECTED]
    -
IV. [RP]
    - Date:
    - Repro: 100%
    - Note:`,
      defaultEnvironment: `Env:
Game version:
    FE:
    BE (lobby):
    BE (in-game):
Device:
OS:
Browser:`,
    },
    {
      name: "PHASE",
      action: "create",
      avatar: "https://enotion.atlassian.net/rest/api/2/universal_avatar/view/type/issuetype/avatar/10304",
      descriptionFields: ["Summary", "Description"],
      contextFields: ["Assignee", "Parent", "Start date", "Due date", "Original estimate", "Sprint"],
      defaultDescription: null,
      defaultEnvironment: null,
    },
    {
      name: "Task",
      action: "configure",
      avatar: null,
      descriptionFields: ["Summary", "Description"],
      contextFields: ["Assignee", "Parent", "Start date", "Due date", "Priority", "Time tracking", "Original estimate", "Sprint"],
      defaultDescription: null,
      defaultEnvironment: null,
    },
    {
      name: "User Story",
      action: "rename",
      renameFrom: "Story",
      avatar: null,
      descriptionFields: ["Summary", "Description"],
      contextFields: ["Assignee", "Parent", "Start date", "Due date", "Priority", "Team", "Sprint"],
      defaultDescription: null,
      defaultEnvironment: null,
    },
  ],
  features: {
    on: ["Backlog", "Board", "Sprints"],
    off: ["Timeline", "Calendar", "Reports", "Goals", "Estimation", "Code", "Security", "Releases", "Deployments", "On-call", "Project pages"],
  },
};

interface ProjectInput {
  key: string;
  name: string;
}

export default function SetupChecklist() {
  const [domain] = useState("enotion");
  const [projectsText, setProjectsText] = useState("");
  const [projects, setProjects] = useState<ProjectInput[]>([]);
  const [currentProject, setCurrentProject] = useState<number>(0);

  const baseUrl = `https://${domain}.atlassian.net`;

  const parseProjects = () => {
    const lines = projectsText.trim().split("\n").filter(Boolean);
    const parsed: ProjectInput[] = [];
    
    for (const line of lines) {
      // Format: KEY Name or KEY,Name or KEY - Name
      const match = line.match(/^([A-Z0-9]+)[\s,\-]+(.+)$/);
      if (match) {
        parsed.push({ key: match[1].trim(), name: match[2].trim() });
      }
    }
    
    setProjects(parsed);
    setCurrentProject(0);
  };

  const project = projects[currentProject];

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (projects.length === 0) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">Jira Project Setup Generator</h1>
        
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            Nhập danh sách projects (mỗi dòng: KEY Name)
          </label>
          <textarea
            className="w-full h-40 p-3 border rounded-lg font-mono text-sm"
            placeholder={`KTSTEST Test Slot Game
KTS001 Slot Game 001
KTS002 Slot Game 002`}
            value={projectsText}
            onChange={(e) => setProjectsText(e.target.value)}
          />
        </div>

        <button
          onClick={parseProjects}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          Generate Checklist
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">
          Setup: {project.key} - {project.name}
        </h1>
        <div className="flex gap-2">
          <span className="text-sm text-gray-500">
            {currentProject + 1} / {projects.length}
          </span>
          <button
            onClick={() => setCurrentProject(Math.max(0, currentProject - 1))}
            disabled={currentProject === 0}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            ←
          </button>
          <button
            onClick={() => setCurrentProject(Math.min(projects.length - 1, currentProject + 1))}
            disabled={currentProject === projects.length - 1}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            →
          </button>
          <button
            onClick={() => setProjects([])}
            className="px-3 py-1 border rounded text-red-600"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Quick URLs */}
      <div className="mb-6 p-4 bg-gray-100 rounded-lg">
        <h2 className="font-semibold mb-2">Quick URLs</h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {[
            { label: "Create Project", url: `${baseUrl}/jira/projects?showFlag=createProject` },
            { label: "Board", url: `${baseUrl}/jira/software/projects/${project.key}/boards` },
            { label: "Columns", url: `${baseUrl}/jira/software/projects/${project.key}/settings/boards` },
            { label: "Issue Types", url: `${baseUrl}/jira/software/projects/${project.key}/settings/issuetypes` },
            { label: "Features", url: `${baseUrl}/jira/software/projects/${project.key}/settings/features` },
          ].map((item) => (
            <a
              key={item.label}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              {item.label} ↗
            </a>
          ))}
        </div>
      </div>

      {/* Step 1: Create Project */}
      <Section title="Step 1: Tạo Space (1 phút)">
        <a
          href={`${baseUrl}/jira/projects?showFlag=createProject`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline block mb-2"
        >
          Mở trang tạo project ↗
        </a>
        <CheckItem>Chọn <b>Scrum</b> template</CheckItem>
        <CheckItem>Chọn <b>Team-managed</b></CheckItem>
        <CheckItem>
          Key: <CopyButton text={project.key} />
        </CheckItem>
        <CheckItem>
          Name: <CopyButton text={project.name} />
        </CheckItem>
        <CheckItem>Click <b>Create</b></CheckItem>
      </Section>

      {/* Step 2: Columns */}
      <Section title="Step 2: Configure Board Columns (2 phút)">
        <a
          href={`${baseUrl}/jira/software/projects/${project.key}/boards`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline block mb-2"
        >
          Mở Board → ⋯ → Configure board → Columns ↗
        </a>
        
        <h4 className="font-medium mt-3 mb-1">Rename:</h4>
        {TEMPLATE.columns.rename.map((r) => (
          <CheckItem key={r.from}>
            <code>{r.from}</code> → <CopyButton text={r.to} />
          </CheckItem>
        ))}

        <h4 className="font-medium mt-3 mb-1">Create new:</h4>
        {TEMPLATE.columns.create.map((c) => (
          <CheckItem key={c.name}>
            <CopyButton text={c.name} /> <span className="text-gray-500">({c.category})</span>
          </CheckItem>
        ))}

        <h4 className="font-medium mt-3 mb-1">Sắp xếp thứ tự:</h4>
        <p className="text-sm text-gray-600 font-mono">{TEMPLATE.columns.order}</p>
      </Section>

      {/* Step 3: Issue Types */}
      <Section title="Step 3: Configure Work Types (5 phút)">
        <a
          href={`${baseUrl}/jira/software/projects/${project.key}/settings/issuetypes`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline block mb-2"
        >
          Mở Issue Types settings ↗
        </a>

        {TEMPLATE.issueTypes.map((type) => (
          <div key={type.name} className="mt-4 p-3 border rounded-lg">
            <h4 className="font-semibold flex items-center gap-2">
              <CopyText>{type.name}</CopyText>
              {type.action === "create" && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">TẠO MỚI</span>}
              {type.action === "rename" && <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">RENAME từ {type.renameFrom}</span>}
            </h4>
            
            {type.avatar && (
              <CheckItem>
                Avatar: <CopyButton text={type.avatar} label="Copy URL" />
              </CheckItem>
            )}

            <h5 className="text-sm font-medium mt-2">Description fields:</h5>
            {type.descriptionFields.map((f) => (
              <CheckItem key={f} small><CopyText>{f}</CopyText></CheckItem>
            ))}

            {type.defaultDescription && (
              <div className="mt-2">
                <span className="text-xs text-gray-500">Default Description:</span>
                <CopyButton text={type.defaultDescription} label="Copy template" block />
              </div>
            )}

            {type.defaultEnvironment && (
              <div className="mt-2">
                <span className="text-xs text-gray-500">Default Environment:</span>
                <CopyButton text={type.defaultEnvironment} label="Copy template" block />
              </div>
            )}

            <h5 className="text-sm font-medium mt-2">Context fields:</h5>
            {type.contextFields.map((f) => (
              <CheckItem key={f} small><CopyText>{f}</CopyText></CheckItem>
            ))}
          </div>
        ))}
      </Section>

      {/* Step 4: Features */}
      <Section title="Step 4: Disable unused features (30 giây)">
        <a
          href={`${baseUrl}/jira/software/projects/${project.key}/settings/features`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline block mb-2"
        >
          Mở Features settings ↗
        </a>

        <h4 className="font-medium mt-2 mb-1 text-green-600">✓ Keep ON:</h4>
        {TEMPLATE.features.on.map((f) => (
          <CheckItem key={f} small><CopyText>{f}</CopyText></CheckItem>
        ))}

        <h4 className="font-medium mt-2 mb-1 text-red-600">✗ Turn OFF:</h4>
        {TEMPLATE.features.off.map((f) => (
          <CheckItem key={f} small><CopyText>{f}</CopyText></CheckItem>
        ))}
      </Section>

      {/* Navigation */}
      <div className="mt-6 flex justify-between">
        <button
          onClick={() => setCurrentProject(Math.max(0, currentProject - 1))}
          disabled={currentProject === 0}
          className="px-4 py-2 border rounded-lg disabled:opacity-50"
        >
          ← Previous
        </button>
        {currentProject < projects.length - 1 ? (
          <button
            onClick={() => setCurrentProject(currentProject + 1)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Next Project →
          </button>
        ) : (
          <button
            onClick={() => setProjects([])}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            ✓ All Done!
          </button>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 p-4 border rounded-lg">
      <h3 className="text-lg font-semibold mb-3">{title}</h3>
      {children}
    </div>
  );
}

function CheckItem({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return (
    <label className={`flex items-start gap-2 ${small ? "text-sm" : ""} mb-1`}>
      <input type="checkbox" className="mt-1" />
      <span>{children}</span>
    </label>
  );
}

function CopyButton({ text, label, block }: { text: string; label?: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (block) {
    return (
      <button
        onClick={handleCopy}
        className="mt-1 w-full text-left p-2 bg-gray-100 rounded text-xs font-mono hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 transition-colors"
      >
        {copied ? "✓ Copied!" : label || text}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 rounded text-sm font-mono hover:bg-blue-100 hover:text-blue-700 dark:bg-gray-800 dark:hover:bg-blue-900 transition-colors cursor-pointer"
      title="Click to copy"
    >
      {label || text}
      <span className="text-xs">{copied ? "✓" : "📋"}</span>
    </button>
  );
}

// Clickable text that copies on click
function CopyText({ children, text }: { children: React.ReactNode; text?: string }) {
  const [copied, setCopied] = useState(false);
  const textToCopy = text || (typeof children === 'string' ? children : '');

  const handleCopy = () => {
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span
      onClick={handleCopy}
      className={`cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900 px-1 rounded transition-colors ${copied ? 'bg-green-100 dark:bg-green-900' : ''}`}
      title="Click to copy"
    >
      {copied ? "✓" : children}
    </span>
  );
}
