import { pool } from '../db/pool.js';
import { importInpeCsv } from './ingestion.js';

function parseArgs(args: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options['dry-run'] = true;
    } else if (arg.startsWith('--')) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Falta valor para ${arg}`);
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Opção desconhecida: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const source = String(options.source ?? 'inpe_queimadas_diario_br');
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  const summary = await importInpeCsv({
    sourceCode: source,
    date: typeof options.date === 'string' ? options.date : undefined,
    file: typeof options.file === 'string' ? options.file : undefined,
    limit,
    dryRun: options['dry-run'] === true,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
