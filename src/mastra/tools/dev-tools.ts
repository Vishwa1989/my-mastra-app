import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const PROJECT_ROOT = process.cwd();
export const WORKING_DIR = process.env.DEVELOPER_AGENT_WORKING_DIR
  ? path.resolve(process.env.DEVELOPER_AGENT_WORKING_DIR)
  : PROJECT_ROOT;

function resolveSafe(filepath: string): string {
  const abs = path.resolve(WORKING_DIR, filepath);
  if (!abs.startsWith(WORKING_DIR)) {
    throw new Error(`Path '${filepath}' escapes the working directory`);
  }
  return abs;
}

export const readFileTool = createTool({
  id: 'read-file',
  description: 'Read the contents of a file. Use relative paths from the project root.',
  inputSchema: z.object({
    filepath: z.string().describe('Relative path from project root'),
  }),
  outputSchema: z.object({
    content: z.string(),
    lines: z.number(),
  }),
  execute: async ({ filepath }) => {
    const abs = resolveSafe(filepath);
    const content = await fs.readFile(abs, 'utf-8');
    return { content, lines: content.split('\n').length };
  },
});

export const writeFileTool = createTool({
  id: 'write-file',
  description: 'Write content to a file, creating parent directories as needed.',
  inputSchema: z.object({
    filepath: z.string().describe('Relative path from project root'),
    content: z.string().describe('Full file content to write'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    absolutePath: z.string(),
  }),
  execute: async ({ filepath, content }) => {
    const abs = resolveSafe(filepath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { success: true, absolutePath: abs };
  },
});

export const editFileTool = createTool({
  id: 'edit-file',
  description: 'Replace a specific string in a file. Fails if oldContent is not found or appears more than once.',
  inputSchema: z.object({
    filepath: z.string().describe('Relative path from project root'),
    oldContent: z.string().describe('Exact string to find and replace'),
    newContent: z.string().describe('String to replace it with'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  execute: async ({ filepath, oldContent, newContent }) => {
    const abs = resolveSafe(filepath);
    const original = await fs.readFile(abs, 'utf-8');
    const count = original.split(oldContent).length - 1;
    if (count === 0) throw new Error(`oldContent not found in ${filepath}`);
    if (count > 1) throw new Error(`oldContent found ${count} times in ${filepath} — be more specific`);
    await fs.writeFile(abs, original.replace(oldContent, newContent), 'utf-8');
    return { success: true };
  },
});

export const listDirectoryTool = createTool({
  id: 'list-directory',
  description: 'List files and directories at a given path.',
  inputSchema: z.object({
    dirpath: z.string().describe('Relative path from project root. Use "." for root.'),
    recursive: z.boolean().optional().default(false),
  }),
  outputSchema: z.object({
    entries: z.array(z.object({
      name: z.string(),
      type: z.enum(['file', 'directory']),
      path: z.string(),
    })),
  }),
  execute: async ({ dirpath, recursive }) => {
    const abs = resolveSafe(dirpath);

    async function collect(dir: string, base: string): Promise<{ name: string; type: 'file' | 'directory'; path: string }[]> {
      const items = await fs.readdir(dir, { withFileTypes: true });
      const results: { name: string; type: 'file' | 'directory'; path: string }[] = [];
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const rel = path.join(base, item.name);
        const type = item.isDirectory() ? 'directory' : 'file';
        results.push({ name: item.name, type, path: rel });
        if (recursive && item.isDirectory()) {
          results.push(...await collect(path.join(dir, item.name), rel));
        }
      }
      return results;
    }

    const entries = await collect(abs, dirpath === '.' ? '' : dirpath);
    return { entries };
  },
});

export const deleteFileTool = createTool({
  id: 'delete-file',
  description: 'Delete a file or empty directory.',
  requireApproval: true,
  inputSchema: z.object({
    filepath: z.string().describe('Relative path from project root'),
  }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ filepath }) => {
    const abs = resolveSafe(filepath);
    await fs.rm(abs, { recursive: false });
    return { success: true };
  },
});

export const searchCodeTool = createTool({
  id: 'search-code',
  description: 'Search for a pattern across files in the project using grep.',
  inputSchema: z.object({
    pattern: z.string().describe('Text or regex pattern to search for'),
    dir: z.string().optional().default('src').describe('Directory to search in'),
    fileGlob: z.string().optional().default('*.ts').describe('File glob pattern, e.g. "*.ts"'),
    maxResults: z.number().optional().default(30),
  }),
  outputSchema: z.object({
    matches: z.array(z.object({
      file: z.string(),
      line: z.number(),
      text: z.string(),
    })),
    truncated: z.boolean(),
  }),
  execute: async ({ pattern, dir, fileGlob, maxResults }) => {
    const absDir = resolveSafe(dir ?? 'src');
    try {
      const { stdout } = await execAsync(
        `grep -rn --include="${fileGlob}" -E "${pattern.replace(/"/g, '\\"')}" "${absDir}"`,
        { cwd: WORKING_DIR }
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      const matches = lines.slice(0, maxResults).map(line => {
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) return { file: line, line: 0, text: '' };
        return {
          file: path.relative(WORKING_DIR, match[1]),
          line: parseInt(match[2], 10),
          text: match[3].trim(),
        };
      });
      return { matches, truncated: lines.length > maxResults };
    } catch {
      return { matches: [], truncated: false };
    }
  },
});

const ALLOWED_COMMANDS = [
  /^npm (run|install|uninstall|ci|test|build|list) /,
  /^npx /,
  /^node /,
  /^tsc /,
  /^ts-node /,
];

export const runCommandTool = createTool({
  id: 'run-command',
  description: 'Run a shell command in the project root. Allowed: npm run/install/test/build, npx, node, tsc.',
  inputSchema: z.object({
    command: z.string().describe('Shell command to execute'),
    timeoutMs: z.number().optional().default(120000),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number(),
  }),
  execute: async ({ command, timeoutMs }) => {
    const allowed = ALLOWED_COMMANDS.some(re => re.test(command));
    if (!allowed) {
      throw new Error(`Command not allowed: "${command}". Only npm, npx, node, tsc commands are permitted.`);
    }
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: WORKING_DIR,
        timeout: timeoutMs,
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout?.trim() ?? '',
        stderr: err.stderr?.trim() ?? err.message,
        exitCode: err.code ?? 1,
      };
    }
  },
});
