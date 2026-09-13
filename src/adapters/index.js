import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as ashby from './ashby.js';
import * as workable from './workable.js';
import * as recruitee from './recruitee.js';
import * as smartrecruiters from './smartrecruiters.js';
import * as workday from './workday.js';
import * as hn from './hn.js';
import * as feeds from './feeds.js';
import * as embeddedjobs from './embeddedjobs.js';

/**
 * Every adapter exports:
 *   name    : string
 *   fetchJobs({ slug, name }) -> Promise<NormalizedJob[]>
 *   detect? : (html) => slug | undefined   // used by the discovery crawler
 *
 * Adding a source means adding one file here. Nothing downstream changes.
 */
export const adapters = {
  greenhouse, lever, ashby, workable, recruitee, smartrecruiters, workday, hn, feeds, embeddedjobs,
};

export const detectors = Object.values(adapters).filter((a) => a.detect);
