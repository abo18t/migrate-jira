import { JiraClient } from "@/lib/jira";

export async function POST(request: Request) {
  const { domain, email, apiToken } = await request.json();

  if (!domain || !email || !apiToken) {
    return new Response(JSON.stringify({ error: "Missing credentials" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const client = new JiraClient({ domain, email, apiToken });
    const fields = await client.getFields();
    
    // Separate custom and system fields
    const customFields = fields
      .filter(f => f.custom)
      .map(f => ({ id: f.id, name: f.name, type: f.schema?.type }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    const systemFields = fields
      .filter(f => !f.custom)
      .map(f => ({ id: f.id, name: f.name, type: f.schema?.type }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return new Response(JSON.stringify({ customFields, systemFields }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
