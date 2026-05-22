import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiter = new RateLimiterMemory({
  points: 10,
  duration: 60,
});

function validarConteudo(conteudo) {
  if (typeof conteudo !== 'string') return 'Campo "conteudo" deve ser texto.';
  if (conteudo.trim().length < 10) return 'Conteúdo muito curto para análise.';
  if (conteudo.trim().length > 6000) return 'Conteúdo excede o limite de 6.000 caracteres.';
  return null;
}

const SYSTEM_PROMPT = `
Você é um analista sênior de verificação narrativa, risco informacional e checagem preliminar de alegações.

Sua tarefa é avaliar se a ALEGAÇÃO enviada pelo usuário parece verdadeira, falsa, incerta ou não verificável.

IMPORTANTE:
O score deve representar a confiabilidade da ALEGAÇÃO ORIGINAL do usuário.

EXEMPLO CRÍTICO:
Usuário:
"Protetor solar causa câncer?"

Se a análise concluir que isso é falso:
- score deve ser BAIXO;
- classificação deve ser "provavelmente falso";
- resumo deve explicar que não há evidência científica sustentando a alegação.

NUNCA:
- retorne score alto enquanto diz que a alegação é incorreta;
- misture confiabilidade da resposta com confiabilidade da alegação.

A pontuação SEMPRE avalia:
"A alegação enviada pelo usuário parece verdadeira?"

OBJETIVOS DA ANÁLISE:
- identificar plausibilidade factual;
- distinguir fato de opinião;
- detectar manipulação emocional;
- avaliar verificabilidade;
- identificar ausência de evidência;
- avaliar consistência lógica;
- detectar teor conspiratório;
- detectar linguagem alarmista;
- diferenciar hipótese de afirmação factual.

REGRAS CRÍTICAS:
- Não invente fatos.
- Não invente fontes.
- Não diga que algo é falso sem base plausível.
- Se não houver evidências suficientes, classifique como "incerto" ou "não verificável".
- Diferencie claramente:
  - fato,
  - opinião,
  - hipótese,
  - sátira,
  - boato,
  - acusação,
  - propaganda,
  - narrativa emocional,
  - e especulação.

SINAIS QUE AUMENTAM CONFIABILIDADE:
- dados específicos;
- contexto coerente;
- possibilidade de verificação objetiva;
- alinhamento com conhecimento científico consolidado;
- ausência de exagero emocional;
- presença de fontes verificáveis.

SINAIS QUE REDUZEM CONFIABILIDADE:
- teor conspiratório;
- alarmismo;
- urgência artificial;
- ausência total de evidência;
- generalizações extremas;
- afirmações absolutas;
- linguagem manipulativa;
- incompatibilidade com consenso científico consolidado.

ESCALA:
0-20 = alegação provavelmente falsa
21-40 = alegação suspeita ou sem sustentação
41-60 = alegação incerta ou não verificável
61-80 = alegação provavelmente verdadeira
81-100 = alegação fortemente confirmada

IMPORTANTE:
A classificação textual, o resumo e o score precisam ser coerentes entre si.

CLASSIFICAÇÕES POSSÍVEIS:
- "provavelmente verdadeiro"
- "incerto"
- "suspeito"
- "provavelmente falso"
- "não verificável"

Retorne SOMENTE JSON válido.
`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    classificacao: {
      type: 'string',
      enum: [
        'provavelmente verdadeiro',
        'incerto',
        'suspeito',
        'provavelmente falso',
        'não verificável'
      ]
    },
    resumo: { type: 'string' },
    sinais: {
      type: 'array',
      items: { type: 'string' }
    },
    evidencias_encontradas: {
      type: 'array',
      items: { type: 'string' }
    },
    fontes_consultadas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titulo: { type: 'string' },
          url: { type: 'string' },
          relevancia: { type: 'string' }
        },
        required: ['titulo', 'url', 'relevancia']
      }
    },
    recomendacao: { type: 'string' },
    nivel_confianca: {
      type: 'string',
      enum: ['baixo', 'médio', 'alto']
    },
    observacao: { type: 'string' }
  },
  required: [
    'score',
    'classificacao',
    'resumo',
    'sinais',
    'evidencias_encontradas',
    'fontes_consultadas',
    'recomendacao',
    'nivel_confianca',
    'observacao'
  ]
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido. Use POST.' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'anonimo';

  try {
    await limiter.consume(ip);
  } catch {
    return res.status(429).json({
      erro: 'Muitas requisições. Aguarde antes de tentar novamente.'
    });
  }

  const body =
  typeof req.body === 'string'
    ? JSON.parse(req.body)
    : (req.body || {});

const { conteudo } = body;
  const erroValidacao = validarConteudo(conteudo);

  if (erroValidacao) {
    return res.status(400).json({ erro: erroValidacao });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      erro: 'OPENAI_API_KEY não configurada na Vercel.'
    });
  }

  try {
    const resposta = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        instructions: SYSTEM_PROMPT,
        input: `
Analise a alegação/conteúdo abaixo.

Conteúdo:
${conteudo.trim()}

Instruções adicionais:
- Busque evidências externas quando necessário.
- Liste fontes consultadas apenas se forem realmente usadas.
- Se não encontrar fontes suficientes, não chute.
`,
      
        text: {
          format: {
            type: 'json_schema',
            name: 'checagem_noticia',
            strict: true,
            schema: RESPONSE_SCHEMA
          }
        },
        max_output_tokens: 1200,
        temperature: 0.3
      })
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text();
      console.error('Erro OpenAI:', resposta.status, detalhe);

      return res.status(502).json({
        erro: 'Erro ao consultar o serviço de análise.'
      });
    }

    const dados = await resposta.json();

    const textoResposta =
      dados.output_text ||
      dados?.output
        ?.find((bloco) => bloco.type === 'message')
        ?.content
        ?.find((parte) => parte.type === 'output_text')
        ?.text;

    if (!textoResposta) {
      console.error('Resposta inesperada:', JSON.stringify(dados));

      return res.status(502).json({
        erro: 'Resposta inválida da IA.'
      });
    }

    let analise;

    try {
      analise = JSON.parse(textoResposta);
    } catch {
      return res.status(502).json({
        erro: 'A IA retornou um formato inválido.'
      });
    }

    return res.status(200).json(analise);

  } catch (err) {
    console.error('Erro interno:', err);

    return res.status(500).json({
      erro: 'Erro interno no servidor.'
    });
  }
}
