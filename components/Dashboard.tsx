'use client';

import { useCallback, useMemo, useState } from 'react';
import { Upload, Loader2, FileText, RefreshCw } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Concurso } from '@/lib/db';
import { useUploadStore } from '@/lib/store';
import { convertPdfToImage } from '@/lib/pdf-utils';
import { twMerge } from 'tailwind-merge';

const columns: { key: keyof Concurso | 'acciones'; label: string }[] = [
  { key: 'nombre_archivo', label: 'Archivo' },
  { key: 'fecha', label: 'Fecha' },
  { key: 'estado', label: 'Estado' },
  { key: 'acciones', label: 'Datos' },
];

export function Dashboard() {
  const concursos = useLiveQuery(() => db.concursos.toArray(), []);
  const { queue, addJob, updateJob, clear } = useUploadStore();
  const [isDragging, setDragging] = useState(false);

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
          const imageBase64 = await convertPdfToImage(file);

          const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64 }),
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

  const queueList = useMemo(() => queue, [queue]);

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
          <p className="text-sm text-slate-500">Se procesa solo la primera página con IA y se guarda en tu navegador.</p>
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

      <section className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-slate-800">Resultados en IndexedDB</h2>
          <span className="text-sm text-slate-500">{concursos?.length ?? 0} registros</span>
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
              {concursos?.map((item) => (
                <tr key={item.id}>
                  <td className="py-3 pr-4 font-medium text-slate-800">{item.nombre_archivo}</td>
                  <td className="py-3 pr-4 text-slate-600">{new Date(item.fecha).toLocaleString()}</td>
                  <td className="py-3 pr-4">{stateBadge(item.estado)}</td>
                  <td className="py-3 pr-4">
                    <pre className="text-xs bg-slate-900 text-slate-100 rounded-lg p-3 max-h-44 overflow-auto">
                      {JSON.stringify(item.json_datos, null, 2)}
                    </pre>
                  </td>
                </tr>
              ))}
              {concursos?.length === 0 && (
                <tr>
                  <td colSpan={columns.length} className="py-6 text-center text-slate-500">
                    No hay registros aún.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
