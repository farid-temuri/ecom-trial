import type { NextStep } from "./types";

// Strip ```json ... ``` / ``` ... ``` fences a model occasionally wraps its JSON
// in, despite the system prompt saying not to. Cheap robustness — saves entire
// trials when the model regresses on raw-JSON output.
export function stripJsonFences(content: string): string {
  const trimmed = content.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i;
  const m = trimmed.match(fence);
  return m && typeof m[1] === "string" ? m[1].trim() : trimmed;
}

export function parseNextStep(content: string): NextStep {
  const obj = JSON.parse(stripJsonFences(content));
  if (
    typeof obj !== "object" ||
    obj === null ||
    typeof obj.code !== "string" ||
    !Array.isArray(obj.plan_remaining_steps_brief) ||
    obj.plan_remaining_steps_brief.length < 1
  ) {
    throw new Error(`Invalid NextStep shape: ${content.slice(0, 500)}`);
  }
  return obj as NextStep;
}
