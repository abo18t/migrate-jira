import { NextRequest, NextResponse } from "next/server";
import { JiraClient } from "@/lib/jira";

export async function POST(request: NextRequest) {
  try {
    const { domain, email, apiToken, fetchIssueTypes } = await request.json();

    if (!domain || !email || !apiToken) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const client = new JiraClient({ domain, email, apiToken });
    const isConnected = await client.testConnection();

    if (isConnected) {
      const result: Record<string, unknown> = { success: true };
      
      if (fetchIssueTypes) {
        try {
          result.issueTypes = await client.getIssueTypes();
        } catch {
          // Non-critical
        }
      }
      
      return NextResponse.json(result);
    } else {
      return NextResponse.json(
        { error: "Failed to connect to Jira" },
        { status: 401 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
