import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// Se importa del fuente y se ejecuta el test ya compilado (dist), igual que
// hace synapse-vscode: evita depender del resolvedor de TS del runner de node.
import {
    resolveInsideRoot,
    createLocalFileOpHandler,
    createLocalExecOpHandler,
    SKIP_DIRS,
    INDEXABLE_EXTENSIONS,
} from './localOps';

let root: string;

before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'localops-'));
});

after(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveInsideRoot — la ruta relativa contra la raíz, y nada fuera de ella
// ---------------------------------------------------------------------------

describe('resolveInsideRoot', () => {
    it('resolves a relative path against the project root, not process.cwd()', () => {
        const r = resolveInsideRoot('openwiki/quickstart.md', root);
        assert.equal(r.ok, true);
        assert.equal(
            (r as { path: string }).path,
            path.join(root, 'openwiki', 'quickstart.md')
        );
    });

    it('accepts an absolute path that is already inside the root', () => {
        const inside = path.join(root, 'src', 'index.ts');
        const r = resolveInsideRoot(inside, root);
        assert.equal(r.ok, true);
        assert.equal((r as { path: string }).path, inside);
    });

    it('rejects traversal that escapes the root', () => {
        for (const evil of [
            '../outside.md',
            'openwiki/../../outside.md',
            '../../.ssh/id_rsa',
        ]) {
            const r = resolveInsideRoot(evil, root);
            assert.equal(r.ok, false, `debería rechazar ${evil}`);
        }
    });

    it('rejects an absolute path outside the root', () => {
        const r = resolveInsideRoot(
            process.platform === 'win32' ? 'C:\\Windows\\System32\\x.txt' : '/etc/passwd',
            root
        );
        assert.equal(r.ok, false);
    });

    it('rejects everything when no folder is open, instead of guessing', () => {
        const r = resolveInsideRoot('openwiki/quickstart.md', '');
        assert.equal(r.ok, false);
    });
});

// ---------------------------------------------------------------------------
// Ejecución de comandos: el cwd debe ser el proyecto, no el host
// ---------------------------------------------------------------------------

describe('createLocalExecOpHandler', () => {
    it('runs commands from the project root, not the host process cwd', async () => {
        // El bug: `git rev-parse --is-inside-work-tree` respondia que no habia
        // repositorio (y openwiki se saltaba toda la seccion de ownership)
        // porque el comando corria en la carpeta de instalacion de VSCode.
        const dir = path.join(root, 'proyecto-con-marca');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'MARCA.txt'), 'aqui', 'utf8');

        const exec = createLocalExecOpHandler(() => dir);
        const res = await exec({
            op_id: 'e1',
            runtime: 'terminal',
            session: 0,
            code: process.platform === 'win32' ? 'dir /b MARCA.txt' : 'ls MARCA.txt',
        } as never);

        assert.equal(res.ok, true);
        assert.match(
            String((res.result as { output: string }).output),
            /MARCA\.txt/,
            'el comando relativo debe resolverse dentro del proyecto'
        );
    });
});

// ---------------------------------------------------------------------------
// Indexado: la salida generada no puede realimentar al indexador
// ---------------------------------------------------------------------------

describe('SKIP_DIRS', () => {
    it('excludes openwiki, so generated docs never feed the code index', () => {
        // Indexarla es circular (las consultas devolvian la documentacion en
        // vez del codigo) y disparaba un reindexado por cada pagina escrita.
        assert.equal(SKIP_DIRS.has('openwiki'), true);
    });

    it('still excludes the usual build/vendor noise', () => {
        for (const d of ['.git', 'node_modules', '.next', 'dist', '.code_knowledge']) {
            assert.equal(SKIP_DIRS.has(d), true, `${d} deberia estar excluido`);
        }
    });
});

// ---------------------------------------------------------------------------
// El handler: el bug real era que write devolvía ok en el sitio equivocado
// ---------------------------------------------------------------------------

describe('createLocalFileOpHandler', () => {
    it('writes a relative path inside the project root', async () => {
        const handler = createLocalFileOpHandler(() => root);
        const res = await handler({
            op_id: '1',
            op: 'write',
            path: 'openwiki/quickstart.md',
            content: '# hola',
        } as never);

        assert.equal(res.ok, true);
        const written = path.join(root, 'openwiki', 'quickstart.md');
        assert.equal(fs.existsSync(written), true, 'el archivo debe estar en el proyecto');
        assert.equal(fs.readFileSync(written, 'utf8'), '# hola');
    });

    it('does NOT report success for a path it refused to write', async () => {
        const handler = createLocalFileOpHandler(() => root);
        const res = await handler({
            op_id: '2',
            op: 'write',
            path: '../escapado.md',
            content: 'x',
        } as never);

        assert.equal(res.ok, false, 'un write rechazado no puede devolver ok');
        assert.equal(fs.existsSync(path.join(path.dirname(root), 'escapado.md')), false);
    });

    it('refuses to write when there is no open folder', async () => {
        const handler = createLocalFileOpHandler(() => undefined);
        const res = await handler({
            op_id: '3',
            op: 'write',
            path: 'openwiki/x.md',
            content: 'x',
        } as never);

        assert.equal(res.ok, false);
    });

    it('deletes a file, resolving the path against the project root', async () => {
        // El bug: sin operacion `delete`, el agente caia a `rm` por shell con
        // ruta relativa, que no resolvia contra la raiz y fallaba en silencio.
        const handler = createLocalFileOpHandler(() => root);
        await handler({ op_id: 'd1', op: 'write', path: 'openwiki/_plan.md', content: 'x' } as never);
        const f = path.join(root, 'openwiki', '_plan.md');
        assert.equal(fs.existsSync(f), true);

        const res = await handler({ op_id: 'd2', op: 'delete', path: 'openwiki/_plan.md' } as never);
        assert.equal(res.ok, true);
        assert.equal(fs.existsSync(f), false, 'el temporal debe desaparecer de verdad');
    });

    it('reports failure when deleting something that is not there', async () => {
        const handler = createLocalFileOpHandler(() => root);
        const res = await handler({ op_id: 'd3', op: 'delete', path: 'no-existe.md' } as never);
        assert.equal(res.ok, false, 'no puede decir ok si no borro nada');
    });

    it('refuses to delete outside the project root', async () => {
        const handler = createLocalFileOpHandler(() => root);
        const res = await handler({ op_id: 'd4', op: 'delete', path: '../fuera.md' } as never);
        assert.equal(res.ok, false);
    });

    it('round-trips a write through a read', async () => {
        const handler = createLocalFileOpHandler(() => root);
        await handler({ op_id: '4', op: 'write', path: 'a/b.md', content: 'uno\ndos' } as never);
        const res = await handler({ op_id: '5', op: 'read', path: 'a/b.md' } as never);

        assert.equal(res.ok, true);
        assert.equal((res.result as { content: string }).content, 'uno\ndos');
    });

    // Estas extensiones faltaban en ambos lados a la vez: un proyecto Vue,
    // Svelte o Astro quedaba indexado sin su capa de UI y nadie se enteraba,
    // porque el filtro se aplica ANTES de mandar nada por el cable — el
    // servidor no ve un archivo vacio, ve un repo donde esos archivos no
    // existen. Falla silenciosa, no error.
    it('list_tree reports Vue/Svelte/Astro route files', async () => {
        const handler = createLocalFileOpHandler(() => root);
        const routes = [
            'src/pages/index.astro',
            'src/routes/+page.svelte',
            'pages/login.vue',
            'src/content/docs/guia.mdx',
        ];
        for (const rel of routes) {
            await handler({ op_id: 'fx', op: 'write', path: rel, content: '<x/>' } as never);
        }

        const res = await handler({ op_id: 't1', op: 'list_tree', path: '.' } as never);
        assert.equal(res.ok, true);
        const tree = (res.result as { tree: string[] }).tree.map((p) => p.replace(/\\/g, '/'));

        for (const rel of routes) {
            assert.ok(
                tree.some((p) => p.endsWith(rel)),
                `list_tree omitio ${rel} — el indexador nunca vera esa ruta`,
            );
        }
    });

    it('keeps the frontend extensions the Python side also indexes', () => {
        // _CODE_EXTENSIONS en helpers/code_knowledge/index_store.py es la otra
        // mitad de este filtro y se sincroniza a mano. Si alguien anade una
        // extension alli y no aqui, list_tree la sigue descartando y el
        // arreglo no sirve de nada — este assert es el recordatorio.
        for (const ext of ['.vue', '.svelte', '.astro', '.mdx']) {
            assert.ok(
                INDEXABLE_EXTENSIONS.has(ext),
                `${ext} debe estar en INDEXABLE_EXTENSIONS y en _CODE_EXTENSIONS (Python)`,
            );
        }
    });
});
