import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@notionhq/client";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

const SYSTEM_PROMPT = `You are a task extraction assistant for an independent sponsor (private equity) professional.

You receive raw voice transcriptions and extract discrete, actionable tasks.

For EACH task, return a JSON object with these fields:
- "task": string — clear, concise task title (imperative form, e.g. "Review LightBridge FDD")
- "priority": one of "🔴 High", "🟡 Medium", "🟢 Low"
  - 🔴 High = has a deadline within 3 days, or is blocking other work
  - 🟡 Medium = important but not urgent, due within 1-2 weeks
  - 🟢 Low = nice-to-have, eventual, no deadline pressure
- "category": one of "Deal Research", "Admin/Ops", "Tool Development", "Networking", "SMG Closeout"
  - Deal Research = FDD reviews, brand analysis, diligence, investment evaluation
  - Admin/Ops = insurance, legal, accounting, administrative tasks
  - Tool Development = building tools, automations, AI workflows, code
  - Networking = outreach, follow-ups, relationship building, meetings
  - SMG Closeout = anything related to winding down SMG
- "due_date": ISO date string (YYYY-MM-DD) if mentioned or inferable, otherwise null
  - Interpret relative dates from today's date which will be provided
  - "by Friday" = the coming Friday, "next week" = next Monday, "end of month" = last day of current month
- "notes": string — any additional context from the transcription that doesn't fit in the title, or null

Return a JSON array of task objects. Nothing else — no markdown, no explanation.

If the transcription contains no actionable tasks, return an empty array: []`;

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth check — support both query param and header
  const token =
    req.query.token ||
    req.headers["x-capture-token"];

  if (token !== process.env.CAPTURE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { text } = req.body;
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "Missing or empty 'text' field" });
  }

  try {
    // Step 1: Claude extracts and categorizes tasks
    const today = new Date().toISOString().split("T")[0];
    const dayOfWeek = new Date().toLocaleDateString("en-US", { weekday: "long" });

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Today is ${dayOfWeek}, ${today}.\n\nTranscription:\n"${text}"`,
        },
      ],
    });

    const responseText = message.content[0].text.trim();
    let tasks;
    try {
      tasks = JSON.parse(responseText);
    } catch {
      return res.status(500).json({
        error: "Failed to parse Claude response",
        raw: responseText,
      });
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(200).json({ message: "No tasks extracted", tasks: [] });
    }

    // Step 2: Create Notion pages for each task
    const created = [];
    for (const t of tasks) {
      const properties = {
        Task: { title: [{ text: { content: t.task } }] },
        Status: { status: { name: "Not started" } },
        Priority: { select: { name: t.priority || "🟡 Medium" } },
        Category: { select: { name: t.category || "Admin/Ops" } },
        Source: { select: { name: "Voice Capture" } },
      };

      if (t.due_date) {
        properties["Due Date"] = { date: { start: t.due_date } };
      }

      if (t.notes) {
        properties["Notes"] = {
          rich_text: [{ text: { content: t.notes } }],
        };
      }

      const page = await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties,
      });

      created.push({ task: t.task, id: page.id });
    }

    return res.status(200).json({
      message: `${created.length} task(s) captured`,
      tasks: created,
    });
  } catch (err) {
    console.error("Capture error:", err);
    return res.status(500).json({
      error: "Internal server error",
      detail: err.message,
    });
  }
}
