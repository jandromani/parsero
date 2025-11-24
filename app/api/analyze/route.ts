// app/api/analyze/route.ts
import { NextResponse } from 'next/server';

// Aumentamos el límite de tamaño por si son muchas páginas
export const maxDuration = 60; 

export async function POST(request: Request) {
  try {
    const { imagesBase64 } = await request.json(); // Ahora esperamos un array

    if (!imagesBase64 || !Array.isArray(imagesBase64) || imagesBase64.length === 0) {
      return NextResponse.json({ error: 'No images provided' }, { status: 400 });
    }

    // Construimos el contenido del mensaje MULTIMODAL
    // Primero el texto de instrucciones, luego TODAS las imágenes en orden
const userContent = [
      { 
        type: 'text', 
        text: `Analiza este documento oficial COMPLETO (te paso todas las páginas en orden).
        
        TU MISIÓN: Inventariar todas las características del formulario administrativo. Extrae todos los detalles posibles de cada sección, asegurándote de que no falte ningún dato.

        IMPORTANTE:
        - La información está distribuida en varias secciones numeradas o con casillas (☐) de verificación.
        - Cada formulario contiene múltiples secciones, por ejemplo: Datos de la convocatoria, Turno de acceso, Datos del solicitante, Requisitos, Tasas, Documentación requerida, Adaptaciones solicitadas, y Firma.
        - Las secciones numéricas son claves, como: "1.- Datos de la convocatoria", "6.- Requisitos de la convocatoria", "7.- Tasa por derecho de examen", etc.
        - Si encuentras casillas (☐) para "Exención por discapacidad", "Exención por terrorismo" o "Exención por violencia de género", ponlo a TRUE si está marcado.

        **Asegúrate de extraer estos bloques de datos completos:**

        1. **Datos de la Convocatoria:**
           - Número de convocatoria, código de especialidad y descripción.
           - Fecha de publicación en B.O.C.M. y referencia interna.
           - Orden de la convocatoria, código de cuerpo/escala/especialidad.

        2. **Turno de Acceso:**
           - Indicar si es "Turno libre" o cualquier otro tipo de acceso, o si existe alguna exención.

        3. **Datos del Solicitante:**
           - Nombre, apellidos, NIF/NIE.
           - Dirección completa (vía, número, piso, puerta, municipio, provincia, código postal).
           - Teléfonos (1 y 2), email.
           - Fecha de nacimiento, sexo, nacionalidad.
           - Si se solicita alguna condición especial (ej. discapacidad o adaptación).

        4. **Datos del Representante (si aplica):**
           - Nombre, NIF/NIE, razón social.
           - Dirección completa, contacto (teléfonos y email).
           - En caso de ser representante, incluye la autorización correspondiente.

        5. **Medio de Notificación:**
           - Especificar si la notificación será al interesado o al representante.

        6. **Requisitos de la Convocatoria:**
           - Titulación exigida.
           - Experiencia sustitutoria (si aplica).
           - Antigüedad o requisitos adicionales (ej. antigüedad en cuerpos o escalas).

        7. **Tasas por Derecho de Examen:**
           - Si el pago es total o parcial.
           - Detallar las exenciones posibles: (personas desempleadas, personas con discapacidad, miembros de familia numerosa, víctimas de terrorismo o violencia de género).
           - Incluir la documentación acreditativa de las exenciones.

        8. **Adaptación Solicitada (si aplica):**
           - Detallar las adaptaciones solicitadas para los exámenes (intérprete de signos, sistema Braille, ampliación del tiempo, etc.).

        9. **Documentación Requerida:**
           - Listar todos los documentos que deben aportarse junto con la solicitud (ej. Modelo 030, certificado de discapacidad, certificado de víctima de terrorismo, etc.).

        10. **Firma y Datos Finales:**
           - Firma del solicitante o del representante.
           - Fecha y lugar de la firma.
           - Indicar si el solicitante se opone a la consulta de algunos de los datos.

        **Detecta especialidades:**
        - Si se menciona "Carnet de Bombero", "Titulación en Medicina", "Especialidad de Seguridad Social", o cualquier otra especialidad, incluye ese dato en el JSON en el campo correspondiente.
        - Si aparece un campo relacionado con la especialidad solicitada (por ejemplo, "Carnet de Bombero"), marca la especialidad correctamente y añádela al JSON.

        **Genera este JSON COMPLETO:**
        {
          "titulo_oficial": "Texto completo del encabezado principal",
          "codigo_convocatoria": "Referencia corta (ej: 265T)",
          "orden_convocatoria": "Orden de la convocatoria Nº",
          "fecha_publicacion": "Fecha de publicación en B.O.C.M.",
          "codigo_especialidad": "Código de cuerpo/escala/especialidad",
          "descripcion_convocatoria": "Descripción de la convocatoria",
          "especialidad": "Especialidad solicitada (Ej. Bombero, Medicina, Seguridad Social)",
          "bloques_detectados": {
            "pide_tasas": boolean (¿Se solicita pago de tasas?),
            "admite_exencion_desempleo": boolean (¿Hay exención para desempleados?),
            "admite_exencion_terrorismo": boolean (¿Exención para víctimas de terrorismo?),
            "admite_exencion_violencia_genero": boolean (¿Exención para víctimas de violencia de género?),
            "solicita_adaptacion_discapacidad": boolean (¿Se solicita adaptación por discapacidad?),
            "pide_titulacion": boolean (¿Pide titulaciones en los requisitos?),
            "requisitos_experiencia": boolean (¿Requiere experiencia sustitutoria?),
            "requisitos_antiguedad": boolean (¿Requiere antigüedad o formación específica?),
            "especialidad_carnet_bombero": boolean (¿Se requiere carnet de bombero?),
            "especialidad_medicina": boolean (¿Se requiere titulación en Medicina?),
            "otros_requisitos_especialidad": "Detalles de cualquier otro requisito específico para la especialidad"
          },
          "datos_solicitante": {
            "nombre": "Nombre completo del solicitante",
            "apellidos": "Apellidos del solicitante",
            "nif_nie": "NIF/NIE del solicitante",
            "direccion": {
              "via": "Tipo de vía",
              "nombre_via": "Nombre de la vía",
              "numero": "Número",
              "piso": "Piso",
              "puerta": "Puerta",
              "codigo_postal": "Código Postal",
              "provincia": "Provincia",
              "municipio": "Municipio"
            },
            "email": "Email del solicitante",
            "telefono1": "Teléfono 1 del solicitante",
            "telefono2": "Teléfono 2 del solicitante",
            "fecha_nacimiento": "Fecha de nacimiento",
            "sexo": "Sexo del solicitante",
            "nacionalidad": "Nacionalidad del solicitante"
          },
          "datos_representante": {
            "nombre_representante": "Nombre del representante",
            "nif_nie_representante": "NIF/NIE del representante",
            "razon_social": "Razón social (si aplica)",
            "direccion_representante": {
              "via": "Tipo de vía",
              "nombre_via": "Nombre de la vía",
              "numero": "Número",
              "piso": "Piso",
              "puerta": "Puerta",
              "codigo_postal": "Código Postal",
              "provincia": "Provincia",
              "municipio": "Municipio"
            },
            "email_representante": "Email del representante",
            "telefono1_representante": "Teléfono 1 del representante",
            "telefono2_representante": "Teléfono 2 del representante"
          },
          "medio_notificacion": "Interesado o representante (seleccionar)",
          "adaptaciones_solicitadas": {
            "eliminacion_barreras_arquitectonicas": boolean (¿Se solicita eliminación de barreras arquitectónicas?),
            "interprete_signos": boolean (¿Se solicita intérprete de signos?),
            "sistema_braille": boolean (¿Se solicita sistema Braille?),
            "ampliacion_tiempo": boolean (¿Se solicita ampliación del tiempo de duración del ejercicio?),
            "aumento_tamano_caracteres": boolean (¿Se solicita aumento del tamaño de los caracteres?),
            "ayuda_tecnica": boolean (¿Se solicita ayuda técnica?),
            "otros": "Especificar otras adaptaciones"
          },
          "documentos_requeridos": [
            "Ejemplar del modelo 030",
            "Certificado de discapacidad",
            "Certificado de víctima de terrorismo",
            "Certificado de víctima de violencia de género",
            "Autorización para presentación y firma de solicitud (si aplica)"
          ],
          "firma_solicitante": {
            "firmado_por": "Nombre de quien firma",
            "fecha_firma": "Fecha de firma",
            "lugar_firma": "Lugar de firma"
          },
          "oposicion_consulta_datos": boolean (¿Se opone a la consulta de datos?),
          "comentarios_oposicion": "Comentarios adicionales sobre la oposición a consulta"
        }`
      },

      // Mapeamos todas las imágenes del array al formato de OpenRouter
      ...imagesBase64.map((img: string) => ({
        type: 'image_url',
        image_url: { url: img }
      }))
    ];

    const completion = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-001',
        response_format: { type: 'json_object' },
        messages: [
          { 
            role: 'system', 
            content: 'Eres un experto Auditor de la Administración Pública. Analizas documentos completos hoja a hoja.' 
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
      }),
    });

    const data = await completion.json();
    
    if (data.error) {
        console.error("OpenRouter Error:", data.error);
        throw new Error(data.error.message);
    }

    const content = JSON.parse(data.choices[0].message.content);
    return NextResponse.json(content);

  } catch (error) {
    console.error('Analyze error:', error);
    return NextResponse.json({ error: 'Error procesando documento' }, { status: 500 });
  }
}