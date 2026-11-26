// Komodo Action: "batch-deploy-changed-and-exclude"
//
// Purpose: the deploy Procedure calls this after pulling fresh repo state.
// It does NOT pull anything itself: "deploy if changed" compares against
// the orchestrator's local repo clones, so those must already be current.
//
// It looks at every Stack Komodo knows about, drops any that match a
// filter (by tag, repo, server, stack name, service name or image), and
// calls BatchDeployStackIfChanged on whatever is left. Only stacks with a
// real pending change redeploy, so it is safe to call across a whole fleet.
//
// Adapted from FoxxMD's guide on scaling Renovate with Komodo
// (blog.foxxmd.dev/posts/scaling-renovate).
//
// ARGS (this Action's Default Arguments, JSON format; the calling
// Procedure's stage args take precedence if set):
//
//   TAGS       => comma-separated tag NAMES to exclude, e.g. "critical-infra,template"
//   REPOS      => comma-separated substrings matched against a stack's repo
//   SERVER_IDS => comma-separated server ids to exclude entirely
//   STACKS     => comma-separated substrings matched against stack names
//   SERVICES   => comma-separated substrings matched against service names
//   IMAGES     => comma-separated substrings matched against image names
//   COMMIT     => bool. false/omitted = dry run (logs what WOULD deploy)

const REPOS = ARGS.REPOS === undefined ? [] : ARGS.REPOS.split(',');
const SERVER_IDS = ARGS.SERVER_IDS === undefined ? [] : ARGS.SERVER_IDS.split(',');
const TAGS = ARGS.TAGS === undefined ? [] : ARGS.TAGS.split(',');
const STACKS = ARGS.STACKS === undefined ? [] : ARGS.STACKS.split(',');
const SERVICES = ARGS.SERVICES === undefined ? [] : ARGS.SERVICES.split(',');
const IMAGES = ARGS.IMAGES === undefined ? [] : ARGS.IMAGES.split(',');

// If ARGS.COMMIT is not present and `true`, this Action only "dry runs":
// it logs what it would do but takes no real action.
const commit = ARGS.COMMIT === 'true' || ARGS.COMMIT === true;

// Values found in both lists
const intersect = (a: Array<any>, b: Array<any>) => {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  return Array.from(intersection);
};

// Lays names out in columns for the console log
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

// Stacks carry tag IDs, not names, so resolve the excluded tag names first
let userTags: string[] = [];
let tagsList: Types.ListTagsResponse = [];
if (TAGS.length > 0) {
  tagsList = await komodo.read('ListTags', {});
  userTags = tagsList.filter(t => TAGS.includes(t.name)).map(t => t._id.$oid);
}

console.log('ARGS.TAGS raw:', JSON.stringify(ARGS.TAGS));
console.log('Tag IDs excluded:', JSON.stringify(userTags));

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

// Never hand an empty list to the batch call: an empty pattern is not
// guaranteed to mean "nothing".
if (commit && candidates.length > 0) {
  await komodo.execute('BatchDeployStackIfChanged', { pattern: candidates.map(s => s.name).join(',') });
}
