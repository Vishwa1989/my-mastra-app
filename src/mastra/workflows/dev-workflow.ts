import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execAsync = promisify(exec);

const MAX_DEV_ITERATIONS = 12;
const MAX_FIX_ITERATIONS = 6;

const WORKING_DIR = process.env.DEVELOPER_AGENT_WORKING_DIR
  ? path.resolve(process.env.DEVELOPER_AGENT_WORKING_DIR)
  : process.cwd();

// ── planStep ──────────────────────────────────────────────────────────────────

const planStep = createStep({
  id: 'plan-step',
  description: 'Planner agent breaks the requirement into an implementation plan',
  inputSchema: z.object({
    requirement: z.string(),
  }),
  outputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgent('plannerAgent');
    const response = await agent.generate([
      {
        role: 'user',
        content: `Here is the requirement:\n\n${inputData.requirement}\n\nProduce a clear, numbered implementation plan. Specify the technology stack and framework you recommend.`,
      },
    ]);
    return { requirement: inputData.requirement, plan: response.text };
  },
});

// ── scaffoldStep ───────────────────────────────────────────────────────────────

type Framework = 'nextjs' | 'react-vite' | 'nestjs' | 'express' | 'node' | 'none';

function detectFramework(plan: string): Framework {
  const p = plan.toLowerCase();
  if (p.includes('next.js') || p.includes('nextjs') || p.includes('next app')) return 'nextjs';
  if (p.includes('nestjs') || p.includes('nest.js')) return 'nestjs';
  if (p.includes('vite') || (p.includes('react') && !p.includes('next'))) return 'react-vite';
  if (p.includes('express') || p.includes('fastify') || p.includes('hono') || p.includes('koa')) return 'express';
  if (p.includes('node') || p.includes('cli') || p.includes('typescript')) return 'node';
  return 'none';
}

const scaffoldStep = createStep({
  id: 'scaffold-step',
  description: 'Deterministically scaffold the project before the agent runs',
  inputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
  }),
  outputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
    scaffoldLog: z.string(),
    projectDir: z.string(),
    framework: z.string(),
  }),
  execute: async ({ inputData }) => {
    await fs.mkdir(WORKING_DIR, { recursive: true });
    const entries = await fs.readdir(WORKING_DIR);
    const isEmpty = entries.filter(e => !e.startsWith('.')).length === 0;
    const logs: string[] = [];
    const framework = detectFramework(inputData.plan);

    if (!isEmpty) {
      logs.push(`Directory already has files: ${entries.join(', ')} — skipping scaffold.`);
    } else {
      logs.push(`Detected framework: ${framework}`);

      if (framework === 'nextjs') {
        logs.push('Scaffolding Next.js project...');
        try {
          const { stdout, stderr } = await execAsync(
            'npx create-next-app@latest app --yes --no-git --ts --app --tailwind --eslint --src-dir --import-alias "@/*"',
            { cwd: WORKING_DIR, timeout: 180000 }
          );
          logs.push(stdout.slice(-500));
          if (stderr) logs.push('stderr: ' + stderr.slice(-200));
          logs.push('Next.js scaffold complete.');
        } catch (err: any) {
          logs.push('create-next-app failed: ' + (err.stderr ?? err.message).slice(0, 300));
          logs.push('Falling back to minimal Next.js scaffold.');
          await writeMinimalNextJs(path.join(WORKING_DIR, 'app'));
          logs.push('Minimal scaffold written.');
        }
      } else if (framework === 'react-vite') {
        logs.push('Scaffolding React + Vite project...');
        try {
          const { stdout } = await execAsync(
            'npx create-vite@latest app --template react-ts',
            { cwd: WORKING_DIR, timeout: 120000 }
          );
          logs.push(stdout.slice(-300));
          await execAsync('npm install', { cwd: path.join(WORKING_DIR, 'app'), timeout: 180000 });
          logs.push('React + Vite scaffold complete.');
        } catch (err: any) {
          logs.push('create-vite failed: ' + (err.stderr ?? err.message).slice(0, 300));
        }
      } else if (framework === 'nestjs') {
        logs.push('Scaffolding NestJS project...');
        try {
          const { stdout } = await execAsync(
            'npx @nestjs/cli@latest new app --package-manager npm --skip-git --strict',
            { cwd: WORKING_DIR, timeout: 180000 }
          );
          logs.push(stdout.slice(-300));
          logs.push('NestJS scaffold complete.');
        } catch (err: any) {
          logs.push('NestJS scaffold failed: ' + (err.stderr ?? err.message).slice(0, 300));
        }
      } else if (framework === 'express' || framework === 'node') {
        logs.push('Scaffolding bare Node/TypeScript project...');
        await writeMinimalNode(path.join(WORKING_DIR, 'app'));
        logs.push('Node scaffold complete.');
      } else {
        logs.push('No recognised framework — leaving directory empty for the developer agent to populate.');
      }
    }

    return {
      requirement: inputData.requirement,
      plan: inputData.plan,
      scaffoldLog: logs.join('\n'),
      projectDir: WORKING_DIR,
      framework,
    };
  },
});

// ── developStep ────────────────────────────────────────────────────────────────

const developStep = createStep({
  id: 'develop-step',
  description: 'Developer agent implements the plan; loops until done or iteration cap reached',
  inputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
    scaffoldLog: z.string(),
    projectDir: z.string(),
    framework: z.string(),
    // Carry-forwards populated from the second iteration onward
    remainingWork: z.string().optional(),
    completedWork: z.string().optional(),
    code: z.string().optional(),
    done: z.boolean().optional(),
  }),
  outputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
    scaffoldLog: z.string(),
    projectDir: z.string(),
    framework: z.string(),
    code: z.string(),
    done: z.boolean(),
    remainingWork: z.string(),
    completedWork: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra.getAgent('developerAgent');
    const isRetry = inputData.done === false;

    const contextBlock = isRetry
      ? [
          'ITERATION: This is a continuation pass — some work from the previous iteration was not completed.',
          `COMPLETED SO FAR:\n${inputData.completedWork ?? 'unknown'}`,
          `REMAINING WORK (focus only on this):\n${inputData.remainingWork}`,
        ].join('\n\n')
      : [
          `FRAMEWORK: ${inputData.framework}`,
          `SCAFFOLD STATUS:\n${inputData.scaffoldLog}`,
          `PROJECT DIR: ${inputData.projectDir}`,
          'Start by calling list-directory "." to understand the scaffolded structure.',
          'Then implement ALL custom code from the plan — business logic, API routes, database integration, and any files NOT created by the scaffolder.',
        ].join('\n\n');

    const response = await agent.generate(
      [
        {
          role: 'user',
          content: `You are executing in an automated workflow. No human will respond. Do not ask for confirmation — use your tools and implement now.

${contextBlock}

PLAN:
${inputData.plan}

Before finishing, run the build (npm run build or npx tsc --noEmit) to confirm the code compiles. Fix any errors you find.

When ALL work is done and the build passes, end your final message with:
<status>{"done":true,"remainingWork":"","completedWork":"<brief summary of what was implemented this pass>"}</status>

If you exhaust your steps before finishing, end with:
<status>{"done":false,"remainingWork":"<exact description of what still needs to be done>","completedWork":"<what was done this pass>"}</status>`,
        },
      ],
      { maxSteps: 30 }
    );

    const statusMatch = response.text.match(/<status>([\s\S]*?)<\/status>/);
    let done = true;
    let remainingWork = '';
    let completedWork = inputData.completedWork ?? '';

    if (statusMatch) {
      try {
        const status = JSON.parse(statusMatch[1].trim());
        done = status.done ?? true;
        remainingWork = status.remainingWork ?? '';
        completedWork = completedWork
          ? `${completedWork}\n${status.completedWork ?? ''}`
          : (status.completedWork ?? '');
      } catch {
        done = true;
      }
    }

    return {
      requirement: inputData.requirement,
      plan: inputData.plan,
      scaffoldLog: inputData.scaffoldLog,
      projectDir: inputData.projectDir,
      framework: inputData.framework,
      code: response.text,
      done,
      remainingWork,
      completedWork,
    };
  },
});

// ── verifyAndFixStep ───────────────────────────────────────────────────────────

const verifyAndFixStep = createStep({
  id: 'verify-step',
  description: 'Run build; if it fails, have the developer agent fix errors then retry',
  inputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
    scaffoldLog: z.string(),
    projectDir: z.string(),
    framework: z.string(),
    code: z.string(),
    done: z.boolean(),
    remainingWork: z.string(),
    completedWork: z.string(),
    buildStatus: z.enum(['passed', 'failed', 'skipped']).optional(),
    buildOutput: z.string().optional(),
  }),
  outputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
    code: z.string(),
    done: z.boolean(),
    remainingWork: z.string(),
    completedWork: z.string(),
    buildStatus: z.enum(['passed', 'failed', 'skipped']),
    buildOutput: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const appDir = path.join(inputData.projectDir, 'app');
    let targetDir: string | null = null;

    for (const candidate of [appDir, inputData.projectDir]) {
      try {
        await fs.access(path.join(candidate, 'package.json'));
        targetDir = candidate;
        break;
      } catch { /* try next */ }
    }

    if (!targetDir) {
      return {
        requirement: inputData.requirement,
        plan: inputData.plan,
        code: inputData.code,
        done: inputData.done,
        remainingWork: inputData.remainingWork,
        completedWork: inputData.completedWork,
        buildStatus: 'skipped' as const,
        buildOutput: 'No package.json found — build skipped.',
      };
    }

    let buildCmd = 'npm run build';
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
      if (!pkg.scripts?.build) buildCmd = 'npx tsc --noEmit';
    } catch { /* use default */ }

    try {
      const { stdout, stderr } = await execAsync(buildCmd, { cwd: targetDir, timeout: 120000 });
      return {
        requirement: inputData.requirement,
        plan: inputData.plan,
        code: inputData.code,
        done: inputData.done,
        remainingWork: inputData.remainingWork,
        completedWork: inputData.completedWork,
        buildStatus: 'passed' as const,
        buildOutput: (stdout + '\n' + stderr).trim().slice(-800),
      };
    } catch (err: any) {
      const buildError = ((err.stdout ?? '') + '\n' + (err.stderr ?? err.message)).trim().slice(-1500);

      const agent = mastra.getAgent('developerAgent');
      const fixResponse = await agent.generate(
        [
          {
            role: 'user',
            content: `You are executing in an automated workflow. The build failed — fix all errors now. No human will respond.

PROJECT DIR: ${targetDir}

BUILD ERRORS:
${buildError}

Fix every error. Do not explain. When done, end with:
<status>{"done":true,"completedWork":"<brief summary of what was fixed>"}</status>`,
          },
        ],
        { maxSteps: 20 }
      );

      return {
        requirement: inputData.requirement,
        plan: inputData.plan,
        code: fixResponse.text,
        done: inputData.done,
        remainingWork: inputData.remainingWork,
        completedWork: inputData.completedWork,
        buildStatus: 'failed' as const,
        buildOutput: buildError,
      };
    }
  },
});

// ── workflow ───────────────────────────────────────────────────────────────────

export const devWorkflow = createWorkflow({
  id: 'dev-workflow',
  description: 'Plan → Scaffold → Develop (loop until done) → Verify build',
  inputSchema: z.object({
    requirement: z.string().describe('The feature or task requirement'),
  }),
  outputSchema: z.object({
    requirement: z.string(),
    plan: z.string(),
    code: z.string(),
    done: z.boolean(),
    remainingWork: z.string(),
    completedWork: z.string(),
    buildStatus: z.enum(['passed', 'failed', 'skipped']),
    buildOutput: z.string(),
  }),
})
  .then(planStep)
  .then(scaffoldStep)
  .dountil(developStep, async ({ inputData, iterationCount }) => {
    return inputData.done || iterationCount >= MAX_DEV_ITERATIONS;
  })
  .dountil(verifyAndFixStep, async ({ inputData, iterationCount }) => {
    return inputData.buildStatus === 'passed' || inputData.buildStatus === 'skipped' || iterationCount >= MAX_FIX_ITERATIONS;
  });

devWorkflow.commit();

// ── helpers ────────────────────────────────────────────────────────────────────

async function writeMinimalNextJs(dir: string) {
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'app',
    version: '0.1.0',
    private: true,
    scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    devDependencies: { typescript: '^5', '@types/node': '^20', '@types/react': '^19', '@types/react-dom': '^19' },
  }, null, 2));

  await fs.writeFile(path.join(dir, 'next.config.ts'),
    `import type { NextConfig } from 'next';\nconst config: NextConfig = {};\nexport default config;\n`);

  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true,
      skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
      module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true,
      isolatedModules: true, jsx: 'preserve', incremental: true,
      paths: { '@/*': ['./src/*'] },
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
    exclude: ['node_modules'],
  }, null, 2));

  const srcApp = path.join(dir, 'src', 'app');
  await fs.mkdir(srcApp, { recursive: true });
  await fs.writeFile(path.join(srcApp, 'layout.tsx'),
    `import type { Metadata } from 'next';\nexport const metadata: Metadata = { title: 'App', description: 'Generated app' };\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`);
  await fs.writeFile(path.join(srcApp, 'page.tsx'),
    `export default function Home() {\n  return <main><h1>Hello World</h1></main>;\n}\n`);
  await fs.writeFile(path.join(dir, '.env.local'), `DATABASE_URL=postgresql://user:password@localhost:5432/mydb\n`);
}

async function writeMinimalNode(dir: string) {
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'app',
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'tsx src/index.ts' },
    devDependencies: { typescript: '^5', '@types/node': '^20', tsx: '^4' },
  }, null, 2));

  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      outDir: 'dist', rootDir: 'src', strict: true, skipLibCheck: true,
      esModuleInterop: true, resolveJsonModule: true,
    },
    include: ['src'],
    exclude: ['node_modules', 'dist'],
  }, null, 2));

  const src = path.join(dir, 'src');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'index.ts'), `console.log('Hello World');\n`);
}
