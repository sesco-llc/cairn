import Anthropic from "@anthropic-ai/sdk";
import type { ReviewPath } from "./types.js";
import { TOOLS, exploreToolNames, type ToolContext } from "./tools.js";

export interface CallOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  debug?: boolean;
  log?: (msg: string) => void;
}

export interface AgenticOptions extends CallOptions {
  worktreePath: string;
  maxIterations?: number;
}

export async function callReviewPath(opts: CallOptions): Promise<ReviewPath> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Export it and try again.");
  const client = new Anthropic({ apiKey });

  if (opts.debug) {
    process.stderr.write(`[debug] (no-context) model=${opts.model} prompt_chars=${opts.userPrompt.length}\n`);
  }

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: 16384,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  });

  if (opts.debug) {
    process.stderr.write(`[debug] usage input=${response.usage.input_tokens} output=${response.usage.output_tokens}\n`);
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseAndNormalize(text);
}

export async function callReviewPathAgentic(opts: AgenticOptions): Promise<ReviewPath> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Export it and try again.");
  const client = new Anthropic({ apiKey });

  const maxIterations = opts.maxIterations ?? 40;
  const log = opts.log ?? (() => {});

  const tools = Object.values(TOOLS).map((t) => t.schema);
  const ctx: ToolContext = { worktreePath: opts.worktreePath, log };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.userPrompt },
  ];

  let totalIn = 0;
  let totalOut = 0;
  let submittedReview: ReviewPath | null = null;

  for (let iter = 0; iter < maxIterations; iter++) {
    const response = await client.messages.create({
      model: opts.model,
      max_tokens: 16384,
      system: opts.systemPrompt,
      tools,
      messages,
    });
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // If the response was truncated mid-output and no tool was called, nudge
    // the model to either call a tool or submit. Don't fail the run.
    if (response.stop_reason === "max_tokens" && toolUses.length === 0) {
      log(`response truncated (max_tokens) without tool call; nudging model to submit`);
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content:
          "Your previous response was cut off because it ran out of output budget. Stop writing analysis prose. Either call exactly one tool (read_file / grep / list_dir / glob) with a specific question, or call submit_review_path now with the Review Path you have so far. Do not output text outside of tool calls.",
      });
      continue;
    }

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (submittedReview) break;
      throw new Error(
        `Model finished without calling submit_review_path. stop_reason=${response.stop_reason}. Last text:\n${text.slice(0, 800)}`,
      );
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const handler = TOOLS[tu.name];
      if (!handler) {
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: `unknown tool: ${tu.name}`, is_error: true });
        continue;
      }
      if (tu.name === "submit_review_path") {
        try {
          submittedReview = normalize(tu.input as ReviewPath);
          toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: "ok" });
          log(`submitted Review Path (${submittedReview.steps.length} steps).`);
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `submit_review_path validation failed: ${(err as Error).message}`,
            is_error: true,
          });
        }
        continue;
      }
      try {
        const out = await handler.handle(tu.input, ctx);
        const inputSummary = summarizeInput(tu.name, tu.input);
        log(`${tu.name}${inputSummary} → ${out.split("\n").length} lines`);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      } catch (err) {
        log(`${tu.name} error: ${(err as Error).message}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `error: ${(err as Error).message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    if (submittedReview) {
      // Allow the model one more turn after submission so it cleanly stops,
      // but break if it tries another tool call.
      const finalToolNames = toolUses.map((tu) => tu.name);
      if (finalToolNames.includes("submit_review_path") && finalToolNames.length === 1) {
        break;
      }
    }
  }

  if (opts.debug) {
    process.stderr.write(`[debug] agentic total tokens: input=${totalIn} output=${totalOut}\n`);
  }

  if (!submittedReview) {
    throw new Error(`Hit max iterations (${maxIterations}) without a submitted Review Path.`);
  }
  return submittedReview;
}

function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "read_file") {
    const range = input.start_line ? ` L${input.start_line}-${input.end_line ?? "?"}` : "";
    return ` ${input.path}${range}`;
  }
  if (name === "list_dir") return ` ${input.path ?? "."}`;
  if (name === "glob") return ` ${input.pattern}`;
  if (name === "grep") return ` /${input.pattern}/${input.path ? ` in ${input.path}` : ""}`;
  return "";
}

function parseAndNormalize(text: string): ReviewPath {
  const cleaned = stripFences(text).trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const preview = cleaned.slice(0, 600);
    throw new Error(`Failed to parse Review Path JSON: ${(err as Error).message}\n--- response preview ---\n${preview}`);
  }
  return normalize(parsed);
}

function normalize(parsed: any): ReviewPath {
  if (!parsed || !Array.isArray(parsed.steps)) {
    throw new Error("Response is not a Review Path object (missing `steps`).");
  }
  if (!parsed.overall) {
    parsed.overall = { risk: "medium", summary: "", headline_concerns: [] };
  }
  parsed.overall.headline_concerns ??= [];
  for (const step of parsed.steps) {
    step.risk ??= "medium";
    step.confidence ??= 0.5;
    step.smells ??= [];
    step.annotations ??= [];
    step.depends_on ??= [];
    step.files ??= [];
    step.commits ??= [];
  }
  return parsed as ReviewPath;
}

function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) return fence[1];
  return text;
}
