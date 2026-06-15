import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: {
    'service-worker': 'src/background/service-worker.js',
    'checkout-reader': 'src/content/checkout-reader.js',
    'platform-scraper': 'src/content/platform-scraper.js',
    'deliveroo-scraper': 'src/content/deliveroo-scraper.js',
    'just-eat-scraper': 'src/content/just-eat-scraper.js',
    'sidebar': 'src/content/sidebar.js',
    'popup': 'src/popup.js',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: ['chrome109', 'firefox109'],
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
