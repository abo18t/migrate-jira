"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";

// Cookie helpers
function setCookie(name: string, value: string, days = 30) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Strict`;
}

function getCookie(name: string): string {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : '';
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}

interface JiraBoard {
  id: number;
  name: string;
  type: string;
  location?: {
    projectId: number;
    projectKey: string;
    projectName: string;
  };
}

interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
}

type Mode = "select" | "export" | "import" | "attachments" | "fix-worklogs";
type ExportStep = "credentials" | "boards" | "exporting" | "complete";
type ImportStep = "credentials" | "upload" | "project" | "importing" | "complete";
type AttachmentStep = "credentials" | "scan" | "scanning" | "transfer" | "transferring" | "complete";
type FixWorklogStep = "credentials" | "config" | "scanning" | "review" | "fixing" | "complete";

export default function Home() {
  const [mode, setMode] = useState<Mode>("select");
  
  // Export state
  const [exportStep, setExportStep] = useState<ExportStep>("credentials");
  const [exportCredentials, setExportCredentials] = useState({
    domain: "seastudio",
    email: "",
    apiToken: "",
  });
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [selectedBoardIds, setSelectedBoardIds] = useState<number[]>([]);
  const [exportedData, setExportedData] = useState<{
    projectKey: string;
    data: unknown;
  }[] | null>(null);
  const [savedDirectoryHandle, setSavedDirectoryHandle] = useState<FileSystemDirectoryHandle | null>(null);
  
  // Import state
  const [importStep, setImportStep] = useState<ImportStep>("credentials");
  const [importCredentials, setImportCredentials] = useState({
    domain: "enotion",
    email: "",
    apiToken: "",
  });
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string>("");
  const [importData, setImportData] = useState<{
    boards: {
      name: string;
      project?: { projectKey: string; projectName: string };
      issues: unknown[];
    }[];
  } | null>(null);
  const [importFileName, setImportFileName] = useState<string>("");
  const [sourceProjects, setSourceProjects] = useState<{ key: string; name: string }[]>([]);
  const [projectMapping, setProjectMapping] = useState<Record<string, string>>({});
  const [importResults, setImportResults] = useState<{
    success: { oldKey: string; newKey: string; project: string; action?: 'created' | 'updated'; matchMethod?: string }[];
    failed: { oldKey: string; error: string }[];
    keyMapping: Record<string, string>;
    createdProjects?: string[];
    warnings?: string[];
    skipped?: { oldKey: string; reason: string }[];
    linksCreated?: number;
    linksFailed?: number;
    assigneesSet?: number;
    assigneesFailed?: number;
    attachmentsUploaded?: number;
    attachmentsFailed?: number;
    linksDetail?: unknown[];
  } | null>(null);
  const [autoCreateProjects, setAutoCreateProjects] = useState(true);
  const [reimportMode, setReimportMode] = useState(true);
  const [reimportOptions, setReimportOptions] = useState({
    updateFields: true,
    updateComments: true,
    updateLinks: true,
    updateSprintsOnly: false,
  });
  const [existingKeyMapping, setExistingKeyMapping] = useState<Record<string, string>>({});
  const [fieldMapping, setFieldMapping] = useState({
    storyPoints: "customfield_10016",
    startDate: "customfield_10015",
    projectWeight: "customfield_10375", // Source field ID, target may differ
  });
  const [issueTypeMapping, setIssueTypeMapping] = useState<Record<string, string>>({
    // Default mappings for common custom types
    "PHASE": "Task",
    "Feature": "Story",
  });
  const [detectedCustomTypes, setDetectedCustomTypes] = useState<string[]>([]);
  const [detectedStatuses, setDetectedStatuses] = useState<string[]>([]);
  const [targetIssueTypes, setTargetIssueTypes] = useState<string[]>([]);
  
  // Attachment transfer state
  const [attachmentStep, setAttachmentStep] = useState<AttachmentStep>("credentials");
  const [attachmentKeyMapping, setAttachmentKeyMapping] = useState<Record<string, string>>({});
  const [attachmentIssues, setAttachmentIssues] = useState<{
    sourceKey: string;
    targetKey: string;
    attachments: { filename: string; size: number }[];
  }[]>([]);
  const [attachmentProgress, setAttachmentProgress] = useState({
    message: "",
    uploaded: 0,
    failed: 0,
    total: 0,
  });

  // Fix worklogs state
  const [fixWorklogStep, setFixWorklogStep] = useState<FixWorklogStep>("credentials");
  const [fixWorklogProjects, setFixWorklogProjects] = useState<string>("");
  const [fixWorklogKeyMapping, setFixWorklogKeyMapping] = useState<string>("");
  const [worklogsToFix, setWorklogsToFix] = useState<{
    issueKey: string;
    worklogId: string;
    currentComment: string;
    originalAuthor: string;
    newComment: string;
  }[]>([]);
  const [fixWorklogProgress, setFixWorklogProgress] = useState({
    message: "",
    issuesScanned: 0,
    worklogsScanned: 0,
    toFix: 0,
    fixed: 0,
    failed: 0,
  });
  
  // Import progress state
  const [importProgress, setImportProgress] = useState({
    message: "",
    currentIssue: "",
    issueIndex: 0,
    totalIssues: 0,
    projectIndex: 0,
    totalProjects: 0,
    phase: "",
  });

  // Export progress state
  const [exportProgress, setExportProgress] = useState({
    message: "",
    boardIndex: 0,
    totalBoards: 0,
    issueIndex: 0,
    totalIssues: 0,
    currentIssueKey: "",
  });
  
  // Common state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rememberCredentials, setRememberCredentials] = useState(true);
  const [mounted, setMounted] = useState(false);

  // Load saved credentials from cookies on mount
  useEffect(() => {
    setMounted(true);
    const savedEmail = getCookie('jira_email');
    const savedExportToken = getCookie('jira_export_token');
    const savedExportDomain = getCookie('jira_export_domain');
    const savedImportToken = getCookie('jira_import_token');
    const savedImportDomain = getCookie('jira_import_domain');
    
    if (savedEmail) {
      setExportCredentials(prev => ({ 
        ...prev, 
        email: savedEmail,
        apiToken: savedExportToken || '',
        domain: savedExportDomain || prev.domain,
      }));
      setImportCredentials(prev => ({ 
        ...prev, 
        email: savedEmail,
        apiToken: savedImportToken || '',
        domain: savedImportDomain || prev.domain,
      }));
    }
  }, []);

  // Save credentials to cookies
  const saveCredentials = (type: 'export' | 'import') => {
    const creds = type === 'export' ? exportCredentials : importCredentials;
    setCookie('jira_email', creds.email);
    setCookie(`jira_${type}_token`, creds.apiToken);
    setCookie(`jira_${type}_domain`, creds.domain);
  };

  // Clear saved credentials
  const clearSavedCredentials = () => {
    deleteCookie('jira_email');
    deleteCookie('jira_export_token');
    deleteCookie('jira_export_domain');
    deleteCookie('jira_import_token');
    deleteCookie('jira_import_domain');
    setExportCredentials({ domain: 'seastudio', email: '', apiToken: '' });
    setImportCredentials({ domain: 'enotion', email: '', apiToken: '' });
  };

  // Export functions
  const testExportConnection = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/jira/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportCredentials),
      });

      const data = await response.json();

      if (data.success) {
        if (rememberCredentials) {
          saveCredentials('export');
        }
        await loadBoards();
      } else {
        setError(data.error || "Connection failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  };

  const loadBoards = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/jira/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exportCredentials),
      });

      const data = await response.json();

      if (data.boards) {
        setBoards(data.boards);
        setExportStep("boards");
      } else {
        setError(data.error || "Failed to load boards");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load boards");
    } finally {
      setLoading(false);
    }
  };

  const toggleBoard = (boardId: number) => {
    setSelectedBoardIds((prev) =>
      prev.includes(boardId)
        ? prev.filter((id) => id !== boardId)
        : [...prev, boardId]
    );
  };

  const selectAllBoards = () => setSelectedBoardIds(boards.map((b) => b.id));
  const deselectAllBoards = () => setSelectedBoardIds([]);

  const exportBoards = async () => {
    if (selectedBoardIds.length === 0) {
      setError("Please select at least one board");
      return;
    }

    setExportStep("exporting");
    setError("");
    setExportProgress({
      message: "Starting export...",
      boardIndex: 0,
      totalBoards: selectedBoardIds.length,
      issueIndex: 0,
      totalIssues: 0,
      currentIssueKey: "",
    });

    try {
      const response = await fetch("/api/jira/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...exportCredentials,
          boardIds: selectedBoardIds,
        }),
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let exportData: unknown = null;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "status" || data.type === "progress") {
                setExportProgress((prev) => ({
                  ...prev,
                  message: data.message,
                  boardIndex: data.boardIndex || prev.boardIndex,
                  totalBoards: data.totalBoards || prev.totalBoards,
                  totalIssues: data.totalIssues || prev.totalIssues,
                }));
              } else if (data.type === "issue") {
                setExportProgress((prev) => ({
                  ...prev,
                  message: data.message,
                  boardIndex: data.boardIndex,
                  totalBoards: data.totalBoards,
                  issueIndex: data.issueIndex,
                  totalIssues: data.totalIssues,
                  currentIssueKey: data.issueKey,
                }));
              } else if (data.type === "complete") {
                // Fetch the actual data using the exportId
                const exportId = data.exportId;
                const dataResponse = await fetch(`/api/jira/export?id=${exportId}`);
                exportData = await dataResponse.json();
              } else if (data.type === "error") {
                throw new Error(data.message);
              }
            } catch (parseError) {
              // Skip malformed JSON lines
              console.warn("Failed to parse SSE line:", line, parseError);
            }
          }
        }
      }

      if (exportData) {
        // Export theo từng project thay vì 1 file lớn
        const data = exportData as { boards: Array<{ project?: { projectKey: string } }> };
        
        // Group boards by project
        const projectGroups: Record<string, typeof data.boards> = {};
        for (const board of data.boards || []) {
          const projectKey = board.project?.projectKey || 'unknown';
          if (!projectGroups[projectKey]) {
            projectGroups[projectKey] = [];
          }
          projectGroups[projectKey].push(board);
        }
        
        // Prepare data for each project (don't download yet)
        const projectExports = Object.keys(projectGroups).map(projectKey => ({
          projectKey,
          data: {
            exportDate: new Date().toISOString(),
            sourceWorkspace: exportCredentials.domain,
            boards: projectGroups[projectKey],
          },
        }));
        
        setExportedData(projectExports);
        setExportStep("complete");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
      setExportStep("boards");
    }
  };

  // Helper to save file to a directory handle
  const saveFileToDirectory = async (dirHandle: FileSystemDirectoryHandle, fileName: string, content: string) => {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  };

  // Download exported data for a specific project (with folder picker on supported browsers)
  const downloadExportedProject = async (projectKey: string, useLastFolder = false) => {
    const projectExport = exportedData?.find(p => p.projectKey === projectKey);
    if (!projectExport) return;
    
    const content = JSON.stringify(projectExport.data, null, 2);
    const fileName = `jira-export-${projectKey}-${new Date().toISOString().split("T")[0]}.json`;
    
    // Fallback download
    const fallbackDownload = () => {
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    // If we have a saved directory and useLastFolder is true, use it directly
    if (useLastFolder && savedDirectoryHandle) {
      try {
        // Verify we still have permission
        const permission = await (savedDirectoryHandle as unknown as { queryPermission: (opts: { mode: string }) => Promise<string> }).queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          await saveFileToDirectory(savedDirectoryHandle, fileName, content);
          return;
        }
      } catch {
        // Permission lost, clear the saved handle
        setSavedDirectoryHandle(null);
      }
    }

    // Try File System Access API (Chrome/Edge only)
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: fileName,
          types: [{
            description: 'JSON Files',
            accept: { 'application/json': ['.json'] },
          }],
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch (err) {
        // User cancelled or API not supported - use fallback
        if ((err as Error).name !== 'AbortError') {
          fallbackDownload();
        }
        return;
      }
    }
    
    fallbackDownload();
  };

  // Download all exported projects to a selected folder
  const downloadAllExports = async () => {
    if (!exportedData) return;
    
    // Try to use saved directory first
    if (savedDirectoryHandle) {
      try {
        const permission = await (savedDirectoryHandle as unknown as { queryPermission: (opts: { mode: string }) => Promise<string> }).queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          for (const projectExport of exportedData) {
            const fileName = `jira-export-${projectExport.projectKey}-${new Date().toISOString().split("T")[0]}.json`;
            const content = JSON.stringify(projectExport.data, null, 2);
            await saveFileToDirectory(savedDirectoryHandle, fileName, content);
          }
          return;
        }
      } catch {
        setSavedDirectoryHandle(null);
      }
    }
    
    // Try to get a directory handle (Chrome/Edge only)
    if ('showDirectoryPicker' in window) {
      try {
        const dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
        
        // Save for future use
        setSavedDirectoryHandle(dirHandle);
        
        for (const projectExport of exportedData) {
          const fileName = `jira-export-${projectExport.projectKey}-${new Date().toISOString().split("T")[0]}.json`;
          const content = JSON.stringify(projectExport.data, null, 2);
          await saveFileToDirectory(dirHandle, fileName, content);
        }
        return;
      } catch (err) {
        // User cancelled or API not supported
        if ((err as Error).name === 'AbortError') return;
      }
    }
    
    // Fallback: download one by one
    for (const projectExport of exportedData) {
      await downloadExportedProject(projectExport.projectKey);
      await new Promise(r => setTimeout(r, 300));
    }
  };

  // Choose a folder for saving exports
  const chooseExportFolder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
        setSavedDirectoryHandle(dirHandle);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };

  // Import functions
  const testImportConnection = async () => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/jira/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importCredentials),
      });

      const data = await response.json();

      if (data.success) {
        if (rememberCredentials) {
          saveCredentials('import');
        }
        setImportStep("upload");
      } else {
        setError(data.error || "Connection failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    setError("");

    try {
      const text = await file.text();
      if (!text || text.trim() === '') {
        throw new Error('File is empty');
      }
      const data = JSON.parse(text);
      setImportData(data);
      
      // Extract unique projects from the export file
      const projectsFromFile: { key: string; name: string }[] = [];
      const seenKeys = new Set<string>();
      
      // Also detect custom issue types and statuses
      const standardTypes = ['epic', 'story', 'task', 'bug', 'subtask', 'sub-task', 'phase', 'improvement'];
      const customTypes = new Set<string>();
      const customStatuses = new Set<string>();
      
      for (const board of data.boards || []) {
        if (board.project?.projectKey && !seenKeys.has(board.project.projectKey)) {
          seenKeys.add(board.project.projectKey);
          projectsFromFile.push({
            key: board.project.projectKey,
            name: board.project.projectName || board.project.projectKey,
          });
        }
        
        // Detect issue types and statuses
        for (const issue of board.issues || []) {
          const issueType = issue.fields?.issuetype?.name;
          if (issueType && !standardTypes.includes(issueType.toLowerCase())) {
            customTypes.add(issueType);
          }
          
          const status = issue.fields?.status?.name;
          if (status) {
            customStatuses.add(status);
          }
        }
      }
      
      setSourceProjects(projectsFromFile);
      setDetectedCustomTypes(Array.from(customTypes));
      setDetectedStatuses(Array.from(customStatuses));
      
      // Initialize issue type mapping for detected custom types
      const defaultMapping: Record<string, string> = { ...issueTypeMapping };
      for (const type of customTypes) {
        if (!defaultMapping[type]) {
          defaultMapping[type] = 'Task'; // Default to Task
        }
      }
      setIssueTypeMapping(defaultMapping);
      
      // Don't set mapping yet - wait until we load destination projects
      // so we can check which ones exist
      setProjectMapping({});
      
      await loadProjects(projectsFromFile);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Invalid JSON file";
      setError(`Failed to parse ${file.name}: ${errorMsg}`);
      setImportData(null);
      setImportFileName("");
    }
  };

  const loadProjects = async (sourceProjectsList?: { key: string; name: string }[]) => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/jira/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importCredentials),
      });

      const data = await response.json();

      if (data.projects) {
        setProjects(data.projects);
        
        // Fetch available issue types from target workspace
        try {
          const typesResp = await fetch("/api/jira/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...importCredentials, fetchIssueTypes: true }),
          });
          const typesData = await typesResp.json();
          if (typesData.issueTypes) {
            setTargetIssueTypes(typesData.issueTypes.map((t: { name: string }) => t.name));
          }
        } catch {
          // Non-critical, continue
        }
        
        // Initialize mapping - auto-select if project exists, otherwise leave empty
        const projectsToMap = sourceProjectsList || sourceProjects;
        const destinationKeys = new Set(data.projects.map((p: JiraProject) => p.key));
        const initialMapping: Record<string, string> = {};
        
        projectsToMap.forEach(p => {
          if (destinationKeys.has(p.key)) {
            // Project exists in destination - auto-select same key
            initialMapping[p.key] = p.key;
          }
          // If not exists, leave empty - user must select
        });
        
        setProjectMapping(initialMapping);
        setImportStep("project");
      } else {
        setError(data.error || "Failed to load projects");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  };

  const startImport = async () => {
    if (!importData || Object.keys(projectMapping).length === 0) {
      setError("Please configure project mapping");
      return;
    }

    // Reimport without audit log is fine - will infer keys from project mapping

    // Check if all target projects exist (only if auto-create is disabled)
    if (!autoCreateProjects) {
      const targetKeys = Object.values(projectMapping);
      const existingKeys = projects.map(p => p.key);
      const missingKeys = targetKeys.filter(k => !existingKeys.includes(k));
      
      if (missingKeys.length > 0) {
        setError(`Projects not found in destination: ${missingKeys.join(", ")}`);
        return;
      }
    }

    // Check that all source projects have a mapping
    const unmappedProjects = sourceProjects.filter(sp => !projectMapping[sp.key]);
    if (unmappedProjects.length > 0) {
      setError(`Please select destination for: ${unmappedProjects.map(p => p.key).join(", ")}`);
      return;
    }

    setImportStep("importing");
    setError("");
    
    // Calculate total issues
    const totalIssues = importData.boards.reduce((acc, b) => acc + (b.issues?.length || 0), 0);
    setImportProgress({
      message: "Starting import...",
      currentIssue: "",
      issueIndex: 0,
      totalIssues,
      projectIndex: 0,
      totalProjects: sourceProjects.length,
      phase: "",
    });

    try {
      const response = await fetch("/api/jira/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...importCredentials,
          projectMapping,
          importData,
          autoCreateProjects,
          fieldMapping,
          issueTypeMapping,
          reimportMode,
          reimportOptions: reimportMode ? reimportOptions : undefined,
          existingKeyMapping: reimportMode ? existingKeyMapping : undefined,
          streaming: true, // Enable streaming
        }),
      });

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let finalResult: typeof importResults = null;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // SSE format: "data: {...}\n\n" - split by double newline
        const parts = buffer.split("\n\n");
        // Keep the last incomplete part in buffer
        buffer = parts.pop() || "";

        for (const part of parts) {
          const line = part.trim();
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6);
            if (!jsonStr) continue;
            
            try {
              const data = JSON.parse(jsonStr);

              if (data.type === "progress" || data.type === "status") {
                setImportProgress(prev => ({
                  ...prev,
                  message: data.message,
                  currentIssue: data.issueKey || prev.currentIssue,
                  issueIndex: data.issueIndex ?? prev.issueIndex,
                  totalIssues: data.totalIssues ?? prev.totalIssues,
                  projectIndex: data.projectIndex ?? prev.projectIndex,
                  totalProjects: data.totalProjects ?? prev.totalProjects,
                  phase: data.phase || prev.phase,
                }));
              } else if (data.type === "issue_complete") {
                setImportProgress(prev => ({
                  ...prev,
                  currentIssue: data.newKey,
                  issueIndex: data.issueIndex ?? prev.issueIndex,
                }));
              } else if (data.type === "complete") {
                finalResult = data.results;
              } else if (data.type === "error") {
                if (data.results) {
                  finalResult = data.results;
                }
                throw new Error(data.message);
              }
            } catch (parseError) {
              // Only warn if it's not empty
              if (jsonStr.trim()) {
                console.warn("Failed to parse SSE JSON:", jsonStr, parseError);
              }
            }
          }
        }
      }

      if (finalResult) {
        setImportResults(finalResult);
        setImportStep("complete");
      } else {
        throw new Error("Import completed without results");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      // Show partial results if available
      if (importResults || (err instanceof Error && err.message.includes("stopped"))) {
        setImportStep("complete");
      } else {
        setImportStep("project");
      }
    }
  };

  const resetAll = () => {
    setMode("select");
    setExportStep("credentials");
    setImportStep("credentials");
    setFixWorklogStep("credentials");
    setBoards([]);
    setSelectedBoardIds([]);
    setProjects([]);
    setSelectedProjectKey("");
    setImportData(null);
    setImportFileName("");
    setImportResults(null);
    setWorklogsToFix([]);
    setFixWorklogProjects("");
    setFixWorklogKeyMapping("");
    setError("");
  };

  // Download audit log for import results
  const downloadAuditLog = () => {
    if (!importResults) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const audit = {
      timestamp: new Date().toISOString(),
      sourceFile: importFileName,
      targetWorkspace: importCredentials.domain,
      summary: {
        totalProcessed: (importResults.success?.length || 0) + (importResults.failed?.length || 0) + (importResults.skipped?.length || 0),
        success: importResults.success?.length || 0,
        failed: importResults.failed?.length || 0,
        skipped: importResults.skipped?.length || 0,
        warnings: importResults.warnings?.length || 0,
        linksCreated: importResults.linksCreated || 0,
        linksFailed: importResults.linksFailed || 0,
        assigneesSet: importResults.assigneesSet || 0,
        assigneesFailed: importResults.assigneesFailed || 0,
      },
      keyMapping: importResults.keyMapping || {},
      failed: importResults.failed || [],
      skipped: importResults.skipped || [],
      warnings: importResults.warnings || [],
      success: importResults.success || [],
      linksDetail: importResults.linksDetail || [],
    };

    const blob = new Blob([JSON.stringify(audit, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-audit-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Download only failed items for retry
  const downloadFailedItems = () => {
    if (!importResults) return;
    
    const failed = importResults.failed || [];
    const skipped = importResults.skipped || [];
    
    if (failed.length === 0 && skipped.length === 0) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const failedData = {
      timestamp: new Date().toISOString(),
      sourceFile: importFileName,
      failed: failed,
      skipped: skipped,
    };

    const blob = new Blob([JSON.stringify(failedData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-failed-${timestamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Sync worklogs separately
  const [worklogSyncing, setWorklogSyncing] = useState(false);
  const [worklogProgress, setWorklogProgress] = useState({ message: "", issueIndex: 0, totalIssues: 0 });
  const [worklogResult, setWorklogResult] = useState<{ synced: number; failed: number; worklogsAdded: number } | null>(null);

  const syncWorklogs = async () => {
    if (!importResults?.keyMapping || !importData) return;
    setWorklogSyncing(true);
    setWorklogResult(null);
    setWorklogProgress({ message: "Starting...", issueIndex: 0, totalIssues: 0 });

    try {
      const response = await fetch("/api/jira/worklogs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...importCredentials,
          keyMapping: importResults.keyMapping,
          importData,
        }),
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response stream");
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "progress" || data.type === "status") {
              setWorklogProgress(prev => ({
                ...prev,
                message: data.message || prev.message,
                issueIndex: data.issueIndex ?? prev.issueIndex,
                totalIssues: data.totalIssues ?? prev.totalIssues,
              }));
            } else if (data.type === "complete") {
              setWorklogResult(data.results);
            } else if (data.type === "error") {
              throw new Error(data.message);
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worklog sync failed");
    } finally {
      setWorklogSyncing(false);
    }
  };

  // Reset export but keep credentials
  const resetExport = () => {
    setExportStep("boards");
    setSelectedBoardIds([]);
    setError("");
  };

  // Reset import but keep credentials and go back to upload
  const resetImport = () => {
    setImportStep("upload");
    setImportData(null);
    setImportFileName("");
    setImportResults(null);
    setSourceProjects([]);
    setProjectMapping({});
    setError("");
  };

  // Mode selection
  if (mode === "select") {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
              Jira Migration Tool
            </h1>
            <p className="text-zinc-600 dark:text-zinc-400 mt-2">
              Export boards from one workspace and import to another
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <Card 
              className="cursor-pointer hover:border-blue-500 transition-colors"
              onClick={() => setMode("export")}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Export
                </CardTitle>
                <CardDescription>
                  Export boards, issues, worklogs, and comments from a Jira workspace
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button className="w-full">Start Export</Button>
              </CardContent>
            </Card>

            <Card 
              className="cursor-pointer hover:border-green-500 transition-colors"
              onClick={() => setMode("import")}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Import
                </CardTitle>
                <CardDescription>
                  Import exported data into another Jira workspace
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full">Start Import</Button>
              </CardContent>
            </Card>

            {false && <Card
              className="cursor-pointer hover:border-purple-500 transition-colors"
              onClick={() => setMode("attachments")}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  Attachments
                </CardTitle>
                <CardDescription>
                  Transfer attachments after import (images, videos, files)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full">Transfer Attachments</Button>
              </CardContent>
            </Card>}

            {false && <Card
              className="cursor-pointer hover:border-orange-500 transition-colors"
              onClick={() => setMode("fix-worklogs")}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Fix Worklogs
                </CardTitle>
                <CardDescription>
                  Add original author info to worklogs imported without it
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full">Fix Worklogs</Button>
              </CardContent>
            </Card>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Button variant="ghost" onClick={resetAll} className="mb-4">
            ← Back to Home
          </Button>
          <div className="text-center">
            <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
              {mode === "export" ? "Export from Jira" : 
               mode === "import" ? "Import to Jira" : 
               mode === "attachments" ? "Transfer Attachments" :
               "Fix Worklogs"}
            </h1>
            <p className="text-zinc-600 dark:text-zinc-400 mt-2">
              {mode === "export" 
                ? `Export from ${exportCredentials.domain}.atlassian.net`
                : mode === "import"
                ? `Import to ${importCredentials.domain}.atlassian.net`
                : mode === "attachments"
                ? "Transfer attachments between workspaces"
                : `Fix worklogs in ${importCredentials.domain}.atlassian.net`
              }
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-lg">
            {error}
          </div>
        )}

        {/* EXPORT MODE */}
        {mode === "export" && (
          <>
            {exportStep === "credentials" && (
              <Card>
                <CardHeader>
                  <CardTitle>Connect to Source Workspace</CardTitle>
                  <CardDescription>
                    Enter credentials for the workspace you want to export from
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="domain">Workspace Domain</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500">https://</span>
                      <Input
                        id="domain"
                        value={exportCredentials.domain}
                        onChange={(e) =>
                          setExportCredentials({ ...exportCredentials, domain: e.target.value })
                        }
                        placeholder="seastudio"
                      />
                      <span className="text-zinc-500">.atlassian.net</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      value={exportCredentials.email}
                      onChange={(e) =>
                        setExportCredentials({ ...exportCredentials, email: e.target.value })
                      }
                      placeholder="your-email@example.com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="apiToken">API Token</Label>
                    <Input
                      id="apiToken"
                      type="password"
                      value={exportCredentials.apiToken}
                      onChange={(e) =>
                        setExportCredentials({ ...exportCredentials, apiToken: e.target.value })
                      }
                      placeholder="Your Jira API token"
                    />
                    <p className="text-sm text-zinc-500">
                      Create at:{" "}
                      <a
                        href="https://id.atlassian.com/manage-profile/security/api-tokens"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        id.atlassian.com/manage-profile/security/api-tokens
                      </a>
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Checkbox 
                        id="remember-export" 
                        checked={rememberCredentials}
                        onCheckedChange={(checked) => setRememberCredentials(checked === true)}
                      />
                      <Label htmlFor="remember-export" className="text-sm text-zinc-500">
                        Remember credentials
                      </Label>
                    </div>
                    {mounted && getCookie('jira_email') && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={clearSavedCredentials}
                        className="text-xs text-zinc-500"
                      >
                        Clear saved
                      </Button>
                    )}
                  </div>

                  <Button
                    onClick={testExportConnection}
                    disabled={loading || !exportCredentials.domain || !exportCredentials.email || !exportCredentials.apiToken}
                    className="w-full"
                  >
                    {loading ? "Connecting..." : "Connect & Load Boards"}
                  </Button>
                </CardContent>
              </Card>
            )}

            {exportStep === "boards" && (
              <Card>
                <CardHeader>
                  <CardTitle>Select Boards to Export</CardTitle>
                  <CardDescription>
                    Found {boards.length} boards in {exportCredentials.domain}.atlassian.net
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={selectAllBoards}>
                        Select All
                      </Button>
                      <Button variant="outline" size="sm" onClick={deselectAllBoards}>
                        Deselect All
                      </Button>
                    </div>
                    <Badge variant="secondary">
                      {selectedBoardIds.length} / {boards.length} selected
                    </Badge>
                  </div>

                  <Separator className="my-4" />

                  <ScrollArea className="h-[400px] pr-4">
                    <div className="space-y-2">
                      {boards.map((board) => (
                        <div
                          key={board.id}
                          className={`flex items-center space-x-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                            selectedBoardIds.includes(board.id)
                              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                              : "border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900"
                          }`}
                          onClick={() => toggleBoard(board.id)}
                        >
                          <Checkbox
                            checked={selectedBoardIds.includes(board.id)}
                            onCheckedChange={() => toggleBoard(board.id)}
                          />
                          <div className="flex-1">
                            <div className="font-medium">{board.name}</div>
                            {board.location && (
                              <div className="text-sm text-zinc-500">
                                Project: {board.location.projectKey} - {board.location.projectName}
                              </div>
                            )}
                          </div>
                          <Badge variant="outline">{board.type}</Badge>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>

                  <Separator className="my-4" />

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setExportStep("credentials")}>
                      Back
                    </Button>
                    <Button
                      onClick={exportBoards}
                      disabled={selectedBoardIds.length === 0}
                      className="flex-1"
                    >
                      Export {selectedBoardIds.length} Board{selectedBoardIds.length !== 1 ? "s" : ""}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {exportStep === "exporting" && (
              <Card>
                <CardHeader>
                  <CardTitle>Exporting...</CardTitle>
                </CardHeader>
                <CardContent className="py-8">
                  <div className="space-y-6">
                    {/* Overall progress */}
                    <div className="text-center">
                      <div className="animate-spin w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4" />
                      <p className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
                        {exportProgress.message}
                      </p>
                    </div>

                    {/* Board progress */}
                    {exportProgress.totalBoards > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-zinc-600 dark:text-zinc-400">
                          <span>Board Progress</span>
                          <span>{exportProgress.boardIndex} / {exportProgress.totalBoards}</span>
                        </div>
                        <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${(exportProgress.boardIndex / exportProgress.totalBoards) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Issue progress */}
                    {exportProgress.totalIssues > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-zinc-600 dark:text-zinc-400">
                          <span>Issue Progress</span>
                          <span>{exportProgress.issueIndex} / {exportProgress.totalIssues}</span>
                        </div>
                        <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-green-600 transition-all duration-300"
                            style={{ width: `${(exportProgress.issueIndex / exportProgress.totalIssues) * 100}%` }}
                          />
                        </div>
                        {exportProgress.currentIssueKey && (
                          <p className="text-xs text-zinc-500 text-center">
                            Current: {exportProgress.currentIssueKey}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {exportStep === "complete" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-green-600">Export Complete!</CardTitle>
                  <CardDescription>
                    {exportedData?.length || 0} project(s) ready to download
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  
                  {/* List of exported projects with individual download buttons */}
                  {exportedData && exportedData.length > 0 && (
                    <div className="border rounded-lg mb-4">
                      <ScrollArea className="h-[200px]">
                        {exportedData.map((project) => {
                          const boardCount = (project.data as { boards?: unknown[] }).boards?.length || 0;
                          return (
                            <div key={project.projectKey} className="flex items-center justify-between p-3 border-b last:border-0">
                              <div>
                                <span className="font-mono font-medium">{project.projectKey}</span>
                                <span className="text-zinc-500 text-sm ml-2">({boardCount} board{boardCount !== 1 ? 's' : ''})</span>
                              </div>
                              <Button 
                                size="sm" 
                                variant="outline"
                                onClick={() => downloadExportedProject(project.projectKey)}
                              >
                                <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Download
                              </Button>
                            </div>
                          );
                        })}
                      </ScrollArea>
                    </div>
                  )}

                  {/* Folder selection */}
                  <div className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-900 rounded-lg mb-4">
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      <span className="text-sm">
                        {savedDirectoryHandle 
                          ? <span className="text-green-600">Folder selected: <span className="font-mono">{savedDirectoryHandle.name}</span></span>
                          : <span className="text-zinc-500">No folder selected (will ask each time)</span>
                        }
                      </span>
                    </div>
                    <Button size="sm" variant="outline" onClick={chooseExportFolder}>
                      {savedDirectoryHandle ? 'Change' : 'Choose Folder'}
                    </Button>
                  </div>

                  <div className="flex gap-2 justify-center flex-wrap">
                    {savedDirectoryHandle && exportedData && exportedData.length > 0 && (
                      <Button onClick={async () => {
                        for (const project of exportedData) {
                          await downloadExportedProject(project.projectKey, true);
                        }
                      }}>
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Save All to Folder
                      </Button>
                    )}
                    {!savedDirectoryHandle && exportedData && exportedData.length > 1 && (
                      <Button onClick={downloadAllExports}>
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download All
                      </Button>
                    )}
                    {!savedDirectoryHandle && exportedData && exportedData.length === 1 && (
                      <Button onClick={() => downloadExportedProject(exportedData[0].projectKey)}>
                        <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download
                      </Button>
                    )}
                    <Button variant="outline" onClick={() => {
                      setExportStep("boards");
                      setExportedData(null);
                    }}>
                      Export More
                    </Button>
                    <Button variant="outline" onClick={resetAll}>
                      Back to Home
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* IMPORT MODE */}
        {mode === "import" && (
          <>
            {importStep === "credentials" && (
              <Card>
                <CardHeader>
                  <CardTitle>Connect to Destination Workspace</CardTitle>
                  <CardDescription>
                    Enter credentials for the workspace you want to import to
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="import-domain">Workspace Domain</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500">https://</span>
                      <Input
                        id="import-domain"
                        value={importCredentials.domain}
                        onChange={(e) =>
                          setImportCredentials({ ...importCredentials, domain: e.target.value })
                        }
                        placeholder="enotion"
                      />
                      <span className="text-zinc-500">.atlassian.net</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="import-email">Email</Label>
                    <Input
                      id="import-email"
                      type="email"
                      value={importCredentials.email}
                      onChange={(e) =>
                        setImportCredentials({ ...importCredentials, email: e.target.value })
                      }
                      placeholder="your-email@example.com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="import-apiToken">API Token</Label>
                    <Input
                      id="import-apiToken"
                      type="password"
                      value={importCredentials.apiToken}
                      onChange={(e) =>
                        setImportCredentials({ ...importCredentials, apiToken: e.target.value })
                      }
                      placeholder="Your Jira API token"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Checkbox 
                        id="remember-import" 
                        checked={rememberCredentials}
                        onCheckedChange={(checked) => setRememberCredentials(checked === true)}
                      />
                      <Label htmlFor="remember-import" className="text-sm text-zinc-500">
                        Remember credentials
                      </Label>
                    </div>
                    {mounted && getCookie('jira_email') && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={clearSavedCredentials}
                        className="text-xs text-zinc-500"
                      >
                        Clear saved
                      </Button>
                    )}
                  </div>

                  <Button
                    onClick={testImportConnection}
                    disabled={loading || !importCredentials.domain || !importCredentials.email || !importCredentials.apiToken}
                    className="w-full"
                  >
                    {loading ? "Connecting..." : "Connect"}
                  </Button>
                </CardContent>
              </Card>
            )}

            {importStep === "upload" && (
              <Card>
                <CardHeader>
                  <CardTitle>Upload Export File</CardTitle>
                  <CardDescription>
                    Select the JSON file you exported earlier
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div 
                    className="border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 text-center transition-colors hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10"
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.add('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
                    }}
                    onDragLeave={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
                      
                      const files = e.dataTransfer.files;
                      if (files.length > 0) {
                        const file = files[0];
                        // Check by extension instead of MIME type (more reliable)
                        if (file.name.endsWith('.json')) {
                          // Create a fake event to reuse handleFileUpload
                          const fakeEvent = {
                            target: { files }
                          } as React.ChangeEvent<HTMLInputElement>;
                          handleFileUpload(fakeEvent);
                        } else {
                          setError('Please drop a valid JSON file');
                        }
                      }
                    }}
                  >
                    <input
                      type="file"
                      accept=".json"
                      onChange={handleFileUpload}
                      className="hidden"
                      id="file-upload"
                    />
                    <label htmlFor="file-upload" className="cursor-pointer">
                      <svg className="w-12 h-12 text-zinc-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                      <p className="text-zinc-600 dark:text-zinc-400 mb-2">
                        <span className="font-medium text-blue-600">Click to select</span> or drag & drop
                      </p>
                      <p className="text-sm text-zinc-500">
                        JSON export file
                      </p>
                    </label>
                  </div>

                  {importFileName && (
                    <div className="flex items-center gap-2 p-3 bg-zinc-100 dark:bg-zinc-800 rounded-lg">
                      <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span>{importFileName}</span>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setImportStep("credentials")}>
                      Back
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {importStep === "project" && (
              <Card>
                <CardHeader>
                  <CardTitle>Configure Project Mapping</CardTitle>
                  <CardDescription>
                    Map source projects to destination projects in {importCredentials.domain}.atlassian.net
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {/* Auto-create option */}
                  <div className="flex items-center space-x-2 mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                    <Checkbox 
                      id="auto-create" 
                      checked={autoCreateProjects}
                      onCheckedChange={(checked) => {
                        setAutoCreateProjects(checked === true);
                        // When enabling auto-create, auto-fill missing mappings with same key
                        if (checked) {
                          const newMapping = { ...projectMapping };
                          sourceProjects.forEach(sp => {
                            if (!newMapping[sp.key]) {
                              newMapping[sp.key] = sp.key;
                            }
                          });
                          setProjectMapping(newMapping);
                        }
                      }}
                    />
                    <Label htmlFor="auto-create" className="text-sm">
                      Auto-create projects if they don&apos;t exist in destination
                    </Label>
                  </div>

                  {/* Source projects from export file */}
                  <div className="space-y-4 mb-6">
                    <h4 className="font-medium text-sm text-zinc-600 dark:text-zinc-400">
                      Projects found in export file:
                    </h4>
                    {sourceProjects.map((sourceProject) => (
                      <div 
                        key={sourceProject.key}
                        className="p-4 border rounded-lg space-y-3"
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">{sourceProject.key}</Badge>
                          <span className="font-medium">{sourceProject.name}</span>
                          <span className="text-zinc-400">→</span>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <Label className="text-sm text-zinc-500 min-w-[100px]">Import to:</Label>
                          <select
                            value={projectMapping[sourceProject.key] || ""}
                            onChange={(e) => setProjectMapping(prev => ({
                              ...prev,
                              [sourceProject.key]: e.target.value
                            }))}
                            className="flex-1 h-10 px-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 text-sm"
                          >
                            <option value="">-- Select destination project --</option>
                            {/* Option to use same key (auto-create) */}
                            {!projects.find(p => p.key === sourceProject.key) && (
                              <option value={sourceProject.key}>
                                {sourceProject.key} (create new)
                              </option>
                            )}
                            {projects.map((p) => (
                              <option key={p.id} value={p.key}>
                                {p.key} - {p.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        
                        {projectMapping[sourceProject.key] === sourceProject.key && projects.find(p => p.key === sourceProject.key) && (
                          <p className="text-xs text-green-600">
                            ✓ Project exists in destination - will import to same project
                          </p>
                        )}
                        {projectMapping[sourceProject.key] === sourceProject.key && !projects.find(p => p.key === sourceProject.key) && autoCreateProjects && (
                          <p className="text-xs text-blue-600">
                            ⊕ Project will be created automatically
                          </p>
                        )}
                        {projectMapping[sourceProject.key] && projectMapping[sourceProject.key] !== sourceProject.key && (
                          <p className="text-xs text-amber-600">
                            ⚠ Will import to different project: {projectMapping[sourceProject.key]}
                          </p>
                        )}
                        {!projectMapping[sourceProject.key] && !autoCreateProjects && (
                          <p className="text-xs text-red-600">
                            ✗ Project &quot;{sourceProject.key}&quot; does not exist in destination. Please select a target project.
                          </p>
                        )}
                        {!projectMapping[sourceProject.key] && autoCreateProjects && (
                          <p className="text-xs text-zinc-500">
                            Select same key to auto-create, or choose different project
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Summary */}
                  <div className="p-4 bg-zinc-50 dark:bg-zinc-900 rounded-lg mb-4">
                    <h4 className="font-medium mb-2">Import Summary</h4>
                    <div className="text-sm text-zinc-600 dark:text-zinc-400 space-y-1">
                      <p>• {sourceProjects.length} project(s) to import</p>
                      <p>• {importData?.boards.length || 0} board(s)</p>
                      <p>• {importData?.boards.reduce((acc, b) => acc + (b.issues?.length || 0), 0) || 0} issue(s)</p>
                    </div>
                  </div>

                  {/* Re-import Mode */}
                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg mb-4">
                    <div className="flex items-center space-x-2 mb-2">
                      <Checkbox 
                        id="reimport-mode" 
                        checked={reimportMode}
                        onCheckedChange={(checked) => {
                          setReimportMode(checked === true);
                          if (!checked) setExistingKeyMapping({});
                        }}
                      />
                      <Label htmlFor="reimport-mode" className="font-medium text-blue-800 dark:text-blue-200">
                        Re-import Mode (Smart Sync)
                      </Label>
                    </div>
                    <p className="text-xs text-blue-700 dark:text-blue-300 ml-6">
                      Scan &amp; match issues by summary, then update/create as needed.
                    </p>
                    {reimportMode && (
                      <div className="mt-3 ml-6 space-y-3">
                        <div>
                          <Label className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2 block">Reimport Options</Label>
                          <div className="grid grid-cols-2 gap-2">
                            {([
                              { key: 'updateFields' as const, label: 'Update Fields (summary, description, status, assignee...)' },
                              { key: 'updateComments' as const, label: 'Update Comments (delete & re-add)' },
                              { key: 'updateLinks' as const, label: 'Update Issue Links (delete & re-create)' },
                              { key: 'updateSprintsOnly' as const, label: '⚡ Sprints Only Mode (clean duplicates & reassign)' },
                            ]).map(opt => (
                              <div key={opt.key} className="flex items-center space-x-2">
                                <Checkbox
                                  id={`reimport-${opt.key}`}
                                  checked={reimportOptions[opt.key]}
                                  onCheckedChange={(checked) => setReimportOptions(prev => ({ ...prev, [opt.key]: checked === true }))}
                                />
                                <Label htmlFor={`reimport-${opt.key}`} className="text-xs text-blue-700 dark:text-blue-300 cursor-pointer">
                                  {opt.label}
                                </Label>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <Label className="text-sm text-blue-800 dark:text-blue-200">Audit Log (optional, for custom key mapping)</Label>
                          <Input
                            type="file"
                            accept=".json"
                            className="mt-1"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              try {
                                const text = await file.text();
                                const audit = JSON.parse(text);
                                const km = audit.keyMapping || {};
                                setExistingKeyMapping(km);
                              } catch {
                                setError("Invalid audit log file");
                              }
                            }}
                          />
                          {Object.keys(existingKeyMapping).length > 0 ? (
                            <p className="text-xs text-green-600 mt-1">
                              {"✓ Using "}{Object.keys(existingKeyMapping).length}{" key mappings from audit log"}
                            </p>
                          ) : (
                            <p className="text-xs text-zinc-500 mt-1">
                              {"No audit log → will match by summary"}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Field Mapping */}
                  <div className="p-4 bg-zinc-50 dark:bg-zinc-900 rounded-lg mb-4">
                    <h4 className="font-medium mb-3">Custom Field Mapping</h4>
                    <p className="text-xs text-zinc-500 mb-3">
                      These fields may have different IDs in destination. Common defaults are pre-filled.
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-sm">Story Points Field</Label>
                        <Input
                          value={fieldMapping.storyPoints}
                          onChange={(e) => setFieldMapping(prev => ({ ...prev, storyPoints: e.target.value }))}
                          placeholder="customfield_10016"
                          className="text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-sm">Start Date Field</Label>
                        <Input
                          value={fieldMapping.startDate}
                          onChange={(e) => setFieldMapping(prev => ({ ...prev, startDate: e.target.value }))}
                          placeholder="customfield_10015"
                          className="text-sm"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-zinc-400 mt-2">
                      ℹ️ Due date & Time estimate sử dụng field chuẩn của Jira
                    </p>
                  </div>

                  {/* Issue Type Mapping */}
                  {(() => {
                    const targetLower = new Set(targetIssueTypes.map(t => t.toLowerCase()));
                    const unmappedTypes = detectedCustomTypes.filter(t => !targetLower.has(t.toLowerCase()));
                    const validTypes = detectedCustomTypes.filter(t => targetLower.has(t.toLowerCase()));
                    
                    return (unmappedTypes.length > 0 || validTypes.length > 0) ? (
                      <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg mb-4">
                        {validTypes.length > 0 && (
                          <div className="mb-3">
                            <h4 className="font-medium mb-2 text-green-700 dark:text-green-300">✅ Custom Issue Types (exist in target)</h4>
                            <div className="flex flex-wrap gap-2">
                              {validTypes.map((type) => (
                                <span key={type} className="text-sm font-mono bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 px-2 py-1 rounded">
                                  {type}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {unmappedTypes.length > 0 && (
                          <>
                            <h4 className="font-medium mb-2 text-amber-800 dark:text-amber-200">⚠️ Issue Types Not Found in Target</h4>
                            <p className="text-xs text-amber-700 dark:text-amber-300 mb-3">
                              Map these to types that exist in destination:
                            </p>
                            <div className="space-y-3">
                              {unmappedTypes.map((type) => (
                                <div key={type} className="flex items-center gap-3">
                                  <span className="text-sm font-mono bg-zinc-200 dark:bg-zinc-700 px-2 py-1 rounded min-w-[120px]">
                                    {type}
                                  </span>
                                  <span className="text-zinc-500">→</span>
                                  <select
                                    value={issueTypeMapping[type] || 'Task'}
                                    onChange={(e) => setIssueTypeMapping(prev => ({ ...prev, [type]: e.target.value }))}
                                    className="flex-1 h-9 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 text-sm"
                                  >
                                    {targetIssueTypes.length > 0 
                                      ? targetIssueTypes.map(t => <option key={t} value={t}>{t}</option>)
                                      : <>
                                          <option value="Task">Task</option>
                                          <option value="Story">Story</option>
                                          <option value="Bug">Bug</option>
                                          <option value="Epic">Epic</option>
                                        </>
                                    }
                                  </select>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    ) : null;
                  })()}

                  {/* Detected Statuses */}
                  {detectedStatuses.length > 0 && (
                    <div className="p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg mb-4">
                      <h4 className="font-medium mb-2 text-purple-800 dark:text-purple-200">📋 Statuses Found in Export</h4>
                      <p className="text-xs text-purple-700 dark:text-purple-300 mb-3">
                        Import sẽ cố gắng transition đến đúng status. Nếu status không tồn tại ở destination, sẽ giữ nguyên status mặc định.
                      </p>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {detectedStatuses.map((status) => (
                          <span key={status} className="text-sm font-mono bg-purple-200 dark:bg-purple-800 px-2 py-1 rounded">
                            {status}
                          </span>
                        ))}
                      </div>
                      <p className="text-xs text-purple-600 dark:text-purple-400">
                        ✅ Exact match được ưu tiên. Fallback mapping chỉ dùng khi không tìm thấy status.
                      </p>
                    </div>
                  )}

                  <Separator className="my-4" />

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setImportStep("upload")}>
                      Back
                    </Button>
                    <Button
                      onClick={startImport}
                      disabled={sourceProjects.some(sp => !projectMapping[sp.key])}
                      className="flex-1"
                    >
                      Start Import
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {importStep === "importing" && (
              <Card>
                <CardHeader>
                  <CardTitle>Importing...</CardTitle>
                </CardHeader>
                <CardContent className="py-8">
                  <div className="space-y-6">
                    {/* Status message */}
                    <div className="text-center">
                      <div className="animate-spin w-12 h-12 border-4 border-green-600 border-t-transparent rounded-full mx-auto mb-4" />
                      <p className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
                        {importProgress.message || "Importing..."}
                      </p>
                      {importProgress.currentIssue && (
                        <p className="text-sm text-zinc-500 mt-1">
                          {"Current: "}{importProgress.currentIssue}
                        </p>
                      )}
                    </div>

                    {/* Phase indicator */}
                    {importProgress.phase && (
                      <div className="flex justify-center gap-2">
                        {["scanning", "issues", "links", "sprints"].map((p) => (
                          <div
                            key={p}
                            className={`px-3 py-1 rounded-full text-xs font-medium ${
                              importProgress.phase === p
                                ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 ring-2 ring-green-500"
                                : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
                            }`}
                          >
                            {p.charAt(0).toUpperCase() + p.slice(1)}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Project progress */}
                    {importProgress.totalProjects > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-zinc-600 dark:text-zinc-400">
                          <span>{"Project Progress"}</span>
                          <span>{importProgress.projectIndex}{" / "}{importProgress.totalProjects}</span>
                        </div>
                        <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${(importProgress.projectIndex / importProgress.totalProjects) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Issue progress */}
                    {importProgress.totalIssues > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm text-zinc-600 dark:text-zinc-400">
                          <span>{"Issue Progress"}</span>
                          <span>{importProgress.issueIndex}{" / "}{importProgress.totalIssues}</span>
                        </div>
                        <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-600 transition-all duration-300"
                            style={{ width: `${(importProgress.issueIndex / importProgress.totalIssues) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {importStep === "complete" && importResults && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-green-600">Import Complete!</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg text-center">
                      <div className="text-3xl font-bold text-green-600">
                        {importResults.success.length}
                      </div>
                      <div className="text-sm text-zinc-600 dark:text-zinc-400">
                        Issues {importResults.success.some(s => s.action === 'updated') ? 'Created/Updated' : 'Created'}
                      </div>
                    </div>
                    <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg text-center">
                      <div className="text-3xl font-bold text-red-600">
                        {importResults.failed.length}
                      </div>
                      <div className="text-sm text-zinc-600 dark:text-zinc-400">
                        Failed
                      </div>
                    </div>
                  </div>

                  {/* Links and Assignees Stats */}
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-purple-700 dark:text-purple-300">🔗 Issue Links</span>
                        <span className="font-mono text-purple-800 dark:text-purple-200">
                          {importResults.linksCreated || 0} created
                          {(importResults.linksFailed || 0) > 0 && (
                            <span className="text-red-500 ml-2">({importResults.linksFailed} failed)</span>
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-blue-700 dark:text-blue-300">👤 Assignees</span>
                        <span className="font-mono text-blue-800 dark:text-blue-200">
                          {importResults.assigneesSet || 0} set
                          {(importResults.assigneesFailed || 0) > 0 && (
                            <span className="text-red-500 ml-2">({importResults.assigneesFailed} not found)</span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  {importResults.createdProjects && importResults.createdProjects.length > 0 && (
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg mb-4">
                      <p className="text-sm text-blue-700 dark:text-blue-300">
                        ⊕ Created {importResults.createdProjects.length} new project(s): {importResults.createdProjects.join(", ")}
                      </p>
                    </div>
                  )}

                  {importResults.warnings && importResults.warnings.length > 0 && (
                    <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg mb-4">
                      <h4 className="font-medium text-amber-800 dark:text-amber-200 mb-2">⚠️ Warnings</h4>
                      <ul className="text-sm text-amber-700 dark:text-amber-300 space-y-1">
                        {importResults.warnings.map((warning, i) => (
                          <li key={i}>• {warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {importResults.skipped && importResults.skipped.length > 0 && (
                    <div className="p-3 bg-zinc-100 dark:bg-zinc-800 rounded-lg mb-4">
                      <h4 className="font-medium mb-2">Skipped ({importResults.skipped.length}):</h4>
                      <ScrollArea className="h-[100px]">
                        <div className="text-sm space-y-1">
                          {importResults.skipped.map((item) => (
                            <div key={item.oldKey} className="text-zinc-600 dark:text-zinc-400">
                              <span className="font-mono">{item.oldKey}</span>: {item.reason}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}

                  {importResults.success.length > 0 && (
                    <>
                      <h4 className="font-medium mb-2">Key Mapping:</h4>
                      <ScrollArea className="h-[200px] border rounded-lg p-2 mb-4">
                        <div className="space-y-1 text-sm font-mono">
                          {importResults.success.map((item) => (
                            <div key={item.oldKey} className="flex items-center gap-2 py-0.5">
                              <span className="text-zinc-500 min-w-[100px]">{item.oldKey}</span>
                              <span>{"→"}</span>
                              <span className="text-green-600 min-w-[100px]">{item.newKey}</span>
                              <Badge variant="outline" className="text-xs">{item.action || 'created'}</Badge>
                              {item.matchMethod && (
                                <Badge variant="outline" className={`text-xs ${
                                  item.matchMethod === 'summary' ? 'border-blue-300 text-blue-600' :
                                  item.matchMethod === 'audit-log' ? 'border-purple-300 text-purple-600' :
                                  'border-green-300 text-green-600'
                                }`}>
                                  {item.matchMethod}
                                </Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </>
                  )}

                  {importResults.failed.length > 0 && (
                    <>
                      <h4 className="font-medium mb-2 text-red-600">Failed:</h4>
                      <ScrollArea className="h-[100px] border border-red-200 rounded-lg p-2 mb-4">
                        <div className="space-y-1 text-sm">
                          {importResults.failed.map((item) => (
                            <div key={item.oldKey} className="text-red-600">
                              {item.oldKey}: {item.error}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </>
                  )}

                  {/* Sync Worklogs */}
                  <div className="p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg mb-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-sm font-medium text-orange-800 dark:text-orange-200">{"⏱ Sync Worklogs"}</span>
                        <p className="text-xs text-orange-600 dark:text-orange-400">{"Delete & re-add worklogs (separate from import)"}</p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={syncWorklogs}
                        disabled={worklogSyncing}
                        className="border-orange-300 text-orange-700 hover:bg-orange-100"
                      >
                        {worklogSyncing ? "Syncing..." : "Sync Worklogs"}
                      </Button>
                    </div>
                    {worklogSyncing && (
                      <div className="mt-2">
                        <p className="text-xs text-orange-700">{worklogProgress.message}</p>
                        {worklogProgress.totalIssues > 0 && (
                          <div className="h-1.5 bg-orange-200 rounded-full mt-1 overflow-hidden">
                            <div className="h-full bg-orange-500 transition-all" style={{ width: `${(worklogProgress.issueIndex / worklogProgress.totalIssues) * 100}%` }} />
                          </div>
                        )}
                      </div>
                    )}
                    {worklogResult && (
                      <p className="text-xs text-green-600 mt-2">
                        {"✓ "}{worklogResult.synced}{" issues synced, "}{worklogResult.worklogsAdded}{" worklogs added"}
                        {worklogResult.failed > 0 && <span className="text-red-500">{" ("}{worklogResult.failed}{" failed)"}</span>}
                      </p>
                    )}
                  </div>

                  {/* Audit Log Download Buttons */}
                  <div className="flex gap-2 mb-4">
                    <Button 
                      variant="outline" 
                      onClick={downloadAuditLog}
                      className="flex-1"
                    >
                      {"📋 Download Full Audit Log"}
                    </Button>
                    {(importResults.failed.length > 0 || (importResults.skipped?.length || 0) > 0) && (
                      <Button 
                        variant="outline" 
                        onClick={downloadFailedItems}
                        className="flex-1 text-red-600 border-red-300 hover:bg-red-50"
                      >
                        {"⚠️ Download Failed Items"}
                      </Button>
                    )}
                  </div>

                  <Separator className="my-4" />

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={resetImport} className="flex-1">
                      Import Another File
                    </Button>
                    <Button variant="outline" onClick={resetAll}>
                      Back to Home
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Attachments Mode */}
        {mode === "attachments" && (
          <>
            <div className="flex items-center gap-4 mb-6">
              <Button variant="ghost" onClick={resetAll}>
                ← Back
              </Button>
              <h2 className="text-2xl font-bold">Transfer Attachments</h2>
            </div>

            {attachmentStep === "credentials" && (
              <Card>
                <CardHeader>
                  <CardTitle>Upload Audit Log</CardTitle>
                  <CardDescription>
                    Upload the import audit log (contains key mapping) and enter credentials
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label>Import Audit Log (JSON)</Label>
                    <Input
                      type="file"
                      accept=".json"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            try {
                              const data = JSON.parse(event.target?.result as string);
                              if (data.keyMapping) {
                                setAttachmentKeyMapping(data.keyMapping);
                                setError("");
                              } else {
                                setError("Invalid audit log: missing keyMapping");
                              }
                            } catch {
                              setError("Failed to parse audit log");
                            }
                          };
                          reader.readAsText(file);
                        }
                      }}
                    />
                    {Object.keys(attachmentKeyMapping).length > 0 && (
                      <p className="text-sm text-green-600 mt-1">
                        ✓ Loaded {Object.keys(attachmentKeyMapping).length} key mappings
                      </p>
                    )}
                  </div>

                  <Separator />

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <h4 className="font-medium">Source Workspace</h4>
                      <div>
                        <Label>Domain</Label>
                        <Input
                          value={exportCredentials.domain}
                          onChange={(e) => setExportCredentials({ ...exportCredentials, domain: e.target.value })}
                          placeholder="your-domain"
                        />
                      </div>
                      <div>
                        <Label>Email</Label>
                        <Input
                          value={exportCredentials.email}
                          onChange={(e) => setExportCredentials({ ...exportCredentials, email: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>API Token</Label>
                        <Input
                          type="password"
                          value={exportCredentials.apiToken}
                          onChange={(e) => setExportCredentials({ ...exportCredentials, apiToken: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h4 className="font-medium">Target Workspace</h4>
                      <div>
                        <Label>Domain</Label>
                        <Input
                          value={importCredentials.domain}
                          onChange={(e) => setImportCredentials({ ...importCredentials, domain: e.target.value })}
                          placeholder="your-domain"
                        />
                      </div>
                      <div>
                        <Label>Email</Label>
                        <Input
                          value={importCredentials.email}
                          onChange={(e) => setImportCredentials({ ...importCredentials, email: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>API Token</Label>
                        <Input
                          type="password"
                          value={importCredentials.apiToken}
                          onChange={(e) => setImportCredentials({ ...importCredentials, apiToken: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  {error && <p className="text-red-500 text-sm">{error}</p>}

                  <Button
                    onClick={async () => {
                      if (Object.keys(attachmentKeyMapping).length === 0) {
                        setError("Please upload audit log first");
                        return;
                      }
                      setAttachmentStep("scanning");
                      setError("");
                      
                      try {
                        const response = await fetch("/api/jira/attachments", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            action: "export",
                            sourceDomain: exportCredentials.domain,
                            sourceEmail: exportCredentials.email,
                            sourceApiToken: exportCredentials.apiToken,
                            keyMapping: attachmentKeyMapping,
                          }),
                        });

                        const reader = response.body?.getReader();
                        if (!reader) throw new Error("No response");

                        const decoder = new TextDecoder();
                        let buffer = "";

                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) break;

                          buffer += decoder.decode(value, { stream: true });
                          const lines = buffer.split("\n");
                          buffer = lines.pop() || "";

                          for (const line of lines) {
                            if (line.startsWith("data: ")) {
                              try {
                                const data = JSON.parse(line.slice(6));
                                if (data.type === "progress" || data.type === "status") {
                                  setAttachmentProgress(prev => ({ ...prev, message: data.message }));
                                } else if (data.type === "complete") {
                                  setAttachmentIssues(data.issuesWithAttachments || []);
                                  setAttachmentProgress(prev => ({ 
                                    ...prev, 
                                    total: data.totalAttachments || 0 
                                  }));
                                  setAttachmentStep("transfer");
                                }
                              } catch {}
                            }
                          }
                        }
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Scan failed");
                        setAttachmentStep("credentials");
                      }
                    }}
                    disabled={Object.keys(attachmentKeyMapping).length === 0}
                    className="w-full"
                  >
                    Scan for Attachments
                  </Button>
                </CardContent>
              </Card>
            )}

            {attachmentStep === "scanning" && (
              <Card>
                <CardHeader>
                  <CardTitle>Scanning Attachments...</CardTitle>
                </CardHeader>
                <CardContent className="py-8 text-center">
                  <div className="animate-spin w-12 h-12 border-4 border-purple-600 border-t-transparent rounded-full mx-auto mb-4" />
                  <p className="text-zinc-600">{attachmentProgress.message}</p>
                </CardContent>
              </Card>
            )}

            {attachmentStep === "transfer" && (
              <Card>
                <CardHeader>
                  <CardTitle>Ready to Transfer</CardTitle>
                  <CardDescription>
                    Found {attachmentProgress.total} attachments in {attachmentIssues.length} issues
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[300px] border rounded-lg p-3 mb-4">
                    {attachmentIssues.map((issue) => (
                      <div key={issue.sourceKey} className="flex justify-between py-2 border-b last:border-0">
                        <span className="font-mono text-sm">
                          {issue.sourceKey} → {issue.targetKey}
                        </span>
                        <span className="text-zinc-500 text-sm">
                          {issue.attachments.length} files ({(issue.attachments.reduce((s, a) => s + a.size, 0) / 1024 / 1024).toFixed(1)} MB)
                        </span>
                      </div>
                    ))}
                  </ScrollArea>

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setAttachmentStep("credentials")}>
                      Back
                    </Button>
                    <Button
                      className="flex-1"
                      onClick={async () => {
                        setAttachmentStep("transferring");
                        setAttachmentProgress(prev => ({ ...prev, uploaded: 0, failed: 0 }));

                        try {
                          const response = await fetch("/api/jira/attachments", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "import",
                              sourceDomain: exportCredentials.domain,
                              sourceEmail: exportCredentials.email,
                              sourceApiToken: exportCredentials.apiToken,
                              targetDomain: importCredentials.domain,
                              targetEmail: importCredentials.email,
                              targetApiToken: importCredentials.apiToken,
                              keyMapping: attachmentKeyMapping,
                              issuesWithAttachments: attachmentIssues,
                            }),
                          });

                          const reader = response.body?.getReader();
                          if (!reader) throw new Error("No response");

                          const decoder = new TextDecoder();
                          let buffer = "";

                          while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split("\n");
                            buffer = lines.pop() || "";

                            for (const line of lines) {
                              if (line.startsWith("data: ")) {
                                try {
                                  const data = JSON.parse(line.slice(6));
                                  if (data.type === "progress" || data.type === "status") {
                                    setAttachmentProgress(prev => ({
                                      ...prev,
                                      message: data.message,
                                      uploaded: data.uploaded ?? prev.uploaded,
                                      failed: data.failed ?? prev.failed,
                                    }));
                                  } else if (data.type === "complete") {
                                    setAttachmentProgress(prev => ({
                                      ...prev,
                                      uploaded: data.uploaded,
                                      failed: data.failed,
                                    }));
                                    setAttachmentStep("complete");
                                  }
                                } catch {}
                              }
                            }
                          }
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Transfer failed");
                          setAttachmentStep("transfer");
                        }
                      }}
                    >
                      Start Transfer
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {attachmentStep === "transferring" && (
              <Card>
                <CardHeader>
                  <CardTitle>Transferring Attachments...</CardTitle>
                </CardHeader>
                <CardContent className="py-8">
                  <div className="text-center mb-6">
                    <div className="animate-spin w-12 h-12 border-4 border-purple-600 border-t-transparent rounded-full mx-auto mb-4" />
                    <p className="text-zinc-600">{attachmentProgress.message}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-green-50 rounded-lg text-center">
                      <div className="text-2xl font-bold text-green-600">{attachmentProgress.uploaded}</div>
                      <div className="text-sm text-zinc-600">Uploaded</div>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg text-center">
                      <div className="text-2xl font-bold text-red-600">{attachmentProgress.failed}</div>
                      <div className="text-sm text-zinc-600">Failed</div>
                    </div>
                  </div>
                  <Progress 
                    value={(attachmentProgress.uploaded + attachmentProgress.failed) / attachmentProgress.total * 100} 
                    className="mt-4"
                  />
                </CardContent>
              </Card>
            )}

            {attachmentStep === "complete" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-green-600">Transfer Complete!</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="p-4 bg-green-50 rounded-lg text-center">
                      <div className="text-3xl font-bold text-green-600">{attachmentProgress.uploaded}</div>
                      <div className="text-sm text-zinc-600">Uploaded</div>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg text-center">
                      <div className="text-3xl font-bold text-red-600">{attachmentProgress.failed}</div>
                      <div className="text-sm text-zinc-600">Failed</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => {
                      setAttachmentStep("credentials");
                      setAttachmentKeyMapping({});
                      setAttachmentIssues([]);
                    }} className="flex-1">
                      Transfer Another
                    </Button>
                    <Button variant="outline" onClick={resetAll}>
                      Back to Home
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* FIX WORKLOGS MODE */}
        {mode === "fix-worklogs" && (
          <>
            {fixWorklogStep === "credentials" && (
              <Card>
                <CardHeader>
                  <CardTitle>Connect to Target Workspace</CardTitle>
                  <CardDescription>
                    Enter credentials for the workspace with worklogs to fix
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="fix-domain">Workspace Domain</Label>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500">https://</span>
                      <Input
                        id="fix-domain"
                        value={importCredentials.domain}
                        onChange={(e) =>
                          setImportCredentials({ ...importCredentials, domain: e.target.value })
                        }
                        placeholder="enotion"
                      />
                      <span className="text-zinc-500">.atlassian.net</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fix-email">Email</Label>
                    <Input
                      id="fix-email"
                      type="email"
                      value={importCredentials.email}
                      onChange={(e) =>
                        setImportCredentials({ ...importCredentials, email: e.target.value })
                      }
                      placeholder="your-email@example.com"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fix-apiToken">API Token</Label>
                    <Input
                      id="fix-apiToken"
                      type="password"
                      value={importCredentials.apiToken}
                      onChange={(e) =>
                        setImportCredentials({ ...importCredentials, apiToken: e.target.value })
                      }
                      placeholder="Your Jira API token"
                    />
                  </div>

                  <Button
                    onClick={async () => {
                      setLoading(true);
                      setError("");
                      try {
                        const response = await fetch("/api/jira/test", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(importCredentials),
                        });
                        const data = await response.json();
                        if (data.success) {
                          if (rememberCredentials) {
                            setCookie('jira_email', importCredentials.email);
                            setCookie('jira_import_token', importCredentials.apiToken);
                            setCookie('jira_import_domain', importCredentials.domain);
                          }
                          setFixWorklogStep("config");
                        } else {
                          setError(data.error || "Connection failed");
                        }
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Connection failed");
                      } finally {
                        setLoading(false);
                      }
                    }}
                    disabled={loading || !importCredentials.domain || !importCredentials.email || !importCredentials.apiToken}
                    className="w-full"
                  >
                    {loading ? "Connecting..." : "Connect"}
                  </Button>
                </CardContent>
              </Card>
            )}

            {fixWorklogStep === "config" && (
              <Card>
                <CardHeader>
                  <CardTitle>Configure Scan</CardTitle>
                  <CardDescription>
                    Provide project keys and key mapping to find original worklog authors
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Project Keys to Scan</Label>
                    <Input
                      value={fixWorklogProjects}
                      onChange={(e) => setFixWorklogProjects(e.target.value)}
                      placeholder="KTS001, KTS002, KTF001"
                    />
                    <p className="text-xs text-zinc-500">Comma-separated project keys</p>
                  </div>

                  <div className="space-y-2">
                    <Label>Key Mapping (JSON)</Label>
                    <textarea
                      className="w-full h-40 p-3 border rounded-lg font-mono text-sm"
                      value={fixWorklogKeyMapping}
                      onChange={(e) => setFixWorklogKeyMapping(e.target.value)}
                      placeholder='Paste keyMapping from import audit log, e.g.:
{"KTS001-1": "KTS001-1", "KTS001-2": "KTS001-2", ...}'
                    />
                    <p className="text-xs text-zinc-500">
                      Paste the keyMapping from your import audit log. This maps target keys back to source keys.
                    </p>
                  </div>

                  <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
                    <h4 className="font-medium text-amber-800 dark:text-amber-200 mb-2">Source Workspace (Optional)</h4>
                    <p className="text-sm text-amber-700 dark:text-amber-300 mb-3">
                      If you have access to source workspace, we can look up original worklog authors.
                    </p>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-500 text-sm">https://</span>
                        <Input
                          value={exportCredentials.domain}
                          onChange={(e) => setExportCredentials({ ...exportCredentials, domain: e.target.value })}
                          placeholder="seastudio"
                          className="flex-1"
                        />
                        <span className="text-zinc-500 text-sm">.atlassian.net</span>
                      </div>
                      <Input
                        type="email"
                        value={exportCredentials.email}
                        onChange={(e) => setExportCredentials({ ...exportCredentials, email: e.target.value })}
                        placeholder="Email"
                      />
                      <Input
                        type="password"
                        value={exportCredentials.apiToken}
                        onChange={(e) => setExportCredentials({ ...exportCredentials, apiToken: e.target.value })}
                        placeholder="API Token"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setFixWorklogStep("credentials")}>
                      Back
                    </Button>
                    <Button
                      className="flex-1"
                      disabled={!fixWorklogProjects.trim() || !fixWorklogKeyMapping.trim()}
                      onClick={async () => {
                        setError("");
                        
                        // Parse inputs
                        const projectKeys = fixWorklogProjects.split(',').map(k => k.trim()).filter(Boolean);
                        let keyMapping: Record<string, string> = {};
                        
                        try {
                          keyMapping = JSON.parse(fixWorklogKeyMapping);
                        } catch {
                          setError("Invalid JSON for key mapping");
                          return;
                        }

                        setFixWorklogStep("scanning");
                        setFixWorklogProgress({
                          message: "Starting scan...",
                          issuesScanned: 0,
                          worklogsScanned: 0,
                          toFix: 0,
                          fixed: 0,
                          failed: 0,
                        });

                        try {
                          const response = await fetch("/api/jira/fix-worklogs", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "scan",
                              ...importCredentials,
                              projectKeys,
                              keyMapping,
                              sourceDomain: exportCredentials.domain || undefined,
                              sourceEmail: exportCredentials.email || undefined,
                              sourceApiToken: exportCredentials.apiToken || undefined,
                            }),
                          });

                          const reader = response.body?.getReader();
                          if (!reader) throw new Error("No response body");

                          const decoder = new TextDecoder();
                          let buffer = "";

                          while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split("\n");
                            buffer = lines.pop() || "";

                            for (const line of lines) {
                              if (line.startsWith("data: ")) {
                                try {
                                  const data = JSON.parse(line.slice(6));
                                  if (data.type === "status" || data.type === "progress") {
                                    setFixWorklogProgress(prev => ({
                                      ...prev,
                                      message: data.message,
                                      issuesScanned: data.issuesScanned ?? prev.issuesScanned,
                                      worklogsScanned: data.worklogsScanned ?? prev.worklogsScanned,
                                      toFix: data.toFix ?? prev.toFix,
                                    }));
                                  } else if (data.type === "complete") {
                                    setWorklogsToFix(data.worklogsToFix || []);
                                    setFixWorklogProgress(prev => ({
                                      ...prev,
                                      ...data.summary,
                                    }));
                                    setFixWorklogStep("review");
                                  } else if (data.type === "error") {
                                    throw new Error(data.message);
                                  }
                                } catch (parseError) {
                                  if (line.trim()) console.warn("Parse error:", parseError);
                                }
                              }
                            }
                          }
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Scan failed");
                          setFixWorklogStep("config");
                        }
                      }}
                    >
                      Start Scan
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {fixWorklogStep === "scanning" && (
              <Card>
                <CardHeader>
                  <CardTitle>Scanning Worklogs...</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-zinc-600 mb-4">{fixWorklogProgress.message}</p>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold">{fixWorklogProgress.issuesScanned}</div>
                      <div className="text-sm text-zinc-500">Issues Scanned</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold">{fixWorklogProgress.worklogsScanned}</div>
                      <div className="text-sm text-zinc-500">Worklogs Scanned</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-orange-600">{fixWorklogProgress.toFix}</div>
                      <div className="text-sm text-zinc-500">To Fix</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {fixWorklogStep === "review" && (
              <Card>
                <CardHeader>
                  <CardTitle>Review Worklogs to Fix</CardTitle>
                  <CardDescription>
                    Found {worklogsToFix.length} worklogs that need author info added
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {worklogsToFix.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-green-600 font-medium">All worklogs already have author info!</p>
                      <Button variant="outline" onClick={resetAll} className="mt-4">
                        Back to Home
                      </Button>
                    </div>
                  ) : (
                    <>
                      <ScrollArea className="h-64 border rounded-lg p-4 mb-4">
                        {worklogsToFix.slice(0, 50).map((wl) => (
                          <div key={`${wl.issueKey}-${wl.worklogId}`} className="py-2 border-b last:border-0">
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary">{wl.issueKey}</Badge>
                              <span className="text-sm">→</span>
                              <span className="text-sm font-medium text-orange-600">{wl.originalAuthor}</span>
                            </div>
                            {wl.currentComment && (
                              <p className="text-xs text-zinc-500 mt-1 truncate">
                                Current: {wl.currentComment}
                              </p>
                            )}
                          </div>
                        ))}
                        {worklogsToFix.length > 50 && (
                          <p className="text-center text-sm text-zinc-500 py-2">
                            ... and {worklogsToFix.length - 50} more
                          </p>
                        )}
                      </ScrollArea>

                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setFixWorklogStep("config")}>
                          Back
                        </Button>
                        <Button
                          className="flex-1"
                          onClick={async () => {
                            setFixWorklogStep("fixing");
                            setFixWorklogProgress(prev => ({
                              ...prev,
                              message: "Fixing worklogs...",
                              fixed: 0,
                              failed: 0,
                            }));

                            try {
                              const response = await fetch("/api/jira/fix-worklogs", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  action: "fix",
                                  ...importCredentials,
                                  worklogsToFix,
                                }),
                              });

                              const reader = response.body?.getReader();
                              if (!reader) throw new Error("No response body");

                              const decoder = new TextDecoder();
                              let buffer = "";

                              while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split("\n");
                                buffer = lines.pop() || "";

                                for (const line of lines) {
                                  if (line.startsWith("data: ")) {
                                    try {
                                      const data = JSON.parse(line.slice(6));
                                      if (data.type === "status" || data.type === "progress") {
                                        setFixWorklogProgress(prev => ({
                                          ...prev,
                                          message: data.message,
                                          fixed: data.fixed ?? prev.fixed,
                                          failed: data.failed ?? prev.failed,
                                        }));
                                      } else if (data.type === "complete") {
                                        setFixWorklogProgress(prev => ({
                                          ...prev,
                                          fixed: data.fixed,
                                          failed: data.failed,
                                        }));
                                        setFixWorklogStep("complete");
                                      } else if (data.type === "error") {
                                        throw new Error(data.message);
                                      }
                                    } catch (parseError) {
                                      if (line.trim()) console.warn("Parse error:", parseError);
                                    }
                                  }
                                }
                              }
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Fix failed");
                              setFixWorklogStep("review");
                            }
                          }}
                        >
                          Fix {worklogsToFix.length} Worklogs
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {fixWorklogStep === "fixing" && (
              <Card>
                <CardHeader>
                  <CardTitle>Fixing Worklogs...</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-zinc-600 mb-4">{fixWorklogProgress.message}</p>
                  <div className="grid grid-cols-2 gap-4 text-center mb-4">
                    <div>
                      <div className="text-2xl font-bold text-green-600">{fixWorklogProgress.fixed}</div>
                      <div className="text-sm text-zinc-500">Fixed</div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold text-red-600">{fixWorklogProgress.failed}</div>
                      <div className="text-sm text-zinc-500">Failed</div>
                    </div>
                  </div>
                  <Progress 
                    value={(fixWorklogProgress.fixed + fixWorklogProgress.failed) / worklogsToFix.length * 100} 
                  />
                </CardContent>
              </Card>
            )}

            {fixWorklogStep === "complete" && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-green-600">Fix Complete!</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="p-4 bg-green-50 rounded-lg text-center">
                      <div className="text-3xl font-bold text-green-600">{fixWorklogProgress.fixed}</div>
                      <div className="text-sm text-zinc-600">Fixed</div>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg text-center">
                      <div className="text-3xl font-bold text-red-600">{fixWorklogProgress.failed}</div>
                      <div className="text-sm text-zinc-600">Failed</div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => {
                      setFixWorklogStep("config");
                      setWorklogsToFix([]);
                    }} className="flex-1">
                      Fix More
                    </Button>
                    <Button variant="outline" onClick={resetAll}>
                      Back to Home
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
