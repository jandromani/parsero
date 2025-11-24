import * as pdfjsLib from 'pdfjs-dist';

const workerSrc = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

if (typeof window !== 'undefined' && 'Worker' in window) {
  // @ts-expect-error - pdfjs type does not expose workerSrc correctly in ESM
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
}

export async function convertPdfToImage(file: File): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('PDF conversion must run in the browser');
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);

  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('No canvas context available');
  }

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: context, viewport }).promise;
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl;
}
