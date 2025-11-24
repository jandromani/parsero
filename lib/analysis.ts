export type BooleanFilters = {
  pide_tasas?: boolean;
  solicita_adaptacion_discapacidad?: boolean;
  especialidad_carnet_bombero?: boolean;
  especialidad_medicina?: boolean;
};

export type ClusterGroup = {
  label: string;
  size: number;
  ids: number[];
  ejemplos: string[];
};

export type MatchResult = {
  id: number;
  nombre_archivo: string;
  score: number;
  descripcion?: string;
  diferencias?: string[];
};

type DifferenceConfig = {
  label: string;
  path: string[];
  formatter?: (value: unknown) => string;
};

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(normalizeText).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(normalizeText).join(' ');
  return '';
}

export function flattenJson(json: Record<string, unknown> | undefined): string {
  if (!json) return '';
  return normalizeText(json)
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractEspecialidad(json: Record<string, unknown>): string {
  const especialidad =
    (json.especialidad as string | undefined) ||
    (json.descripcion_convocatoria as string | undefined) ||
    '';
  return especialidad.trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Záéíóúñ0-9]+/)
    .filter(Boolean);
}

function cosineSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const freqA = new Map<string, number>();
  const freqB = new Map<string, number>();
  tokensA.forEach((t) => freqA.set(t, (freqA.get(t) ?? 0) + 1));
  tokensB.forEach((t) => freqB.set(t, (freqB.get(t) ?? 0) + 1));

  const allTokens = new Set([...freqA.keys(), ...freqB.keys()]);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const token of allTokens) {
    const aVal = freqA.get(token) ?? 0;
    const bVal = freqB.get(token) ?? 0;
    dot += aVal * bVal;
    magA += aVal * aVal;
    magB += bVal * bVal;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function clusterConcursos(
  concursos: { id?: number; nombre_archivo: string; json_datos: Record<string, unknown> }[],
  similarityThreshold = 0.6
): ClusterGroup[] {
  const clusters: ClusterGroup[] = [];

  concursos.forEach((concurso) => {
    const texto = extractEspecialidad(concurso.json_datos) || concurso.nombre_archivo;
    const resumen = texto || flattenJson(concurso.json_datos);
    let targetCluster: ClusterGroup | undefined;

    for (const cluster of clusters) {
      const sim = cosineSimilarity(cluster.label, resumen);
      if (sim >= similarityThreshold) {
        targetCluster = cluster;
        break;
      }
    }

    if (!targetCluster) {
      targetCluster = {
        label: resumen || 'Sin clasificar',
        size: 0,
        ids: [],
        ejemplos: [],
      };
      clusters.push(targetCluster);
    }

    targetCluster.size += 1;
    if (concurso.id !== undefined) targetCluster.ids.push(concurso.id);
    if (targetCluster.ejemplos.length < 3) {
      targetCluster.ejemplos.push(concurso.nombre_archivo);
    }
  });

  return clusters.sort((a, b) => b.size - a.size);
}

export function rankSimilarConcursos(
  nuevoDocumento: Record<string, unknown>,
  concursos: { id?: number; nombre_archivo: string; json_datos: Record<string, unknown> }[]
): MatchResult[] {
  const nuevoTexto = flattenJson(nuevoDocumento);
  if (!nuevoTexto) return [];

  return concursos
    .map((concurso) => {
      const textoExistente = flattenJson(concurso.json_datos);
      const score = cosineSimilarity(nuevoTexto, textoExistente);
      return {
        id: concurso.id ?? 0,
        nombre_archivo: concurso.nombre_archivo,
        score,
        descripcion: extractEspecialidad(concurso.json_datos),
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

function getValueFromPath(json: Record<string, unknown> | undefined, path: string[]): unknown {
  return path.reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, json);
}

export function getDifferences(newDoc: Record<string, unknown>, oldDoc: Record<string, unknown>): string[] {
  const checks: DifferenceConfig[] = [
    { label: 'Especialidad', path: ['especialidad'] },
    { label: 'Tasas', path: ['bloques_detectados', 'pide_tasas'], formatter: (v) => (v ? 'Sí' : 'No') },
    {
      label: 'Adaptación discapacidad',
      path: ['bloques_detectados', 'solicita_adaptacion_discapacidad'],
      formatter: (v) => (v ? 'Sí' : 'No'),
    },
    { label: 'Carnet Bombero', path: ['bloques_detectados', 'especialidad_carnet_bombero'], formatter: (v) => (v ? 'Sí' : 'No') },
    { label: 'Carnet Medicina', path: ['bloques_detectados', 'especialidad_medicina'], formatter: (v) => (v ? 'Sí' : 'No') },
    { label: 'Comentarios', path: ['comentarios'] },
  ];

  return checks
    .map((check) => {
      const oldValue = getValueFromPath(oldDoc, check.path);
      const newValue = getValueFromPath(newDoc, check.path);
      const format = check.formatter ?? ((value: unknown) => String(value ?? ''));
      if (format(oldValue) !== format(newValue)) {
        return `${check.label}: ${format(oldValue) || 'N/A'} → ${format(newValue) || 'N/A'}`;
      }
      return null;
    })
    .filter((item): item is string => Boolean(item));
}

export function compareDocuments(
  nuevoDocumento: Record<string, unknown>,
  concursos: { id?: number; nombre_archivo: string; json_datos: Record<string, unknown> }[]
): MatchResult[] {
  const nuevoTexto = flattenJson(nuevoDocumento);
  if (!nuevoTexto) return [];

  return concursos
    .map((concurso) => {
      const textoExistente = flattenJson(concurso.json_datos);
      const score = cosineSimilarity(nuevoTexto, textoExistente);
      const diferencias = getDifferences(nuevoDocumento, concurso.json_datos);
      return {
        id: concurso.id ?? 0,
        nombre_archivo: concurso.nombre_archivo,
        score,
        descripcion: extractEspecialidad(concurso.json_datos),
        diferencias,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

export function extractBooleanFilters(json: Record<string, unknown>, filters: BooleanFilters): boolean {
  const bloques = (json.bloques_detectados as Record<string, unknown> | undefined) ?? {};

  const checks: [keyof BooleanFilters, string][] = [
    ['pide_tasas', 'pide_tasas'],
    ['solicita_adaptacion_discapacidad', 'solicita_adaptacion_discapacidad'],
    ['especialidad_carnet_bombero', 'especialidad_carnet_bombero'],
    ['especialidad_medicina', 'especialidad_medicina'],
  ];

  for (const [key, path] of checks) {
    if (filters[key] === undefined) continue;
    if (Boolean(bloques[path]) !== filters[key]) return false;
  }

  return true;
}
