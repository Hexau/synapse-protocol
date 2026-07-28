// Local filesystem + process-execution handlers for any client that runs
// on a real machine with direct disk access (synapse-vscode's extension
// host, the Synapse CLI). Extracted from synapse-vscode/src/cliClient.ts —
// this logic never touched a VSCode API, it's plain Node fs/cp/os/crypto,
// so it was always portable; keeping two copies in sync by hand was the
// same mistake this session already found and fixed once for shared
// skills (code-knowledge-graph/team-projects drifting between locations).
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as os from "os";
import * as crypto from "crypto";
import { FileOpHandler, ExecOpHandler } from "./wsClient";
import { FileOpRequest, FileOpResult, ExecOpRequest, ExecOpResult } from "./types";

// Mirrors helpers/code_knowledge/index_store.py's _CODE_EXTENSIONS/_SKIP_DIRS
// on the server — kept in sync by hand since this is the client-side half
// of the same filter (list_tree only reports files the indexer would ever
// read anyway, so there's no point shipping the rest over the wire).
export const INDEXABLE_EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".go", ".rs",
  ".cs", ".cpp", ".c", ".rb", ".php", ".swift", ".kt", ".md",
  // Componentes de framework frontend con extension propia. Sin estos, un
  // proyecto Vue/Svelte/Astro nunca cruza el cable: list_tree lo filtra
  // aqui, asi que el servidor jamas se entera de que existen esos archivos
  // y el repo queda indexado sin su capa de UI, en silencio.
  ".vue", ".svelte", ".astro",
  // En Astro / Nuxt Content / Docusaurus un .mdx es una ruta, no solo prosa.
  ".mdx",
]);
export const SKIP_DIRS = new Set([
  // "openwiki" es salida generada por la skill del mismo nombre: indexarla es
  // circular (las consultas devuelven la documentacion en vez del codigo del
  // que salio) y cerraba un bucle caro con el watcher de extension.ts.
  "openwiki",
  ".git", "node_modules", "venv", ".venv", "env", "__pycache__",
  ".idea", ".vscode", "dist", "build", ".cache", ".code_knowledge",
  ".next", ".nuxt", ".turbo", ".svelte-kit", "coverage", "out",
]);

interface IndexableFile {
  relPath: string;
  mtime: number;
  size: number;
}

// Recursively lists indexable files under rootPath, pruning skip-dirs in
// place (same approach as index_store.py's _collect_files — avoids
// descending into node_modules/.next/etc at all rather than filtering
// after a full walk).
function walkIndexableFiles(rootPath: string): IndexableFile[] {
  const results: IndexableFile[] = [];

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
        const full = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(full);
          results.push({
            relPath: path.relative(rootPath, full).split(path.sep).join("/"),
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        } catch {
          // file disappeared between readdir and stat — skip
        }
      }
    }
  };

  walk(rootPath);
  return results;
}

// Cheap change-detection signature: hash of (path|mtime|size) per file, NOT
// file content (that would mean reading every file just to decide whether
// anything changed, defeating the point of a fast pre-check).
function hashFileList(files: IndexableFile[]): string {
  const hash = crypto.createHash("md5");
  for (const f of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    hash.update(`${f.relPath}|${f.mtime}|${f.size}\n`);
  }
  return hash.digest("hex");
}

// Builds the {tree, tree_hash} pair for a connector_remote_tree_update push
// (see wsClient.ts's sendRemoteTreeUpdate) — the file list here doubles as
// what the server-side _76_include_remote_file_structure.py extension
// injects into the agent's prompt every turn, so the agent knows what
// project/files it's looking at without needing the separate "projects"
// registry (usr/projects/<name>/) at all, which only supports folders it
// creates itself, not arbitrary external paths like a CLI's cwd.
export function buildRemoteTreeSnapshot(rootPath: string): { tree: string; treeHash: string } {
  const files = walkIndexableFiles(rootPath);
  const treeHash = hashFileList(files);
  const tree = files
    .map((f) => f.relPath)
    .sort()
    .join("\n");
  return { tree, treeHash };
}

function applyUnifiedDiff(filePath: string, patchText: string): { ok: boolean; error?: string } {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const srcLines = content.split("\n");
    const patchLines = patchText.split("\n");

    let i = 0;
    while (i < patchLines.length && !patchLines[i].startsWith("@@")) i++;

    const hunks: Array<{ srcStart: number; srcLen: number; newLines: string[] }> = [];

    while (i < patchLines.length) {
      const m = patchLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
      if (!m) { i++; continue; }
      const srcStart = parseInt(m[1]) - 1;
      const srcLen = m[2] !== undefined ? parseInt(m[2]) : 1;
      i++;

      const newLines: string[] = [];
      while (i < patchLines.length && !patchLines[i].startsWith("@@")) {
        const ln = patchLines[i];
        if (ln.startsWith("+")) newLines.push(ln.slice(1));
        else if (ln.startsWith(" ")) newLines.push(ln.slice(1));
        // '-' lines are dropped (removed)
        i++;
      }
      hunks.push({ srcStart, srcLen, newLines });
    }

    const result = [...srcLines];
    for (let h = hunks.length - 1; h >= 0; h--) {
      const { srcStart, srcLen, newLines } = hunks[h];
      result.splice(srcStart, srcLen, ...newLines);
    }

    fs.writeFileSync(filePath, result.join("\n"), "utf8");
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: `Patch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Resuelve la ruta que mandó el agente contra la raíz del workspace, y la
 * confina ahí dentro.
 *
 * Sin esto, una ruta relativa como `openwiki/quickstart.md` la resolvía
 * `fs.writeFileSync` contra el `process.cwd()` del proceso anfitrión — que en
 * VSCode es su carpeta de instalación, no el proyecto. El write funcionaba y
 * devolvía `ok: true`, así que el agente creía haber documentado el repo
 * mientras los archivos se acumulaban en `…/Programs/Microsoft VS Code/`.
 * Un éxito falso es peor que un error: nadie va a buscar ahí.
 *
 * La jaula además cierra la misma clase de agujero que ya se corrigió en el
 * explorador de archivos del servidor: el prompt del agente puede venir de un
 * hook de un repo ajeno, así que un `../../.ssh/id_rsa` no puede ser una ruta
 * válida ni para leer ni para escribir.
 */
export function resolveInsideRoot(
  filePath: string,
  root: string
): { ok: true; path: string } | { ok: false; error: string } {
  if (!root) {
    return {
      ok: false,
      error:
        "no project folder is open, so the path cannot be resolved: " +
        filePath,
    };
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, filePath);
  const rel = path.relative(resolvedRoot, resolved);

  // `rel` vacío es la raíz misma; empezar por `..` o ser absoluta significa
  // que la ruta se salió.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      ok: false,
      error: `path escapes the project root: ${filePath}`,
    };
  }

  return { ok: true, path: resolved };
}

/**
 * Answers connector_file_op requests using the real local filesystem.
 *
 * `getRoot` da la raíz del proyecto contra la que se resuelven las rutas
 * relativas. Por defecto `process.cwd()`, que es correcto para el CLI (se
 * lanza dentro del proyecto) pero NO para la extensión de VSCode, que debe
 * pasar la carpeta del workspace explícitamente.
 */
export function createLocalFileOpHandler(
  getRoot: () => string | undefined = () => process.cwd()
): FileOpHandler {
  return async (data: FileOpRequest): Promise<FileOpResult> => {
    const { op } = data;

    const resolvedPath = resolveInsideRoot(data.path, getRoot() || "");
    if (!resolvedPath.ok) {
      return { op_id: data.op_id, ok: false, error: resolvedPath.error };
    }
    const filePath = resolvedPath.path;

    try {
      if (op === "read") {
        const raw = fs.readFileSync(filePath, "utf8");
        const lines = raw.split("\n");
        const from = data.line_from ? Math.max(0, data.line_from - 1) : 0;
        const to = data.line_to ? Math.min(lines.length, data.line_to) : lines.length;
        const content = lines.slice(from, to).join("\n");
        const stat = fs.statSync(filePath);
        return {
          op_id: data.op_id,
          ok: true,
          result: {
            content,
            total_lines: lines.length,
            file: { path: filePath, mtime: stat.mtimeMs, size: stat.size },
          },
        };
      }

      if (op === "write") {
        if (data.content === undefined) {
          return { op_id: data.op_id, ok: false, error: "content is required for write" };
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, data.content, "utf8");
        const stat = fs.statSync(filePath);
        return {
          op_id: data.op_id,
          ok: true,
          result: {
            message: `${filePath} written successfully`,
            file: { path: filePath, mtime: stat.mtimeMs, size: stat.size },
          },
        };
      }

      if (op === "list_dir") {
        // Listado crudo de un directorio. Distinto de `list_tree`, que filtra
        // por SKIP_DIRS/extensiones indexables y por tanto no ve `openwiki/`
        // — justo lo que hay que inspeccionar para comprobar si una corrida
        // de documentacion quedo completa.
        if (!fs.existsSync(filePath)) {
          return { op_id: data.op_id, ok: true, result: { entries: [], exists: false } };
        }
        const entries = fs.readdirSync(filePath, { withFileTypes: true }).map((e) => ({
          name: e.name,
          is_dir: e.isDirectory(),
        }));
        return { op_id: data.op_id, ok: true, result: { entries, exists: true } };
      }

      if (op === "delete") {
        // Sin esta operacion el agente no tenia forma de borrar por el
        // conector y caia a `rm` por shell, cuyo cwd no es la raiz del
        // proyecto: `rm openwiki/_plan.md` fallaba en silencio (el
        // `2>/dev/null` se comia el error) y el temporal sobrevivia a cada
        // corrida. Aqui la ruta ya viene resuelta y enjaulada como en el
        // resto de operaciones.
        if (!fs.existsSync(filePath)) {
          return { op_id: data.op_id, ok: false, error: `not found: ${filePath}` };
        }
        fs.unlinkSync(filePath);
        return {
          op_id: data.op_id,
          ok: true,
          result: { message: `${filePath} deleted` },
        };
      }

      if (op === "stat") {
        const stat = fs.statSync(filePath);
        return {
          op_id: data.op_id,
          ok: true,
          result: { file: { path: filePath, mtime: stat.mtimeMs, size: stat.size } },
        };
      }

      if (op === "patch") {
        if (data.patch_text) {
          const result = applyUnifiedDiff(filePath, data.patch_text);
          if (result.ok) {
            const stat = fs.statSync(filePath);
            return {
              op_id: data.op_id,
              ok: true,
              result: {
                message: `${filePath} patched successfully`,
                file: { path: filePath, mtime: stat.mtimeMs, size: stat.size },
              },
            };
          }
          return { op_id: data.op_id, ok: false, error: result.error };
        }

        const edits: Array<{ old_text: string; new_text: string }> =
          data.edits && Array.isArray(data.edits)
            ? data.edits
            : data.old_text !== undefined && data.new_text !== undefined
              ? [{ old_text: data.old_text, new_text: data.new_text }]
              : [];

        if (edits.length === 0) {
          return {
            op_id: data.op_id,
            ok: false,
            error: "patch requires patch_text, edits, or old_text+new_text",
          };
        }

        const raw = fs.readFileSync(filePath, "utf8");
        const hasCrlf = raw.includes("\r\n");
        let content = hasCrlf ? raw.replace(/\r\n/g, "\n") : raw;

        for (const edit of edits) {
          if (typeof edit.old_text !== "string" || typeof edit.new_text !== "string") continue;
          const normalOld = hasCrlf ? edit.old_text.replace(/\r\n/g, "\n") : edit.old_text;
          const normalNew = hasCrlf ? edit.new_text.replace(/\r\n/g, "\n") : edit.new_text;
          const idx = content.indexOf(normalOld);
          if (idx === -1) {
            return { op_id: data.op_id, ok: false, code: "patch_need_read", error: "" };
          }
          content = content.slice(0, idx) + normalNew + content.slice(idx + normalOld.length);
        }

        const output = hasCrlf ? content.replace(/\n/g, "\r\n") : content;
        fs.writeFileSync(filePath, output, "utf8");
        const stat = fs.statSync(filePath);
        return {
          op_id: data.op_id,
          ok: true,
          result: {
            message: `${filePath} patched successfully`,
            file: { path: filePath, mtime: stat.mtimeMs, size: stat.size },
          },
        };
      }

      if (op === "list_tree") {
        const files = walkIndexableFiles(filePath);
        const treeHash = hashFileList(files);
        return {
          op_id: data.op_id,
          ok: true,
          result: {
            root_path: filePath,
            tree: files.map((f) => f.relPath),
            tree_hash: treeHash,
          },
        };
      }

      return { op_id: data.op_id, ok: false, error: `Unknown op: ${op}` };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { op_id: data.op_id, ok: false, error: `Error (${op} '${filePath}'): ${msg}` };
    }
  };
}

interface SessionState {
  process?: cp.ChildProcess;
  outputBuffer: string;
  running: boolean;
}

/**
 * Answers connector_exec_op requests by running real local processes.
 *
 * `getRoot` da el directorio de trabajo. Sin el, `cp.exec` hereda el cwd del
 * proceso anfitrion — en VSCode, su carpeta de instalacion — y cualquier
 * comando que dependa del directorio actual hace lo equivocado en silencio:
 * `git rev-parse --is-inside-work-tree` respondia "no es un repo" para un
 * proyecto que si lo era (y con eso se saltaba toda la seccion de ownership),
 * y `rm openwiki/_plan.md` no borraba nada. Es el mismo fallo que ya se
 * corrigio para las operaciones de archivo con `resolveInsideRoot`, que nunca
 * se aplico a la ejecucion de comandos.
 */
export function createLocalExecOpHandler(
  getRoot: () => string | undefined = () => process.cwd()
): ExecOpHandler {
  const sessions = new Map<number, SessionState>();

  return (data: ExecOpRequest): Promise<ExecOpResult> => {
    const { op_id, runtime, session: sessionId = 0 } = data;

    if (runtime === "reset") {
      const sess = sessions.get(sessionId);
      sess?.process?.kill();
      sessions.delete(sessionId);
      return Promise.resolve({ op_id, ok: true, result: { message: `Session ${sessionId} reset.` } });
    }

    if (runtime === "output") {
      const sess = sessions.get(sessionId);
      return Promise.resolve({
        op_id,
        ok: true,
        result: { output: sess?.outputBuffer ?? "", running: sess?.running ?? false },
      });
    }

    if (!data.code) {
      return Promise.resolve({ op_id, ok: false, error: `code is required for runtime=${runtime}` });
    }

    const sess: SessionState = { outputBuffer: "", running: true };
    sessions.set(sessionId, sess);

    let cmd: string;
    if (runtime === "terminal") {
      cmd = data.code;
    } else if (runtime === "python") {
      const tmp = path.join(os.tmpdir(), `synapse_py_${op_id}.py`);
      fs.writeFileSync(tmp, data.code, "utf8");
      cmd = `python "${tmp}"`;
    } else if (runtime === "nodejs") {
      const tmp = path.join(os.tmpdir(), `synapse_js_${op_id}.js`);
      fs.writeFileSync(tmp, data.code, "utf8");
      cmd = `node "${tmp}"`;
    } else {
      return Promise.resolve({ op_id, ok: false, error: `Unsupported runtime: ${runtime}` });
    }

    const maxTimeout = data.timeouts
      ? Math.max(...Object.values(data.timeouts).map(Number)) + 15000
      : 120000;

    return new Promise((resolve) => {
      // El cwd es la raiz del proyecto abierto, no el del proceso anfitrion:
      // el agente escribe comandos relativos al repo (`git status`,
      // `rm openwiki/_plan.md`) dando por hecho que ahi esta.
      const cwd = getRoot() || undefined;
      const proc = cp.exec(cmd, { cwd, timeout: maxTimeout, windowsHide: true }, (_err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();
        sess.outputBuffer = output;
        sess.running = false;
        sess.process = undefined;
        resolve({ op_id, ok: true, result: { output, running: false } });
      });

      sess.process = proc ?? undefined;
    });
  };
}

/** Disposes all tracked local sessions (call on shutdown). */
export function killAllSessions(sessions: Map<number, SessionState>): void {
  for (const [, sess] of sessions) sess.process?.kill();
  sessions.clear();
}
