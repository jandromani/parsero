// lib/pdf-utils.ts
import * as pdfjsLib from 'pdfjs-dist';

// Configuración del worker (igual que antes)
const workerSrc = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
if (typeof window !== 'undefined' && 'Worker' in window) {
  // @ts-expect-error - pdfjs type definition issue
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
}

export async function convertPdfToImages(file: File): Promise<string[]> {
  if (typeof window === 'undefined') {
    throw new Error('PDF conversion must run in the browser');
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  const images: string[] = [];

  // BUCLE: Recorremos TODAS las páginas, no solo la 1
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 }); // Escala 1.5 para buena resolución (OCR)
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) continue;

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: context, viewport }).promise;
    
    // Convertir a base64 y limpiar cabecera para enviar limpio si fuera necesario, 
    // pero para dataURI standard lo dejamos completo.
    images.push(canvas.toDataURL('image/png'));
  }

  return images;
}