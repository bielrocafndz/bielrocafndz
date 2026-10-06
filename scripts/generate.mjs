// Genera gráficos SVG con Recharts (renderizado en servidor) a partir de tus
// repos públicos y actualiza las secciones dinámicas del README.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const R = require('recharts');
const h = React.createElement;

// ───────────── ⚙️ Configuración ─────────────
const USER = process.env.GH_USER || 'bielrocafndz';
const TOKEN = process.env.GITHUB_TOKEN;
const EXCLUDE = new Set([USER.toLowerCase()]); // añade aquí repos que no quieras mostrar

// Paleta verde persa, a juego con el banner
const ACCENT = '#3fd9c4';    // verde persa claro: títulos, líneas, puntos
const SECONDARY = '#00a693'; // verde persa: rellenos
const HIGHLIGHT = '#eafff9'; // menta muy claro: números destacados
const TEXT = '#c9d1d9';
const MUTED = '#8b949e';
const GRID = 'rgba(0,166,147,0.2)';
const PALETTE = ['#3fd9c4', '#00a693', '#7ee8d6', '#2bb3a1', '#b8f5e8', '#00574d', '#ffd97a'];
const LANG_COLORS = {
  JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', HTML: '#e34c26', CSS: '#563d7c',
  Java: '#b07219', 'C#': '#178600', 'C++': '#f34b7d', C: '#555555', Go: '#00ADD8', Rust: '#dea584',
  PHP: '#4F5D95', Ruby: '#701516', Kotlin: '#A97BFF', Swift: '#F05138', Dart: '#00B4AB', Vue: '#41b883',
  Svelte: '#ff3e00', Shell: '#89e051', 'Jupyter Notebook': '#DA5B0B', SCSS: '#c6538c', Astro: '#ff5a03',
};
const LANG_EMOJI = {
  JavaScript: '🟨', TypeScript: '🟦', Python: '🐍', HTML: '🟧', CSS: '🎨', Java: '☕', Go: '🐹',
  Rust: '🦀', PHP: '🐘', Ruby: '💎', Kotlin: '🟪', Swift: '🕊️', Dart: '🎯', Vue: '💚', Shell: '🐚',
  'Jupyter Notebook': '📓', 'C#': '🟪',
};
const MAX_LANG_AXES = 8;   // a partir de aquí, el resto se agrupa en "Other"
const MIN_RADAR_AXES = 3;  // con menos lenguajes se dibujan barras

// ───────────── GitHub API ─────────────
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER,
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} en ${path}`);
  return res.json();
}

async function getRepos() {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/users/${USER}/repos?per_page=100&type=owner&sort=pushed&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all.filter((r) => !r.fork && !EXCLUDE.has(r.name.toLowerCase()));
}

async function getLanguageTotals(repos) {
  const results = await Promise.all(
    repos.map((r) => gh(`/repos/${r.full_name}/languages`).catch(() => ({})))
  );
  const totals = {};
  for (const langs of results)
    for (const [lang, bytes] of Object.entries(langs)) totals[lang] = (totals[lang] || 0) + bytes;
  return totals;
}

// ───────────── Utilidades ─────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function rel(date) {
  const days = Math.round((new Date(date) - Date.now()) / 86400000);
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(months, 'month');
  return rtf.format(Math.round(days / 365), 'year');
}
const tick = { fill: MUTED, fontSize: 12 };

// Envuelve el SVG de Recharts en una tarjeta con título (válida para <img> en GitHub)
function frame({ title, subtitle, width, height, chart, extra = '' }) {
  const inner = chart
    ? renderToStaticMarkup(chart)
        .match(/<svg[\s\S]*<\/svg>/)[0]
        .replace(/ style="width:100%;height:100%"/, '') // si no, el SVG interno se estira
    : '';
  const H = height + 72;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">
<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${H - 1}" rx="12" fill="none" stroke="${GRID}"/>
<text x="20" y="30" fill="${ACCENT}" font-size="16" font-weight="600">${esc(title)}</text>
${subtitle ? `<text x="20" y="48" fill="${MUTED}" font-size="11">${esc(subtitle)}</text>` : ''}
<g transform="translate(0,60)">${inner}${extra}</g>
</svg>`;
}

// ───────────── Gráficos ─────────────

// Radar dinámico: un eje por cada lenguaje que tengas de verdad.
// Con menos de MIN_RADAR_AXES lenguajes cambia solo a barras horizontales.
function languagesChart(totals, repoCount) {
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const keep = sorted.length > MAX_LANG_AXES ? MAX_LANG_AXES - 1 : sorted.length;
  const data = sorted.slice(0, keep).map(([name, value], i) => ({
    name, pct: (value / sum) * 100, color: LANG_COLORS[name] || PALETTE[i % PALETTE.length],
  }));
  const rest = sorted.slice(keep).reduce((a, [, v]) => a + v, 0);
  if (rest) data.push({ name: 'Other', pct: (rest / sum) * 100, color: '#6e7681' });

  const W = 460, H = 200;
  const title = 'Most used languages';
  const subtitle = `By bytes of code across ${plural(repoCount, 'public repo')}`;

  if (data.length < MIN_RADAR_AXES) {
    const chart = h(R.BarChart, {
      width: W, height: H, data, layout: 'vertical',
      margin: { top: (H - data.length * 44) / 2, right: 64, left: 10, bottom: (H - data.length * 44) / 2 },
    },
      h(R.XAxis, { type: 'number', domain: [0, 100], hide: true }),
      h(R.YAxis, { type: 'category', dataKey: 'name', width: 110, tick: { fill: TEXT, fontSize: 13 }, axisLine: false, tickLine: false }),
      h(R.Bar, {
        dataKey: 'pct', radius: [0, 6, 6, 0], barSize: 18, isAnimationActive: false,
        background: { fill: GRID, radius: 6 },
      },
        data.map((d, i) => h(R.Cell, { key: i, fill: d.color })),
        h(R.LabelList, {
          dataKey: 'pct', position: 'right', fill: ACCENT, fontSize: 13, fontWeight: 600,
          formatter: (v) => `${v.toFixed(1)}%`,
        }))
    );
    return frame({ title, subtitle, width: W, height: H, chart });
  }

  // Escala raíz cuadrada: así los lenguajes pequeños se ven aunque uno domine.
  // La leyenda sigue mostrando el porcentaje real.
  const radarData = data.map((d) => ({ ...d, r: Math.sqrt(d.pct) }));
  const chart = h(R.RadarChart, {
    width: 260, height: H, data: radarData, cx: 130, cy: H / 2, outerRadius: 64,
  },
    h(R.PolarGrid, { stroke: GRID }),
    h(R.PolarAngleAxis, { dataKey: 'name', tick: { fill: MUTED, fontSize: 11 } }),
    h(R.PolarRadiusAxis, { domain: [0, 10], tick: false, axisLine: false }),
    h(R.Radar, {
      dataKey: 'r', stroke: ACCENT, strokeWidth: 2, fill: SECONDARY, fillOpacity: 0.35,
      dot: { r: 3, fill: ACCENT, stroke: 'none' }, isAnimationActive: false,
    })
  );
  const rowH = Math.min(24, (H - 10) / data.length);
  const top = (H - rowH * data.length) / 2 + rowH * 0.7;
  const legend = data.map((d, i) => {
    const y = top + i * rowH;
    return `<circle cx="282" cy="${y - 4}" r="5" fill="${d.color}"/>
<text x="296" y="${y}" fill="${TEXT}" font-size="13">${esc(d.name)}</text>
<text x="${W - 24}" y="${y}" fill="${i === 0 ? ACCENT : MUTED}" font-size="13" font-weight="${i === 0 ? 600 : 400}" text-anchor="end">${d.pct.toFixed(1)}%</text>`;
  }).join('');
  return frame({ title, subtitle, width: W, height: H, chart, extra: legend });
}

function timelineChart(repos) {
  const years = repos.map((r) => new Date(r.created_at).getFullYear());
  const now = new Date();
  const min = Math.min(...years), max = now.getFullYear();
  let data, subtitle;
  if (max - min >= 2) {
    data = [];
    for (let y = min; y <= max; y++) data.push({ label: String(y), count: years.filter((v) => v === y).length });
    subtitle = 'Repos created per year';
  } else {
    // Si tu cuenta es joven, el gráfico cambia solo a vista mensual
    data = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      data.push({
        label: d.toLocaleDateString('en', { month: 'short' }),
        count: repos.filter((r) => r.created_at.slice(0, 7) === key).length,
      });
    }
    subtitle = 'Repos created in the last 12 months';
  }
  const W = 460, H = 200;
  const chart = h(R.AreaChart, { width: W, height: H, data, margin: { top: 10, right: 32, left: 0, bottom: 0 } },
    h('defs', null,
      h('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 },
        h('stop', { offset: '0%', stopColor: SECONDARY, stopOpacity: 0.55 }),
        h('stop', { offset: '100%', stopColor: SECONDARY, stopOpacity: 0 }))),
    h(R.CartesianGrid, { strokeDasharray: '3 3', stroke: GRID, vertical: false }),
    h(R.XAxis, { dataKey: 'label', tick, axisLine: false, tickLine: false }),
    h(R.YAxis, { allowDecimals: false, width: 36, tick, axisLine: false, tickLine: false }),
    h(R.Area, {
      type: 'monotone', dataKey: 'count', stroke: ACCENT, strokeWidth: 2, fill: 'url(#areaGrad)',
      dot: { r: 3, fill: ACCENT, stroke: 'none' }, isAnimationActive: false,
    })
  );
  return frame({ title: 'Project activity', subtitle, width: W, height: H, chart });
}

function starsChart(repos) {
  const data = repos.filter((r) => r.stargazers_count > 0)
    .sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 8)
    .map((r) => ({ name: r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name, stars: r.stargazers_count }));
  const W = 460, H = Math.max(120, data.length * 30 + 10);
  const chart = h(R.BarChart, { width: W, height: H, data, layout: 'vertical', margin: { top: 0, right: 48, left: 10, bottom: 0 } },
    h(R.XAxis, { type: 'number', hide: true }),
    h(R.YAxis, { type: 'category', dataKey: 'name', width: 140, tick, axisLine: false, tickLine: false }),
    h(R.Bar, { dataKey: 'stars', fill: SECONDARY, radius: [0, 6, 6, 0], barSize: 16, isAnimationActive: false },
      h(R.LabelList, { dataKey: 'stars', position: 'right', fill: ACCENT, fontSize: 12 }))
  );
  return frame({ title: 'Most starred projects', subtitle: 'Top repos by stars', width: W, height: H, chart });
}

function topicsChart(counts) {
  const data = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([topic, count]) => ({ topic, count }));
  const W = 460, H = 220;
  const chart = h(R.RadarChart, { width: W, height: H, data, cx: W / 2, cy: H / 2, outerRadius: 80 },
    h(R.PolarGrid, { stroke: GRID }),
    h(R.PolarAngleAxis, { dataKey: 'topic', tick }),
    h(R.Radar, {
      dataKey: 'count', stroke: ACCENT, strokeWidth: 2, fill: SECONDARY, fillOpacity: 0.35,
      dot: { r: 3, fill: ACCENT, stroke: 'none' }, isAnimationActive: false,
    })
  );
  return frame({ title: 'Project topics', subtitle: "Based on each repo's topics", width: W, height: H, chart });
}

// ───────────── Secciones del README ─────────────
function projectsSection(repos) {
  if (!repos.length) return '_Projects coming soon_ 🚧';
  const featured = [...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 4);
  const pin = (r) =>
    `<a href="${r.html_url}"><img src="https://github-readme-stats-lyart-mu.vercel.app/api/pin/?username=${USER}&repo=${r.name}&theme=transparent&hide_border=true&title_color=${ACCENT.slice(1)}&icon_color=${SECONDARY.slice(1)}&text_color=${MUTED.slice(1)}&border_radius=8" alt="${r.name}" width="49%"/></a>`;

  let out = `### 📌 Featured

<p align="center">
${featured.map(pin).join('\n')}
</p>`;

  // La lista de recientes solo aparece cuando hay más repos de los que caben en Featured,
  // para no repetir los mismos proyectos dos veces
  if (repos.length > featured.length) {
    const recent = [...repos].sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at)).slice(0, 5);
    const items = recent.map((r) => {
      const meta = [
        r.language ? `${LANG_EMOJI[r.language] || '📦'} ${r.language}` : null,
        r.stargazers_count ? `⭐ ${r.stargazers_count}` : null,
        `updated ${rel(r.pushed_at)}`,
        r.homepage ? `<a href="${r.homepage}">🔗 demo</a>` : null,
      ].filter(Boolean).join(' · ');
      const desc = r.description ? ` — ${esc(r.description)}` : '';
      return `- **[${r.name}](${r.html_url})**${desc}<br><sub>${meta}</sub>`;
    });
    out += `

### 🕒 Recently working on

${items.join('\n')}`;
  }
  return out;
}

function replaceSection(text, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(text)) {
    console.warn(`⚠️  No encontré los marcadores ${name} en el README`);
    return text;
  }
  return text.replace(re, `$1\n${content}\n$2`);
}

// ───────────── Main ─────────────
const repos = await getRepos();
console.log(`📦 ${repos.length} repos públicos encontrados para ${USER}`);

await mkdir('charts', { recursive: true });
for (const f of ['languages.svg', 'timeline.svg', 'stars.svg', 'topics.svg'])
  await rm(`charts/${f}`, { force: true });

const charts = [];
const save = async (file, alt, svg) => {
  await writeFile(`charts/${file}`, svg);
  charts.push({ file, alt });
};

const totals = await getLanguageTotals(repos);
const langCount = Object.keys(totals).length;
const topicCounts = {};
for (const r of repos) for (const t of r.topics || []) topicCounts[t] = (topicCounts[t] || 0) + 1;
const totalStars = repos.reduce((a, r) => a + r.stargazers_count, 0);

// Cada gráfico aparece solo cuando tus datos lo justifican
if (langCount) await save('languages.svg', 'Most used languages', languagesChart(totals, repos.length));
if (repos.length) await save('timeline.svg', 'Project activity', timelineChart(repos));
if (repos.filter((r) => r.stargazers_count > 0).length >= 2) await save('stars.svg', 'Most starred projects', starsChart(repos));
if (Object.keys(topicCounts).length >= 3) await save('topics.svg', 'Project topics', topicsChart(topicCounts));

const summary = repos.length
  ? `<p align="center"><b>${repos.length}</b> public repo${repos.length === 1 ? '' : 's'} · <b>${totalStars}</b> ⭐ · <b>${langCount}</b> language${langCount === 1 ? '' : 's'} · last push ${rel(repos[0].pushed_at)}</p>`
  : '';
const chartsMd = `${summary}

<p align="center">
${charts.map((c) => `<img src="./charts/${c.file}" alt="${c.alt}" width="49%"/>`).join('\n')}
</p>`;

let readme = await readFile('README.md', 'utf8');
readme = replaceSection(readme, 'CHARTS', chartsMd);
readme = replaceSection(readme, 'PROJECTS', projectsSection(repos));
await writeFile('README.md', readme);
console.log(`✅ README actualizado con ${charts.length} gráficos`);
