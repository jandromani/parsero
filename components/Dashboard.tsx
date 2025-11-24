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
  MatchResult,
  clusterConcursos,
  extractBooleanFilters,
  extractEspecialidad,
  flattenJson,
  rankSimilarConcursos,
} from '@/lib/analysis';

type FormValues = {
  nombre: string;
  apellidos: string;
  nif?: string;
  email?: string;
  especialidad?: string;
  tasas?: string;
  comentarios?: string;
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

function buildSimplePdf(lines: string[]): Blob {
  const escapedLines = lines.map((line) => line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'));
  const textContent = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', `(${escapedLines[0] ?? ''}) Tj`]
    .concat(escapedLines.slice(1).map((line) => `T* (${line}) Tj`))
    .concat(['ET'])
    .join('\n');

  const stream = `<< /Length ${textContent.length} >>\nstream\n${textContent}\nendstream\n`;
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

  const clusters = useMemo<ClusterGroup[]>(() => clusterConcursos(filteredConcursos), [filteredConcursos]);

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
    });
  }, [selectedConcurso]);

  const queueList = useMemo(() => queue, [queue]);

  const toggleFilter = (key: keyof BooleanFilters) => {
    setFilters((prev) => {
      const current = prev[key];
      const nextValue = current === undefined ? true : current === true ? false : undefined;
      return { ...prev, [key]: nextValue };
    });
  };

  const handleExportExcel = useCallback(() => {
    if (!filteredConcursos.length) return;
    const headers = ['archivo', 'fecha', 'estado', 'especialidad', 'resumen'];
    const rows = filteredConcursos.map((item) => [
      item.nombre_archivo,
      formatDate(item.fecha),
      item.estado,
      extractEspecialidad(item.json_datos),
      flattenJson(item.json_datos).slice(0, 200).replace(/\n/g, ' '),
    ]);
    const csv = [headers.join(';')]
      .concat(rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(';')))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'auditia-informe.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  }, [filteredConcursos]);

  const handleMatch = useCallback(() => {
    setMatchError(null);
    if (!newDocumentJson.trim()) {
      setMatchError('Pega un JSON para comparar.');
      return;
    }
    try {
      const parsed = JSON.parse(newDocumentJson) as Record<string, unknown>;
      const ranked = rankSimilarConcursos(parsed, concursos ?? []);
      setMatchResults(ranked);
    } catch (error) {
      setMatchError('JSON inválido. Asegúrate de que está bien formado.');
    }
  }, [concursos, newDocumentJson]);

  const handleFormSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFormMessage(null);
      if (formValues.nif && !/^\d{8}[A-Za-z]$/.test(formValues.nif)) {
        setFormMessage('El DNI/NIE no cumple el formato esperado (8 dígitos + letra).');
        return;
      }
      if (formValues.email && !/.+@.+\..+/.test(formValues.email)) {
        setFormMessage('El email no es válido.');
        return;
      }
      setFormMessage('Validación correcta. Genera el PDF para el cliente.');
    },
    [formValues]
  );

  const handleGeneratePdf = useCallback(() => {
    const lines = [
      'Solicitud AuditIA',
      `Nombre: ${formValues.nombre || '-'}`,
      `Apellidos: ${formValues.apellidos || '-'}`,
      `DNI/NIE: ${formValues.nif || '-'}`,
      `Email: ${formValues.email || '-'}`,
      `Especialidad: ${formValues.especialidad || '-'}`,
      `¿Pide tasas?: ${formValues.tasas ?? 'No'}`,
      `Comentarios: ${formValues.comentarios || 'Sin observaciones'}`,
    ];
    const blob = buildSimplePdf(lines);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'auditia-formulario.pdf';
    link.click();
    URL.revokeObjectURL(url);
  }, [formValues]);

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
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Clustering automático
          </h3>
          <p className="text-sm text-slate-500">Agrupa variantes de convocatorias similares.</p>
        </div>
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
                <li key={match.id} className="flex justify-between items-center rounded-lg border border-slate-200 p-3">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{match.nombre_archivo}</p>
                    <p className="text-xs text-slate-500">Especialidad: {match.descripcion || 'N/A'}</p>
                  </div>
                  <span className="text-sm font-semibold text-slate-700">{(match.score * 100).toFixed(1)}%</span>
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
              onChange={(e) => setFormValues((prev) => ({ ...prev, especialidad: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">¿Pide tasas?</label>
            <select
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.tasas}
              onChange={(e) => setFormValues((prev) => ({ ...prev, tasas: e.target.value }))}
            >
              <option value="Sí">Sí</option>
              <option value="No">No</option>
            </select>
          </div>
        </div>

        <form className="grid md:grid-cols-2 gap-4" onSubmit={handleFormSubmit}>
          <div>
            <label className="text-xs text-slate-500">Nombre</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.nombre}
              onChange={(e) => setFormValues((prev) => ({ ...prev, nombre: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Apellidos</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.apellidos}
              onChange={(e) => setFormValues((prev) => ({ ...prev, apellidos: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">DNI/NIE (regex)</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.nif ?? ''}
              onChange={(e) => setFormValues((prev) => ({ ...prev, nif: e.target.value }))}
              placeholder="00000000A"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500">Email</label>
            <input
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              value={formValues.email ?? ''}
              onChange={(e) => setFormValues((prev) => ({ ...prev, email: e.target.value }))}
              placeholder="correo@dominio.com"
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-slate-500">Comentarios adicionales</label>
            <textarea
              className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
              rows={3}
              value={formValues.comentarios ?? ''}
              onChange={(e) => setFormValues((prev) => ({ ...prev, comentarios: e.target.value }))}
            />
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
