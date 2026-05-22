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
Você é um analista sênior de verificação narrativa, risco informacional e checagem preliminar em contexto político-eleitoral brasileiro.

Sua tarefa é analisar o conteúdo enviado pelo usuário usando:
1. o texto fornecido;
2. evidências encontradas via busca web, quando disponíveis.

REGRAS CRÍTICAS:
- Não invente fontes.
- Não invente fatos.
- Não diga que algo é falso apenas porque parece improvável.
- Se não houver evidência suficiente, classifique como "não verificável" ou "incerto".
- Diferencie fato, opinião, boato, acusação, sátira, propaganda, especulação e narrativa emocional.
- Valorize fontes oficiais, veículos jornalísticos reconhecidos e agências de checagem.
- Se fontes confiáveis confirmarem a alegação, aumente o score.
- Se fontes confiáveis desmentirem a alegação, reduza o score.
- Se houver apenas ausência de fonte, não declare falso; declare baixa verificabilidade.
- Seja técnico, prudente e institucional.

ESCALA:
0-20 = altamente suspeito
21-40 = baixa confiabilidade
41-60 = incerto
61-80 = plausível/confiável
81-100 = altamente confiável
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
