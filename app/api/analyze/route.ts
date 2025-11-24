import { NextResponse } from 'next/server';

type AnalyzeRequestBody = {
  imageBase64: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as AnalyzeRequestBody;
    if (!body?.imageBase64) {
      return NextResponse.json({ error: 'imageBase64 is required' }, { status: 400 });
    }

    const completion = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Eres un experto administrativo. Devuelve JSON.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extrae requisitos y datos del solicitante del formulario en la imagen.' },
              { type: 'image_url', image_url: { url: body.imageBase64 } },
            ],
          },
        ],
      }),
    });

    if (!completion.ok) {
      const errorText = await completion.text();
      return NextResponse.json({ error: errorText }, { status: completion.status });
    }

    const result = await completion.json();
    return NextResponse.json(result);
  } catch (error) {
    console.error('Analyze error', error);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
