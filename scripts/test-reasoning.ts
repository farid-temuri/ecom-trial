// Probes OpenRouter to see whether the configured model returns reasoning
// tokens when called with `reasoning: { effort: "medium" }`.
//
// Run: bun run scripts/test-reasoning.ts [model] [effort]
//   bun run scripts/test-reasoning.ts xiaomi/mimo-v2.5-pro medium
//
// Prints the full /chat/completions response so we can see which fields
// (message.reasoning, message.reasoning_details, etc.) actually come back.

const KEY = process.env.OPENROUTER_API_KEY ?? "";
if (!KEY) {
  console.error("OPENROUTER_API_KEY missing");
  process.exit(1);
}

const model = process.argv[2] ?? process.env.MODEL_ID ?? "xiaomi/mimo-v2.5-pro";
const effortArg = (process.argv[3] ?? "medium").toLowerCase();
const effort: string | undefined =
  effortArg === "off" || effortArg === "none" ? undefined : effortArg;

const body: Record<string, unknown> = {
  model,
  messages: [
    {
      role: "system",
      content:
        "You answer in JSON. The user will give you a simple multi-step puzzle. Show your reasoning if your tier supports it.",
    },
    {
      role: "user",
      content:
        'Puzzle: Alice has 3 apples. She gives Bob half, then Charlie gives her 5 more. How many does Alice have? Answer as {"answer": <int>}.',
    },
  ],
  response_format: { type: "json_object" },
};
if (effort) body.reasoning = { effort };

console.log(`POST /chat/completions  model=${model}  reasoning.effort=${effort ?? "(omitted)"}\n`);

const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log("HTTP", res.status);
let data: any;
try {
  data = JSON.parse(text);
} catch {
  console.log(text);
  process.exit(1);
}

console.log("\n--- top-level keys ---");
console.log(Object.keys(data));

const msg = data?.choices?.[0]?.message;
console.log("\n--- message keys ---");
console.log(msg ? Object.keys(msg) : "(no message)");

if (msg) {
  for (const k of Object.keys(msg)) {
    const v = (msg as any)[k];
    const preview =
      typeof v === "string"
        ? v.slice(0, 300) + (v.length > 300 ? `… (+${v.length - 300} chars)` : "")
        : JSON.stringify(v).slice(0, 500);
    console.log(`\n  message.${k}:`, preview);
  }
}

console.log("\n--- usage ---");
console.log(JSON.stringify(data?.usage, null, 2));
