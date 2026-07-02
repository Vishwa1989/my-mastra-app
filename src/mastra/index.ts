
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { MastraEditor } from '@mastra/editor';
import { Observability, MastraStorageExporter, MastraPlatformExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { devWorkflow } from './workflows/dev-workflow';
import { weatherAgent } from './agents/weather-agent';
import { plannerAgent } from './agents/planner-agent';
import { developerAgent } from './agents/developer-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';

export const mastra = new Mastra({
  editor: new MastraEditor(),
  server: {
    cors: {
      origin: ['https://mastra-studio-production-2eb0.up.railway.app'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    },
  },
  workflows: { weatherWorkflow, devWorkflow },
  agents: { weatherAgent, plannerAgent, developerAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  storage: new PostgresStore({
    id: 'mastra-storage',
    connectionString: process.env.SUPABASE_CONNECTION_STRING!,
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(),
          new MastraPlatformExporter(),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
});
