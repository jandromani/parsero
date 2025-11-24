'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Upload, Loader2, FileText, RefreshCw, Filter, Download, Sparkles, Wand2 } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Concurso } from '@/lib/db';
import { useUploadStore } from '@/lib/store';
import { convertPdfToImages } from '@/lib/pdf-utils';
import { twMerge } from 'tailwind-merge';
import {
  BooleanFilters,
  ClusterGroup,
  ClusterStrategy,
  DifferenceDetail,
  MatchResult,
  clusterConcursos,
  compareDocuments,
  extractBooleanFilters,
  extractEspecialidad,
  flattenJson,
  runSimilarityBenchmarks,
} from '@/lib/analysis';

type ValidationErrorBag = Record<string, string>;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildExcelXml(headers: string[], rows: (string | number | boolean)[][]): string {
  const headerRow = `<Row>${headers
    .map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>`)
    .join('')}</Row>`;
  const dataRows = rows
    .map(
      (row) =>
        `<Row>${row
          .map((cell) => `<Cell><Data ss:Type="String">${escapeXml(String(cell))}</Data></Cell>`)
          .join('')}</Row>`
    )
    .join('');

  return `<?xml version="1.0"?>\n` +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    `<Worksheet ss:Name="Informe"><Table>${headerRow}${dataRows}</Table></Worksheet></Workbook>`;
}

function downloadBlob(content: Blob, filename: string) {
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function validateFormValues(values: FormValues, dynamicKeys: { key: string; type: 'boolean' | 'text' }[]): ValidationErrorBag {
  const errors: ValidationErrorBag = {};

  if (!values.nombre.trim()) errors.nombre = 'El nombre es obligatorio';
  if (values.nombre && values.nombre.trim().length < 2) errors.nombre = 'Introduce al menos 2 caracteres para el nombre';

  if (!values.apellidos.trim()) errors.apellidos = 'Los apellidos son obligatorios';
  if (values.apellidos && values.apellidos.trim().length < 2)
    errors.apellidos = 'Introduce al menos 2 caracteres para los apellidos';

  if (values.nif) {
    if (!/^\d{8}[A-Za-z]$/.test(values.nif)) {
      errors.nif = 'El DNI/NIE no cumple el formato esperado (8 dígitos + letra).';
    }
  }

  if (values.email) {
    if (!/.+@.+\..+/.test(values.email)) {
      errors.email = 'El email no es válido.';
    }
  } else {
    errors.email = 'El correo electrónico es obligatorio';
  }

  if (values.tasas && !['Sí', 'No'].includes(String(values.tasas))) {
    errors.tasas = 'Seleccione una opción válida para tasas';
  }

  if (values.especialidad && values.especialidad.length < 3) {
    errors.especialidad = 'La especialidad debe tener al menos 3 caracteres';
  }

  if (values.comentarios && values.comentarios.length > 500) {
    errors.comentarios = 'El comentario no debe exceder los 500 caracteres';
  }

  dynamicKeys.forEach((field) => {
    const value = values[field.key];
    if (field.type === 'text' && typeof value === 'string' && value.length > 200) {
      errors[field.key] = 'Este campo no debe superar los 200 caracteres';
    }
  });

  return errors;
}

type FormValues = {
  nombre: string;
  apellidos: string;
  nif?: string;
  email?: string;
  especialidad?: string;
  tasas?: string;
  comentarios?: string;
  [key: string]: string | boolean | undefined;
};

const columns: { key: keyof Concurso | 'especialidad' | 'acciones'; label: string }[] = [
  { key: 'nombre_archivo', label: 'Archivo' },
  { key: 'fecha', label: 'Fecha' },
  { key: 'estado', label: 'Estado' },
  { key: 'especialidad', label: 'Especialidad' },
  { key: 'acciones', label: 'Datos' },
];

const booleanFilterLabels: { key: keyof BooleanFilters; label: string }[] = [
  { key: 'pide_tasas', label: 'Piden tasas' },
  { key: 'solicita_adaptacion_discapacidad', label: 'Adaptación discapacidad' },
  { key: 'especialidad_carnet_bombero', label: 'Perfil Bomberos' },
  { key: 'especialidad_medicina', label: 'Perfil Medicina' },
];

function formatDate(value: string) {
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    return value;
  }
}

function buildStyledPdf(title: string, sections: { heading: string; lines: string[] }[]): Blob {
  const escapeLine = (line: string) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const header = escapeLine(title);
  const bodyLines = sections
    .flatMap((section) => [
      `${section.heading.toUpperCase()}:`,
      ...section.lines.map((line) => `• ${line}`),
      ' ',
    ])
    .map(escapeLine);

  const textInstructions = ['BT', '/F1 18 Tf', '18 TL', '72 740 Td', `(${header}) Tj`, '/F1 12 Tf', '0 -22 Td']
    .concat(['(-----------------------------------------------) Tj'])
    .concat(bodyLines.map((line) => `T* (${line}) Tj`))
    .concat(['ET'])
    .join('\n');

  const stream = `<< /Length ${textInstructions.length} >>\nstream\n${textInstructions}\nendstream\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n${stream}endobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((obj) => {
    offsets.push(pdf.length);
    pdf += obj;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.forEach((offset) => {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Blob([pdf], { type: 'application/pdf' });
}

export function Dashboard() {
  const concursos = useLiveQuery(() => db.concursos.toArray(), []);
  const { queue, addJob, updateJob, clear } = useUploadStore();
  const [isDragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<BooleanFilters>({});
  const [newDocumentJson, setNewDocumentJson] = useState('');
  const [matchResults, setMatchResults] = useState<MatchResult[]>([]);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [selectedConcursoId, setSelectedConcursoId] = useState<number | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({ nombre: '', apellidos: '', tasas: 'No' });
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [similarityThreshold, setSimilarityThreshold] = useState(0.6);
  const [clusterStrategy, setClusterStrategy] = useState<ClusterStrategy>('threshold');
  const [benchmarkSummary, setBenchmarkSummary] = useState<string>('');
  const [isBenchmarking, setIsBenchmarking] = useState(false);

  useEffect(() => {
    if (concursos?.length && selectedConcursoId === null) {
      setSelectedConcursoId(concursos[0].id ?? null);
    }
  }, [concursos, selectedConcursoId]);

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer.files).filter((f) => f.type === 'application/pdf');
      await processFiles(files);
    },
    []
  );

  const onInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((f) => f.type === 'application/pdf');
    await processFiles(files);
    event.target.value = '';
  }, []);

  const processFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        addJob({ id, fileName: file.name, status: 'pendiente' });
        try {
          updateJob(id, { status: 'procesando' });
          const imagesBase64 = await convertPdfToImages(file);

          const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imagesBase64 }),
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data?.error ?? 'Error procesando archivo');
          }

          const content = data?.choices?.[0]?.message?.content ?? data;
          const parsedContent =
            typeof content === 'string'
              ? (JSON.parse(content) as Record<string, unknown>)
              : (content as Record<string, unknown>);

          await db.concursos.add({
            nombre_archivo: file.name,
            fecha: new Date().toISOString(),
            json_datos: parsedContent,
            estado: 'procesado',
          });
          updateJob(id, { status: 'completado' });
        } catch (error) {
          console.error('Upload error', error);
          updateJob(id, { status: 'error', error: error instanceof Error ? error.message : 'Error' });
          await db.concursos.add({
            nombre_archivo: file.name,
            fecha: new Date().toISOString(),
            json_datos: {},
            estado: 'error',
          });
        }
      }
    },
    [addJob, updateJob]
  );

  const stateBadge = useCallback((estado: Concurso['estado']) => {
    const classes = twMerge(
      'px-2 py-1 rounded-full text-xs font-semibold',
      estado === 'procesado' && 'bg-green-100 text-green-800',
      estado === 'pendiente' && 'bg-yellow-100 text-yellow-800',
      estado === 'error' && 'bg-red-100 text-red-800'
    );
    return <span className={classes}>{estado}</span>;
  }, []);

  const filteredConcursos = useMemo(() => {
    if (!concursos) return [];
    return concursos.filter((item) => {
      const matchesSearch = flattenJson(item.json_datos).includes(search.toLowerCase()) ||
        item.nombre_archivo.toLowerCase().includes(search.toLowerCase());
      const matchesFlags = extractBooleanFilters(item.json_datos, filters);
      return matchesSearch && matchesFlags;
    });
  }, [concursos, filters, search]);

  const clusters = useMemo<ClusterGroup[]>(
    () => clusterConcursos(filteredConcursos, { similarityThreshold, strategy: clusterStrategy }),
    [clusterStrategy, filteredConcursos, similarityThreshold]
  );

  const selectedConcurso = useMemo(
    () => filteredConcursos.find((c) => c.id === selectedConcursoId) ?? concursos?.find((c) => c.id === selectedConcursoId),
    [concursos, filteredConcursos, selectedConcursoId]
  );

  useEffect(() => {
    if (!selectedConcurso) return;
    const datosSolicitante = (selectedConcurso.json_datos as Record<string, any>).datos_solicitante ?? {};
    const bloques = (selectedConcurso.json_datos as Record<string, any>).bloques_detectados ?? {};
    setFormValues({
      nombre: datosSolicitante.nombre ?? '',
      apellidos: datosSolicitante.apellidos ?? '',
      nif: datosSolicitante.nif_nie ?? '',
      email: datosSolicitante.email ?? '',
      especialidad: extractEspecialidad(selectedConcurso.json_datos),
      tasas: bloques.pide_tasas ? 'Sí' : 'No',
      comentarios: '',
      pide_tasas: Boolean(bloques.pide_tasas),
      solicita_adaptacion_discapacidad: Boolean(bloques.solicita_adaptacion_discapacidad),
      especialidad_carnet_bombero: Boolean(bloques.especialidad_carnet_bombero),
      especialidad_medicina: Boolean(bloques.especialidad_medicina),
      pide_titulacion: bloques.pide_titulacion ?? '',
      requisitos_experiencia: bloques.requisitos_experiencia ?? '',
    });
    setFormErrors({});
  }, [selectedConcurso]);

  const queueList = useMemo(() => queue, [queue]);

  const dynamicFields = useMemo(
    () => {
      const bloques = (selectedConcurso?.json_datos as Record<string, any>)?.bloques_detectados ?? {};
      return [
        { key: 'pide_tasas', label: '¿Pide tasas?', type: 'boolean' as const },
        { key: 'solicita_adaptacion_discapacidad', label: '¿Solicita adaptación por discapacidad?', type: 'boolean' as const },
        { key: 'especialidad_carnet_bombero', label: 'Carnet de bombero', type: 'boolean' as const },
        { key: 'especialidad_medicina', label: 'Carnet de medicina', type: 'boolean' as const },
        { key: 'pide_titulacion', label: 'Titulación requerida', type: 'text' as const },
        { key: 'requisitos_experiencia', label: 'Requisitos de experiencia', type: 'text' as const },
      ].filter((field) => field.type === 'boolean' || bloques[field.key] !== undefined);
    },
    [selectedConcurso]
  );

  const setFieldValue = (key: string, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
    setFormErrors((prev) => {
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const toggleFilter = (key: keyof BooleanFilters) => {
    setFilters((prev) => {
      const current = prev[key];
      const nextValue = current === undefined ? true : current === true ? false : undefined;
      return { ...prev, [key]: nextValue };
    });
  };

  const handleExportExcel = useCallback(() => {
    if (!filteredConcursos.length) return;

    const headers = [
      'Archivo',
      'Fecha',
      'Estado',
      'Especialidad',
      'Descripción',
      'Tasas',
      'Adaptación discapacidad',
      'Carnet de bombero',
      'Carnet de medicina',
      'Comentarios',
    ];

    const rows = filteredConcursos.map((item) => {
      const bloques = (item.json_datos as Record<string, any>).bloques_detectados ?? {};
      const descripcion = flattenJson(item.json_datos).slice(0, 200).replace(/\n/g, ' ');
      const comentarios = (item.json_datos as Record<string, any>).comentarios ?? 'Sin comentarios';
      return [
        item.nombre_archivo,
        formatDate(item.fecha),
        item.estado,
        extractEspecialidad(item.json_datos) || 'Sin especialidad',
        descripcion,
        bloques.pide_tasas ? 'Sí' : 'No',
        bloques.solicita_adaptacion_discapacidad ? 'Sí' : 'No',
        bloques.especialidad_carnet_bombero ? 'Sí' : 'No',
        bloques.especialidad_medicina ? 'Sí' : 'No',
        comentarios,
      ];
    });

    const xml = buildExcelXml(headers, rows);
    const blob = new Blob([xml], {
      type: 'application/vnd.ms-excel;charset=utf-8;',
    });
    downloadBlob(blob, 'auditia-informe.xlsx');
  }, [filteredConcursos]);

  const handleMatch = useCallback(() => {
    setMatchError(null);
    if (!newDocumentJson.trim()) {
      setMatchError('Pega un JSON para comparar.');
      return;
    }
    try {
      const parsed = JSON.parse(newDocumentJson) as Record<string, unknown>;
      const ranked = compareDocuments(parsed, concursos ?? []);
      setMatchResults(ranked);
    } catch (error) {
      setMatchError('JSON inválido. Asegúrate de que está bien formado.');
    }
  }, [concursos, newDocumentJson]);

  const handleFormSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const errors = validateFormValues(
        formValues,
        dynamicFields.map((field) => ({ key: field.key, type: field.type }))
      );

      setFormErrors(errors);
      if (Object.keys(errors).length > 0) {
        setFormMessage('Revisa los errores antes de continuar.');
        return;
      }

      setFormMessage('Validación correcta. Genera el PDF para el cliente.');
    },
    [dynamicFields, formValues]
  );

  const handleGeneratePdf = useCallback(() => {
    const errors = validateFormValues(
      formValues,
      dynamicFields.map((field) => ({ key: field.key, type: field.type }))
    );
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      setFormMessage('Revisa los errores antes de generar el PDF.');
      return;
    }

    const fieldLines = dynamicFields.map((field) => {
      const value = formValues[field.key];
      const label = field.label;
      if (typeof value === 'boolean') return `${label}: ${value ? 'Sí' : 'No'}`;
      return `${label}: ${value ?? '-'}`;
    });

    const sections = [
      {
        heading: 'Datos de contacto',
        lines: [
          `Nombre: ${formValues.nombre || '-'}`,
          `Apellidos: ${formValues.apellidos || '-'}`,
          `DNI/NIE: ${formValues.nif || '-'}`,
          `Email: ${formValues.email || '-'}`,
        ],
      },
      {
        heading: 'Convocatoria detectada',
        lines: [
          `Especialidad: ${formValues.especialidad || '-'}`,
          `¿Pide tasas?: ${formValues.tasas ?? 'No'}`,
          ...fieldLines,
        ],
      },
      {
        heading: 'Comentarios',
        lines: [formValues.comentarios || 'Sin observaciones'],
      },
      {
        heading: 'Generado',
        lines: [`Fecha: ${new Date().toLocaleString()}`],
      },
    ];
    const blob = buildStyledPdf('Solicitud AuditIA', sections);
    downloadBlob(blob, 'auditia-formulario.pdf');
  }, [dynamicFields, formValues]);

  const handleBenchmark = useCallback(() => {
    if (!filteredConcursos.length) {
      setBenchmarkSummary('Carga algunos documentos para medir el clustering.');
      return;
    }
    setIsBenchmarking(true);
    const thresholds = [Math.max(0.3, similarityThreshold - 0.1), similarityThreshold, Math.min(0.9, similarityThreshold + 0.1)];
    const results = runSimilarityBenchmarks(filteredConcursos, thresholds, clusterStrategy);
    const summary = results
      .map((item) => `${(item.threshold * 100).toFixed(0)}% → ${item.clusters} grupos en ${item.durationMs.toFixed(1)}ms`)
      .join(' | ');
    setBenchmarkSummary(summary);
    setIsBenchmarking(false);
  }, [clusterStrategy, filteredConcursos, similarityThreshold]);

  const renderDifferences = (differences?: DifferenceDetail[]) => {
    if (!differences || differences.length === 0) {
      return <p className="text-xs text-slate-400">Sin diferencias clave detectadas.</p>;
    }

    return (
      <ul className="mt-2 space-y-1">
        {differences.map((diff) => (
          <li key={diff.label} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="px-2 py-1 bg-slate-100 text-slate-700 rounded-full font-semibold">{diff.label}</span>
            <span className="line-through text-red-600">{diff.previous}</span>
            <span className="text-slate-400">→</span>
            <span className="text-green-700 font-semibold">{diff.current}</span>
          </li>
        ))}
      </ul>
    );
  };

  const renderCluster = (cluster: ClusterGroup) => (
    <div key={cluster.label} className="rounded-lg border border-slate-200 p-4 bg-slate-50">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-slate-800">{cluster.label || 'Sin etiqueta'}</p>
        <span className="text-xs bg-slate-200 text-slate-700 px-2 py-1 rounded-full">{cluster.size} docs</span>
      </div>
      <p className="text-xs text-slate-500 mt-2">Ejemplos: {cluster.ejemplos.join(', ') || 'N/A'}</p>
    </div>
  );

  return (
    <main className="container-grid py-10 space-y-6">
      <section className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm text-slate-600">Carga y extracción inteligente</p>
            <h1 className="text-2xl font-semibold">AuditIA</h1>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <RefreshCw className="h-4 w-4" />
            IndexedDB local-first
          </div>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={twMerge(
            'flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl p-8 text-center transition bg-white',
            isDragging ? 'border-sky-400 bg-sky-50' : 'border-slate-200'
          )}
        >
          <Upload className="h-10 w-10 text-slate-400" />
          <p className="text-lg font-medium text-slate-700">Arrastra tus formularios PDF aquí</p>
          <p className="text-sm text-slate-500">Se procesan todas las páginas con IA y se guardan en tu navegador.</p>
          <label className="inline-flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm rounded-lg cursor-pointer hover:bg-slate-800">
            <input type="file" accept="application/pdf" multiple className="hidden" onChange={onInputChange} />
            Seleccionar archivos
          </label>
        </div>

        {queueList.length > 0 && (
          <div className="mt-6 space-y-2">
            <div className="flex justify-between items-center text-sm text-slate-500">
              <span>Cola de procesamiento</span>
              <button
                type="button"
                className="text-slate-600 hover:text-slate-800"
                onClick={() => clear()}
              >
                Limpiar
              </button>
            </div>
            <div className="space-y-2">
              {queueList.map((job) => (
                <div key={job.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 bg-slate-50">
                  <div>
                    <p className="text-sm font-medium text-slate-700">{job.fileName}</p>
                    {job.error ? (
                      <p className="text-xs text-red-600">{job.error}</p>
                    ) : (
                      <p className="text-xs text-slate-500">{job.status}</p>
                    )}
                  </div>
                  {job.status === 'procesando' && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
                  {job.status === 'error' && <RefreshCw className="h-4 w-4 text-red-500" />}
                  {job.status === 'completado' && <FileText className="h-4 w-4 text-green-600" />}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Inventario y filtros avanzados</h2>
            <p className="text-sm text-slate-500">Busqueda por texto y banderas de bloques detectados.</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-slate-200 hover:bg-slate-50"
            >
              <Download className="h-4 w-4" /> Exportar Excel
            </button>
            <div className="relative">
              <input
                className="pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring focus:ring-sky-200"
                placeholder="Buscar por nombre, especialidad..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Filter className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {booleanFilterLabels.map((item) => {
            const value = filters[item.key];
            const label = value === undefined ? 'Todos' : value ? 'Sí' : 'No';
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => toggleFilter(item.key)}
                className={twMerge(
                  'text-xs px-3 py-2 rounded-full border transition',
                  value === undefined && 'border-slate-200 text-slate-600 bg-white',
                  value === true && 'border-green-200 bg-green-50 text-green-700',
                  value === false && 'border-amber-200 bg-amber-50 text-amber-700'
                )}
              >
                {item.label}: {label}
              </button>
            );
          })}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key} className="py-2 pr-4">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredConcursos.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="py-3 pr-4 font-medium text-slate-800">{item.nombre_archivo}</td>
                  <td className="py-3 pr-4 text-slate-600">{formatDate(item.fecha)}</td>
                  <td className="py-3 pr-4">{stateBadge(item.estado)}</td>
                  <td className="py-3 pr-4 text-slate-700">{extractEspecialidad(item.json_datos) || 'Sin especialidad'}</td>
                  <td className="py-3 pr-4">
                    <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-3 max-h-44 overflow-auto">
                      {JSON.stringify(item.json_datos, null, 2)}
                    </pre>
                  </td>
                </tr>
              ))}
              {filteredConcursos.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="py-6 text-center text-slate-500">
                    No hay registros que coincidan con el filtro.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Clustering automático
          </h3>
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
            <span className="flex items-center gap-2">
              Umbral: {(similarityThreshold * 100).toFixed(0)}%
              <input
                type="range"
                min={0.3}
                max={0.9}
                step={0.05}
                value={similarityThreshold}
                onChange={(e) => setSimilarityThreshold(Number(e.target.value))}
              />
            </span>
            <label className="flex items-center gap-2">
              Estrategia
              <select
                className="border border-slate-200 rounded px-2 py-1 bg-white"
                value={clusterStrategy}
                onChange={(e) => setClusterStrategy(e.target.value as ClusterStrategy)}
              >
                <option value="threshold">Umbral (rápido)</option>
                <option value="kmeans">K-means (agrupa por centroides)</option>
              </select>
            </label>
            <button
              type="button"
              onClick={handleBenchmark}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              {isBenchmarking ? 'Midiendo...' : 'Benchmark'}
            </button>
          </div>
        </div>
        {benchmarkSummary && <p className="text-xs text-slate-500">{benchmarkSummary}</p>}
        <div className="grid md:grid-cols-2 gap-3">
          {clusters.map((cluster) => renderCluster(cluster))}
          {clusters.length === 0 && <p className="text-sm text-slate-500">No hay datos para agrupar todavía.</p>}
        </div>
      </section>

      <section className="card space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Wand2 className="h-4 w-4" /> Nuevo ingreso y matching
          </h3>
          <p className="text-sm text-slate-500">Compara un JSON nuevo contra el histórico.</p>
        </div>
        <textarea
          className="w-full border border-slate-200 rounded-lg p-3 text-sm font-mono"
          rows={5}
          placeholder='Pega aquí el JSON del nuevo documento'
          value={newDocumentJson}
          onChange={(e) => setNewDocumentJson(e.target.value)}
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleMatch}
            className="px-4 py-2 text-sm rounded-lg bg-slate-900 text-white hover:bg-slate-800"
          >
            Ejecutar comparador
          </button>
        </div>
        {matchError && <p className="text-sm text-red-600">{matchError}</p>}
        {matchResults.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-700">Coincidencias encontradas:</p>
            <ul className="space-y-2">
              {matchResults.map((match) => (
                <li key={match.id} className="flex justify-between items-start rounded-lg border border-slate-200 p-3 gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-800">{match.nombre_archivo}</p>
                    <p className="text-xs text-slate-500">Especialidad: {match.descripcion || 'N/A'}</p>
                    {renderDifferences(match.diferencias?.slice(0, 4))}
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-slate-700">{(match.score * 100).toFixed(1)}%</span>
                    <p className="text-[11px] text-slate-500">Similitud</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800">Generador dinámico + validación</h3>
          <p className="text-sm text-slate-500">Construye el formulario según lo que detectó la IA.</p>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-slate-500">Selecciona un registro</label>
            <select
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={selectedConcursoId ?? ''}
              onChange={(e) => setSelectedConcursoId(Number(e.target.value))}
            >
              {(concursos ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.nombre_archivo}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500">Especialidad detectada</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.especialidad ?? ''}
              onChange={(e) => setFieldValue('especialidad', e.target.value)}
            />
            {formErrors.especialidad && <p className="text-xs text-red-600 mt-1">{formErrors.especialidad}</p>}
          </div>
          <div>
            <label className="text-xs text-slate-500">¿Pide tasas?</label>
            <select
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.tasas}
              onChange={(e) => setFieldValue('tasas', e.target.value)}
            >
              <option value="Sí">Sí</option>
              <option value="No">No</option>
            </select>
            {formErrors.tasas && <p className="text-xs text-red-600 mt-1">{formErrors.tasas}</p>}
          </div>
        </div>

        <form className="grid md:grid-cols-2 gap-4" onSubmit={handleFormSubmit}>
          <div>
            <label className="text-xs text-slate-500">Nombre</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.nombre}
              onChange={(e) => setFieldValue('nombre', e.target.value)}
            />
            {formErrors.nombre && <p className="text-xs text-red-600 mt-1">{formErrors.nombre}</p>}
          </div>
          <div>
            <label className="text-xs text-slate-500">Apellidos</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.apellidos}
              onChange={(e) => setFieldValue('apellidos', e.target.value)}
            />
            {formErrors.apellidos && <p className="text-xs text-red-600 mt-1">{formErrors.apellidos}</p>}
          </div>
          <div>
            <label className="text-xs text-slate-500">DNI/NIE (regex)</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.nif ?? ''}
              onChange={(e) => setFieldValue('nif', e.target.value)}
              placeholder="00000000A"
            />
            {formErrors.nif && <p className="text-xs text-red-600 mt-1">{formErrors.nif}</p>}
          </div>
          <div>
            <label className="text-xs text-slate-500">Email</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.email ?? ''}
              onChange={(e) => setFieldValue('email', e.target.value)}
              placeholder="correo@dominio.com"
            />
            {formErrors.email && <p className="text-xs text-red-600 mt-1">{formErrors.email}</p>}
          </div>
          {dynamicFields.length > 0 && (
            <div className="md:col-span-2 grid md:grid-cols-2 gap-4 bg-slate-50 border border-slate-200 rounded-lg p-4">
              {dynamicFields.map((field) => (
                <label key={field.key} className="block text-xs text-slate-600">
                  {field.label}
                  {field.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      className="ml-2 h-4 w-4 align-middle"
                      checked={Boolean(formValues[field.key])}
                      onChange={(e) => setFieldValue(field.key, e.target.checked)}
                    />
                  ) : (
                    <input
                      className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                      value={String(formValues[field.key] ?? '')}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                    />
                  )}
                  {formErrors[field.key] && <p className="text-xs text-red-600 mt-1">{formErrors[field.key]}</p>}
                </label>
              ))}
            </div>
          )}
          <div className="md:col-span-2">
            <label className="text-xs text-slate-500">Comentarios adicionales</label>
            <textarea
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              rows={3}
              value={formValues.comentarios ?? ''}
              onChange={(e) => setFieldValue('comentarios', e.target.value)}
            />
            {formErrors.comentarios && <p className="text-xs text-red-600 mt-1">{formErrors.comentarios}</p>}
          </div>
          <div className="md:col-span-2 flex items-center gap-3">
            <button
              type="submit"
              className="px-4 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-800"
            >
              Validar datos
            </button>
            <button
              type="button"
              onClick={handleGeneratePdf}
              className="px-4 py-2 text-sm rounded-lg border border-slate-200 hover:bg-slate-50"
            >
              Descargar PDF
            </button>
            {formMessage && <span className="text-sm text-slate-600">{formMessage}</span>}
          </div>
        </form>
      </section>
    </main>
  );
}
