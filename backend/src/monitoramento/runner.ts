import { importInpeCsv } from './ingestion.js';
import { importDeterWfs } from './deter.js';
import type { ImportOptions, ImportSummary } from './ingestion.js';
import { getSource } from './ingestion.js';

export async function importMonitorSource(options: ImportOptions): Promise<ImportSummary> {
  const source = await getSource(options.sourceCode);
  if (source.formato === 'csv') {
    if (options.since !== undefined || options.windowDays !== undefined) {
      throw new Error('Fontes CSV usam --date; --since e --janela-dias são exclusivos de fontes WFS');
    }
    return importInpeCsv(options);
  }
  if (source.formato === 'wfs') {
    if (options.date !== undefined) throw new Error('Fontes WFS usam --since ou --janela-dias, não --date');
    return importDeterWfs(options);
  }
  throw new Error(`Formato de fonte não suportado: ${source.formato}`);
}
