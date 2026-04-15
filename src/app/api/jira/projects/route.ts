import { NextRequest, NextResponse } from "next/server";
import { JiraClient } from "@/lib/jira";

export async function POST(request: NextRequest) {
  try {
    const { domain, email, apiToken } = await request.json();

    if (!domain || !email || !apiToken) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const client = new JiraClient({ domain, email, apiToken });
    const projects = await client.getProjects();

    return NextResponse.json({ projects });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
