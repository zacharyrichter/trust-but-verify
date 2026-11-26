// Komodo Action: "Renovate Git Commit"
//
// Purpose: this is the Action your Git server's webhook points at directly.
// It receives the raw push-event payload, checks whether any commit in the
// push was authored or committed by your update bot's account, and only if
// so triggers the deploy Procedure through Komodo's own API.
//
// Forgejo/Gitea (and GitHub) cannot filter webhook deliveries by commit
// author from the UI. That check has to happen in code, on the receiving
// end. This script is that check.
//
// Adapted from FoxxMD's guide on scaling Renovate with Komodo
// (blog.foxxmd.dev/posts/scaling-renovate).
//
// ARGS (set these as this Action's Default Arguments in the Komodo UI,
// using the JSON format selector, not Key-Value: a Key-Value list that
// looks right in the UI can reach the script as undefined):
//
//   RENOVATE_USER => exact username of the update bot's account
//   PROCEDURE_ID  => id of the Procedure to trigger on a match
//   BASE_BRANCH   => (optional) only act on pushes to this branch
//   COMMIT        => bool. false/omitted = dry run (logs only, no deploy)
//
// The webhook is the only thing that can call this with a payload: Komodo
// merges the raw request body into ARGS as ARGS.WEBHOOK_BODY. A manual
// "Run Action" click has no payload and fails on the line below by design.

const body = ARGS.WEBHOOK_BODY;
const commit = ARGS.COMMIT === 'true' || ARGS.COMMIT === true;

const {
  commits = []
} = body;

if (commits.length > 0) {
  const {
    ref,
  } = body;

  if (ARGS.RENOVATE_USER === undefined) {
    throw new Error('RENOVATE_USER arg must be defined!');
  }

  if (ARGS.BASE_BRANCH !== undefined) {
    if (!ref.includes(ARGS.BASE_BRANCH)) {
      console.log(`Base Branch wanted '${ARGS.BASE_BRANCH}' but found '${ref}', ignoring this webhook event.`);
      return;
    }
  } else {
    console.log('No Base Branch check required.');
  }

  // Match on username, not email. Some Git servers only fill in a commit's
  // `username` field in webhook payloads if the commit's git-config email
  // exactly matches a VERIFIED email on an existing account. A typo in that
  // stored email makes every commit from the right account arrive with an
  // empty username, indistinguishable from "wrong author" unless you read
  // the raw payload.
  const renovateCommits = commits.filter(x => {
    const {
      author: {
        username: authorUser
      } = {},
      committer: {
        username: commitUser
      } = {}
    } = x;
    return authorUser === ARGS.RENOVATE_USER || commitUser === ARGS.RENOVATE_USER;
  });

  if (renovateCommits.length === 0) {
    console.log(`No commits by username ${ARGS.RENOVATE_USER}`);
    return;
  }

  console.log(`Found ${renovateCommits.length} by username ${ARGS.RENOVATE_USER}:\n${renovateCommits.map(x => x.message).join('\n')}`);

  const pid = ARGS.PROCEDURE_ID;
  console.log(`${commit === false ? '[DRY RUN] ' : ''}Triggering procedure ${pid}`);
  if (undefined === pid) {
    throw new Error('Cannot trigger procedure because no ID was provided as arg PROCEDURE_ID');
  }
  if (commit) {
    komodo.execute('RunProcedure', { procedure: pid });
  }
}
