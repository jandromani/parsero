import Dexie, { type Table } from 'dexie';

export type Concurso = {
  id?: number;
  nombre_archivo: string;
  fecha: string;
  json_datos: Record<string, unknown>;
  estado: 'pendiente' | 'procesado' | 'error';
};

class AuditDB extends Dexie {
  concursos!: Table<Concurso, number>;

  constructor() {
    super('AuditDB');
    this.version(1).stores({
      concursos: '++id, nombre_archivo, fecha, estado',
    });
  }
}

export const db = new AuditDB();
