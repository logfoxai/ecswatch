// Build a single ESM bundle for ecswatch.
//
// We bundle everything except the AWS SDK clients and Ink-family deps. Why:
//   - AWS SDK v3 is large; bundling slows install/build with no real win since
//     it's already split into per-service packages.
//   - Ink internally uses dynamic imports and CJS shims (e.g. react-reconciler);
//     bundling it tends to break the React reconciler runtime. Leaving it
//     external also keeps native peers like yoga-layout intact.
//
// The bin shim (bin/ecswatch) is a tiny launcher that imports dist/cli.js
// so `npm link` works without rebuilding the shim itself.

import {build, context} from 'esbuild';
import {readFileSync} from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Mark every runtime dep as external so we ship a small bundle and avoid
// double-loading React (Ink's reconciler is allergic to that).
const external = Object.keys(pkg.dependencies);

const options = {
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    external,
    logLevel: 'info',
    jsx: 'automatic',
    banner: {
        // Without this, `import.meta.url` is the bundle path which is fine,
        // but ESM modules sometimes need __dirname-style helpers from deps.
        js: 'import {createRequire as __ecswatchCreateRequire} from "module"; const require = __ecswatchCreateRequire(import.meta.url);',
    },
};

const watch = process.argv.includes('--watch');

if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    console.log('ecswatch: watching for changes…');
} else {
    await build(options);
}
