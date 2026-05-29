// ANSI color codes for terminal output. Single source of truth — previously
// duplicated in both agent.ts and main.ts.
export const CLI = {
  red: "\x1B[31m",
  green: "\x1B[32m",
  blue: "\x1B[34m",
  yellow: "\x1B[33m",
  clr: "\x1B[0m",
} as const;
