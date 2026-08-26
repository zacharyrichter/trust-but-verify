// Komodo Action: "batch-deploy-changed-and-exclude" (rename to whatever fits your setup)
//
// Purpose: this is the Action your deploy Procedure should call after
// pulling fresh repo state (see the Procedure setup notes in the writeup --
// this script depends on the orchestrator's local repo clones already
// being current; it does NOT pull anything itself).
//
// It looks at every Stack the orchestrator knows about, excludes any that
// match a filter (by tag, repo, server, stack name, service name, or
// image), and calls BatchDeployStackIfChanged on whatever's left. Only
// stacks with a real pending change actually redeploy -- this is safe to
// call broadly across a whole fleet, since "if changed" does the real
// gating.
//
// Credit: originally adapted from FoxxMD's guide on scaling Renovate with
// Komodo (blog.foxxmd.dev/posts/scaling-renovate).
//
// ARGS (set as this Action's own Default Arguments, JSON format, and/or
// pass explicitly from the calling Procedure's stage -- both work, the
// Procedure's stage args take precedence if set):
//
//   TAGS      => comma-separated tag NAMES to exclude, e.g. "critical-infra,template"
//   REPOS     => comma-separated substrings to match against a stack's repo field
//   SERVER_IDS=> comma-separated server IDs to exclude entirely
//   STACKS    => comma-separated substrings to match against stack names
//   SERVICES  => comma-separated substrings to match against service names within a stack
//   IMAGES    => comma-separated substrings to match against image names
//   COMMIT    => bool. false/omitted = dry run (logs what WOULD deploy, does nothing)

const REPOS = ARGS.REPOS === undefined ? [] : ARGS.REPOS.split(',');
const SERVER_IDS = ARGS.SERVER_IDS === undefined ? [] : ARGS.SERVER_IDS.split(',');
const TAGS = ARGS.TAGS === undefined ? [] : ARGS.TAGS.split(',');
const STACKS = ARGS.STACKS === undefined ? [] : ARGS.STACKS.split(',');
const SERVICES = ARGS.SERVICES === undefined ? [] : ARGS.SERVICES.split(',');
const IMAGES = ARGS.IMAGES === undefined ? [] : ARGS.IMAGES.split(',');

// If ARGS.COMMIT is not present and `true`, this Action only "dry runs" --
// it logs what it would do but takes no real action.
const commit = ARGS.COMMIT === 'true' || ARGS.COMMIT === true;

const intersect = (a: Array<any>, b: Array<any>) => {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  return Array.from(intersection);
};

const formatColumns = (arr: string[], numCols: number) => {
  if (!arr || arr.length === 0) return "";
  const colWidths = Array.from({ length: numCols }, (_, colIndex) => {
    let maxWidth = 0;
    for (let i = colIndex; i < arr.length; i += numCols) {
      if (arr[i].length > maxWidth) maxWidth = arr[i].length;
    }
    return maxWidth;
  });
  const rows = [];
  for (let i = 0; i < arr.length; i += numCols) {
    const rowItems = arr.slice(i, i + numCols);
    const row = rowItems
      .map((item, colIndex) => item.padEnd(colWidths[colIndex]))
      .join("  ");
    rows.push(row.trimEnd());
  }
  return rows.join("\n");
};

const availableStacks = await komodo.read('ListStacks', {});

let userTags: string[] = [];
let tagsList;
if (TAGS.length > 0) {
  tagsList = await komodo.read('ListTags', {});
  userTags = tagsList.filter(t => TAGS.includes(t.name)).map(t => t._id.$oid);
}

const excluded: string[] = [];

const candidates = availableStacks.filter(stack => {
  if (REPOS.length > 0 && REPOS.some(r => stack.info.repo.includes(r))) {
    excluded.push(`${stack.name} => repo`);
    return false;
  }
  if (SERVER_IDS.length > 0 && SERVER_IDS.includes(stack.info.server_id)) {
    excluded.push(`${stack.name} => server`);
    return false;
  }
  if (TAGS.length > 0 && intersect(userTags, stack.tags).length > 0) {
    const intersectedTags = intersect(userTags, stack.tags);
    excluded.push(`${stack.name} => tags ${tagsList.filter(t => intersectedTags.includes(t._id.$oid)).map(t => t.name).join(',')}`);
    return false;
  }
  if (STACKS.length > 0 && STACKS.some(s => stack.name.includes(s))) {
    excluded.push(`${stack.name} => stack`);
    return false;
  }
  if (SERVICES.length > 0) {
    const svcNames = stack.info.services.map(s => s.service);
    if (svcNames.some(svc => SERVICES.some(s => svc.includes(s)))) {
      excluded.push(`${stack.name} => service`);
      return false;
    }
  }
  if (IMAGES.length > 0) {
    const imageNames = stack.info.services.map(s => s.image);
    if (imageNames.some(img => IMAGES.some(i => img.includes(i)))) {
      excluded.push(`${stack.name} => image`);
      return false;
    }
  }
  return true;
});

if (excluded.length > 0) {
  console.log(`Excluded ${excluded.length} Stack(s):\n${formatColumns(excluded, 3)}`);
}

console.log(`\n${commit === false ? '[DRY RUN] ' : ''}Will deploy ${candidates.length} if changed:\n${formatColumns(candidates.map(s => s.name), 3)}`);

if (commit) {
  await komodo.execute('BatchDeployStackIfChanged', { pattern: candidates.map(s => s.name).join(',') });
}
