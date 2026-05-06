import { execFile } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type TmuxExecutor = (args: string[]) => Promise<CommandResult>;

export const execTmux: TmuxExecutor = (args) => new Promise((resolve, reject) => {
  execFile("tmux", args, { encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(error, { stdout, stderr }));
      return;
    }
    resolve({ stdout, stderr });
  });
});

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function newTmuxSession(input: {
  tmux: TmuxExecutor;
  sessionName: string;
  cwd: string;
  env: Record<string, string | undefined>;
  command: string;
  args: string[];
}): Promise<void> {
  const envParts = Object.entries(input.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = ["env", ...envParts, shellQuote(input.command), ...input.args.map(shellQuote)].join(" ");
  await input.tmux(["new-session", "-d", "-s", input.sessionName, "-c", input.cwd, command]);
}

export async function sessionExists(tmux: TmuxExecutor, sessionName: string): Promise<boolean> {
  try {
    await tmux(["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function capturePane(tmux: TmuxExecutor, sessionName: string): Promise<string | undefined> {
  try {
    const result = await tmux(["capture-pane", "-p", "-t", sessionName, "-S", "-200"]);
    return result.stdout.trimEnd();
  } catch {
    return undefined;
  }
}

export async function killSession(tmux: TmuxExecutor, sessionName: string): Promise<void> {
  await tmux(["kill-session", "-t", sessionName]);
}
