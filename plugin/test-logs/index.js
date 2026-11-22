import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

// Only process sufficiently long output and cap the size of the replacement.
const minimumLength = 1024;
const maximumSummaryLength = 4000;

// Recognize pytest result counts, output markers, and command names.
const count = /^\d+ (?:passed|failed|errors?|skipped|warnings?|xfailed|xpassed|deselected|reruns?)$/;
const pytestMarker = /^=+\s+(?:test session starts|short test summary info)\s+=+$/m;
const pytestProgress = /^[.sFxXEr]+[ \t]+\[[ \t]*\d+%\][ \t]*$/m;
const pytestCommand = /(?:^|[\s/])(?:pytest|py\.test)(?=$|[\s;|&])/;

// Detect common log-reading commands so an agent can inspect a full log.
const logReader = /^\s*(?:[^\s/]+\/|\/\S*\/)?(?:cat|head|tail|sed|less|more|bat)(?:\s|$)/;

// Trim each summary line and limit it to 420 Unicode code points.
function shortenLine(line) {
  const characters = Array.from(line.trim());
  return characters.length > 420
    ? characters.slice(0, 419).join("") + "…"
    : characters.join("");
}

function summarize(log, command, exitCode, savedPath) {
  // Normalize terminal output for parsing. Remove OpenCode's truncation
  // notice when it points to the saved full log.
  let text = stripVTControlCharacters(log).replace(/\r\n/g, "\n").trimEnd();
  const notice = text.lastIndexOf("\n[showing ");
  if (savedPath && notice >= 0 && text.endsWith("full output saved to " + savedPath + "]")) {
    text = text.slice(0, notice).trimEnd();
  }

  // Skip log readers and require evidence of a pytest run in the command or output.
  if (logReader.test(command)) return;
  if (!pytestCommand.test(command) && !pytestMarker.test(text) && !pytestProgress.test(text)) return;
  
  // Extract the result counts from pytest's final line, before the elapsed time.
  const lines = text.split("\n");
  const lastLine = lines.at(-1).trim().replace(/^=+\s*|\s*=+$/g, "");
  const totals = lastLine.match(/^(.+) in \d+(?:\.\d+)?s(?: \([^)]*\))?$/)?.[1];

  if (totals === "no tests ran" || /^\d+ deselected$/.test(totals ?? "")) {
    return exitCode === 5 ? [lastLine] : undefined;
  }

  // When normal counts are unavailable, handle conftest import errors
  // using the error heading and the last two lines of output.
  const counts = totals?.split(/,\s*/);
  if (!counts?.every((part) => count.test(part))) {
    const conftest = lines.find((line) => /^ImportError while loading conftest\b/.test(line));
    if (exitCode === 4 && conftest) return [conftest, ...lines.slice(-2)];
    return;
  }

  // Check that the counts agree with the exit code. Successful runs need only
  // the final totals line. Failure details are collected for exit codes 1 and 2.
  const hasFailures = counts.some((part) => /^[1-9]\d* (?:failed|errors?)$/.test(part));
  if (exitCode === 0) return hasFailures ? undefined : [lastLine];
  if (!hasFailures || (exitCode !== 1 && exitCode !== 2)) return;

  const shortReport = lines.findLastIndex((line) => /^=+\s+short test summary info\s+=+$/.test(line));
  const failures = shortReport < 0
    ? []
    : lines.slice(shortReport + 1).filter((line) => /^(?:FAILED|ERROR)\s/.test(line));
  const excerpts = lines.filter((line) => /^(?:E\s+\S|\S+:\d+:\s+\S)/.test(line)).slice(0, 3);

  if (failures.length === 0 && excerpts.length === 0) return;
  const remaining = failures.length > 3
    ? ["Additional failures listed in the full log: " + (failures.length - 3)]
    : [];

  return [lastLine, ...failures.slice(0, 3), ...excerpts, ...remaining];
}

// Register the summarizer as an OpenCode post-execution hook.
export default {
  id: "test-log-summary",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "shell" || event.status !== "completed") return;

      const { output, metadata } = event.result;
      const { output: raw, exitCode, outputPath } = output ?? {};
      if (metadata?.status !== "completed" || metadata.timeout || metadata.signal || metadata.killed) return;
      if (typeof raw !== "string" || raw.length < minimumLength || !Number.isInteger(exitCode)) return;

      const savedPath = typeof outputPath === "string" && isAbsolute(outputPath) ? outputPath : undefined;
      if (metadata.truncated && !savedPath) return;

      const details = summarize(raw, event.input?.command ?? "", exitCode, savedPath);
      if (!details) return;

      const logPath = savedPath ?? join(tmpdir(), "opencode-pytest-" + randomUUID() + ".log");
      const summary = [
        "pytest exit code: " + exitCode,
        ...details.map(shortenLine),
        "Full log: " + logPath,
      ].join("\n");
      if (summary.length > maximumSummaryLength || summary.length >= raw.length) return;

      try {
        if (savedPath) await access(savedPath, constants.R_OK);
        else await writeFile(logPath, raw, { flag: "wx", mode: 0o600 });
      } catch {
        return;
      }

      // Direct calls use content. Code Mode can read the structured output.
      event.result = {
        ...event.result,
        output: { ...output, output: summary, outputPath: logPath },
        content: [{ type: "text", text: summary }],
      };
    });
  },
};