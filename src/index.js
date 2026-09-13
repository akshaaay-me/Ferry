import cron from 'node-cron';
import { migrate } from './db.js';
import { ingest } from './pipeline/ingest.js';
import { prefilter } from './pipeline/prefilter.js';
import { scoreAll } from './pipeline/score.js';
import { notify } from './pipeline/notify.js';
import { env } from './config.js';

async function cycle() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] cycle start`);
  try {
    console.log('ingest   ', await ingest({ concurrency: env.concurrency }));
    console.log('prefilter', await prefilter({ keep: env.keep, floor: env.prefilterFloor }));
    console.log('score    ', await scoreAll({ concurrency: env.concurrency, threshold: env.scoreThreshold }));
    console.log('notify   ', await notify({ threshold: env.notifyThreshold }));
  } catch (err) {
    console.error('cycle failed:', err);
  }
  console.log(`cycle done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

await migrate();
await cycle();
cron.schedule(env.cron, cycle);
console.log(`scheduled: ${env.cron}`);
