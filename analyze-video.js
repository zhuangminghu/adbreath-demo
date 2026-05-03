/**
 * AdBreath Video Analyzer v2
 * Sends entire video directly to MiMo-v2.5 for analysis
 *
 * Usage: node analyze-video.js [video-path]
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIMO_API_KEY = process.env.MIMO_API_KEY;
const MIMO_BASE_URL = process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1';
const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5';
const VIDEO_PATH = process.argv[2] || path.join(__dirname, 'public', 'video.mp4');
const OUTPUT_PATH = path.join(__dirname, 'public', 'analysis.json');

// ===== Call MiMo API =====
async function callMiMo(messages, maxTokens = 4096) {
  const res = await fetch(`${MIMO_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MIMO_API_KEY}`,
    },
    body: JSON.stringify({
      model: MIMO_MODEL,
      messages,
      max_completion_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MiMo API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const msg = data.choices[0].message;
  return msg.content || msg.reasoning_content || '';
}

// ===== Prepare video (trim/compress if needed) =====
function prepareVideo(videoPath) {
  const stats = fs.statSync(videoPath);
  const sizeMB = stats.size / (1024 * 1024);
  console.log(`  Original: ${sizeMB.toFixed(1)} MB`);

  // Get duration
  const durationStr = execSync(
    `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
  ).toString().trim();
  const duration = parseFloat(durationStr);
  console.log(`  Duration: ${Math.floor(duration / 60)}m${Math.floor(duration % 60)}s`);

  // If video is too large (>45MB for base64 limit), compress it
  const tmpPath = path.join(__dirname, 'public', 'video_analysis.mp4');

  if (sizeMB > 45) {
    console.log(`  ⚠️ Video too large for base64, compressing...`);
    execSync(
      `ffmpeg -y -i "${videoPath}" -vf "scale=480:-2" -c:v libx264 -crf 28 -preset fast -c:a aac -b:a 64k "${tmpPath}"`,
      { stdio: 'pipe' }
    );
    const newSize = fs.statSync(tmpPath).size / (1024 * 1024);
    console.log(`  Compressed: ${newSize.toFixed(1)} MB`);
    return { path: tmpPath, duration, isTemp: true };
  }

  return { path: videoPath, duration, isTemp: false };
}

// ===== Main =====
async function main() {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║  AdBreath AI Video Analyzer v2   ║');
  console.log('║  (Direct Video Analysis)         ║');
  console.log('╚══════════════════════════════════╝\n');

  if (!fs.existsSync(VIDEO_PATH)) {
    console.error(` Video not found: ${VIDEO_PATH}`);
    process.exit(1);
  }
  console.log(`  Video: ${VIDEO_PATH}`);

  if (!MIMO_API_KEY) {
    console.error(' MIMO_API_KEY not set in .env');
    process.exit(1);
  }
  console.log(`  API: ${MIMO_BASE_URL} (${MIMO_MODEL})`);

  // Step 1: Prepare video
  console.log('\n━━━ Step 1: Prepare Video ━━━');
  const { path: videoFile, duration, isTemp } = prepareVideo(VIDEO_PATH);

  // Step 2: Read video as base64
  console.log('\n━━━ Step 2: Send Video to MiMo ━━━');
  const videoBuffer = fs.readFileSync(videoFile);
  const videoBase64 = videoBuffer.toString('base64');
  console.log(`  Base64 size: ${(videoBase64.length / 1024 / 1024).toFixed(1)} MB`);
  console.log('  Sending to MiMo for analysis... (this may take a minute)');

  // Step 3: Analyze the entire video
  const analysisPrompt = `你是一个专业的视频内容分析AI。请观看这个视频，完成以下任务：

## 任务1：逐段分析
将视频按内容变化分成若干段落（每段10-30秒），对每个段落分析：
- 时间范围（起始秒-结束秒）
- 场景描述（一句话）
- 情绪强度（1-10，1=极度平静，10=极度紧张激烈）
- 内容标签

## 任务2：呼吸位探测
找出视频中适合插入广告的"呼吸位"（剧情自然断点）：
- 一级呼吸位：黑场转场、章节结束、淡入淡出
- 二级呼吸位：节奏明显放缓、情绪从紧张转为平静
对每个呼吸位给出：时间点、类型（primary/secondary）、场景描述

## 任务3：禁止区域
找出不适合插入广告的"高能心流区"：
- 剧情高潮、激烈冲突、关键对话、情绪爆发
对每个禁止区域给出：时间范围、原因

请以JSON格式返回，结构如下：
{
  "segments": [
    {"start": 0, "end": 15, "scene": "场景描述", "emotion": 8, "tags": ["tag1"]}
  ],
  "breathing_spots": [
    {"timestamp": 45, "type": "primary", "scene": "场景描述", "reason": "原因"}
  ],
  "forbidden_zones": [
    {"start": 30, "end": 50, "scene": "场景描述", "reason": "原因"}
  ]
}

只返回JSON，不要其他内容。`;

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: analysisPrompt },
        {
          type: 'video_url',
          video_url: {
            url: `data:video/mp4;base64,${videoBase64}`,
            fps: 0.5,  // 1 frame every 2 seconds
          },
        },
      ],
    },
  ];

  let analysisResult;
  try {
    analysisResult = await callMiMo(messages, 8192);
    console.log('  Analysis complete!');
  } catch (err) {
    console.error(`  Analysis failed: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Parse results
  console.log('\n━━━ Step 3: Parse Results ━━━');
  let parsed;
  try {
    const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : analysisResult);
  } catch (err) {
    console.error(`  JSON parse failed: ${err.message}`);
    console.log('  Raw response (first 500 chars):', analysisResult.slice(0, 500));
    process.exit(1);
  }

  const segments = parsed.segments || [];
  const breathingSpots = parsed.breathing_spots || [];
  const forbiddenZones = parsed.forbidden_zones || [];

  console.log(`  Segments: ${segments.length}`);
  console.log(`  Breathing spots: ${breathingSpots.length}`);
  console.log(`  Forbidden zones: ${forbiddenZones.length}`);

  // Print breathing spots
  console.log('\n  呼吸位详情:');
  breathingSpots.forEach((s, i) => {
    console.log(`    ${i + 1}. ${formatTime(s.timestamp)} | ${s.type} | ${s.scene}`);
  });

  // Step 5: Generate ads for breathing spots
  console.log('\n━━━ Step 4: Generate Interactive Ads ━━━');
  const ads = {};

  for (const spot of breathingSpots) {
    process.stdout.write(`\r  Generating ad for ${formatTime(spot.timestamp)}...`);

    const adPrompt = `你是一个创意广告AI。当前视频场景：「${spot.scene}」。

生成一个情境化互动广告，返回JSON：
{"brand":"品牌名","question":"与场景情绪共鸣的问题","opt_a":"简短选项","opt_b":"简短选项","reveal":"品牌关联文案","egg":"趣味彩蛋"}`;

    try {
      const adResult = await callMiMo([{ role: 'user', content: adPrompt }], 512);
      const adJson = adResult.match(/\{[\s\S]*?\}/);
      if (adJson) {
        const adParsed = JSON.parse(adJson[0]);
        ads[spot.timestamp] = {
          selected_brand: adParsed.brand || '',
          question: adParsed.question || '',
          option_a: adParsed.opt_a || adParsed.option_a || '',
          option_b: adParsed.opt_b || adParsed.option_b || '',
          brand_reveal: adParsed.reveal || adParsed.brand_reveal || '',
          easter_egg: adParsed.egg || adParsed.easter_egg || '',
        };
      }
    } catch (err) {
      console.error(`\n  ⚠️ Ad generation failed for ${spot.timestamp}s: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\n  Generated ${Object.keys(ads).length} ads`);

  // Step 6: Save results
  console.log('\n━━━ Step 5: Save Results ━━━');

  // Convert breathing spots to frame analysis format for frontend compatibility
  const frameAnalysis = [];
  for (const seg of segments) {
    frameAnalysis.push({
      timestamp: seg.start,
      scene_description: seg.scene,
      emotion_intensity: seg.emotion || 5,
      is_transition: false,
      suitable_for_ad: !(forbiddenZones.some(z => seg.start >= z.start && seg.start < z.end)),
      content_tags: seg.tags || [],
    });
  }

  const output = {
    videoInfo: {
      path: VIDEO_PATH,
      duration,
      analyzedAt: new Date().toISOString(),
      method: 'direct_video_analysis',
    },
    segments,
    frameAnalysis,
    breathingSpots: breathingSpots.map(s => ({
      timestamp: s.timestamp,
      type: s.type,
      scene: s.scene,
      reason: s.reason,
    })),
    forbiddenZones,
    ads,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`  Saved to: ${OUTPUT_PATH}`);

  // Cleanup temp file
  if (isTemp) {
    fs.unlinkSync(videoFile);
    console.log(`  Cleaned up temp video`);
  }

  // Summary
  console.log('\n╔══════════════════════════════════╗');
  console.log('║         Analysis Complete!       ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`  Duration:        ${Math.floor(duration / 60)}m${Math.floor(duration % 60)}s`);
  console.log(`  Segments:        ${segments.length}`);
  console.log(`  Breathing spots: ${breathingSpots.length}`);
  console.log(`  Forbidden zones: ${forbiddenZones.length}`);
  console.log(`  Ads generated:   ${Object.keys(ads).length}`);
  console.log(`\n  Open http://localhost:3000 to see results!\n`);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

main().catch(err => {
  console.error('\n Fatal error:', err);
  process.exit(1);
});
