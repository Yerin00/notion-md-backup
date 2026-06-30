#!/usr/bin/env node
// Notion subtree → Markdown exporter (zero dependency, Node 18+ native fetch)
//
// Usage:
//   NOTION_TOKEN=secret_xxx node notion-export.mjs <page-url-or-id> [outputDir]
//   node notion-export.mjs <page-url> ./output       (token read from .env)
//
// What it does:
//   - Takes ONE Notion page URL/ID and exports ONLY that page and everything
//     beneath it (child pages, and rows of child databases), recursively.
//   - Preserves hierarchy as folders: a page that has children becomes a
//     "<title>.md" file PLUS a "<title>/" folder holding its descendants
//     (same layout Notion's own Markdown export uses).

import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- config / token ----------
function loadEnvFile() {
  const p = join(__dirname, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}
loadEnvFile();

const TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = process.env.NOTION_VERSION || "2022-06-28";
if (!TOKEN) {
  console.error(
    "❌ NOTION_TOKEN 이 없습니다. .env 파일에 NOTION_TOKEN=secret_xxx 를 넣거나 환경변수로 전달하세요."
  );
  process.exit(1);
}

const rawArg = process.argv[2];
const outRoot = process.argv[3] || join(__dirname, "output");
if (!rawArg) {
  console.error("사용법: node notion-export.mjs <page-url-or-id> [outputDir]");
  process.exit(1);
}

// link style for images: "md" (standard ![](path)) or "wiki" (Obsidian ![[path]])
const LINK_STYLE = (process.env.LINK_STYLE || "md").toLowerCase();


// ---------- helpers ----------
function extractId(input) {
  // Notion IDs are the trailing 32 hex chars of the last path segment.
  // The title slug (e.g. "7-1-6-29-6-30-") can contain hex digits, so we must
  // anchor to the END of the segment, not grab the first 32-hex run.
  const seg = input.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() || input;
  const compact = seg.replace(/-/g, "");
  const hex =
    compact.match(/[0-9a-fA-F]{32}$/) || compact.match(/[0-9a-fA-F]{32}/);
  if (!hex) throw new Error(`URL/ID 에서 페이지 ID를 찾지 못했습니다: ${input}`);
  return dashifyId(hex[0]);
}
function dashifyId(id) {
  const s = id.replace(/-/g, "");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(
    16,
    20
  )}-${s.slice(20)}`;
}

function sanitize(name) {
  let s = (name || "untitled")
    .replace(/[\/\\:*?"<>|]/g, " ")
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = "untitled";
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s;
}

// unique, human-readable name within a directory. Appends a short id tag only
// when the same title already exists in that folder (so names stay clean).
const usedNames = new Map(); // dir -> Set
function uniqueName(dir, base, id) {
  if (!usedNames.has(dir)) usedNames.set(dir, new Set());
  const set = usedNames.get(dir);
  let name = base;
  if (set.has(name.toLowerCase())) {
    name = `${base} (${id.replace(/-/g, "").slice(0, 4)})`;
    let n = 2;
    while (set.has(name.toLowerCase())) name = `${base} (${id.replace(/-/g, "").slice(0, 4)}-${n++})`;
  }
  set.add(name.toLowerCase());
  return name;
}

// unique filename within an assets dir (keeps original name, suffixes on clash)
const usedAssetNames = new Map(); // dir -> Set
function uniqueAssetName(dir, fname) {
  if (!usedAssetNames.has(dir)) usedAssetNames.set(dir, new Set());
  const set = usedAssetNames.get(dir);
  if (!set.has(fname.toLowerCase())) {
    set.add(fname.toLowerCase());
    return fname;
  }
  const dot = fname.lastIndexOf(".");
  const stem = dot > 0 ? fname.slice(0, dot) : fname;
  const ext = dot > 0 ? fname.slice(dot) : "";
  let n = 2;
  let cand;
  do {
    cand = `${stem}-${n++}${ext}`;
  } while (set.has(cand.toLowerCase()));
  set.add(cand.toLowerCase());
  return cand;
}

let reqCount = 0;
async function notion(path, { method = "GET", body } = {}) {
  const url = `https://api.notion.com/v1${path}`;
  for (let attempt = 0; ; attempt++) {
    reqCount++;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = (Number(res.headers.get("retry-after")) || 1) * 1000;
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && attempt < 4) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API ${res.status} on ${path}: ${text}`);
    }
    // gentle pacing ~3 req/s
    await sleep(120);
    return res.json();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- asset download ----------
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const assetCache = new Map(); // (destDir+url) -> absolute saved path
let assetCount = 0;
// Notion-native: each page's images live INSIDE that page's own folder, so the
// file is downloaded into destDir (the page folder), not a shared _assets dir.
async function downloadAsset(url, destDir) {
  const key = destDir + "\n" + url;
  if (assetCache.has(key)) return assetCache.get(key);
  let basename = "file";
  try {
    const u = new URL(url);
    const bn = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (bn) basename = bn;
  } catch {}
  basename = sanitize(basename).replace(/\s+/g, "_") || "file";
  const fname = uniqueAssetName(destDir, basename);
  const abs = join(destDir, fname);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(destDir, { recursive: true });
  writeFileSync(abs, buf);
  assetCount++;
  assetCache.set(key, abs);
  return abs;
}
// returns markdown link to a downloaded asset, or null on failure (caller falls back to url)
// ct = childTargets (carries this page's folder + the dir its .md lives in)
async function assetLink(url, ct, caption, isImage) {
  try {
    const abs = await downloadAsset(url, ct.assetsDir);
    const fname = abs.split(sep).pop();
    if (LINK_STYLE === "wiki") {
      // Obsidian resolves wikilinks by filename (assets are uniquely named)
      return isImage ? `![[${fname}]]` : `[[${fname}|${caption || fname}]]`;
    }
    // relative to the .md file's directory → "assets/<asset>"
    const rel = `${ct.assetsRel}/${fname}`;
    return isImage ? `![${caption}](<${rel}>)` : `[${caption || rel}](<${rel}>)`;
  } catch (e) {
    console.warn(`  ⚠️ 에셋 다운로드 실패(${e.message}): ${url.slice(0, 70)}…`);
    return null;
  }
}

async function getAllChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const data = await notion(`/blocks/${blockId}/children${qs}`);
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function queryDatabase(dbId) {
  const out = [];
  let cursor;
  do {
    const data = await notion(`/databases/${dbId}/query`, {
      method: "POST",
      body: cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 },
    });
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ---------- title extraction ----------
function plainFromRich(rich) {
  return (rich || []).map((t) => t.plain_text).join("");
}
function pageTitle(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p.type === "title") return plainFromRich(p.title) || "Untitled";
  }
  return "Untitled";
}

// ---------- rich text → markdown ----------
function richText(arr) {
  return (arr || [])
    .map((t) => {
      let s;
      if (t.type === "equation") s = `$${t.equation.expression}$`;
      else s = t.plain_text;
      if (s === "") return "";
      const a = t.annotations || {};
      if (a.code) s = "`" + s + "`";
      if (a.bold) s = "**" + s + "**";
      if (a.italic) s = "*" + s + "*";
      if (a.strikethrough) s = "~~" + s + "~~";
      const href = t.href;
      if (href) s = `[${s}](${href})`;
      return s;
    })
    .join("");
}

// ---------- block → markdown ----------
// Returns markdown string. Recurses into nested children (lists/toggles/etc).
// Collects child pages and child databases to be exported as separate files.
async function blocksToMarkdown(blocks, indent, childTargets) {
  const lines = [];
  let numbered = 0;
  for (const block of blocks) {
    const t = block.type;
    const pad = "  ".repeat(indent);
    const data = block[t] || {};
    const isNumbered = t === "numbered_list_item";
    if (isNumbered) numbered++;
    else numbered = 0;

    let text = "";
    switch (t) {
      case "paragraph":
        text = richText(data.rich_text);
        lines.push(text ? pad + text : "");
        break;
      case "heading_1":
        lines.push(`${pad}# ${richText(data.rich_text)}`);
        break;
      case "heading_2":
        lines.push(`${pad}## ${richText(data.rich_text)}`);
        break;
      case "heading_3":
        lines.push(`${pad}### ${richText(data.rich_text)}`);
        break;
      case "bulleted_list_item":
        lines.push(`${pad}- ${richText(data.rich_text)}`);
        break;
      case "numbered_list_item":
        lines.push(`${pad}${numbered}. ${richText(data.rich_text)}`);
        break;
      case "to_do":
        lines.push(
          `${pad}- [${data.checked ? "x" : " "}] ${richText(data.rich_text)}`
        );
        break;
      case "toggle":
        lines.push(`${pad}- ${richText(data.rich_text)}`);
        break;
      case "quote":
        lines.push(`${pad}> ${richText(data.rich_text)}`);
        break;
      case "callout": {
        const icon = data.icon?.emoji ? data.icon.emoji + " " : "";
        lines.push(`${pad}> ${icon}${richText(data.rich_text)}`);
        break;
      }
      case "code": {
        const lang = data.language || "";
        lines.push(`${pad}\`\`\`${lang}`);
        for (const l of richText(data.rich_text).split("\n")) lines.push(pad + l);
        lines.push(`${pad}\`\`\``);
        break;
      }
      case "divider":
        lines.push(`${pad}---`);
        break;
      case "equation":
        lines.push(`${pad}$$${data.expression}$$`);
        break;
      case "image":
      case "file":
      case "pdf":
      case "video": {
        const f = data;
        const isExternal = f.type === "external";
        const url = isExternal ? f.external?.url : f.file?.url;
        const cap = richText(f.caption) || t;
        const isImage = t === "image";
        if (!url) break;
        // download Notion-hosted files (URLs expire) and external images;
        // keep external non-image links (e.g. youtube video) as plain links.
        const shouldDownload = !isExternal || isImage;
        let line = null;
        if (shouldDownload) {
          line = await assetLink(url, childTargets, cap, isImage);
        }
        if (!line) line = isImage ? `![${cap}](${url})` : `[${cap}](${url})`;
        lines.push(pad + line);
        break;
      }
      case "bookmark":
      case "embed":
      case "link_preview": {
        const url = data.url;
        if (url) lines.push(`${pad}[${url}](${url})`);
        break;
      }
      case "table":
        // children are table_row blocks; handled via recursion below as a table
        break;
      case "child_page": {
        const title = data.title || "Untitled";
        if (childTargets.linkedMode) {
          // 1-level linked page: don't recurse, just point at the page online
          lines.push(`${pad}- 📄 [${title}](https://www.notion.so/${block.id.replace(/-/g, "")})`);
        } else {
          const sub = uniqueName(childTargets.dir, sanitize(title), block.id);
          childTargets.pages.push({ id: block.id, title, name: sub });
          lines.push(`${pad}- 📄 [${title}](<./${sub}/${sub}.md>)`);
        }
        break;
      }
      case "child_database": {
        const title = data.title || "Untitled Database";
        if (childTargets.linkedMode) {
          lines.push(`${pad}- 🗂️ [${title}](https://www.notion.so/${block.id.replace(/-/g, "")})`);
        } else {
          const sub = uniqueName(childTargets.dir, sanitize(title), block.id);
          childTargets.databases.push({ id: block.id, name: sub, title });
          lines.push(`${pad}- 🗂️ [${title}](<./${sub}/${sub}.md>)`);
        }
        break;
      }
      case "synced_block":
      case "column_list":
      case "column":
        // structural — just recurse into children (handled below)
        break;
      default:
        if (data.rich_text) lines.push(pad + richText(data.rich_text));
        break;
    }

    // nested children (lists, toggles, columns, tables, etc.)
    if (block.has_children && t !== "child_page" && t !== "child_database") {
      const kids = await getAllChildren(block.id);
      if (t === "table") {
        lines.push(...tableToMarkdown(kids, pad));
      } else {
        const nestedIndent =
          t === "bulleted_list_item" ||
          t === "numbered_list_item" ||
          t === "to_do" ||
          t === "toggle"
            ? indent + 1
            : indent;
        const nested = await blocksToMarkdown(kids, nestedIndent, childTargets);
        if (nested.trim()) lines.push(nested);
      }
    }
  }
  return lines.join("\n");
}

function tableToMarkdown(rows, pad) {
  const out = [];
  rows.forEach((row, i) => {
    if (row.type !== "table_row") return;
    const cells = row.table_row.cells.map((c) => richText(c).replace(/\|/g, "\\|"));
    out.push(`${pad}| ${cells.join(" | ")} |`);
    if (i === 0) out.push(`${pad}| ${cells.map(() => "---").join(" | ")} |`);
  });
  return out;
}

// extract a single property's display value as a string
function propValue(p) {
  if (!p) return "";
  switch (p.type) {
    case "title": return plainFromRich(p.title);
    case "rich_text": return plainFromRich(p.rich_text);
    case "number": return p.number ?? "";
    case "select": return p.select?.name ?? "";
    case "multi_select": return (p.multi_select || []).map((s) => s.name).join(", ");
    case "status": return p.status?.name ?? "";
    case "date": return p.date ? [p.date.start, p.date.end].filter(Boolean).join(" → ") : "";
    case "checkbox": return p.checkbox ? "✓" : "";
    case "url": return p.url ?? "";
    case "email": return p.email ?? "";
    case "phone_number": return p.phone_number ?? "";
    case "people": return (p.people || []).map((x) => x.name).filter(Boolean).join(", ");
    case "files": return (p.files || []).map((f) => f.name).join(", ");
    case "formula": return p.formula?.[p.formula?.type] ?? "";
    case "relation": return (p.relation || []).length ? `${p.relation.length}개 관계` : "";
    case "rollup": return p.rollup?.type === "number" ? (p.rollup.number ?? "") : (p.rollup?.type === "array" ? `${p.rollup.array?.length ?? 0}개` : "");
    case "created_time": return p.created_time ?? "";
    case "last_edited_time": return p.last_edited_time ?? "";
    case "created_by": return p.created_by?.name ?? "";
    case "last_edited_by": return p.last_edited_by?.name ?? "";
    default: return "";
  }
}
function mdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

// ---------- page property frontmatter (for database rows) ----------
function propsToFrontmatter(page) {
  const props = page.properties || {};
  const lines = [];
  for (const [key, p] of Object.entries(props)) {
    if (p.type === "title") continue;
    const v = propValue(p);
    if (v === "" || v == null) continue;
    lines.push(`${key.replace(/:/g, " ")}: ${String(v).replace(/\n/g, " ")}`);
  }
  if (!lines.length) return "";
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// ---------- export a page (and recurse) ----------
// Folder-per-page layout (human-readable):
//   <page>/
//   ├─ <page>.md      ← this page's body (# title + content)
//   ├─ assets/        ← this page's images
//   └─ <child>/ ...   ← each child page as its own folder
let exportedCount = 0;
const exportedIdToPath = new Map(); // compact page id -> absolute .md path (for link rewiring)
async function exportPage({ id, title, dir, name }) {
  exportedCount++;
  const page = await safe(() => notion(`/pages/${id}`));
  const realTitle = title || (page ? pageTitle(page) : "Untitled");
  const clean = name || uniqueName(dir, sanitize(realTitle), id);
  const pageDir = join(dir, clean); // this page owns this folder

  const childTargets = {
    pages: [],
    databases: [],
    dir: pageDir, // children folders + this body .md live here
    assetsDir: join(pageDir, "assets"), // images download here
    assetsRel: "assets", // asset link prefix, relative to the body .md
  };

  const blocks = await safe(() => getAllChildren(id), []);
  let body = "";
  try {
    body = await blocksToMarkdown(blocks, 0, childTargets);
  } catch (e) {
    body = `\n> ⚠️ 본문 변환 중 오류: ${e.message}\n`;
  }

  // human-readable: keep the title as H1, and metadata as frontmatter for DB rows
  const front = page && page.parent?.type === "database_id" ? propsToFrontmatter(page) : "";
  const md = `${front}# ${realTitle}\n\n${body}\n`;

  mkdirSync(pageDir, { recursive: true });
  const absMd = join(pageDir, `${clean}.md`);
  writeFileSync(absMd, md, "utf8");
  exportedIdToPath.set(id.replace(/-/g, "").toLowerCase(), absMd); // for link rewiring
  console.log(`  ✅ ${absMd.replace(outRoot, ".")}`);

  // recurse: children become subfolders inside this page's folder
  for (const cp of childTargets.pages) {
    await exportPage({ id: cp.id, title: cp.title, dir: pageDir, name: cp.name });
  }
  for (const db of childTargets.databases) {
    await exportDatabase({ ...db, dir: pageDir });
  }
}

// A database becomes a folder:
//   <db>/
//   ├─ <db>.md        ← table summary of all rows
//   └─ <row>/ ...     ← each row as its own page folder
async function exportDatabase({ id, name, title, dir }) {
  console.log(`  🗂️  DB: ${title}`);
  const dbDir = join(dir, name);
  mkdirSync(dbDir, { recursive: true });

  // schema → column order (title first, then the rest in Notion's order)
  const schema = await safe(() => notion(`/databases/${id}`), null);
  const rows = await safe(() => queryDatabase(id), []);
  const propEntries = schema
    ? Object.entries(schema.properties)
    : rows[0]
    ? Object.entries(rows[0].properties)
    : [];
  const titleKey = propEntries.find(([, p]) => p.type === "title")?.[0] || "Name";
  const otherKeys = propEntries
    .filter(([, p]) => p.type !== "title")
    .map(([k]) => k);

  const tableRows = [];
  for (const row of rows) {
    const t = pageTitle(row);
    const rowClean = uniqueName(dbDir, sanitize(t), row.id);
    await exportPage({ id: row.id, title: t, dir: dbDir, name: rowClean });
    const cells = [`[${mdEscape(t || "Untitled")}](<./${rowClean}/${rowClean}.md>)`];
    for (const k of otherKeys) cells.push(mdEscape(propValue(row.properties[k])));
    tableRows.push(cells);
  }

  // <db>.md : the database as one browsable table (links to each row page)
  const header = [titleKey, ...otherKeys].map(mdEscape);
  const idx = [`# ${title}`, "", `총 ${rows.length}개 항목`, ""];
  idx.push(`| ${header.join(" | ")} |`);
  idx.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of tableRows) idx.push(`| ${r.join(" | ")} |`);
  writeFileSync(join(dbDir, `${name}.md`), idx.join("\n") + "\n", "utf8");
  console.log(`  ✅ ${join(dbDir, `${name}.md`).replace(outRoot, ".")} (DB 표)`);
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`  ⚠️ ${e.message}`);
    return fallback;
  }
}

// ---------- determine if root id is a page or database ----------
async function main() {
  const id = extractId(rawArg);
  console.log(`▶ 대상 ID: ${id}`);
  console.log(`▶ 출력 폴더: ${outRoot}\n`);
  mkdirSync(outRoot, { recursive: true });

  // try as page first, then database
  let asPage;
  try {
    asPage = await notion(`/pages/${id}`);
  } catch {
    asPage = null;
  }

  if (asPage) {
    const title = pageTitle(asPage);
    console.log(`📄 루트 페이지: ${title}\n`);
    await exportPage({ id, title, dir: outRoot });
  } else {
    // maybe it's a database
    let db;
    try {
      db = await notion(`/databases/${id}`);
    } catch (e) {
      console.error(
        `❌ 이 ID는 페이지도 DB도 아니거나, integration이 해당 페이지에 연결(공유)되지 않았습니다.\n   Notion에서 페이지 우상단 ••• → "연결(Connections)" → integration 추가 후 다시 실행하세요.\n   상세: ${e.message}`
      );
      process.exit(1);
    }
    const title = plainFromRich(db.title) || "Untitled Database";
    console.log(`🗂️ 루트 데이터베이스: ${title}\n`);
    await exportDatabase({ id, name: uniqueName(outRoot, sanitize(title), id), title, dir: outRoot });
  }

  // 1단계 링크 페이지 가져오기 (기본 켜짐, FETCH_LINKED=0 으로 끔)
  if (process.env.FETCH_LINKED !== "0") {
    await fetchLinkedPages();
  }

  console.log(
    `\n✨ 완료: 페이지 ${exportedCount}개, 에셋 ${assetCount}개 다운로드, API 호출 ${reqCount}회. → ${outRoot}`
  );
}

// ---------- 본문 속 Notion 링크를 1단계만 가져와 로컬로 연결 ----------
// 이미 하위 트리에 있는 페이지면 그 로컬 파일로, 아니면 _linked/ 로 받아 연결.
// 1단계만 받으므로 재귀가 없어 순환 위험 없음. 같은 페이지는 Set 으로 1번만 조회.
function compactId(s) {
  const m = s.replace(/-/g, "").match(/[0-9a-fA-F]{32}/);
  return m ? m[0].toLowerCase() : null;
}
function allMdFiles(dir, skipDir) {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "assets" && e.name !== skipDir) walk(p); }
      else if (e.name.endsWith(".md")) out.push(p);
    }
  })(dir);
  return out;
}
const NOTION_LINK_RE =
  /\[([^\]]*)\]\(<?(https?:\/\/(?:app\.notion\.com|(?:www\.)?notion\.(?:so|site))\/[^\s)>\]]*)>?\)/g;

async function exportLinkedPage(id, linkedRoot) {
  let page;
  try {
    page = await notion(`/pages/${id}`);
  } catch {
    return null; // 권한 없음/삭제됨 → 호출측에서 URL 유지
  }
  const title = pageTitle(page);
  const clean = uniqueName(linkedRoot, sanitize(title), id);
  const pageDir = join(linkedRoot, clean);
  const childTargets = {
    pages: [], databases: [],
    dir: pageDir, assetsDir: join(pageDir, "assets"), assetsRel: "assets",
    linkedMode: true, // 하위 페이지/DB 는 따라가지 않음
  };
  let body = "";
  try {
    body = await blocksToMarkdown(await getAllChildren(id), 0, childTargets);
  } catch (e) {
    body = `\n> ⚠️ 본문 변환 오류: ${e.message}\n`;
  }
  const front = page.parent?.type === "database_id" ? propsToFrontmatter(page) : "";
  mkdirSync(pageDir, { recursive: true });
  const absMd = join(pageDir, `${clean}.md`);
  writeFileSync(absMd, `${front}# ${title}\n\n> 🔗 다른 페이지에서 링크되어 1단계만 가져온 페이지\n\n${body}\n`, "utf8");
  return absMd;
}

async function fetchLinkedPages() {
  const LINKED = "_linked";
  const linkedRoot = join(outRoot, LINKED);
  const files = allMdFiles(outRoot, LINKED);

  // 본문에서 Notion 링크 id 수집 (이미 export된 내부 페이지는 제외 → 그건 바로 로컬 연결)
  const refs = new Map(); // compact id -> sample title
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let m;
    while ((m = NOTION_LINK_RE.exec(text))) {
      const cid = compactId(m[2]);
      if (cid && !refs.has(cid)) refs.set(cid, m[1].trim());
    }
  }
  // 가져와야 할 것 = 하위 트리에 없는 외부 링크
  const external = [...refs.keys()].filter((cid) => !exportedIdToPath.has(cid));
  if (!refs.size) return;

  console.log(`\n🔗 링크된 Notion 페이지 1단계 가져오기: 외부 ${external.length}개 (+ 내부 연결 ${refs.size - external.length}개)`);
  const idToLinked = new Map();
  for (const cid of external) {
    const abs = await exportLinkedPage(cid, linkedRoot);
    if (abs) { idToLinked.set(cid, abs); console.log(`  ✅ _linked/${basename(dirname(abs))}`); }
    else console.warn(`  ⚠️ 못 가져옴(권한/삭제) → URL 유지: ${refs.get(cid) || cid}`);
  }

  // 링크 교체: 내부 페이지는 export 경로로, 외부는 _linked 경로로
  let rewired = 0;
  for (const f of files) {
    const dir = dirname(f);
    let text = readFileSync(f, "utf8");
    let changed = false;
    text = text.replace(
      /(\]\()(<?)(https?:\/\/(?:app\.notion\.com|(?:www\.)?notion\.(?:so|site))\/[^\s)>\]]*)(>?)(\))/g,
      (whole, open, lt, url, gt, close) => {
        const cid = compactId(url);
        const target = cid && (exportedIdToPath.get(cid) || idToLinked.get(cid));
        if (!target) return whole;
        const rel = relative(dir, target).split(sep).join("/");
        changed = true; rewired++;
        return `${open}<${rel}>${close}`;
      }
    );
    if (changed) writeFileSync(f, text, "utf8");
  }
  console.log(`  → 링크 ${rewired}개를 로컬 파일로 연결`);
}

main().catch((e) => {
  console.error("💥 실패:", e.message);
  process.exit(1);
});
