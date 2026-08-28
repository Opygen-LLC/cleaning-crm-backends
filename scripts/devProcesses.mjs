import { spawn } from "node:child_process";

const includeScheduler = process.env.INCLUDE_SCHEDULER === "true";
const commands = [
  { name: "api", args: ["run", "dev:api"] },
  { name: "worker", args: ["run", "dev:worker"] },
  ...(includeScheduler ? [{ name: "scheduler", args: ["run", "dev:scheduler"] }] : []),
];

const children = new Set();
let stopping = false;

const prefixStream = (stream, target, name) => {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) target.write(`[${name}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffered) target.write(`[${name}] ${buffered}\n`);
  });
};

const stopAll = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};

for (const command of commands) {
  const child = spawn("pnpm", command.args, {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.add(child);
  prefixStream(child.stdout, process.stdout, command.name);
  prefixStream(child.stderr, process.stderr, command.name);

  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && code !== 0) {
      console.error(`[dev] ${command.name} stopped unexpectedly (${signal ?? `exit ${code}`}). Stopping the other development processes.`);
      process.exitCode = code || 1;
      stopAll();
    }
    if (children.size === 0 && stopping) process.exit(process.exitCode ?? 0);
  });
}

console.log(`[dev] Starting ${commands.map((command) => command.name).join(" + ")}. Verification emails require the worker process.`);

process.once("SIGINT", () => stopAll("SIGINT"));
process.once("SIGTERM", () => stopAll("SIGTERM"));
