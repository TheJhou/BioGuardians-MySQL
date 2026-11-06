export interface CsvDocument {
  headers: string[];
  rows: Record<string, string>[];
}

/** Parse the RFC 4180 subset used by the public CSV feeds, including quoted commas and newlines. */
export function parseCsv(input: string): CsvDocument {
  const text = input.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.some((value) => value.trim() !== '')) records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV inválido: campo entre aspas não foi fechado');
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    if (record.some((value) => value.trim() !== '')) records.push(record);
  }
  if (records.length < 1) throw new Error('CSV sem cabeçalho');

  const headers = records[0].map((value) => value.trim());
  if (headers.some((header) => !header)) throw new Error('CSV contém coluna sem nome');
  const normalizedHeaders = headers.map((header) => header.toLocaleLowerCase('pt-BR'));
  if (new Set(normalizedHeaders).size !== headers.length) throw new Error('CSV contém cabeçalhos duplicados');

  return {
    headers,
    rows: records.slice(1).map((values, index) => {
      if (values.length !== headers.length) {
        throw new Error(`CSV inválido na linha ${index + 2}: esperadas ${headers.length} colunas, recebidas ${values.length}`);
      }
      return Object.fromEntries(headers.map((header, column) => [header, values[column].trim()]));
    }),
  };
}
