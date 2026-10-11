import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = 'C:/Users/LIOR SULTAN/.gemini/antigravity/brain/f30437f0-c1d5-490d-8abd-eeaf4dfe8a37';

const PROMPTS = [
  {
    id: 'idf_rifleman',
    title: '🪖 רובאי חי"ר צה"ל (IDF Rifleman)',
    filename: 'idf_rifleman_hero.jpg',
    prompt: `8K heroic military character portrait taken on an 85mm f/1.4 lens with extreme shallow depth of field. An elite Israeli Defense Forces (IDF) infantry rifleman in tack-sharp crystal focus in the immediate foreground. The urban combat background is heavily blurred with creamy cinematic bokeh and subtle desaturated muted grey tones. The soldier is highlighted with strong edge rim lighting along his silhouette, making him pop out three-dimensionally. Wearing authentic IDF tactical combat uniform in rich olive drab (madei bet) with an embroidered Israeli flag patch on the upper sleeve and an authentic IDF Mitznefet floppy camouflage helmet cover over his combat helmet. Holding an IWI Micro Tavor X95 carbine in a ready stance with holographic sight. Razor-sharp detail on the soldier and equipment, soft blurred backdrop. Aspect ratio 4:3.`
  },
  {
    id: 'idf_rocket',
    title: '🚀 צוות נ"ט ונ"מ צה"ל (IDF Rocket Team AT/AA)',
    filename: 'idf_rocket_hero.jpg',
    prompt: `8K dramatic military action portrait shot on an 85mm f/1.4 prime lens. An elite Israeli Defense Forces (IDF) anti-tank specialist soldier in crisp razor-sharp focus in the center foreground, aiming a shoulder-fired Matador (RGW-90) rocket launcher. Wearing authentic IDF olive-drab tactical uniform with an Israeli flag patch and an authentic IDF Mitznefet camouflage helmet cover. Sturdy IDF plate carrier vest with tactical utility pouches. High-contrast edge rim lighting separates the soldier from the background. The background showing rugged terrain and pine trees is rendered in a soft, creamy, desaturated bokeh. Dynamic, powerful focal composition. Aspect ratio 4:3.`
  },
  {
    id: 'idf_sniper',
    title: '❄️ צלף קרבי צה"ל (IDF Sniper)',
    filename: 'idf_sniper_hero.jpg',
    prompt: `8K atmospheric military sniper portrait with ultra-shallow depth of field, 85mm f/1.4 lens. An elite Israeli Defense Forces (IDF) marksman sniper kneeling in tack-sharp focus in the foreground with an authentic heavy Barrett MRAD sniper rifle mounted on a snow bipod. Wearing tactical winter/alpine gear with an authentic IDF uniform underneath, subtle subdued Israeli flag patch, and winter camouflage netting. The background is rendered in a soft, heavily blurred aesthetic bokeh with cool, muted desaturated tones. Crisp directional rim lighting outlines the sniper's shoulders and rifle barrel, making the soldier stand out powerfully. Aspect ratio 4:3.`
  },
  {
    id: 'idf_medic',
    title: '🩺 חובש קרבי צה"ל (IDF Combat Medic)',
    filename: 'idf_medic_hero.jpg',
    prompt: `8K powerful military photojournalism portrait with extreme shallow depth of field, 85mm lens at f/1.4. An unmistakable IDF combat field medic is sharply focused in the foreground with vivid colors. Prominently highlighted in the direct light are his bright blue nitrile medical examination gloves on both hands, holding trauma shears and applying an authentic Israeli emergency pressure bandage (The Israeli Bandage). Clear bold red-cross medical patches on his helmet, a red-cross MEDIC armband on his sleeve, and CAT tourniquets in dedicated quick-draw slots. Beside him is an open IDF combat medic aid backpack displaying saline IV drip bags and sterile field dressings. The background bunker is heavily blurred into a soft, desaturated neutral bokeh. Warm rim lighting separates the medic's silhouette from the muted background, drawing total visual focus to the blue gloves and medical kit. Aspect ratio 4:3.`
  },
  {
    id: 'idf_engineer',
    title: '🛠️ פלס/מהנדס קרבי צה"ל (IDF Combat Engineer)',
    filename: 'idf_engineer_hero.jpg',
    prompt: `8K ultra-vibrant heroic character portrait filling 80% of the frame, shot on an 85mm f/1.2 lens with extreme shallow depth of field. An elite unmistakable Israeli Defense Forces (IDF) combat engineer standing dominantly in tack-sharp focus in the center foreground. NO radio headset, clean ears, determined focused expression. Held up prominently in one hand is a large heavy industrial steel wrench, and in his other hand is a prominent rugged tactical equipment hard-case briefcase. Wearing authentic IDF tactical uniform in rich olive drab (madei bet) with an Israeli flag patch and Combat Engineering Corps insignia, reinforced plate carrier vest with tools. High-contrast key lighting and intense golden rim lighting carve his silhouette, making the soldier pop out dramatically from a dark, heavily desaturated, ultra-blurred creamy bokeh background. Aspect ratio 4:3.`
  }
];

export async function generateAllUnits(apiKey) {
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY is required.');
    process.exit(1);
  }

  console.log(`Starting automated generation of 5 IDF soldier units using Gemini 3 Pro Image (Nano Banana Pro)...`);

  const results = [];

  for (let i = 0; i < PROMPTS.length; i++) {
    const item = PROMPTS[i];
    console.log(`\n[${i + 1}/${PROMPTS.length}] Generating ${item.title}...`);
    
    try {
      // 1. Try Interactions API endpoint
      let imgBuffer = null;
      
      const interactionsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gemini-3-pro-image',
          input: item.prompt,
          response_format: {
            type: 'image',
            aspect_ratio: '4:3',
            image_size: '2K'
          }
        })
      });

      if (interactionsRes.ok) {
        const data = await interactionsRes.json();
        // Look for image data in response
        if (data.outputs) {
          for (const out of data.outputs) {
            if (out.type === 'image' && out.data) {
              imgBuffer = Buffer.from(out.data, 'base64');
              break;
            }
          }
        }
      } else {
        const errText = await interactionsRes.text();
        console.log(`Interactions API response ${interactionsRes.status}: ${errText.substring(0, 200)}...`);
      }

      // 2. Fallback to generateContent endpoint if interactions didn't return image
      if (!imgBuffer) {
        console.log(`Trying generateContent endpoint for ${item.id}...`);
        const genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: item.prompt }] }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT']
            }
          })
        });

        if (genRes.ok) {
          const genData = await genRes.json();
          const parts = genData?.candidates?.[0]?.content?.parts || [];
          for (const p of parts) {
            if (p.inlineData && p.inlineData.data) {
              imgBuffer = Buffer.from(p.inlineData.data, 'base64');
              break;
            }
          }
        } else {
          console.error(`generateContent failed: ${genRes.status} ${await genRes.text()}`);
        }
      }

      if (imgBuffer) {
        const outPath = path.join(ARTIFACTS_DIR, item.filename);
        fs.writeFileSync(outPath, imgBuffer);
        console.log(`Saved: ${outPath} (${imgBuffer.length} bytes)`);
        results.push({ ...item, path: outPath, success: true });
      } else {
        console.error(`Failed to retrieve image data for ${item.id}`);
        results.push({ ...item, success: false });
      }
    } catch (err) {
      console.error(`Exception while generating ${item.id}:`, err);
      results.push({ ...item, success: false, error: err.message });
    }
  }

  // Update gallery markdown
  updateGalleryArtifact(results);
  return results;
}

function updateGalleryArtifact(results) {
  const mdPath = path.join(ARTIFACTS_DIR, 'idf_infantry_pro_gallery.md');
  let md = `# 🇮🇱 גלריית חיילי צה"ל – נוצרו באמצעות Gemini 3 Pro Image (Nano Banana Pro 🍌)\n\n`;
  md += `כל התמונות נוצרו במודל ה-**Pro** החזק ביותר, עם **מדי צה"ל אותנטיים (מדי ב' ירוק-זית, מיצנפת, דגל ישראל)**, **טשטוש עומק שדה קולנועי (85mm f/1.4 Bokeh)**, **הבלטת הדמות (Rim Lighting)**, ו**כפפות ניטריל כחולות לחובש**.\n\n`;
  md += `**סטטוס:** מוצגות לבדיקתך – שום שינוי לא יוטמע במשחק לפני שתכתוב "מאשר"!\n\n`;
  md += `\`\`\`\`carousel\n`;

  for (const r of results) {
    if (r.success) {
      md += `### ${r.title}\n`;
      md += `![${r.title}](file:///${r.path.replace(/\\/g, '/')})\n\n`;
      md += `* **קובץ:** \`${r.filename}\`\n`;
      md += `* **מיקוד:** דמות בפוקוס חד במרכז, רקע מטושטש ומושתק, תאורת הילה מפרידה.\n\n<!-- slide -->\n`;
    }
  }

  md += `\`\`\`\`\n\n`;
  md += `---\n### מה הצעד הבא?\n`;
  md += `בדוק את התמונות בגלריה. ברגע שתכתוב **"מאשר"**, נחתוך אותן ישירות ל-512x384 (4:3) ונטמיע אותן במשחק!\n`;

  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`\nUpdated gallery preview artifact at: ${mdPath}`);
}

const key = process.argv[2] || process.env.GEMINI_API_KEY;
if (key) {
  generateAllUnits(key);
} else {
  console.log('Script ready. Usage: node scripts/generate_idf_units.mjs <API_KEY>');
}
