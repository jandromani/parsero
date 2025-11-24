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

export type DifferenceDetail = {
  label: string;
  previous: string;
  current: string;
};

export type MatchResult = {
  id: number;
  nombre_archivo: string;
  score: number;
  descripcion?: string;
  diferencias?: DifferenceDetail[];
};

export type ClusterStrategy = 'threshold' | 'kmeans';

type ClusterOptions = {
  similarityThreshold?: number;
  strategy?: ClusterStrategy;
  maxIterations?: number;
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

type TextVector = {
  resumen: string;
  tokens: Map<string, number>;
};

function vectorizeText(text: string): TextVector {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  tokens.forEach((token) => freq.set(token, (freq.get(token) ?? 0) + 1));
  return { resumen: text, tokens: freq };
}

function cosineSimilarityFromVectors(a: TextVector, b: TextVector): number {
  const allTokens = new Set([...a.tokens.keys(), ...b.tokens.keys()]);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const token of allTokens) {
    const aVal = a.tokens.get(token) ?? 0;
    const bVal = b.tokens.get(token) ?? 0;
    dot += aVal * bVal;
    magA += aVal * aVal;
    magB += bVal * bVal;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function cosineSimilarity(a: string, b: string): number {
  return cosineSimilarityFromVectors(vectorizeText(a), vectorizeText(b));
}

function buildLabelFromTokens(vector: TextVector, fallback: string): string {
  const sortedTokens = [...vector.tokens.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map((entry) => entry[0]);
  if (sortedTokens.length === 0) return fallback;
  return sortedTokens.join(' ');
}

function clusterByThreshold(
  items: { id?: number; nombre_archivo: string; vector: TextVector }[],
  similarityThreshold: number
): ClusterGroup[] {
  const clusters: (ClusterGroup & { vector: TextVector })[] = [];

  items.forEach((item) => {
    let targetCluster: (ClusterGroup & { vector: TextVector }) | undefined;

    for (const cluster of clusters) {
      const sim = cosineSimilarityFromVectors(cluster.vector, item.vector);
      if (sim >= similarityThreshold) {
        targetCluster = cluster;
        break;
      }
    }

    if (!targetCluster) {
      targetCluster = {
        label: buildLabelFromTokens(item.vector, item.vector.resumen || 'Sin clasificar'),
        size: 0,
        ids: [],
        ejemplos: [],
        vector: item.vector,
      };
      clusters.push(targetCluster);
    }

    targetCluster.size += 1;
    if (item.id !== undefined) targetCluster.ids.push(item.id);
    if (targetCluster.ejemplos.length < 3) {
      targetCluster.ejemplos.push(item.nombre_archivo);
    }
  });

  return clusters
    .map(({ vector: _vector, ...rest }) => rest)
    .sort((a, b) => b.size - a.size);
}

function averageVectors(vectors: TextVector[]): TextVector {
  const accumulator = new Map<string, number>();

  vectors.forEach((vector) => {
    vector.tokens.forEach((value, key) => {
      accumulator.set(key, (accumulator.get(key) ?? 0) + value);
    });
  });

  const averaged = new Map<string, number>();
  accumulator.forEach((value, key) => {
    averaged.set(key, value / vectors.length);
  });

  return { resumen: '', tokens: averaged };
}

function clusterWithKMeans(
  items: { id?: number; nombre_archivo: string; vector: TextVector }[],
  iterations = 5
): ClusterGroup[] {
  if (items.length === 0) return [];
  const k = Math.max(1, Math.min(8, Math.round(Math.sqrt(items.length / 2))));
  const centroids = items.slice(0, k).map((item) => item.vector);

  let assignments: number[] = new Array(items.length).fill(0);

  for (let iter = 0; iter < iterations; iter += 1) {
    let changed = false;

    assignments = items.map((item, idx) => {
      let best = 0;
      let bestScore = -Infinity;
      centroids.forEach((centroid, cIdx) => {
        const score = cosineSimilarityFromVectors(item.vector, centroid);
        if (score > bestScore) {
          bestScore = score;
          best = cIdx;
        }
      });
      if (best !== assignments[idx]) changed = true;
      return best;
    });

    if (!changed) break;

    const grouped = new Map<number, TextVector[]>();
    assignments.forEach((clusterIndex, idx) => {
      const current = grouped.get(clusterIndex) ?? [];
      current.push(items[idx].vector);
      grouped.set(clusterIndex, current);
    });

    grouped.forEach((vectors, clusterIndex) => {
      if (vectors.length > 0) centroids[clusterIndex] = averageVectors(vectors);
    });
  }

  const clusterMap = new Map<number, ClusterGroup>();
  assignments.forEach((clusterIndex, idx) => {
    const item = items[idx];
    const cluster = clusterMap.get(clusterIndex) ?? {
      label: buildLabelFromTokens(centroids[clusterIndex], item.vector.resumen || 'Cluster'),
      size: 0,
      ids: [],
      ejemplos: [],
    };
    cluster.size += 1;
    if (item.id !== undefined) cluster.ids.push(item.id);
    if (cluster.ejemplos.length < 3) cluster.ejemplos.push(item.nombre_archivo);
    clusterMap.set(clusterIndex, cluster);
  });

  return [...clusterMap.values()].sort((a, b) => b.size - a.size);
}

export function clusterConcursos(
  concursos: { id?: number; nombre_archivo: string; json_datos: Record<string, unknown> }[],
  similarityThresholdOrOptions: number | ClusterOptions = 0.6,
  legacyStrategy?: ClusterStrategy
): ClusterGroup[] {
  const options: ClusterOptions =
    typeof similarityThresholdOrOptions === 'number'
      ? { similarityThreshold: similarityThresholdOrOptions, strategy: legacyStrategy }
      : similarityThresholdOrOptions;

  const similarityThreshold = options.similarityThreshold ?? 0.6;
  const strategy = options.strategy ?? 'threshold';
  const iterations = options.maxIterations ?? 5;

  const items = concursos.map((concurso) => {
    const texto = extractEspecialidad(concurso.json_datos) || concurso.nombre_archivo;
    const resumen = texto || flattenJson(concurso.json_datos);
    return {
      id: concurso.id,
      nombre_archivo: concurso.nombre_archivo,
      vector: vectorizeText(resumen),
    };
  });

  if (strategy === 'kmeans' && items.length > 2) {
    return clusterWithKMeans(items, iterations);
  }

  return clusterByThreshold(items, similarityThreshold);
}

export function runSimilarityBenchmarks(
  concursos: { id?: number; nombre_archivo: string; json_datos: Record<string, unknown> }[],
  thresholds: number[],
  strategy: ClusterStrategy = 'threshold'
): { threshold: number; durationMs: number; clusters: number }[] {
  return thresholds.map((threshold) => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const groups = clusterConcursos(concursos, { similarityThreshold: threshold, strategy });
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return { threshold, durationMs: end - start, clusters: groups.length };
  });
}

export function runAdvancedPerformanceTests(
  concursos: { id?: number; nombre_archivo: string; json_datos: Record<string, unknown> }[]
): { strategy: ClusterStrategy; threshold: number; durationMs: number; clusters: number }[] {
  const thresholds = [0.4, 0.5, 0.6, 0.7];
  const strategies: ClusterStrategy[] = ['threshold', 'kmeans'];
  const results: { strategy: ClusterStrategy; threshold: number; durationMs: number; clusters: number }[] = [];

  thresholds.forEach((threshold) => {
    strategies.forEach((strategy) => {
      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const clusters = clusterConcursos(concursos, { similarityThreshold: threshold, strategy });
      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const durationMs = endTime - startTime;
      results.push({ strategy, threshold, durationMs, clusters: clusters.length });
      // eslint-disable-next-line no-console
      console.log(
        `Cluster Strategy: ${strategy}, Threshold: ${(threshold * 100).toFixed(0)}%, Duration: ${durationMs.toFixed(
          2
        )}ms, Clusters: ${clusters.length}`
      );
    });
  });

  return results;
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

export function getDifferences(newDoc: Record<string, unknown>, oldDoc: Record<string, unknown>): DifferenceDetail[] {
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
        return {
          label: check.label,
          previous: format(oldValue) || 'N/A',
          current: format(newValue) || 'N/A',
        };
      }
      return null;
    })
    .filter((item): item is DifferenceDetail => Boolean(item));
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
