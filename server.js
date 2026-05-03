require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// MiMo API config
const MIMO_API_KEY = process.env.MIMO_API_KEY;
const MIMO_BASE_URL = process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1';
const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5';

// ===== Call MiMo API =====
async function callMiMo(messages, maxTokens = 1024) {
  const response = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MIMO_API_KEY}`,
    },
    body: JSON.stringify({
      model: MIMO_MODEL,
      messages,
      max_completion_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`MiMo API error: ${response.status} - ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ===== API: Analyze a single frame =====
app.post('/api/analyze-frame', async (req, res) => {
  try {
    const { imageBase64, timestamp } = req.body;

    const prompt = `你是一个视频内容分析 AI。请分析这张视频帧截图，回答以下问题（JSON 格式）：

1. "scene_description": 用一句话描述画面内容
2. "emotion_intensity": 情绪强度评分 1-10（1=平静温馨，10=极度紧张激烈）
3. "is_transition": 这是否是一个转场/黑场画面？true/false
4. "suitable_for_ad": 这个时间点适合插入广告吗？true/false
5. "reason": 为什么不适合/适合插广告（一句话）

只返回 JSON，不要其他内容。`;

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
        ],
      },
    ];

    const result = await callMiMo(messages, 512);

    // Parse JSON from response
    let parsed;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
    } catch {
      parsed = {
        scene_description: result,
        emotion_intensity: 5,
        is_transition: false,
        suitable_for_ad: true,
        reason: '无法解析，使用默认值',
      };
    }

    res.json({ success: true, timestamp, analysis: parsed });
  } catch (error) {
    console.error('analyze-frame error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== API: Batch analyze frames =====
app.post('/api/analyze-batch', async (req, res) => {
  try {
    const { frames } = req.body;
    // frames: [{ timestamp: 0, imageBase64: "..." }, ...]

    const results = [];

    for (const frame of frames) {
      try {
        const prompt = `分析这张视频帧截图，返回 JSON：
{
  "scene_description": "一句话描述画面",
  "emotion_intensity": 1-10的情绪强度(1=平静,10=极度紧张),
  "is_transition": true/false是否转场黑场,
  "suitable_for_ad": true/false是否适合插广告,
  "reason": "一句话原因"
}
只返回 JSON。`;

        const messages = [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${frame.imageBase64}` },
              },
            ],
          },
        ];

        const result = await callMiMo(messages, 256);
        let parsed;
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
        } catch {
          parsed = {
            scene_description: '分析中',
            emotion_intensity: 5,
            is_transition: false,
            suitable_for_ad: true,
            reason: '默认判断',
          };
        }

        results.push({ timestamp: frame.timestamp, analysis: parsed });
      } catch (err) {
        results.push({
          timestamp: frame.timestamp,
          analysis: {
            scene_description: '分析失败',
            emotion_intensity: 5,
            is_transition: false,
            suitable_for_ad: true,
            reason: err.message,
          },
        });
      }
    }

    // Determine breathing spots from analysis
    const breathingSpots = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i].analysis;
      if (r.is_transition || (r.emotion_intensity <= 3 && r.suitable_for_ad)) {
        breathingSpots.push({
          timestamp: results[i].timestamp,
          type: r.is_transition ? 'primary' : 'secondary',
          scene: r.scene_description,
        });
      }
    }

    res.json({ success: true, results, breathingSpots });
  } catch (error) {
    console.error('analyze-batch error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== API: Generate interactive ad =====
app.post('/api/generate-ad', async (req, res) => {
  try {
    const { sceneDescription, emotionIntensity, adPool } = req.body;

    const poolInfo = adPool || [
      { brand: 'XX咖啡', keywords: ['提神', '温暖', '陪伴'], tone: '温暖关怀' },
      { brand: 'YY零食', keywords: ['解压', '美味', '快乐'], tone: '轻松愉悦' },
      { brand: 'ZZ运动', keywords: ['健康', '活力', '释放'], tone: '积极向上' },
    ];

    const prompt = `你是一个创意广告 AI。当前视频场景描述：「${sceneDescription}」，情绪强度：${emotionIntensity}/10。

广告素材池：
${poolInfo.map(p => `- ${p.brand}：关键词[${p.keywords.join(', ')}]，调性：${p.tone}`).join('\n')}

请生成一个情境化互动广告，返回 JSON：
{
  "selected_brand": "从素材池中选择最匹配的品牌",
  "question": "一个与当前场景情绪共鸣的问题（不是推销，是让用户表达看法）",
  "option_a": "选项A文案（简短，8字以内）",
  "option_b": "选项B文案（简短，8字以内）",
  "brand_reveal": "用户选择后展示的品牌关联文案（温暖，不硬推）",
  "easter_egg": "与场景相关的趣味彩蛋文案"
}

要求：
- 问题要引发情绪共鸣，不是商业推销
- 选项是让用户「表态」，不是「买东西」
- 品牌关联要自然，像是朋友推荐

只返回 JSON。`;

    const messages = [
      { role: 'user', content: prompt },
    ];

    const result = await callMiMo(messages, 512);

    let parsed;
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
    } catch {
      parsed = {
        selected_brand: 'XX咖啡',
        question: '你觉得主角现在需要什么？',
        option_a: '一杯热咖啡',
        option_b: '安静独处',
        brand_reveal: '有时候，一杯咖啡就是最好的陪伴。',
        easterEgg: '据说编剧写这场戏时，桌上就放着一杯咖啡。',
      };
    }

    res.json({ success: true, ad: parsed });
  } catch (error) {
    console.error('generate-ad error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== API: Health check =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mimoConfigured: !!MIMO_API_KEY && MIMO_API_KEY !== 'your_api_key_here',
    model: MIMO_MODEL,
  });
});

// ===== Start server =====
app.listen(PORT, () => {
  console.log(`\n  AdBreath Demo Server`);
  console.log(`   http://localhost:${PORT}\n`);
  if (!MIMO_API_KEY || MIMO_API_KEY === 'your_api_key_here') {
    console.log('  ⚠️  请在 .env 文件中配置 MIMO_API_KEY');
  } else {
    console.log(`  ✅ MiMo API 已配置 (${MIMO_MODEL})`);
  }
  console.log('');
});
