import { NextRequest, NextResponse } from "next/server";
import { JiraClient } from "@/lib/jira";

// SEA Office Jira Template
const SEA_TEMPLATE = {
  // Custom Issue Types to create
  issueTypes: [
    { name: "PHASE", description: "Phase of project (Creation, Development, etc.)", type: "standard" },
    { name: "IMPROVEMENT", description: "Improvement request", type: "standard" },
    { name: "QUESTION", description: "Question or inquiry", type: "standard" },
  ],
  
  // Board columns/statuses
  statuses: [
    { name: "GD-TODO", category: "new" },
    { name: "ART-TODO", category: "new" },
    { name: "DEV-TODO", category: "new" },
    { name: "QC-TODO", category: "new" },
    { name: "SE-TODO", category: "new" },
    { name: "IN-PROGRESS", category: "indeterminate" },
    { name: "FIXED/DONE", category: "indeterminate" },
    { name: "DEPLOYED", category: "indeterminate" },
    { name: "IN-TESTING", category: "indeterminate" },
    { name: "WON'T FIX", category: "done" },
    { name: "CLOSED", category: "done" },
  ],

  // Project naming conventions
  projectPrefixes: {
    fishing: "KTF",
    slot: "KTS", 
    virtualSport: "KTVS",
    arcade: "KTA",
  },

  // Phases for EPIC
  phases: [
    "Creation",
    "Art-Creation", 
    "Development",
    "GD/PO-Finetune",
    "Finalization",
    "Closure",
  ],
};

export async function POST(request: NextRequest) {
  try {
    const { domain, email, apiToken, projectKey } = await request.json();

    if (!domain || !email || !apiToken || !projectKey) {
      return NextResponse.json(
        { error: "Missing required fields: domain, email, apiToken, projectKey" },
        { status: 400 }
      );
    }

    const client = new JiraClient({ domain, email, apiToken });
    
    const results = {
      project: null as string | null,
      issueTypesCreated: [] as string[],
      statusesInfo: SEA_TEMPLATE.statuses.map(s => s.name),
      manualStepsRequired: [
        "1. Go to Project Settings → Features:",
        "   - Turn OFF: Timeline, List, Calendar, Reports, Goals, Estimation, Code, Security, Release, Deployment, On-Call, Project Pages",
        "   - Turn ON: Backlog, Board, Issue Navigator, Sprints",
        "",
        "2. Go to Project Settings → Issue Types → Add issue type:",
        "   - Create: PHASE, IMPROVEMENT, QUESTION",
        "",
        "3. Configure fields for each Issue Type:",
        "   - Bug: Start Date, Due Date, Priority, Time tracking, Environment",
        "   - Phase/Task/Subtask/Story: Start Date, Due Date, Priority, Time tracking, Original estimate",
        "   - Epic: Start Date, Due Date, Priority",
        "",
        "4. Add Bug description template:",
        "   I. [STEPS]",
        "   II. [CURRENT]", 
        "   III. [EXPECTED]",
        "   IV. [RP]",
        "   Date:",
        "   Repro: 100%",
        "   Note:",
        "",
        "5. Add Environment template for Bug:",
        "   Env:",
        "   Game version:",
        "   Device:",
        "   OS:",
        "   Browser:",
        "",
        "6. Configure Board columns (drag to reorder):",
        ...SEA_TEMPLATE.statuses.map((s, i) => `   ${i + 1}. ${s.name}`),
        "",
        "7. Naming conventions:",
        "   - EPIC: [WS0x].[PROJECT ID].[PROJECT-NAME + REQUEST]",
        "   - PHASE: Creation, Art-Creation, Development, GD/PO-Finetune-xx, Finalization",
        "   - STORY/TASK: [GROUPNAME] Title",
      ],
      errors: [] as string[],
    };

    // Check if project exists
    const projectExists = await client.projectExists(projectKey);
    
    if (!projectExists) {
      // Try to create project with Scrum template
      try {
        await client.createProject({
          key: projectKey,
          name: projectKey,
          projectTypeKey: "software",
          projectTemplate: "scrum",
        });
        results.project = `Created project ${projectKey} (Scrum)`;
      } catch (error) {
        results.errors.push(`Failed to create project: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    } else {
      results.project = `Project ${projectKey} already exists`;
      
      // Check board type
      const boardType = await client.getProjectBoardType(projectKey);
      if (boardType === 'kanban') {
        results.manualStepsRequired.unshift(
          "⚠️ IMPORTANT: Project is Kanban, needs to be Scrum!",
          "   Go to Project Settings → Features → Switch to Scrum",
          ""
        );
      }
    }

    // Note: Creating custom issue types and statuses requires admin permissions
    // and different API endpoints that may not be available in all Jira instances
    
    return NextResponse.json({
      success: true,
      template: "SEA Office Jira Template",
      ...results,
      note: "Most configuration must be done manually in Jira UI. See manualStepsRequired for detailed steps.",
    });
    
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// GET endpoint to retrieve template info
export async function GET() {
  return NextResponse.json({
    template: "SEA Office Jira Template",
    ...SEA_TEMPLATE,
    description: "Template for SEA Office game development projects",
    projectTypes: [
      { prefix: "KTF", type: "Fishing" },
      { prefix: "KTS", type: "Slot" },
      { prefix: "KTVS", type: "Virtual Sport" },
      { prefix: "KTA", type: "Arcade/Crash" },
    ],
  });
}
