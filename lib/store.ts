import { create } from 'zustand';

export type UploadJob = {
  id: string;
  fileName: string;
  status: 'pendiente' | 'procesando' | 'completado' | 'error';
  error?: string;
};

type UploadState = {
  queue: UploadJob[];
  addJob: (job: UploadJob) => void;
  updateJob: (id: string, data: Partial<UploadJob>) => void;
  clear: () => void;
};

export const useUploadStore = create<UploadState>((set) => ({
  queue: [],
  addJob: (job) => set((state) => ({ queue: [...state.queue, job] })),
  updateJob: (id, data) =>
    set((state) => ({
      queue: state.queue.map((job) => (job.id === id ? { ...job, ...data } : job)),
    })),
  clear: () => set({ queue: [] }),
}));
