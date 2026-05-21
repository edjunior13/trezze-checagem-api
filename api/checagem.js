import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiter = new RateLimiterMemory({
  points: 10,
  duration: 60,
});

function validarConteudo(conteudo) {
  if (typeof conteudo !== 'string') {
    return 'Campo "conteudo" deve ser texto.';
  }

  if (conteudo.trim().length < 10) {
    return 'Conteúdo muito curto para análise.';
  }

  if (conteudo.trim().length > 8000) {
    return 'Conteúdo excede o limite de 8.000 caracteres.';
  }

  return null;
}

const SYSTEM_PROMPT = `
Você atua como analista sênior de verificação narrativa e risco informacional em contexto político-eleitoral brasileiro.

Seu objetivo NÃO é apenas identificar fake news.

Seu objetivo é avaliar:
- plausibilidade factual,
- verificabilidade,
- consistência lógica,
- presença de manipulação emocional,
- risco narrativo,
- qualidade das evidências,
- potencial de desinformação.

IMPORTANTE:
Nem todo conteúdo falso é desinformação.
Nem todo conteúdo verdadeiro é confiável.
Nem toda opinião é verificável.

Você deve distinguir cuidadosamente:
- fato verificável,
- opinião,
- hipótese,
- sátira,
- acusação,
- narrativa emocional,
- propaganda,
- especulação,
- conteúdo conspiratório,
- conteúdo sem evidência,
- informação plausível mas não confirmada.

REGRAS CRÍTICAS:
- Nunca invente fatos.
- Nunca invente fontes.
- Nunca afirme que algo é falso sem evidência clara.
- Quando não houver contexto suficiente, classifique como "não verificável" ou "incerto".
- Seja prudente e técnico.
- Evite respostas repetitivas.
- Analise o conteúdo REAL enviado.
- Considere nuances semânticas.
- Diferencie claramente linguagem emocional de evidência factual.
- Se o texto for apenas opinião, deixe isso explícito.
- Se houver sinais de manipulação narrativa, explique quais.
- Se houver sinais de confiabilidade, explique também.

CRITÉRIOS IMPORTANTES:

Aumentam confiabilidade:
- presença de dados específicos,
- datas,
- contexto coerente,
- linguagem equilibrada,
- fonte identificável,
- possibilidade de verificação objetiva.

Reduzem confiabilidade:
- alarmismo,
- urgência artificial,
- caixa alta excessiva,
- generalizações,
- teor conspiratório,
- ausência total de evidência,
- ataques pessoais,
- afirmações absolutas,
- manipulação emocional.

A pontuação deve ser altamente variável.
Evite concentrar scores na mesma faixa.
Use toda a escala de 0 a 100 de forma inteligente.

Interpretação da escala:
0-20 = altamente suspeito
21-40 = baixa confiabilidade
41-60 = incerto
61-80 = plausível/confiável
81-100 = altamente confiável

Retorne SOMENTE JSON válido:

{
  "score": inteiro de 0 a 100,
  "classificacao": "provavelmente verdadeiro" | "incerto" | "suspeito" | "provavelmente falso" | "não verificável",
  "resumo": "análise curta e contextual",
  "sinais": ["lista objetiva de sinais encontrados"],
  "recomendacao": "orientação prática ao usuário",
  "nivel_confianca": "baixo" | "médio" | "alto",
  "observacao": "Esta análise é preliminar e automatizada."
}
`;

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      erro: 'Método não permitido. Use POST.'
    });
  }

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || 'anonimo';

  try {
    await limiter.consume(ip);
  } catch {
    return res.status(429).json({
      erro: 'Muitas requisições. Aguarde antes de tentar novamente.'
    });
  }

  const { conteudo } = req.body || {};

  const erroValidacao = validarConteudo(conteudo);

  if (erroValidacao) {
    return res.status(400).json({
      erro: erroValidacao
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error('OPENAI_API_KEY não configurada.');

    return res.status(500).json({
      erro: 'Configuração do servidor incompleta.'
    });
  }

  try {

    const resposta = await fetch(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },

        body: JSON.stringify({
          model: 'gpt-4.1',

          instructions: SYSTEM_PROMPT,

          input: conteudo.trim(),

          max_output_tokens: 800,

          temperature: 0.5,

          top_p: 0.9
        })
      }
    );

    if (!resposta.ok) {

      const detalhe = await resposta.text();

      console.error(
        'Erro OpenAI:',
        resposta.status,
        detalhe
      );

      return res.status(502).json({
        erro: 'Erro ao consultar o serviço de análise.'
      });
    }

    const dados = await resposta.json();

    const textoResposta = dados?.output
      ?.find(bloco => bloco.type === 'message')
      ?.content
      ?.find(parte => parte.type === 'output_text')
      ?.text;

    if (!textoResposta) {

      console.error(
        'Resposta inesperada:',
        JSON.stringify(dados)
      );

      return res.status(502).json({
        erro: 'Resposta inválida da IA.'
      });
    }

    let analise;

    try {

      analise = JSON.parse(textoResposta);

    } catch {

      const match = textoResposta.match(/\{[\s\S]*\}/);

      if (match) {
        analise = JSON.parse(match[0]);
      } else {

        console.error(
          'JSON inválido:',
          textoResposta
        );

        return res.status(502).json({
          erro: 'Formato inesperado retornado pela IA.'
        });
      }
    }

    const classificacoesValidas = [
      'provavelmente verdadeiro',
      'incerto',
      'suspeito',
      'provavelmente falso',
      'não verificável'
    ];

    const niveisValidos = [
      'baixo',
      'médio',
      'alto'
    ];

    const resultado = {

      score:
        Math.min(
          100,
          Math.max(
            0,
            parseInt(analise.score) || 50
          )
        ),

      classificacao:
        classificacoesValidas.includes(
          analise.classificacao
        )
          ? analise.classificacao
          : 'incerto',

      resumo:
        String(
          analise.resumo || ''
        ).slice(0, 400),

      sinais:
        Array.isArray(analise.sinais)
          ? analise.sinais
              .slice(0, 8)
              .map(s => String(s).slice(0, 120))
          : [],

      recomendacao:
        String(
          analise.recomendacao || ''
        ).slice(0, 500),

      nivel_confianca:
        niveisValidos.includes(
          analise.nivel_confianca
        )
          ? analise.nivel_confianca
          : 'médio',

      observacao:
        'Esta análise é preliminar e automatizada.'
    };

    return res.status(200).json(resultado);

  } catch (err) {

    console.error(
      'Erro interno:',
      err
    );

    return res.status(500).json({
      erro: 'Erro interno no servidor.'
    });
  }
}